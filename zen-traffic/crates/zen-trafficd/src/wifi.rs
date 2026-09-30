//! hostapd cache: asynchronous get_clients requests on the existing uloop thread.
//! No shared-context threads, no daemon lock in callbacks, one request per object.
use std::collections::HashMap;
use std::ffi::CStr;
use std::os::raw::{c_int, c_void};
use zen_ubus_sys as ubus;
use crate::device;

const SCAN_MS: u64 = 15_000;
const TIMEOUT_MS: u64 = 1_500;
type Clients = Vec<(String, Option<String>)>;

#[derive(Default)]
pub struct WifiCache {
    cached: HashMap<String, Clients>,
    pending: Vec<Box<Pending>>,
    last_scan: Option<u64>,
}

struct Pending {
    req: ubus::ubus_request,
    name: String,
    started: u64,
    done: Option<c_int>,
    clients: Option<Clients>,
}

impl WifiCache {
    /// All access, including C callbacks, is confined to the uloop thread.
    pub unsafe fn tick(&mut self, ctx: *mut ubus::ubus_context, now: u64) {
        if ctx.is_null() { return; }
        let mut i = 0;
        while i < self.pending.len() {
            let item = &mut self.pending[i];
            if item.done.is_none() && now.saturating_sub(item.started) >= TIMEOUT_MS {
                ubus::ubus_abort_request(ctx, &mut item.req);
                item.done = Some(ubus::UBUS_STATUS_TIMEOUT);
            }
            if let Some(status) = item.done {
                let mut item = self.pending.swap_remove(i);
                if status == ubus::UBUS_STATUS_OK {
                    if let Some(clients) = item.clients.take() {
                        self.cached.insert(item.name.clone(), clients);
                    }
                }
                // Failed/timed-out requests leave this object's previous cache intact.
            } else { i += 1; }
        }
        if !self.pending.is_empty() || self.last_scan.is_some_and(|last| now.saturating_sub(last) < SCAN_MS) { return; }
        self.last_scan = Some(now);
        let mut objects: Vec<(String, u32)> = Vec::new();
        // Discovery is a low-frequency ubusd lookup; hostapd itself is never waited on.
        let status = ubus::ubus_lookup(ctx, std::ptr::null(), Some(collect),
            (&mut objects as *mut Vec<(String, u32)>).cast());
        if status != ubus::UBUS_STATUS_OK { return; }
        self.cached.retain(|name, _| objects.iter().any(|(current, _)| current == name));
        for (name, id) in objects {
            let mut item = Box::new(Pending {
                req: std::mem::zeroed(), name, started: now, done: None, clients: None,
            });
            let mut msg = ubus::empty_blobmsg_msg();
            let result = ubus::ubus_invoke_async_fd(ctx, id, c"get_clients".as_ptr(), msg.head, &mut item.req, -1);
            ubus::blob_buf_free(&mut msg);
            if result != ubus::UBUS_STATUS_OK { continue; }
            item.req.priv_ = (&mut *item as *mut Pending).cast();
            item.req.data_cb = Some(data);
            item.req.complete_cb = Some(complete);
            // Moving the Box into the vector keeps the request and private data addresses stable.
            self.pending.push(item);
            let item = self.pending.last_mut().unwrap();
            ubus::ubus_complete_request_async(ctx, &mut item.req);
        }
    }

    pub fn clients(&self) -> Clients {
        self.cached.values().flat_map(|clients| clients.iter().cloned()).collect()
    }

    /// Call before ubus_free so libubus cannot retain pointers to dropped request storage.
    pub unsafe fn cancel(&mut self, ctx: *mut ubus::ubus_context) {
        if !ctx.is_null() {
            for item in &mut self.pending {
                if item.done.is_none() { ubus::ubus_abort_request(ctx, &mut item.req); }
            }
        }
        self.pending.clear();
    }
}

unsafe extern "C" fn collect(_ctx: *mut ubus::ubus_context, obj: *mut ubus::ubus_object_data, private: *mut c_void) {
    if obj.is_null() || (*obj).path.is_null() { return; }
    let path = CStr::from_ptr((*obj).path).to_string_lossy();
    let name = path.strip_prefix('/').unwrap_or(&path);
    if name.starts_with("hostapd.") {
        let objects = &mut *private.cast::<Vec<(String, u32)>>();
        objects.push((name.to_string(), (*obj).id));
    }
}

unsafe extern "C" fn data(req: *mut ubus::ubus_request, _kind: c_int, msg: *mut ubus::blob_attr) {
    let item = &mut *(*req).priv_.cast::<Pending>();
    if let Some(clients) = device::parse_wifi_clients(msg) { item.clients = Some(clients); }
}

unsafe extern "C" fn complete(req: *mut ubus::ubus_request, status: c_int) {
    let item = &mut *(*req).priv_.cast::<Pending>();
    item.done = Some(status);
}
