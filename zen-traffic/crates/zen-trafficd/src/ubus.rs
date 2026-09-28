//! ubus.rs — 直接发布 ubus 对象 `zen.traffic`（ARCHITECTURE §6 契约）。
//!
//! 无 HTTP、无 TCP 端口、无 shell rpcd 桥（红线）。经 rpcd/uhttpd 通道给 LuCI，
//! 复用 LuCI session 与 ACL（ACL 由 zen-traffic 包 / luci-app 提供）。
//!
//! 方法：getStatus / getDevices / getTotal / getHistory / setHostname /
//!       resetDevice / reloadPrefixes。方向约定 rx=下载、tx=上传。

use std::os::raw::{c_char, c_int};
use std::sync::Mutex;

use zen_ubus_sys as ubus;

use crate::daemon::{parse_mac, Daemon};
use crate::persistence::mac_str;
use crate::state::{local_date, local_month, month_shift, now_epoch};

pub const OBJ_NAME: &str = "zen.traffic";
pub const TICK_MS: c_int = 1000;

pub static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 全局唯一 daemon 实例（uloop 单线程回调模型）
pub static DAEMON: Mutex<Option<Daemon>> = Mutex::new(None);

pub fn with_daemon<R>(f: impl FnOnce(&mut Daemon) -> R) -> Option<R> {
    let mut guard = DAEMON.lock().expect("DAEMON lock");
    guard.as_mut().map(f)
}

// ---------------------------------------------------------------------------
// C 字符串辅助（调用方必须传入含 \0 的字面量）
// ---------------------------------------------------------------------------

const fn cs(s: &'static [u8]) -> *const c_char {
    s.as_ptr().cast()
}

// ---------------------------------------------------------------------------
// ubus 方法表
// ---------------------------------------------------------------------------

static METHODS: [ubus::ubus_method; 7] = [
    m(b"getStatus\0", handle_get_status),
    m(b"getDevices\0", handle_get_devices),
    m(b"getTotal\0", handle_get_total),
    m(b"getHistory\0", handle_get_history),
    m(b"setHostname\0", handle_set_hostname),
    m(b"resetDevice\0", handle_reset_device),
    m(b"reloadPrefixes\0", handle_reload_prefixes),
];

const fn m(
    name: &'static [u8],
    handler: unsafe extern "C" fn(
        *mut ubus::ubus_context,
        *mut ubus::ubus_object,
        *mut ubus::ubus_request_data,
        *const c_char,
        *mut ubus::blob_attr,
    ) -> c_int,
) -> ubus::ubus_method {
    ubus::ubus_method {
        name: cs(name),
        handler: Some(handler),
        mask: 0,
        tags: 0,
        policy: std::ptr::null(),
        n_policy: 0,
    }
}

// ---------------------------------------------------------------------------
// reply 辅助
// ---------------------------------------------------------------------------

unsafe fn reply(ctx: *mut ubus::ubus_context, req: *mut ubus::ubus_request_data) -> ubus::blob_buf {
    let _ = (ctx, req);
    let mut b = ubus::blob_buf::new_zeroed();
    ubus::blob_buf_init(&mut b, 0);
    b
}

unsafe fn send(ctx: *mut ubus::ubus_context, req: *mut ubus::ubus_request_data, b: &mut ubus::blob_buf) {
    ubus::ubus_send_reply(ctx, req, b.head);
    ubus::blob_buf_free(b);
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

/// getStatus → { backend, offload, since, version, interval_ms, devices, synced }
unsafe extern "C" fn handle_get_status(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let mut b = reply(ctx, req);
    ubus::blobmsg_add_string(&mut b, cs(b"backend\0"), c"ebpf".as_ptr().cast());
    ubus::blobmsg_add_string(
        &mut b,
        cs(b"offload\0"),
        offload_cstr().as_ptr().cast(),
    );
    ubus::blobmsg_add_u64(&mut b, cs(b"since\0"), now_epoch());
    ubus::blobmsg_add_string(
        &mut b,
        cs(b"version\0"),
        concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char,
    );
    with_daemon(|d| {
        ubus::blobmsg_add_u32(&mut b, cs(b"interval_ms\0"), d.cfg.interval_ms as u32);
        ubus::blobmsg_add_u32(&mut b, cs(b"devices\0"), d.devs.len() as u32);
    });
    blobmsg_add_bool(&mut b, cs(b"synced\0"), crate::state::time_synced(now_epoch()));
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

/// 软分载探测（尽力而为）：/proc/net/nf_flowtable 存在 → "sw"，否则 "off"。
/// 硬件分载不可软件探测（UI 明示口径，ARCHITECTURE §10）。
fn offload_status() -> &'static str {
    if std::path::Path::new("/proc/net/nf_flowtable").exists() {
        "sw"
    } else {
        "off"
    }
}

fn offload_cstr() -> &'static std::ffi::CStr {
    if offload_status() == "sw" {
        c"sw"
    } else {
        c"off"
    }
}

