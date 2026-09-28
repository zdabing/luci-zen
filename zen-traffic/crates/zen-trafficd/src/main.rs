//! zen-trafficd — luci-zen 设备流量守护进程（Rust 正式包）。
//!
//! 技术路线（spike Step 1–5 验证）：Aya 加载 zen_traffic.bpf.o + TC attach；
//! libubus 直连发布 zen.traffic；uloop 事件循环。
//! 正式能力：SQLite 日/月累计持久化、日切/月切、DHCP/neighbour/hostapd 属性合并、
//! 全局速率（netlink）、残留 TC filter 清理。
//!
//! 命令行（init.d 由 UCI /etc/config/zen-traffic 生成）：
//!   zen-trafficd -b <zen_traffic.bpf.o> [-i iface]... [-t ms] [-o sec]
//!                [-c sec] [-d db] [-P cidr]... [-q]

mod accounting;
mod daemon;
mod device;
mod netif;
mod netlink;
mod persistence;
mod state;
mod totals;
mod ubus;

use state::Config;

fn main() {
    let cfg = match parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[zen-trafficd] {e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };

    unsafe {
        let handler = ubus::on_signal as extern "C" fn(std::os::raw::c_int) as usize;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // 1) daemon 初始化（DB/netlink/BPF attach）；失败即退出（procd respawn）
    let daemon = match daemon::Daemon::init(cfg) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[zen-trafficd] 初始化失败: {e}");
            std::process::exit(1);
        }
    };
    let ubus_ctx = {
        *ubus::DAEMON.lock().expect("DAEMON lock") = Some(daemon);
        match unsafe { ubus::start() } {
            Ok(ctx) => {
                println!(
                    "[zen-trafficd] ubus 对象已注册：ubus call {} getStatus",
                    ubus::OBJ_NAME
                );
                ctx
            }
            Err(e) => {
                // spike 同款：ubus 不可用不阻塞采集（降级：仅 1s timer 维持）
                eprintln!("[zen-trafficd] 警告: {e}（采集继续，ubus 发布不可用）");
                unsafe { ubus::arm_tick_only() };
                std::ptr::null_mut()
            }
        }
    };
    // 回填 ctx 供属性合并（hostapd/network dump）使用
    ubus::with_daemon(|d| d.ubus_ctx = ubus_ctx);

    println!(
        "[zen-trafficd] running: ifaces={:?} db={} interval={}ms checkpoint={}s",
        ubus::with_daemon(|d| d.cfg.ifaces.clone()),
        ubus::with_daemon(|d| d.cfg.db_path.clone()),
        ubus::with_daemon(|d| d.cfg.interval_ms),
        ubus::with_daemon(|d| d.cfg.checkpoint_secs),
    );

    // 2) 事件循环（SIGTERM 置 uloop_cancelled，≤1s 退出）
    unsafe { zen_ubus_sys::uloop_run_timeout(-1) };

    // 3) 清理：最终 checkpoint → ubus/uloop → drop(Bpf) 自动 detach filter
    ubus::with_daemon(|d| {
        if ubus::shutting_down() {
            println!("[zen-trafficd] 收到 SIGTERM/SIGINT，开始清理");
        }
        d.shutdown_checkpoint();
    });

    if !ubus_ctx.is_null() {
        unsafe {
            zen_ubus_sys::ubus_free(ubus_ctx);
            zen_ubus_sys::uloop_done();
        }
    }
    println!("[zen-trafficd] clean shutdown 完成");
}

const USAGE: &str = "用法: zen-trafficd [选项]
  -b, --bpf PATH        BPF 对象路径（默认 /usr/share/zen-traffic/zen_traffic.bpf.o）
  -i, --iface NAME      LAN 桥设备（可重复，默认 br-lan）
  -t, --interval-ms N   轮询周期（默认 1000，最小 100）
  -o, --offline SEC     设备离线判定秒数（默认 600）
  -c, --checkpoint SEC  SQLite checkpoint 周期秒数（默认 300）
  -d, --db PATH         SQLite 数据库路径（默认 /etc/zen-traffic/traffic.db）
  -P, --prefix CIDR     额外本地前缀（可重复，如 10.0.0.0/24）
  -h, --help";

fn parse_args() -> Result<Config, String> {
    let mut cfg = Config::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-b" | "--bpf" => cfg.bpf_path = it.next().ok_or("-b 缺参数")?,
            "-i" | "--iface" => {
                let v = it.next().ok_or("-i 缺参数")?;
                if cfg.ifaces.len() == 1 && cfg.ifaces[0] == "br-lan" {
                    cfg.ifaces[0] = v; // 首个 -i 替换默认项（对齐 C PoC 语义）
                } else {
                    cfg.ifaces.push(v);
                }
            }
            "-t" | "--interval-ms" => {
                let v: u64 = it.next().ok_or("-t 缺参数")?.parse().map_err(|_| "-t 非法")?;
                cfg.interval_ms = v.max(100);
            }
            "-o" | "--offline" => {
                let v: u64 = it.next().ok_or("-o 缺参数")?.parse().map_err(|_| "-o 非法")?;
                cfg.offline_timeout = v.max(30);
            }
            "-c" | "--checkpoint" => {
                let v: u64 = it.next().ok_or("-c 缺参数")?.parse().map_err(|_| "-c 非法")?;
                cfg.checkpoint_secs = v.max(30);
            }
            "-d" | "--db" => cfg.db_path = it.next().ok_or("-d 缺参数")?,
            "-P" | "--prefix" => cfg.extra_prefixes.push(it.next().ok_or("-P 缺参数")?),
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("未知参数 {other}（-h 看用法）")),
        }
    }
    Ok(cfg)
}
