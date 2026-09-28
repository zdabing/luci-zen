//! zen-ubus-sys — 最小 libubus / libubox / uloop FFI（feasibility spike）
//!
//! 布局来源（逐字段手工转写，非 bindgen）：
//!   - https://git.openwrt.org/?p=project/ubus.git   libubus.h
//!   - https://git.openwrt.org/?p=project/libubox.git blob.h / blobmsg.h / uloop.h / avl.h / list.h
//!
//! 转写原则（spike 最小面）：
//!   - 只声明实际调用的导出符号；头文件中的 static inline（如 ubus_add_uloop、
//!     blobmsg_add_string/u64）在 Rust 侧等价复现，避免依赖内联函数的链接。
//!   - 只转写需要字段访问的结构体；`ubus_request_data` 等仅作不透明指针透传。
//!   - `ubus_context` 只转写到 `sock` 字段为止（`ubus_add_uloop` 内联体需要
//!     `&ctx->sock`）。`sock` 之前的字段（requests/objects/pending）偏移必须精确，
//!     其后字段对偏移无影响，一律归入不透明尾部。
//!
//! 已知布局风险（Step 4 验证覆盖）：
//!   - `ubus_method.mask/tags` 为 `unsigned long`，64 位目标 = 8 字节；
//!   - 32 位目标 `struct timeval` 尺寸（musl time64）与 64 位不同，
//!     已按指针宽度 cfg 处理；spike 主目标为 aarch64/x86_64。
//!
//! unsafe 面：本 crate 提供 raw 声明；安全封装在 zen-trafficd-spike 的 ubusd.rs。

#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]

use std::os::raw::{c_char, c_int, c_ulong, c_uint, c_void};

// ---------------------------------------------------------------------------
// ubus status（libubus.h enum ubus_status）
// ---------------------------------------------------------------------------

pub const UBUS_STATUS_OK: c_int = 0;
pub const UBUS_STATUS_INVALID_COMMAND: c_int = 1;
pub const UBUS_STATUS_INVALID_ARGUMENT: c_int = 2;
pub const UBUS_STATUS_METHOD_NOT_FOUND: c_int = 3;
pub const UBUS_STATUS_NOT_FOUND: c_int = 4;
pub const UBUS_STATUS_NO_DATA: c_int = 5;
pub const UBUS_STATUS_PERMISSION_DENIED: c_int = 6;
pub const UBUS_STATUS_TIMEOUT: c_int = 7;
pub const UBUS_STATUS_NOT_SUPPORTED: c_int = 8;
pub const UBUS_STATUS_UNKNOWN_ERROR: c_int = 9;
pub const UBUS_STATUS_CONNECTION_FAILED: c_int = 10;

// ---------------------------------------------------------------------------
// blob / blobmsg（libubox blob.h / blobmsg.h）
// ---------------------------------------------------------------------------

pub const BLOBMSG_TYPE_STRING: c_int = 3;
pub const BLOBMSG_TYPE_INT64: c_int = 4;
pub const BLOBMSG_TYPE_INT32: c_int = 5;

/// `struct blob_attr` — 不透明（reply 时只透传 `blob_buf.head` 指针）
#[repr(C)]
pub struct blob_attr {
    _opaque: [u8; 0],
}

/// `struct blob_buf`（blob.h，字段顺序：head, grow, buflen, buf）
#[repr(C)]
pub struct blob_buf {
    pub head: *mut blob_attr,
    pub grow: Option<unsafe extern "C" fn(*mut blob_buf, c_int) -> bool>,
    pub buflen: c_int,
    pub buf: *mut c_void,
}

impl blob_buf {
    /// 等价 C 用法：`struct blob_buf b; memset(&b, 0, sizeof b); blob_buf_init(&b, 0);`
    pub fn new_zeroed() -> Self {
        // grow 的 Option<fn> 全零即 None，与 C 静态零初始化一致
        unsafe { std::mem::zeroed() }
    }
}

extern "C" {
    // blob.c（导出符号）
    pub fn blob_buf_init(buf: *mut blob_buf, id: c_int) -> c_int;
    pub fn blob_buf_free(buf: *mut blob_buf);

    // blobmsg.c（导出符号；头文件内联 helper 在 Rust 侧封装，见下方安全函数）
    pub fn blobmsg_add_field(
        buf: *mut blob_buf,
        attr_type: c_int,
        name: *const c_char,
        data: *const c_void,
        len: c_int,
    ) -> c_int;

    // blobmsg_open_table/array 的实现体（blobmsg.h 的 inline 调用它）
    pub fn blobmsg_open_nested(
        buf: *mut blob_buf,
        name: *const c_char,
        array: bool,
    ) -> *mut c_void;
}

/// 等价 blobmsg_add_string（inline：blobmsg_add_field(.., BLOBMSG_TYPE_STRING, name, s, strlen(s)+1)）
/// # Safety
/// name/val 必须为以 NUL 结尾的合法 C 字符串。
pub unsafe fn blobmsg_add_string(buf: *mut blob_buf, name: *const c_char, val: *const c_char) {
    blobmsg_add_field(
        buf,
        BLOBMSG_TYPE_STRING,
        name,
        val as *const c_void,
        libc_strlen(val) as c_int + 1,
    );
}