/// getDevices → { t, dev: [ {mac, ip4, ip6, host, conn, band, online, last,
///   rx_r, tx_r, rx_today, tx_today, rx_month, tx_month, rx_total, tx_total} ] }
unsafe extern "C" fn handle_get_devices(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let mut b = reply(ctx, req);
    ubus::blobmsg_add_u64(&mut b, cs(b"t\0"), crate::state::now_epoch_ms());

    {
        let mut guard = DAEMON.lock().expect("DAEMON lock");
        if let Some(d) = guard.as_mut() {
            let arr = ubus::blobmsg_open_array(&mut b, cs(b"dev\0"));
            // 按 last_active 降序输出；Top-N 排序/展开由前端完成
            let mut list: Vec<&crate::state::DevState> = d.devs.values().collect();
            list.sort_by(|a, z| z.last_active.cmp(&a.last_active));
            for s in list {
                // 休眠设备（>7 天）不输出（DB 保留，属性/累计不丢）
                if s.is_dormant(now_epoch(), crate::state::DORMANT_DAYS) {
                    continue;
                }
                let mac = mac_str(&s.mac);
                let t = ubus::blobmsg_open_table(&mut b, std::ptr::null());
                add_str(&mut b, b"mac\0", &mac);
                add_opt_str(&mut b, b"ip4\0", &s.ip4);
                add_opt_str(&mut b, b"ip6\0", &s.ip6);
                add_opt_str(&mut b, b"host\0", &s.host);
                add_str(&mut b, b"conn\0", &s.conn.as_str().to_string());
                add_opt_str(&mut b, b"band\0", &s.band);
                blobmsg_add_bool(&mut b, cs(b"online\0"), s.online);
                ubus::blobmsg_add_u64(&mut b, cs(b"last\0"), s.last_active);
                ubus::blobmsg_add_u64(&mut b, cs(b"rx_r\0"), s.rx_r());
                ubus::blobmsg_add_u64(&mut b, cs(b"tx_r\0"), s.tx_r());
                ubus::blobmsg_add_u64(&mut b, cs(b"rx_today\0"), s.rx_today);
                ubus::blobmsg_add_u64(&mut b, cs(b"tx_today\0"), s.tx_today);
                ubus::blobmsg_add_u64(&mut b, cs(b"rx_month\0"), s.rx_month);
                ubus::blobmsg_add_u64(&mut b, cs(b"tx_month\0"), s.tx_month);
                ubus::blobmsg_add_u64(&mut b, cs(b"rx_total\0"), s.rx_total);
                ubus::blobmsg_add_u64(&mut b, cs(b"tx_total\0"), s.tx_total);
                ubus::blobmsg_close_table(&mut b, t);
            }
            ubus::blobmsg_close_array(&mut b, arr);
        }
    }
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

/// getTotal → { rx_r, tx_r, rx_today, tx_today, rx_month, tx_month, rx_total, tx_total }
unsafe extern "C" fn handle_get_total(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let mut b = reply(ctx, req);

    // 实时速率：netlink 上游接口差分；today/month：DB SUM（口径与设备归因一致）；
    // lifetime：devices 表 SUM
    let stats = with_daemon(|d| {
        let (rt, tt) = sum_day(d, &d.cur_day);
        let (rm, tm) = sum_month(d, &d.cur_month);
        let (lr, lt) = d.db.lifetime_totals();
        (d.rx_r, d.tx_r, rt, tt, rm, tm, lr, lt)
    })
    .unwrap_or((0, 0, 0, 0, 0, 0, 0, 0));
    let (rx_r, tx_r, rx_today, tx_today, rx_month, tx_month, rx_total, tx_total) = stats;

    ubus::blobmsg_add_u64(&mut b, cs(b"rx_r\0"), rx_r);
    ubus::blobmsg_add_u64(&mut b, cs(b"tx_r\0"), tx_r);
    ubus::blobmsg_add_u64(&mut b, cs(b"rx_today\0"), rx_today);
    ubus::blobmsg_add_u64(&mut b, cs(b"tx_today\0"), tx_today);
    ubus::blobmsg_add_u64(&mut b, cs(b"rx_month\0"), rx_month);
    ubus::blobmsg_add_u64(&mut b, cs(b"tx_month\0"), tx_month);
    ubus::blobmsg_add_u64(&mut b, cs(b"rx_total\0"), rx_total);
    ubus::blobmsg_add_u64(&mut b, cs(b"tx_total\0"), tx_total);
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

fn sum_day(d: &Daemon, date: &str) -> (u64, u64) {
    d.db
        .history_days(None, date, date)
        .map(|rows| {
            rows.iter()
                .fold((0u64, 0u64), |(a, b), (_, dl, ul)| {
                    (a + dl.max(0) as u64, b + ul.max(0) as u64)
                })
        })
        .unwrap_or((0, 0))
}

fn sum_month(d: &Daemon, month: &str) -> (u64, u64) {
    d.db
        .history_months(None, month, month)
        .map(|rows| {
            rows.iter()
                .fold((0u64, 0u64), |(a, b), (_, dl, ul)| {
                    (a + dl.max(0) as u64, b + ul.max(0) as u64)
                })
        })
        .unwrap_or((0, 0))
}

/// getHistory {mac?, agg?("day"|"month"), start_ms?, end_ms?}
/// → { agg, days: [{date, download, upload}] } / { agg, months: [{month, download, upload}] }
unsafe extern "C" fn handle_get_history(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    msg: *mut ubus::blob_attr,
) -> c_int {
    let mut agg = String::from("day");
    let mut mac: Option<String> = None;
    let mut start_ms: Option<u64> = None;
    let mut end_ms: Option<u64> = None;

    for a in ubus::parse_msg(msg) {
        match a.name {
            Some("agg") => {
                if let Some(s) = a.as_str() {
                    agg = s.to_string();
                }
            }
            Some("mac") => mac = a.as_str().map(|s| s.to_string()),
            Some("start_ms") => start_ms = a.as_u64(),
            Some("end_ms") => end_ms = a.as_u64(),
            _ => {}
        }
    }

    let now = now_epoch();
    let result: Result<(String, Vec<(String, i64, i64)>), String> = with_daemon(|d| {
        if agg == "month" {
            let end = end_ms
                .map(|ms| local_month(ms / 1000))
                .unwrap_or_else(|| local_month(now));
            let start = start_ms
                .map(|ms| local_month(ms / 1000))
                .unwrap_or_else(|| month_shift(&end, 11));
            let rows = if let Some(m) = &mac {
                d.db.history_months(Some(m.as_str()), &start, &end)?
            } else {
                d.db.history_months(None, &start, &end)?
            };
            Ok((start, rows))
        } else {
            let end = end_ms
                .map(|ms| local_date(ms / 1000))
                .unwrap_or_else(|| local_date(now));
            let start = start_ms
                .map(|ms| local_date(ms / 1000))
                .unwrap_or_else(|| month_shift_date(&end, 89));
            let rows = if let Some(m) = &mac {
                d.db.history_days(Some(m.as_str()), &start, &end)?
            } else {
                d.db.history_days(None, &start, &end)?
            };
            Ok((start, rows))
        }
    })
    .unwrap_or(Ok((String::new(), Vec::new())));

    match result {
        Ok((start, rows)) => {
            let mut b = reply(ctx, req);
            ubus::blobmsg_add_string(
                &mut b,
                cs(b"agg\0"),
                if agg == "month" { b"month\0" } else { b"day\0" }.as_ptr() as *const c_char,
            );
            ubus::blobmsg_add_string(
                &mut b,
                cs(b"start\0"),
                cstr_of(&start).as_ptr(),
            );
            let arr = ubus::blobmsg_open_array(
                &mut b,
                if agg == "month" { cs(b"months\0") } else { cs(b"days\0") },
            );
            for (k, dl, ul) in rows {
                let t = ubus::blobmsg_open_table(&mut b, std::ptr::null());
                add_str(
                    &mut b,
                    if agg == "month" { b"month\0" } else { b"date\0" },
                    &k,
                );
                ubus::blobmsg_add_u64(&mut b, cs(b"download\0"), dl.max(0) as u64);
                ubus::blobmsg_add_u64(&mut b, cs(b"upload\0"), ul.max(0) as u64);
                ubus::blobmsg_close_table(&mut b, t);
            }
            ubus::blobmsg_close_array(&mut b, arr);
            send(ctx, req, &mut b);
            ubus::UBUS_STATUS_OK
        }
        Err(e) => {
            eprintln!("[zen-trafficd] getHistory: {e}");
            ubus::UBUS_STATUS_INVALID_ARGUMENT
        }
    }
}

fn month_shift_date(date: &str, minus_days: u32) -> String {
    crate::state::date_shift(date, minus_days)
}

/// setHostname {mac, host} → { ok }
unsafe extern "C" fn handle_set_hostname(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    msg: *mut ubus::blob_attr,
) -> c_int {
    let (mac, host) = {
        let mut mac: Option<String> = None;
        let mut host: Option<String> = None;
        for a in ubus::parse_msg(msg) {
            match a.name {
                Some("mac") => mac = a.as_str().map(|s| s.to_string()),
                Some("host") => host = a.as_str().map(|s| s.to_string()),
                _ => {}
            }
        }
        (mac, host)
    };
    let (Some(mac), Some(host)) = (mac, host) else {
        return ubus::UBUS_STATUS_INVALID_ARGUMENT;
    };
    let mac_l = mac.to_ascii_lowercase();
    if parse_mac(&mac_l).is_none() || host.is_empty() || host.len() > 64 {
        return ubus::UBUS_STATUS_INVALID_ARGUMENT;
    }

    match with_daemon(|d| {
        d.db.set_hostname(&mac_l, &host)?;
        if let Some(m) = parse_mac(&mac_l) {
            if let Some(s) = d.devs.get_mut(&m) {
                s.host = Some(host.clone());
                s.host_src = crate::state::HostSrc::User;
            }
        }
        Ok(())
    }) {
        Some(Ok(())) => {
            let mut b = reply(ctx, req);
            blobmsg_add_bool(&mut b, cs(b"ok\0"), true);
            send(ctx, req, &mut b);
            ubus::UBUS_STATUS_OK
        }
        Some(Err(e)) => {
            eprintln!("[zen-trafficd] setHostname: {e}");
            ubus::UBUS_STATUS_UNKNOWN_ERROR
        }
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

/// resetDevice {mac} → { ok }
unsafe extern "C" fn handle_reset_device(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    msg: *mut ubus::blob_attr,
) -> c_int {
    let mac = {
        let mut mac: Option<String> = None;
        for a in ubus::parse_msg(msg) {
            if a.name == Some("mac") {
                mac = a.as_str().map(|s| s.to_string());
            }
        }
        mac
    };
    let Some(mac) = mac else {
        return ubus::UBUS_STATUS_INVALID_ARGUMENT;
    };
    let mac_l = mac.to_ascii_lowercase();
    let Some(m) = parse_mac(&mac_l) else {
        return ubus::UBUS_STATUS_INVALID_ARGUMENT;
    };

    match with_daemon(|d| {
        d.db.reset_device(&mac_l)?;
        if let Some(s) = d.devs.get_mut(&m) {
            s.rx_today = 0;
            s.tx_today = 0;
            s.rx_month = 0;
            s.tx_month = 0;
            s.rx_total = 0;
            s.tx_total = 0;
        }
        zen_bpf_zero_device(&mut d.bpf, &m);
        Ok(())
    }) {
        Some(Ok(())) => {
            let mut b = reply(ctx, req);
            blobmsg_add_bool(&mut b, cs(b"ok\0"), true);
            send(ctx, req, &mut b);
            ubus::UBUS_STATUS_OK
        }
        Some(Err(e)) => {
            eprintln!("[zen-trafficd] resetDevice: {e}");
            ubus::UBUS_STATUS_UNKNOWN_ERROR
        }
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

/// BPF map 单设备计数清零（aya HashMap 语义：不存在则忽略）
fn zen_bpf_zero_device(bpf: &mut aya::Bpf, mac: &zen_bpf::MacKey) {
    use zen_bpf::DevStats;
    let Some(map) = bpf.map_mut("devices") else { return };
    if let Ok(mut devs) = aya::maps::HashMap::<_, zen_bpf::MacKey, DevStats>::try_from(map) {
        let _ = devs.insert(mac, DevStats::default(), aya::maps::MapFlags::ANY);
    }
}

/// reloadPrefixes → { ok }（netifd hotplug 调用）
unsafe extern "C" fn handle_reload_prefixes(
    ctx: *mut ubus::ubus_context,
    _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data,
    _method: *const c_char,
    _msg: *mut ubus::blob_attr,
) -> c_int {
    let n = with_daemon(|d| unsafe { crate::netif::refresh(d) });
    let mut b = reply(ctx, req);
    blobmsg_add_bool(&mut b, cs(b"ok\0"), true);
    if let Some(n) = n {
        ubus::blobmsg_add_u32(&mut b, cs(b"prefixes\0"), n as u32);
    }
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

// ---------------------------------------------------------------------------
// reply 字段辅助
// ---------------------------------------------------------------------------

unsafe fn add_str(b: &mut ubus::blob_buf, name: &[u8], val: &str) {
    let cname = CString_of(val);
    ubus::blobmsg_add_string(b, cs(name), cname.as_ptr());
}

unsafe fn add_opt_str(b: &mut ubus::blob_buf, name: &[u8], val: &Option<String>) {
    if let Some(v) = val {
        add_str(b, name, v);
    }
}

fn CString_of(s: &str) -> std::ffi::CString {
    std::ffi::CString::new(s).unwrap_or_default()
}

fn cstr_of(s: &str) -> std::ffi::CString {
    CString_of(s)
}

// blobmsg_add_bool（libubox inline：BLOBMSG_TYPE_BOOL = INT8 单字节）
mod blob_bool {
    use zen_ubus_sys as ubus;
    use std::os::raw::c_char;

    /// # Safety
    /// buf 指针必须有效。
    pub unsafe fn add_bool(buf: *mut ubus::blob_buf, name: *const c_char, val: bool) {
        ubus::blobmsg_add_field(
            buf,
            ubus::BLOBMSG_TYPE_INT8,
            name,
            &(val as u8) as *const u8 as *const std::os::raw::c_void,
            1,
        );
    }
}

use blob_bool::add_bool as blobmsg_add_bool;

// ---------------------------------------------------------------------------
// 对象注册 + uloop timer
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
        avl: std::mem::zeroed(),
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

    ubus::ubus_add_uloop(ctx);

    TICK.write(ubus::uloop_timeout {
        list: std::mem::zeroed(),
        pending: false,
        cb: Some(tick_cb),
        time: std::mem::zeroed(),
    });
    ubus::uloop_timeout_set(TICK.as_mut_ptr(), TICK_MS);

    Ok(ctx)
}

/// 1s tick 回调：daemon.tick() + SHUTDOWN 双保险退出
unsafe extern "C" fn tick_cb(t: *mut ubus::uloop_timeout) {
    if SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst) {
        ubus::uloop_cancelled = true;
        return;
    }
    with_daemon(|d| d.tick());
    ubus::uloop_timeout_set(t, TICK_MS);
}

/// ubus 不可用时的降级：仍挂 1s timer 维持采集（uloop_run 不至于空转阻塞）
pub unsafe fn arm_tick_only() {
    if ubus::uloop_init() != 0 {
        return;
    }
    TICK.write(ubus::uloop_timeout {
        list: std::mem::zeroed(),
        pending: false,
        cb: Some(tick_cb),
        time: std::mem::zeroed(),
    });
    ubus::uloop_timeout_set(TICK.as_mut_ptr(), TICK_MS);
}

/// 信号处理（SIGTERM/SIGINT）：置位 + 写 uloop 取消标志（spike Step 5 同款）
pub extern "C" fn on_signal(_sig: c_int) {
    SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    unsafe {
        ubus::uloop_cancelled = true;
    }
}

pub fn shutting_down() -> bool {
    SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst)
}
