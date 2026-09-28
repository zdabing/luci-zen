//! Step 4：直接发布 ubus 对象 `zen.traffic`（ping / stats）。
//! Step 5：uloop 事件循环 + SIGTERM clean shutdown。
//!
//! 对照红线（ARCHITECTURE.md §3）：daemon 经 libubus 直接注册对象，
//! 无 HTTP、无 TCP 端口、无 shell rpcd 桥。
//!
//! ubus handler 由 uloop 主线程回调执行：
//!   - Bpf/map 访问全部发生在主线程，无跨线程 Send 问题；
//!   - Bpf 放入全局 Mutex<Option<Bpf>>（aya::Bpf: Send），tick 与 stats 共享。

use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use aya::Bpf;
use zen_ubus_sys as ubus;

use crate::bpf;

pub const OBJ_NAME: &str = "zen.traffic";
pub const TICK_MS: c_int = 1000;

// ---------------------------------------------------------------------------
// 全局共享状态（uloop 单线程回调模型，Mutex 仅防逃逸借用）
// ---------------------------------------------------------------------------

pub(crate) static BPF: Mutex<Option<Bpf>> = Mutex::new(None);

#[derive(Clone, Copy, Default)]
pub struct Snapshot {
    pub devices: u64,
    pub wan_rx_b: u64,
    pub wan_tx_b: u64,
    pub lan_rx_b: u64,
    pub lan_tx_b: u64,
    pub wan_rx_rate: u64, // B/s，tick 差分
    pub wan_tx_rate: u64,
    pub ticks: u64,
}

pub(crate) static SNAP: Mutex<Snapshot> = Mutex::new(Snapshot {
    devices: 0,
    wan_rx_b: 0,
    wan_tx_b: 0,
    lan_rx_b: 0,
    lan_tx_b: 0,
    wan_rx_rate: 0,
    wan_tx_rate: 0,
    ticks: 0,
});

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static TICKS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn bpf_slot() -> MutexGuard<'static, Option<Bpf>> {
    BPF.lock().expect("BPF lock")
}

pub(crate) fn take_bpf() -> Option<Bpf> {
    bpf_slot().take()
}

/// Step 5：信号处理。置位 SHUTDOWN 并写 uloop 的全局取消标志。
/// uloop 主循环每轮检查 `uloop_cancelled`；即便写竞争未生效，
/// 1s tick 也会唤醒 poll，下一 tick 在主线程再次检查 SHUTDOWN（双保险）。
/// 注：正式包改用 uloop 的 signalfd 集成（uloop_signal），此处保持 FFI 最小面。
extern "C" fn on_signal(_sig: c_int) {
    SHUTDOWN.store(true, Ordering::SeqCst);
    unsafe {
        ubus::uloop_cancelled = true;
    }
}

pub fn shutting_down() -> bool {
    SHUTDOWN.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// C 字符串 / blob reply 辅助
// ---------------------------------------------------------------------------

const fn cs(s: &'static [u8]) -> *const c_char {
    // 调用方必须传入含 \0 的字面量（如 b"ping\0"）
    s.as_ptr().cast()
}

fn lock_snap() -> std::sync::MutexGuard<'static, Snapshot> {
    SNAP.lock().expect("SNAP lock")
}

// ---------------------------------------------------------------------------
// ubus methods（静态方法表，生命周期 = 进程）
// ---------------------------------------------------------------------------

static METHODS: [ubus::ubus_method; 2] = [
    ubus::ubus_method {
        name: cs(b"ping\0"),
        handler: Some(handle_ping),
        mask: 0,
        tags: 0,
        policy: std::ptr::null(),
        n_policy: 0,
    },
    ubus::ubus_method {
        name: cs(b"stats\0"),
        handler: Some(handle_stats),
        mask: 0,
        tags: 0,
        policy: std::ptr::null(),
        n_policy: 0,
    },
];

/// `ubus call zen.traffic ping` → `{"status":"pong","daemon":...,"pid":N}`
unsafe extern "C" fn handle_ping(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let mut b = ubus::blob_buf::new_zeroed();
    ubus::blob_buf_init(&mut b, 0);
    ubus::blobmsg_add_string(&mut b, cs(b"status\0"), cs(b"pong\0"));
    ubus::blobmsg_add_string(&mut b, cs(b"daemon\0"), cs(b"zen-trafficd-spike\0"));
    ubus::blobmsg_add_u32(&mut b, cs(b"pid\0"), std::process::id());
    ubus::ubus_send_reply(ctx, req, b.head);
    ubus::blob_buf_free(&mut b);
    ubus::UBUS_STATUS_OK
}

/// `ubus call zen.traffic stats` → 最近一次 tick 的结构化快照
unsafe extern "C" fn handle_stats(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let s = lock_snap();
    let mut b = ubus::blob_buf::new_zeroed();
    ubus::blob_buf_init(&mut b, 0);
    ubus::blobmsg_add_string(&mut b, cs(b"daemon\0"), cs(b"zen-trafficd-spike\0"));
    ubus::blobmsg_add_u64(&mut b, cs(b"devices\0"), s.devices);
    ubus::blobmsg_add_u64(&mut b, cs(b"wan_rx_rate\0"), s.wan_rx_rate);
    ubus::blobmsg_add_u64(&mut b, cs(b"wan_tx_rate\0"), s.wan_tx_rate);
    ubus::blobmsg_add_u64(&mut b, cs(b"wan_rx_bytes\0"), s.wan_rx_b);
    ubus::blobmsg_add_u64(&mut b, cs(b"wan_tx_bytes\0"), s.wan_tx_b);
    ubus::blobmsg_add_u64(&mut b, cs(b"lan_rx_bytes\0"), s.lan_rx_b);
    ubus::blobmsg_add_u64(&mut b, cs(b"lan_tx_bytes\0"), s.lan_tx_b);
    ubus::blobmsg_add_u64(&mut b, cs(b"ticks\0"), s.ticks);
    drop(s);
    ubus::ubus_send_reply(ctx, req, b.head);
    ubus::blob_buf_free(&mut b);
    ubus::UBUS_STATUS_OK
}

