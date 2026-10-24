//! ubus.rs — 直接发布 ubus 对象 `zen.capture`（docs/PACKET_CAPTURE.md 契约）。
//!
//! 无 HTTP、无 TCP 端口、无 shell rpcd 桥（红线）。进程与 zen-trafficd 完全独立：
//! 抓包崩溃或耗尽资源不影响流量账本，仅共享 UCI 配置文件。
//!
//! 方法：start / stop / status / delete。语义错误经 `{ok:false,error:"固定错误码"}` 返回，
//! 缺参返回 ubus INVALID_ARGUMENT（与 zen.traffic setDevicePolicy 同约定）。

use std::os::raw::{c_char, c_int};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use serde_json::json;
use zen_ubus_sys as ubus;

use crate::capture::{Manager, Mode, StartRequest};

pub const OBJ_NAME: &str = "zen.capture";
pub const TICK_MS: c_int = 1000;

pub static SHUTDOWN: AtomicBool = AtomicBool::new(false);

/// 全局唯一 Manager 实例（uloop 单线程回调模型）
pub static MANAGER: Mutex<Option<Manager>> = Mutex::new(None);

pub fn with_manager<R>(f: impl FnOnce(&mut Manager) -> R) -> Option<R> {
    let mut guard = MANAGER.lock().expect("MANAGER lock");
    guard.as_mut().map(f)
}

