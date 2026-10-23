//! zen-capture — luci-zen 独立抓包守护进程（M1，docs/PACKET_CAPTURE.md）。
//!
//! 职责：按 MAC 管理 tcpdump 会话（每接口一个子进程），执行时长/大小/并发/磁盘限额，
//! 崩溃重启后收割孤儿 tcpdump，经 ubus `zen.capture` 发布 start/stop/status/delete。
//! 与 zen-trafficd 进程隔离：抓包资源失控不影响流量账本。SQLite/BPF 均不涉及。
//!
//! 命令行（init.d 由 UCI /etc/config/zen-traffic capture 段生成）：
//!   zen-capture [-d dir] [-i iface]... [-s sessions] [-T duration]
//!               [-M max_file_mb] [-S snaplen] [-K keep]

#![allow(unsafe_op_in_unsafe_fn)]

mod capture;
mod ubus;

use capture::Config;

fn main() {
    let cfg = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[zen-capture] {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    unsafe {
        let handler = ubus::on_signal as extern "C" fn(std::os::raw::c_int) as usize;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // 1) 会话恢复（孤儿收割 + 残留清理）；失败即退出（procd respawn）
    let manager = match capture::Manager::init(cfg) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[zen-capture] 初始化失败: {e}");
            std::process::exit(1);
        }
    };
    let ubus_ctx = {
        *ubus::MANAGER.lock().expect("MANAGER lock") = Some(manager);
        match unsafe { ubus::start() } {
            Ok(ctx) => {
                println!(
                    "[zen-capture] ubus 对象已注册：ubus call {} status",
                    ubus::OBJ_NAME
                );
                ctx
            }
            Err(e) => {
                // ubus 不可用不阻塞限额执行（降级：仅 1s timer 收割与限额）
                eprintln!("[zen-capture] 警告: {e}（限额监控继续，ubus 发布不可用）");
                unsafe { ubus::arm_tick_only() };
                std::ptr::null_mut()
            }
        }
    };

    println!(
        "[zen-capture] running: dir={:?} ifaces={:?} sessions={} duration={}s max_file={}MB snap={} keep={}",
        ubus::with_manager(|m| m.cfg.dir.to_string_lossy().into_owned()),
        ubus::with_manager(|m| m.cfg.ifaces.clone()),
        ubus::with_manager(|m| m.cfg.max_sessions),
        ubus::with_manager(|m| m.cfg.max_duration),
        ubus::with_manager(|m| m.cfg.max_file_mb),
        ubus::with_manager(|m| m.cfg.snaplen),
        ubus::with_manager(|m| m.cfg.keep),
    );

    // 2) 事件循环（SIGTERM 置 uloop_cancelled，≤1s 退出）
    unsafe { zen_ubus_sys::uloop_run_timeout(-1) };

    // 3) 清理：SIGTERM 全部 running 会话 → 落盘 → 退出 ubus/uloop。
    let shutdown_manager = ubus::MANAGER.lock().expect("MANAGER lock").take();
    if let Some(mut m) = shutdown_manager {
        if ubus::shutting_down() {
            println!("[zen-capture] 收到 SIGTERM/SIGINT，停止抓包会话并清理");
        }
        m.shutdown();
    }

    if !ubus_ctx.is_null() {
        unsafe {
            zen_ubus_sys::ubus_free(ubus_ctx);
            zen_ubus_sys::uloop_done();
        }
    }
    println!("[zen-capture] clean shutdown 完成");
}

const USAGE: &str = "用法: zen-capture [选项]
  -d, --dir PATH        pcap 输出目录（默认 /tmp/zen-capture）
  -i, --iface NAME      监听接口（网桥自动展开为端口，可重复，默认 br-lan）
  -s, --sessions N      最大并发会话（默认 2，范围 1–4）
  -T, --duration SEC    单会话时长上限秒（默认 600，范围 60–86400）
  -M, --max-file-mb N   单会话总大小上限 MB（默认 8，范围 1–512）
  -S, --snaplen N       抓包 snaplen 字节（默认 256，范围 24–262144）
  -K, --keep N          保留的已完成会话数（默认 10，范围 1–64）
  -B, --bpf PATH        zen_capture.bpf.o 路径（默认 /usr/share/zen-traffic/zen_capture.bpf.o）
  -C, --ca-dir PATH     CA 存储目录（默认 /etc/zen-capture）
  -N, --skip DOMAIN     MITM 直连白名单域名（可重复，后缀匹配）
  -h, --help";