// ---------------------------------------------------------------------------
// 对象注册 + uloop
// ---------------------------------------------------------------------------

static mut OBJ: std::mem::MaybeUninit<ubus::ubus_object> = std::mem::MaybeUninit::uninit();
static mut OBJ_TYPE: std::mem::MaybeUninit<ubus::ubus_object_type> =
    std::mem::MaybeUninit::uninit();
static mut TICK: std::mem::MaybeUninit<ubus::uloop_timeout> = std::mem::MaybeUninit::uninit();

/// uloop_init → ubus_connect → ubus_add_object → ubus_add_uloop → 启动 1s tick。
/// 返回 ctx 供退出时 ubus_free。
pub unsafe fn start() -> Result<*mut ubus::ubus_context, String> {
    if ubus::uloop_init() != 0 {
        return Err("uloop_init 失败".into());
    }

    let ctx = ubus::ubus_connect(std::ptr::null());
    if ctx.is_null() {
        return Err("ubus_connect 失败（rpcd/ubusd 未运行？）".into());
    }

    OBJ_TYPE.write(ubus::ubus_object_type {
        name: cs(b"zen.traffic\0"),
        id: 0,
        methods: METHODS.as_ptr(),
        n_methods: METHODS.len() as c_int,
    });

    OBJ.write(ubus::ubus_object {
        avl: std::mem::zeroed(), // libubus 初始化 avl 节点
        name: cs(b"zen.traffic\0"),
        id: 0,
        path: std::ptr::null(),
        obj_type: OBJ_TYPE.as_mut_ptr(),
        subscribe_cb: None,
        has_subscribers: false,
        methods: METHODS.as_ptr(),
        n_methods: METHODS.len() as c_int,
    });

    let rc = ubus::ubus_add_object(ctx, OBJ.as_mut_ptr());
    if rc != ubus::UBUS_STATUS_OK {
        let err = format!("ubus_add_object 失败 rc={rc}");
        ubus::ubus_free(ctx);
        return Err(err);
    }

    ubus::ubus_add_uloop(ctx); // 等价头文件 inline：uloop_fd_add(&ctx->sock, BLOCKING|READ)

    TICK.write(ubus::uloop_timeout {
        list: std::mem::zeroed(),
        pending: false,
        cb: Some(tick_cb),
        time: std::mem::zeroed(),
    });
    ubus::uloop_timeout_set(TICK.as_mut_ptr(), TICK_MS);

    Ok(ctx)
}

/// 1s tick：差分速率（对齐 C PoC 的输出格式）+ 更新 stats 快照 + 重臂。
unsafe extern "C" fn tick_cb(t: *mut ubus::uloop_timeout) {
    let ticks = TICKS.fetch_add(1, Ordering::SeqCst) + 1;
    if SHUTDOWN.load(Ordering::SeqCst) {
        ubus::uloop_cancelled = true;
        return;
    }

    let mut guard = match BPF.try_lock() {
        Ok(g) => g,
        Err(_) => {
            ubus::uloop_timeout_set(t, TICK_MS);
            return;
        }
    };

    if let Some(bpf) = guard.as_mut() {
        match bpf::read_devices(bpf) {
            Ok(tot) => {
                let dt = TICK_MS as u64 / 1000;
                let prev = *SNAP.lock().expect("SNAP lock");
                let rate = |cur: u64, old: u64| -> u64 {
                    if prev.ticks > 0 && cur >= old {
                        (cur - old) / dt.max(1)
                    } else {
                        0
                    }
                };
                let rx_rate = rate(tot.wan_rx_b, prev.wan_rx_b);
                let tx_rate = rate(tot.wan_tx_b, prev.wan_tx_b);

                *lock_snap() = Snapshot {
                    devices: tot.devices,
                    wan_rx_b: tot.wan_rx_b,
                    wan_tx_b: tot.wan_tx_b,
                    lan_rx_b: tot.lan_rx_b,
                    lan_tx_b: tot.lan_tx_b,
                    wan_rx_rate: rx_rate,
                    wan_tx_rate: tx_rate,
                    ticks,
                };

                print!(
                    "[tick {ticks}] devices={} WAN↓ {}/s WAN↑ {}/s",
                    tot.devices,
                    fmt_rate(rx_rate),
                    fmt_rate(tx_rate)
                );
                if let Some((mac, s)) = tot.sample.first() {
                    print!(
                        " | {mac} wan_rx={}B wan_tx={}B lan_rx={}B lan_tx={}B",
                        s.wan_rx_b, s.wan_tx_b, s.lan_rx_b, s.lan_tx_b
                    );
                }
                println!();
            }
            Err(e) => eprintln!("[spike] tick: {e}"),
        }
    }

    ubus::uloop_timeout_set(t, TICK_MS);
}

fn fmt_rate(bps: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bps >= GB {
        format!("{:.1} GB", bps as f64 / GB as f64)
    } else if bps >= MB {
        format!("{:.1} MB", bps as f64 / MB as f64)
    } else if bps >= KB {
        format!("{:.1} KB", bps as f64 / KB as f64)
    } else {
        format!("{bps} B")
    }
}