/// 等价 blobmsg_add_u64（inline：按大端写入 8 字节）
/// # Safety
/// buf 指针必须有效。
pub unsafe fn blobmsg_add_u64(buf: *mut blob_buf, name: *const c_char, val: u64) {
    let be = val.to_be();
    blobmsg_add_field(
        buf,
        BLOBMSG_TYPE_INT64,
        name,
        &be as *const u64 as *const c_void,
        8,
    );
}

/// 等价 blobmsg_add_u32
/// # Safety
/// buf 指针必须有效。
pub unsafe fn blobmsg_add_u32(buf: *mut blob_buf, name: *const c_char, val: u32) {
    let be = val.to_be();
    blobmsg_add_field(
        buf,
        BLOBMSG_TYPE_INT32,
        name,
        &be as *const u32 as *const c_void,
        4,
    );
}

/// 等价 blobmsg_open_table（inline → blobmsg_open_nested(.., false)）
/// # Safety
/// buf 指针必须有效。
pub unsafe fn blobmsg_open_table(buf: *mut blob_buf, name: *const c_char) -> *mut c_void {
    blobmsg_open_nested(buf, name, false)
}

/// 等价 blobmsg_close_table（blob.h inline：`buf->head = cookie`）
/// # Safety
/// cookie 必须来自同 buf 的 open。
pub unsafe fn blobmsg_close_table(buf: *mut blob_buf, cookie: *mut c_void) {
    (*buf).head = cookie as *mut blob_attr;
}

unsafe fn libc_strlen(s: *const c_char) -> usize {
    // 独立于 libc crate 的最小 strlen，供 add_string 计算长度
    let mut n = 0usize;
    while *s.add(n) != 0 {
        n += 1;
    }
    n
}

// ---------------------------------------------------------------------------
// list / avl（libubox list.h / avl.h）
// ---------------------------------------------------------------------------

/// `struct list_head`（双向链表，仅两个指针）
#[repr(C)]
pub struct list_head {
    pub next: *mut list_head,
    pub prev: *mut list_head,
}

/// `struct avl_node`（avl.h；list 必须为第一个成员）
#[repr(C)]
pub struct avl_node {
    pub list: list_head,
    pub parent: *mut avl_node,
    pub left: *mut avl_node,
    pub right: *mut avl_node,
    pub key: *const c_void,
    pub balance: i8,
    pub leader: bool,
}

/// `struct avl_tree`（avl.h；ubus_context 第二个成员，决定 sock 偏移）
#[repr(C)]
pub struct avl_tree {
    pub list_head: list_head,
    pub root: *mut avl_node,
    pub count: c_uint,
    pub allow_dups: bool,
    pub comp: *const c_void, // avl_tree_comp 函数指针
    pub cmp_ptr: *mut c_void,
}

// ---------------------------------------------------------------------------
// uloop（libubox uloop.h）
// ---------------------------------------------------------------------------

pub const ULOOP_READ: c_uint = 1 << 0;
pub const ULOOP_WRITE: c_uint = 1 << 1;
pub const ULOOP_BLOCKING: c_uint = 1 << 3;

pub type uloop_fd_handler_t =
    Option<unsafe extern "C" fn(u: *mut uloop_fd, events: c_uint)>;
pub type uloop_timeout_handler_t = Option<unsafe extern "C" fn(t: *mut uloop_timeout)>;

/// 64 位：{long, long}；32 位 musl time64：{long long, long}
#[repr(C)]
#[cfg(target_pointer_width = "64")]
pub struct timeval {
    pub tv_sec: i64,
    pub tv_usec: i64,
}
#[repr(C)]
#[cfg(target_pointer_width = "32")]
pub struct timeval {
    pub tv_sec: i64,
    pub tv_usec: i32,
}

/// `struct uloop_fd`（uloop.h：cb, fd, eof, error, registered, flags）
#[repr(C)]
pub struct uloop_fd {
    pub cb: uloop_fd_handler_t,
    pub fd: c_int,
    pub eof: bool,
    pub error: bool,
    pub registered: bool,
    pub flags: u8,
}

/// `struct uloop_timeout`（uloop.h：list, pending, cb, time）
#[repr(C)]
pub struct uloop_timeout {
    pub list: list_head,
    pub pending: bool,
    pub cb: uloop_timeout_handler_t,
    pub time: timeval,
}

extern "C" {
    pub fn uloop_init() -> c_int;
    pub fn uloop_run_timeout(timeout: c_int) -> c_int;
    pub fn uloop_done();

    pub fn uloop_fd_add(u: *mut uloop_fd, flags: c_uint) -> c_int;
    pub fn uloop_timeout_set(timeout: *mut uloop_timeout, msecs: c_int) -> c_int;

    /// uloop.c 全局变量（uloop_end() 的本体就是把它置 true）
    pub static mut uloop_cancelled: bool;
}

// ---------------------------------------------------------------------------
// ubus（libubus.h）
// ---------------------------------------------------------------------------

