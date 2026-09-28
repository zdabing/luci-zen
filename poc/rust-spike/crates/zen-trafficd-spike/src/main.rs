//! zen-trafficd-spike — luci-zen Rust/Aya feasibility spike
//!
//! Step 2  Aya 加载 zen_traffic.bpf.o，识别 SchedClassifier 与 devices map
//! Step 3  clsact + TC ingress/egress attach + map read + detach/cleanup
//! Step 4  libubus 直连发布 zen.traffic（ping/stats），`ubus call zen.traffic ping`
//! Step 5  uloop 事件循环 + SIGTERM clean shutdown
//!
//! 用法：
//!   zen-trafficd-spike -b /path/zen_traffic.bpf.o [-i br-lan] [--interval-ms 1000]
//!                      [--no-attach]
//!   --no-attach：跳过 BPF/TC（Step 4/5 在开发机上单独验证用）

mod bpf;
mod tc;
mod ubusd;

use std::path::PathBuf;

use aya::programs::TcAttachType;

struct Args {
    iface: String,
    bpf: Option<PathBuf>,
    no_attach: bool,
    _interval_ms: i32,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        iface: "br-lan".into(),
        bpf: None,
        no_attach: false,
        _interval_ms: 1000,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-i" | "--iface" => a.iface = it.next().ok_or("-i 缺参数")?,
            "-b" | "--bpf" => {
                a.bpf = Some(PathBuf::from(it.next().ok_or("-b 缺参数")?));
            }
            "--no-attach" => a.no_attach = true,
            "--interval-ms" => {
                a._interval_ms = it
                    .next()
                    .ok_or("--interval-ms 缺参数")?
                    .parse()
                    .map_err(|_| "--interval-ms 非法")?;
            }
            "-h" | "--help" => {
                println!(
                    "usage: zen-trafficd-spike -b <zen_traffic.bpf.o> \
                     [-i iface] [--interval-ms N] [--no-attach]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("未知参数 {other}（-h 看用法）")),
        }
    }
    if !a.no_attach && a.bpf.is_none() {
        return Err("必须提供 -b <zen_traffic.bpf.o>（或 --no-attach）".into());
    }
    Ok(a)
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[spike] {e}");
            std::process::exit(2);
        }
    };

    // Step 5：SIGTERM/SIGINT → clean shutdown（uloop 退出 → detach → ubus_free）
    let handler = ubusd::on_signal as extern "C" fn(std::os::raw::c_int) as usize;
    unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    }

    if let Err(e) = run(&args) {
        eprintln!("[spike] fatal: {e}");
        std::process::exit(1);
    }
}

fn run(args: &Args) -> Result<(), String> {
    zen_ubus_sys::layout_report(); // Step 4 验证辅助：核对 FFI 结构体偏移

    // ---- Step 2/3：BPF 加载 + TC attach -----------------------------------
    // attach 结果（link id）保存在本作用域，退出时显式 detach
    let mut ingress_link = None;
    let mut egress_link = None;
    let mut qdisc_created = false;

    if !args.no_attach {
        let path = args.bpf.as_ref().unwrap();
        println!("[spike] == Step 2: 加载 {path:?} ==");
        let mut bpf = bpf::load_object(path)?;
        bpf::describe(&bpf);

        println!("[spike] == Step 3: TC attach {iface} ==", iface = args.iface);
        qdisc_created = tc::qdisc_ensure(&args.iface)?;
        ingress_link = Some(tc::attach(
            &mut bpf,
            "zen_ingress",
            &args.iface,
            TcAttachType::Ingress,
        )?);
        egress_link = Some(tc::attach(
            &mut bpf,
            "zen_egress",
            &args.iface,
            TcAttachType::Egress,
        )?);
        println!(
            "[spike] attach 完成：zen_ingress→{iface}/ingress, zen_egress→{iface}/egress \
             （qdisc {}）",
            if qdisc_created { "本次新建" } else { "已存在，复用" }
        );

        *ubusd::bpf_slot() = Some(bpf);
    } else {
        println!("[spike] --no-attach：跳过 BPF/TC（仅验证 Step 4/5）");
    }

    // ---- Step 4：ubus 直连发布 ---------------------------------------------
    println!("[spike] == Step 4: 发布 ubus 对象 {} ==", ubusd::OBJ_NAME);
    let ctx = unsafe { ubusd::start() }?;
    println!(
        "[spike] ubus 对象已注册：ubus call {name} ping / {name} stats；uloop 运行中…",
        name = ubusd::OBJ_NAME
    );

    // ---- Step 5：事件循环（SIGTERM 置 uloop_cancelled 退出）----------------
    unsafe { zen_ubus_sys::uloop_run_timeout(-1) };
    println!("[spike] == Step 5: uloop 退出，开始清理 ==");
    if ubusd::shutting_down() {
        println!("[spike] 原因：收到 SIGTERM/SIGINT");
    }

    // ---- 清理：显式 detach + qdisc（仅本次创建时删）+ ubus_free + uloop_done
    if let (Some(mut bpf), Some(li), Some(le)) = (
        ubusd::take_bpf(),
        ingress_link,
        egress_link,
    ) {
        let _ = tc::detach(&mut bpf, "zen_ingress", li);
        let _ = tc::detach(&mut bpf, "zen_egress", le);
        drop(bpf);
        println!("[spike] TC filter 已 detach");
    }
    tc::qdisc_cleanup(&args.iface, qdisc_created);
    unsafe {
        zen_ubus_sys::ubus_free(ctx);
        zen_ubus_sys::uloop_done();
    }
    println!("[spike] clean shutdown 完成");
    Ok(())
}