fn parse_args() -> Result<Config, String> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from(mut it: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut cfg = Config {
        dir: std::path::PathBuf::from("/tmp/zen-capture"),
        ifaces: vec!["br-lan".into()],
        max_sessions: 2,
        max_duration: 600,
        max_file_mb: 8,
        snaplen: 256,
        keep: 10,
        tap_obj: std::path::PathBuf::from("/usr/share/zen-traffic/zen_capture.bpf.o"),
        ca_dir: std::path::PathBuf::from("/etc/zen-capture"),
        decrypt_skip: Vec::new(),
    };
    let mut explicit_ifaces = false;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-d" | "--dir" => cfg.dir = std::path::PathBuf::from(it.next().ok_or("-d 缺参数")?),
            "-i" | "--iface" => {
                let v = it.next().ok_or("-i 缺参数")?;
                if !explicit_ifaces {
                    cfg.ifaces.clear();
                    explicit_ifaces = true;
                }
                if !cfg.ifaces.contains(&v) {
                    cfg.ifaces.push(v);
                }
            }
            "-s" | "--sessions" => {
                let v: u32 = it.next().ok_or("-s 缺参数")?.parse().map_err(|_| "-s 非法")?;
                cfg.max_sessions = v.clamp(1, 4);
            }
            "-T" | "--duration" => {
                let v: u64 = it.next().ok_or("-T 缺参数")?.parse().map_err(|_| "-T 非法")?;
                cfg.max_duration = v.clamp(60, 86_400);
            }
            "-M" | "--max-file-mb" => {
                let v: u64 = it.next().ok_or("-M 缺参数")?.parse().map_err(|_| "-M 非法")?;
                cfg.max_file_mb = v.clamp(1, 512);
            }
            "-S" | "--snaplen" => {
                let v: u32 = it.next().ok_or("-S 缺参数")?.parse().map_err(|_| "-S 非法")?;
                cfg.snaplen = v.clamp(24, 262_144);
            }
            "-K" | "--keep" => {
                let v: u32 = it.next().ok_or("-K 缺参数")?.parse().map_err(|_| "-K 非法")?;
                cfg.keep = v.clamp(1, 64);
            }
            "-B" | "--bpf" => cfg.tap_obj = std::path::PathBuf::from(it.next().ok_or("-B 缺参数")?),
            "-C" | "--ca-dir" => cfg.ca_dir = std::path::PathBuf::from(it.next().ok_or("-C 缺参数")?),
            "-N" | "--skip" => {
                let v = it.next().ok_or("-N 缺参数")?;
                if !v.is_empty() && !cfg.decrypt_skip.contains(&v) {
                    cfg.decrypt_skip.push(v);
                }
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("未知参数 {other}（-h 看用法）")),
        }
    }
    Ok(cfg)
}

#[cfg(test)]
mod args_tests {
    use super::parse_args_from;

    #[test]
    fn defaults_match_documented_caps() {
        let cfg = parse_args_from(std::iter::empty()).unwrap();
        assert_eq!(cfg.dir, std::path::PathBuf::from("/tmp/zen-capture"));
        assert_eq!(cfg.ifaces, ["br-lan"]);
        assert_eq!(cfg.max_sessions, 2);
        assert_eq!(cfg.max_duration, 600);
        assert_eq!(cfg.max_file_mb, 8);
        assert_eq!(cfg.snaplen, 256);
        assert_eq!(cfg.keep, 10);
        assert_eq!(cfg.tap_obj, std::path::PathBuf::from("/usr/share/zen-traffic/zen_capture.bpf.o"));
        assert_eq!(cfg.ca_dir, std::path::PathBuf::from("/etc/zen-capture"));
        assert!(cfg.decrypt_skip.is_empty());
    }

    #[test]
    fn explicit_bridge_is_not_replaced_by_the_second_interface() {
        let cfg = parse_args_from(["-i", "br-lan", "-i", "eth0", "-i", "br-lan"]
            .into_iter().map(String::from)).unwrap();
        assert_eq!(cfg.ifaces, ["br-lan", "eth0"]);
    }

    #[test]
    fn values_are_clamped_to_hard_ranges() {
        let cfg = parse_args_from(["-s", "9", "-T", "1", "-M", "4096", "-S", "1", "-K", "0"]
            .into_iter().map(String::from)).unwrap();
        assert_eq!((cfg.max_sessions, cfg.max_duration, cfg.max_file_mb, cfg.snaplen, cfg.keep),
            (4, 60, 512, 24, 1));
    }

    #[test]
    fn skip_domains_deduplicate_and_ignore_empty() {
        let cfg = parse_args_from(["-N", "bank.com", "-N", "bank.com", "-N", ""]
            .into_iter().map(String::from)).unwrap();
        assert_eq!(cfg.decrypt_skip, ["bank.com"]);
    }

    #[test]
    fn missing_values_are_rejected() {
        assert!(parse_args_from(["-d"].into_iter().map(String::from)).is_err());
        assert!(parse_args_from(["-x"].into_iter().map(String::from)).is_err());
    }
}