pub type ubus_handler_t = Option<
    unsafe extern "C" fn(
        ctx: *mut ubus_context,
        obj: *mut ubus_object,
        req: *mut ubus_request_data,
        method: *const c_char,
        msg: *mut blob_attr,
    ) -> c_int,
>;

/// `struct ubus_request_data` — 不透明透传（ubus_send_reply 只需要指针）
#[repr(C)]
pub struct ubus_request_data {
    _opaque: [u8; 0],
}

/// `struct blobmsg_policy` — spike 方法均无参（policy = NULL），仅占类型位
#[repr(C)]
pub struct blobmsg_policy {
    pub name: *const c_char,
    pub attr_type: c_int,
}

/// `struct ubus_method`（libubus.h：name, handler, mask, tags, policy, n_policy；
/// mask/tags 为 unsigned long）
#[repr(C)]
pub struct ubus_method {
    pub name: *const c_char,
    pub handler: ubus_handler_t,
    pub mask: c_ulong,
    pub tags: c_ulong,
    pub policy: *const blobmsg_policy,
    pub n_policy: c_int,
}

/// `struct ubus_object_type`（name, id, methods, n_methods）
#[repr(C)]
pub struct ubus_object_type {
    pub name: *const c_char,
    pub id: u32,
    pub methods: *const ubus_method,
    pub n_methods: c_int,
}

/// `struct ubus_object`（libubus.h 完整字段顺序：avl, name, id, path, type,
/// subscribe_cb, has_subscribers, methods, n_methods）
#[repr(C)]
pub struct ubus_object {
    pub avl: avl_node,
    pub name: *const c_char,
    pub id: u32,
    pub path: *const c_char,
    pub obj_type: *mut ubus_object_type,
    pub subscribe_cb: Option<unsafe extern "C" fn(*mut ubus_context, *mut ubus_object)>,
    pub has_subscribers: bool,
    pub methods: *const ubus_method,
    pub n_methods: c_int,
}

/// `struct ubus_context` — **部分转写**。
///
/// `ubus_add_uloop` 在 libubus.h 中是 static inline：
/// `uloop_fd_add(&ctx->sock, ULOOP_BLOCKING | ULOOP_READ)`。
/// 为在 Rust 侧等价调用，必须精确转写 sock 之前的全部成员：
///   requests: list_head(16) + objects: avl_tree(48) + pending: list_head(16)
///   → sock 偏移 = 80（64 位目标）。
/// sock 之后的成员（pending_timer/local_id/msgbuf/...）不影响偏移，归入尾部。
/// context 由 `ubus_connect()` 分配，本结构从不自行实例化。
#[repr(C)]
pub struct ubus_context {
    pub requests: list_head,
    pub objects: avl_tree,
    pub pending: list_head,
    pub sock: uloop_fd,
    pub _tail: [u8; 512],
}

extern "C" {
    pub fn ubus_connect(path: *const c_char) -> *mut ubus_context;
    pub fn ubus_free(ctx: *mut ubus_context);
    pub fn ubus_add_object(ctx: *mut ubus_context, obj: *mut ubus_object) -> c_int;
    pub fn ubus_send_reply(
        ctx: *mut ubus_context,
        req: *mut ubus_request_data,
        msg: *mut blob_attr,
    ) -> c_int;
}

/// 等价 libubus.h 的 `static inline void ubus_add_uloop(ctx)`：
/// `uloop_fd_add(&ctx->sock, ULOOP_BLOCKING | ULOOP_READ)`
///
/// # Safety
/// ctx 必须来自 ubus_connect 且未被释放；须在 uloop_init 之后调用。
pub unsafe fn ubus_add_uloop(ctx: *mut ubus_context) -> c_int {
    uloop_fd_add(&mut (*ctx).sock, ULOOP_BLOCKING | ULOOP_READ)
}

/// 运行时布局自检：打印 sock 在 64 位目标的期望偏移（80）与实际转写偏移。
/// Step 4 验证时核对。
pub fn layout_report() {
    let ctx = ubus_context {
        requests: list_head { next: std::ptr::null_mut(), prev: std::ptr::null_mut() },
        objects: avl_tree {
            list_head: list_head { next: std::ptr::null_mut(), prev: std::ptr::null_mut() },
            root: std::ptr::null_mut(),
            count: 0,
            allow_dups: false,
            comp: std::ptr::null(),
            cmp_ptr: std::ptr::null_mut(),
        },
        pending: list_head { next: std::ptr::null_mut(), prev: std::ptr::null_mut() },
        sock: uloop_fd {
            cb: None,
            fd: 0,
            eof: false,
            error: false,
            registered: false,
            flags: 0,
        },
        _tail: [0u8; 512],
    };
    let base = &ctx as *const ubus_context as usize;
    let sock = &ctx.sock as *const uloop_fd as usize;
    println!(
        "[zen-ubus-sys] layout: sock offset = {} (64-bit 期望 80), \
         ubus_object = {}B, ubus_method = {}B",
        sock - base,
        std::mem::size_of::<ubus_object>(),
        std::mem::size_of::<ubus_method>(),
    );
}