pub fn shutting_down() -> bool {
    SHUTDOWN.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn now_epoch() -> u64 {
    unsafe { libc::time(std::ptr::null_mut()) as u64 }
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

static METHODS: [ubus::ubus_method; 8] = [
    m(b"start\0", handle_start),
    m(b"stop\0", handle_stop),
    m(b"status\0", handle_status),
    m(b"delete\0", handle_delete),
    m(b"getDomains\0", handle_get_domains),
    m(b"getEvents\0", handle_get_events),
    m(b"getCA\0", handle_get_ca),
    m(b"getHar\0", handle_get_har),
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

unsafe fn send_json(ctx: *mut ubus::ubus_context, req: *mut ubus::ubus_request_data, value: serde_json::Value) -> c_int {
    let mut b = reply(ctx, req);
    ubus::blobmsg_add_string(&mut b, cs(b"json\0"), cstr_of(&value.to_string()).as_ptr());
    send(ctx, req, &mut b);
    ubus::UBUS_STATUS_OK
}

fn cstr_of(s: &str) -> std::ffi::CString {
    std::ffi::CString::new(s).unwrap_or_default()
}

fn param_str(msg: *mut ubus::blob_attr, name: &str) -> Option<String> {
    unsafe { ubus::parse_msg(msg).into_iter() }
        .find(|a| a.name == Some(name))
        .and_then(|a| a.as_str().map(str::to_owned))
}

fn param_u64(msg: *mut ubus::blob_attr, name: &str) -> Option<u64> {
    unsafe { ubus::parse_msg(msg).into_iter() }
        .find(|a| a.name == Some(name))
        .and_then(|a| a.as_u64())
}

fn param_bool(msg: *mut ubus::blob_attr, name: &str) -> Option<bool> {
    unsafe { ubus::parse_msg(msg).into_iter() }
        .find(|a| a.name == Some(name))
        .and_then(|a| a.as_bool())
}

fn session_value(session: &crate::capture::Session) -> serde_json::Value {
    serde_json::to_value(session).unwrap_or(serde_json::Value::Null)
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

unsafe extern "C" fn handle_start(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(mac) = param_str(msg, "mac") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    let mode = param_str(msg, "mode").and_then(|mode| match mode.as_str() {
        "tap" => Some(Mode::Tap),
        "http" => Some(Mode::Http),
        "tcpdump" => Some(Mode::Tcpdump),
        _ => None,
    });
    let request = StartRequest {
        mac,
        mode,
        seconds: param_u64(msg, "seconds"),
        max_bytes: param_u64(msg, "max_bytes"),
        snap: param_u64(msg, "snap").and_then(|v| u32::try_from(v).ok()),
        decrypt: param_bool(msg, "decrypt"),
    };
    match with_manager(|m| m.start(&request, now_epoch()).map(session_value)) {
        Some(Ok(session)) => send_json(ctx, req, json!({"ok":true, "session": session})),
        Some(Err(error)) => send_json(ctx, req, json!({"ok":false, "error": error})),
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_stop(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(id) = param_str(msg, "id") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    match with_manager(|m| m.stop(&id).map(session_value)) {
        Some(Ok(session)) => send_json(ctx, req, json!({"ok":true, "session": session})),
        Some(Err(error)) => send_json(ctx, req, json!({"ok":false, "error": error})),
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

unsafe extern "C" fn handle_status(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, _msg: *mut ubus::blob_attr) -> c_int {
    let Some(reply) = with_manager(|m| json!({
        "ok": true,
        "sessions": m.sessions(),
        "caps": {
            "max_sessions": m.cfg.max_sessions,
            "max_duration": m.cfg.max_duration,
            "max_file_mb": m.cfg.max_file_mb,
            "dir": m.cfg.dir.to_string_lossy(),
        },
        "ca_ready": crate::proxy::CaStore::new(&m.cfg.ca_dir).is_ready(),
    })) else { return ubus::UBUS_STATUS_NOT_SUPPORTED };
    send_json(ctx, req, reply)
}

unsafe extern "C" fn handle_get_domains(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(id) = param_str(msg, "id") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    let Some(reply) = with_manager(|m| {
        m.domains(&id).map(|domains| json!({"ok": true, "domains": domains.iter()
            .map(|(domain, stat)| json!({"domain": domain, "count": stat.count, "last_ts": stat.last_ts}))
            .collect::<Vec<_>>()}))
    }) else { return ubus::UBUS_STATUS_NOT_SUPPORTED };
    match reply {
        Some(value) => send_json(ctx, req, value),
        None => send_json(ctx, req, json!({"ok":false, "error": "not_found"})),
    }
}

unsafe extern "C" fn handle_get_events(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(id) = param_str(msg, "id") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    let Some(reply) = with_manager(|m| {
        m.events(&id).map(|events| json!({"ok": true, "events": events}))
    }) else { return ubus::UBUS_STATUS_NOT_SUPPORTED };
    match reply {
        Some(value) => send_json(ctx, req, value),
        None => send_json(ctx, req, json!({"ok":false, "error": "not_found"})),
    }
}

unsafe extern "C" fn handle_get_ca(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, _msg: *mut ubus::blob_attr) -> c_int {
    let Some(reply) = with_manager(|m| {
        crate::proxy::CaStore::new(&m.cfg.ca_dir).cert_pem().map(|pem| json!({"ok": true, "pem": pem}))
    }) else { return ubus::UBUS_STATUS_NOT_SUPPORTED };
    match reply {
        Some(value) => send_json(ctx, req, value),
        None => send_json(ctx, req, json!({"ok":false, "error": "ca_unavailable"})),
    }
}

unsafe extern "C" fn handle_get_har(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(id) = param_str(msg, "id") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    let Some(reply) = with_manager(|m| {
        m.har(&id).map(|har| json!({"ok": true, "har": har.to_string()}))
    }) else { return ubus::UBUS_STATUS_NOT_SUPPORTED };
    match reply {
        Some(value) => send_json(ctx, req, value),
        None => send_json(ctx, req, json!({"ok":false, "error": "not_found"})),
    }
}

unsafe extern "C" fn handle_delete(ctx: *mut ubus::ubus_context, _obj: *mut ubus::ubus_object,
    req: *mut ubus::ubus_request_data, _method: *const c_char, msg: *mut ubus::blob_attr) -> c_int {
    let Some(id) = param_str(msg, "id") else { return ubus::UBUS_STATUS_INVALID_ARGUMENT };
    match with_manager(|m| m.delete(&id)) {
        Some(Ok(())) => send_json(ctx, req, json!({"ok":true})),
        Some(Err(error)) => send_json(ctx, req, json!({"ok":false, "error": error})),
        None => ubus::UBUS_STATUS_NOT_SUPPORTED,
    }
}

// ---------------------------------------------------------------------------
// 对象注册 + uloop timer（zen-trafficd 同款骨架）
// ---------------------------------------------------------------------------

static mut OBJ: std::mem::MaybeUninit<ubus::ubus_object> = std::mem::MaybeUninit::uninit();
static mut OBJ_TYPE: std::mem::MaybeUninit<ubus::ubus_object_type> = std::mem::MaybeUninit::uninit();
static mut TICK: std::mem::MaybeUninit<ubus::uloop_timeout> = std::mem::MaybeUninit::uninit();

/// uloop_init → ubus_connect → ubus_add_object → ubus_add_uloop → 启动 1s tick。
pub unsafe fn start() -> Result<*mut ubus::ubus_context, String> {
    if ubus::uloop_init() != 0 {
        return Err("uloop_init 失败".into());
    }

    let ctx = ubus::ubus_connect(std::ptr::null());
    if ctx.is_null() {
        return Err("ubus_connect 失败（rpcd/ubusd 未运行？）".into());
    }

    let obj_name = cs(b"zen.capture\0");
    let obj_type = std::ptr::addr_of_mut!(OBJ_TYPE).cast::<ubus::ubus_object_type>();
    obj_type.write(ubus::ubus_object_type {
        name: obj_name,
        id: 0,
        methods: METHODS.as_ptr(),
        n_methods: METHODS.len() as c_int,
    });

    let obj = std::ptr::addr_of_mut!(OBJ).cast::<ubus::ubus_object>();
    obj.write(ubus::ubus_object {
        avl: std::mem::zeroed(),
        name: obj_name,
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

/// 1s tick 回调：限额执行 + SHUTDOWN 双保险退出
unsafe extern "C" fn tick_cb(t: *mut ubus::uloop_timeout) {
    if shutting_down() {
        ubus::uloop_cancelled = true;
        return;
    }
    with_manager(|m| m.tick(now_epoch()));
    ubus::uloop_timeout_set(t, TICK_MS);
}

/// ubus 不可用时的降级：仍挂 1s timer 执行限额与孤儿收割
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

/// 信号处理（SIGTERM/SIGINT）：置位 + 写 uloop 取消标志（≤1s 退出）
pub extern "C" fn on_signal(_sig: c_int) {
    SHUTDOWN.store(true, std::sync::atomic::Ordering::SeqCst);
    unsafe { ubus::uloop_cancelled = true; }
}
