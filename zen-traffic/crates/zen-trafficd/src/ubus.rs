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

static METHODS: [ubus::ubus_method; 14] = [
    m(b"getStatus\0", handle_get_status),
    m(b"getDevices\0", handle_get_devices),
    m(b"getTotal\0", handle_get_total),
    m(b"getWanUsage\0", handle_get_wan_usage),
    m(b"getInternetHistory\0", handle_get_internet_history),
    m(b"getDeviceTimeline\0", handle_get_device_timeline),
    m(b"getNotifications\0", handle_get_notifications),
    m(b"setNotifications\0", handle_set_notifications),
    m(b"testNotification\0", handle_test_notification),
    m(b"getHistory\0", handle_get_history),
    m(b"getRealtimeHistory\0", handle_get_realtime_history),
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

unsafe fn send_json(ctx: *mut ubus::ubus_context, req: *mut ubus::ubus_request_data, value: serde_json::Value) -> c_int {
    let mut b = reply(ctx, req);
    add_str(&mut b, b"json\0", &value.to_string());
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

unsafe extern "C" fn handle_get_internet_history(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let (mut agg, mut mac) = ("day".to_owned(), String::new());
    for a in ubus::parse_msg(msg) {
        match a.name {
            Some("agg") => match a.as_str() { Some("day" | "month") => agg = a.as_str().unwrap().into(), _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT },
            Some("mac") => match a.as_str() { Some(s) if s.is_empty() || parse_mac(s).is_some() => mac = s.to_ascii_lowercase(), _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT },
            _ => {}
        }
    }
    match with_daemon(|d| d.wan.history(&agg, &mac)) {
        Some(v) => send_json(ctx, req, v), None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_get_device_timeline(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let (mut mac, mut date, mut hour) = (String::new(), String::new(), None);
    for a in ubus::parse_msg(msg) {
        match a.name {
            Some("mac") => match a.as_str() {
                Some(s) if parse_mac(s).is_some() => mac = s.to_ascii_lowercase(),
                _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT,
            },
            Some("date") => match a.as_str() {
                Some(s) if crate::timeline::day_bounds(s).is_ok() => date = s.to_owned(),
                _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT,
            },
            Some("hour") => match a.as_str() {
                Some("") => hour = None,
                Some(s) => match s.parse::<u64>() {
                    Ok(time) if time <= i64::MAX as u64 => hour = Some(time),
                    _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT,
                },
                _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT,
            },
            _ => {}
        }
    }
    if mac.is_empty() || date.is_empty() { return ubus::UBUS_STATUS_INVALID_ARGUMENT; }
    match with_daemon(|d| d.timeline.query(&d.db, &mac, &date, hour, now_epoch())) {
        Some(Ok(value)) => send_json(ctx, req, value),
        Some(Err(_)) => ubus::UBUS_STATUS_INVALID_ARGUMENT,
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_get_notifications(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, _msg: *mut ubus::blob_attr) -> c_int {
    match with_daemon(|d| d.notifications.public(&d.wan)) {
        Some(v) => send_json(ctx, req, v), None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_set_notifications(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let input = ubus::parse_msg(msg).into_iter().find(|a| a.name == Some("json")).and_then(|a| a.as_str().map(str::to_owned));
    let Some(input) = input else { return ubus::UBUS_STATUS_INVALID_ARGUMENT; };
    match with_daemon(|d| d.notifications.configure(&d.db, &input)) {
        Some(Ok(())) => send_json(ctx, req, serde_json::json!({"ok":true})),
        // Errors are fixed strings; never return request text, URLs or secrets.
        Some(Err(e)) => send_json(ctx, req, serde_json::json!({"ok":false,"error":e})),
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_test_notification(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let channel = ubus::parse_msg(msg).into_iter().find(|a| a.name == Some("channel")).and_then(|a| a.as_str().map(str::to_owned));
    let Some(channel) = channel else { return ubus::UBUS_STATUS_INVALID_ARGUMENT; };
    match with_daemon(|d| d.notifications.test(&d.db, &channel, now_epoch(), crate::state::now_mono_ms())) {
        Some(Ok(())) => send_json(ctx, req, serde_json::json!({"ok":true})),
        Some(Err(e)) => send_json(ctx, req, serde_json::json!({"ok":false,"error":e})),
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

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
    ubus::blobmsg_add_u64(&mut b, cs(b"since\0"), now_epoch());
    blobmsg_add_bool(&mut b, cs(b"device_wan_rates\0"), true);
    blobmsg_add_bool(&mut b, cs(b"wan_daily\0"), true);
    blobmsg_add_bool(&mut b, cs(b"device_timeline\0"), true);
    add_str(&mut b, b"timeline_today\0", &local_date(now_epoch()));
    blobmsg_add_bool(&mut b, cs(b"notifications\0"), true);
    ubus::blobmsg_add_string(
        &mut b,
        cs(b"version\0"),
        concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr() as *const c_char,
    );
    with_daemon(|d| {
        ubus::blobmsg_add_string(&mut b, cs(b"offload\0"), d.offload.mode().as_ptr());
        blobmsg_add_bool(&mut b, cs(b"hardware_offload_requested\0"), d.offload.hardware_requested);
        blobmsg_add_bool(&mut b, cs(b"hardware_offload_active\0"), d.offload.hardware_active);
        let interfaces = d.ifaces_meta.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(",");
        ubus::blobmsg_add_string(&mut b, cs(b"capture_interfaces\0"), cstr_of(&interfaces).as_ptr());
        ubus::blobmsg_add_u32(&mut b, cs(b"interval_ms\0"), d.cfg.interval_ms as u32);
        ubus::blobmsg_add_u32(&mut b, cs(b"devices\0"), d.devs.len() as u32);
    });
    blobmsg_add_bool(&mut b, cs(b"synced\0"), crate::state::time_synced(now_epoch()));
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
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
                let mac = mac_str(&s.mac.b);
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
                ubus::blobmsg_add_u64(&mut b, cs(b"wan_rx_r\0"), s.wan_rx_r);
                ubus::blobmsg_add_u64(&mut b, cs(b"wan_tx_r\0"), s.wan_tx_r);
                ubus::blobmsg_add_u64(&mut b, cs(b"lan_rx_r\0"), s.lan_rx_r);
                ubus::blobmsg_add_u64(&mut b, cs(b"lan_tx_r\0"), s.lan_tx_r);
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

/// Internet-only usage since the persisted collection window began.
unsafe extern "C" fn handle_get_wan_usage(
    ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, _msg: *mut ubus::blob_attr,
) -> c_int {
    let mut b = reply(ctx, req);
    with_daemon(|d| {
        let attributed = d.wan.attributed();
        let interface = d.wan.interface;
        for (name, value) in [
            (b"since\0".as_slice(), d.wan.since),
            (b"interface_download\0", interface.download),
            (b"interface_upload\0", interface.upload),
            (b"attributed_download\0", attributed.download),
            (b"attributed_upload\0", attributed.upload),
            (b"unassigned_download\0", interface.download.saturating_sub(attributed.download)),
            (b"unassigned_upload\0", interface.upload.saturating_sub(attributed.upload)),
            (b"excess_download\0", attributed.download.saturating_sub(interface.download)),
            (b"excess_upload\0", attributed.upload.saturating_sub(interface.upload)),
        ] { ubus::blobmsg_add_u64(&mut b, cs(name), value); }
        let arr = ubus::blobmsg_open_array(&mut b, cs(b"dev\0"));
        let mut rows: Vec<_> = d.wan.devices.iter().collect();
        rows.sort_by_key(|(mac, _)| mac.b);
        for (mac, bytes) in rows {
            if bytes.download == 0 && bytes.upload == 0 { continue; }
            let row = ubus::blobmsg_open_table(&mut b, std::ptr::null());
            add_str(&mut b, b"mac\0", &mac_str(&mac.b));
            if let Some(device) = d.devs.get(mac) { add_opt_str(&mut b, b"host\0", &device.host); }
            ubus::blobmsg_add_u64(&mut b, cs(b"download\0"), bytes.download);
            ubus::blobmsg_add_u64(&mut b, cs(b"upload\0"), bytes.upload);
            ubus::blobmsg_close_table(&mut b, row);
        }
        ubus::blobmsg_close_array(&mut b, arr);
    });
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

    // 实时速率：netlink 上游接口差分；用量：与设备 API 相同的 RAM 当前值。
    // SQLite 仍批量落盘，读取汇总不应额外等待 checkpoint 或触发写入。
    let stats = with_daemon(|d| {
        let [rt, tt, rm, tm, lr, lt] = crate::state::usage_totals(d.devs.values());
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
            Some("mac") => mac = a.as_str().filter(|s| !s.is_empty()).map(|s| s.to_string()),
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
                { if agg == "month" { &b"month\0"[..] } else { &b"day\0"[..] } }.as_ptr() as *const c_char,
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

/// getRealtimeHistory {iface?, start?, end?, limit?}; timestamps are Unix seconds.
unsafe extern "C" fn handle_get_realtime_history(
    ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr,
) -> c_int {
    let now = now_epoch();
    let (mut start, mut end, mut limit) = (now.saturating_sub(300), now, 600usize);
    let mut interface = None;
    for a in ubus::parse_msg(msg) {
        let number = a.as_u64().or_else(|| a.as_u32().map(u64::from));
        match a.name {
            Some("iface") => interface = a.as_str().map(str::to_string),
            Some("start") => match number { Some(n) => start = n, None => return ubus::UBUS_STATUS_INVALID_ARGUMENT },
            Some("end") => match number { Some(n) => end = n, None => return ubus::UBUS_STATUS_INVALID_ARGUMENT },
            Some("limit") => match number { Some(n) if n <= 1200 => limit = n as usize, _ => return ubus::UBUS_STATUS_INVALID_ARGUMENT },
            _ => {}
        }
    }
    let result = with_daemon(|d| d.realtime.query(&d.db, interface.as_deref(), start, end, limit, now));
    let query = match result {
        Some(Ok(query)) => query,
        Some(Err(e)) => {
            eprintln!("[zen-trafficd] getRealtimeHistory: {e}");
            return ubus::UBUS_STATUS_INVALID_ARGUMENT;
        }
        None => return ubus::UBUS_STATUS_NOT_SUPPORTED,
    };
    let mut b = reply(ctx, req);
    add_str(&mut b, b"interface\0", &query.interface);
    ubus::blobmsg_add_u64(&mut b, cs(b"start\0"), query.start);
    ubus::blobmsg_add_u64(&mut b, cs(b"end\0"), query.end);
    ubus::blobmsg_add_u32(&mut b, cs(b"step\0"), query.step as u32);
    ubus::blobmsg_add_u32(&mut b, cs(b"retention_days\0"), 7);
    ubus::blobmsg_add_u32(&mut b, cs(b"sample_seconds\0"), 5);
    let interfaces = ubus::blobmsg_open_array(&mut b, cs(b"interfaces\0"));
    for name in &query.interfaces { add_str(&mut b, b"\0", name); }
    ubus::blobmsg_close_array(&mut b, interfaces);
    let rows = ubus::blobmsg_open_array(&mut b, cs(b"samples\0"));
    for sample in query.samples {
        let row = ubus::blobmsg_open_table(&mut b, std::ptr::null());
        ubus::blobmsg_add_u64(&mut b, cs(b"time\0"), sample.time);
        ubus::blobmsg_add_u64(&mut b, cs(b"download\0"), sample.download);
        ubus::blobmsg_add_u64(&mut b, cs(b"upload\0"), sample.upload);
        ubus::blobmsg_close_table(&mut b, row);
    }
    ubus::blobmsg_close_array(&mut b, rows);
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
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

    match with_daemon(|d| -> Result<(), String> {
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

    match with_daemon(|d| -> Result<(), String> {
        d.db.reset_device(&mac_l)?;
        d.pending_periods.remove_device(&mac_l);
        d.timeline.remove_device(&mac_l);
        d.wan.remove_device(m);
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
fn zen_bpf_zero_device(bpf: &mut aya::Ebpf, mac: &zen_bpf::MacKey) {
    use zen_bpf::DevStats;
    let Some(map) = bpf.map_mut("devices") else { return };
    if let Ok(mut devs) = aya::maps::HashMap::<_, zen_bpf::MacKey, DevStats>::try_from(map) {
        let _ = devs.insert(mac, DevStats::default(), 0);
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
    let n = match with_daemon(|d| unsafe {
        let n = crate::netif::refresh(d)?;
        crate::totals::detect_upstream(d);
        d.last_attr_mono = 0;
        Ok::<usize, String>(n)
    }) {
        Some(Ok(n)) => n,
        Some(Err(e)) => {
            eprintln!("[zen-trafficd] reloadPrefixes: {e}");
            return ubus::UBUS_STATUS_UNKNOWN_ERROR;
        }
        None => return ubus::UBUS_STATUS_NOT_SUPPORTED,
    };
    let mut b = reply(ctx, req);
    blobmsg_add_bool(&mut b, cs(b"ok\0"), true);
    ubus::blobmsg_add_u32(&mut b, cs(b"prefixes\0"), n as u32);
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

// ---------------------------------------------------------------------------
// reply 字段辅助
// ---------------------------------------------------------------------------

unsafe fn add_str(b: &mut ubus::blob_buf, name: &[u8], val: &str) {
    let cname = CString_of(val);
    ubus::blobmsg_add_string(b, name.as_ptr().cast(), cname.as_ptr());
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

    let obj_type = std::ptr::addr_of_mut!(OBJ_TYPE).cast::<ubus::ubus_object_type>();
    obj_type.write(ubus::ubus_object_type {
        name: cs(b"zen.traffic\0"),
        id: 0,
        methods: METHODS.as_ptr(),
        n_methods: METHODS.len() as c_int,
    });

    let obj = std::ptr::addr_of_mut!(OBJ).cast::<ubus::ubus_object>();
    obj.write(ubus::ubus_object {
        avl: std::mem::zeroed(),
        name: cs(b"zen.traffic\0"),
        id: 0,
        path: std::ptr::null(),
        obj_type,
        subscribe_cb: None,
        has_subscribers: false,
        methods: METHODS.as_ptr(),
        n_methods: METHODS.len() as c_int,
    });

    let rc = ubus::ubus_add_object(ctx, obj);
    if rc != ubus::UBUS_STATUS_OK {
        let err = format!("ubus_add_object 失败 rc={rc}");
        ubus::ubus_free(ctx);
        return Err(err);
    }

    ubus::ubus_add_uloop(ctx);

    let tick = std::ptr::addr_of_mut!(TICK).cast::<ubus::uloop_timeout>();
    tick.write(ubus::uloop_timeout {
        list: std::mem::zeroed(),
        pending: false,
        cb: Some(tick_cb),
        time: std::mem::zeroed(),
    });
    ubus::uloop_timeout_set(tick, TICK_MS);

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
    let tick = std::ptr::addr_of_mut!(TICK).cast::<ubus::uloop_timeout>();
    tick.write(ubus::uloop_timeout {
        list: std::mem::zeroed(),
        pending: false,
        cb: Some(tick_cb),
        time: std::mem::zeroed(),
    });
    ubus::uloop_timeout_set(tick, TICK_MS);
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
