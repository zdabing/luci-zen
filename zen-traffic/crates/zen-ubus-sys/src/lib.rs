//! zen-ubus-sys — 最小 libubus / libubox / uloop FFI（zen-traffic 正式包）
//!
//! 自 poc/rust-spike/crates/zen-ubus-sys 原样升级（spike Step 1–5 已验证的基线）：
//!   - blob_attr 转为真实布局（id_len 头字段），提供 blob/blobmsg 逐字段解析辅助
//!     （network.interface dump、hostapd get_clients 等 ubus 客户端回包解析用）；
//!   - 新增 ubus 客户端侧符号：ubus_lookup / ubus_lookup_id / ubus_invoke_fd。
//!
//! 布局来源（逐字段手工转写，非 bindgen）：
//!   - https://git.openwrt.org/?p=project/ubus.git   libubus.h
//!   - https://git.openwrt.org/?p=project/libubox.git blob.h / blobmsg.h / uloop.h / avl.h / list.h
//!
//! 转写原则（spike 最小面）：
//!   - 只声明实际调用的导出符号；头文件中的 static inline（如 ubus_add_uloop、
//!     blobmsg_add_string/u64、blobmsg_data 等）在 Rust 侧等价复现，避免依赖内联函数的链接。
//!   - 只转写需要字段访问的结构体；`ubus_request_data` 等仅作不透明指针透传。
//!   - `ubus_context` 只转写到 `sock` 字段为止（`ubus_add_uloop` 内联体需要
//!     `&ctx->sock`）。`sock` 之前的字段（requests/objects/pending）偏移必须精确，
//!     其后字段对偏移无影响，一律归入不透明尾部。
//!
//! 已知布局风险（spike Step 4 验证覆盖）：
//!   - `ubus_method.mask/tags` 为 `unsigned long`，64 位目标 = 8 字节；
//!   - 32 位目标 `struct timeval` 尺寸（musl time64）与 64 位不同，
//!     已按指针宽度 cfg 处理；主目标为 aarch64/x86_64。
//!
//! unsafe 面：本 crate 提供 raw 声明与最小安全封装；上层封装在 zen-trafficd。

#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]
// 手写 FFI 层：unsafe fn 体内直接操作裸指针属预期行为（edition 2024 默认 warn）
#![allow(unsafe_op_in_unsafe_fn)]

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

pub const BLOBMSG_TYPE_ARRAY: c_int = 1;
pub const BLOBMSG_TYPE_TABLE: c_int = 2;
pub const BLOBMSG_TYPE_STRING: c_int = 3;
pub const BLOBMSG_TYPE_INT64: c_int = 4;
pub const BLOBMSG_TYPE_INT32: c_int = 5;
pub const BLOBMSG_TYPE_INT8: c_int = 7;
pub const BLOBMSG_TYPE_BOOL: c_int = BLOBMSG_TYPE_INT8;

/// `struct blob_attr`（blob.h：`uint32_t id_len; char data[]`）。
/// id_len 以**大端**存储（be32_to_cpu 语义）：
///   bit31 = EXTENDED（blobmsg 属性带名字头），bit24..30 = 类型，
///   bit0..23 = 含 4B 头的原始长度（对齐由 blob_pad_len 计算）。
#[repr(C)]
pub struct blob_attr {
    pub id_len: c_uint,
    _data: [u8; 0],
}

pub const BLOB_ATTR_ID_MASK: u32 = 0x7f00_0000;
pub const BLOB_ATTR_ID_SHIFT: u32 = 24;
pub const BLOB_ATTR_LEN_MASK: u32 = 0x00ff_ffff;
pub const BLOB_ATTR_EXTENDED: u32 = 0x8000_0000;

#[inline]
pub unsafe fn blob_id(attr: *const blob_attr) -> u8 {
    ((u32::from_be((*attr).id_len) & BLOB_ATTR_ID_MASK) >> BLOB_ATTR_ID_SHIFT) as u8
}

/// 含 4B 头的原始长度（未对齐）
#[inline]
pub unsafe fn blob_raw_len(attr: *const blob_attr) -> usize {
    (u32::from_be((*attr).id_len) & BLOB_ATTR_LEN_MASK) as usize
}

/// 载荷长度（不含 blob_attr 头 4 字节）
#[inline]
pub unsafe fn blob_len(attr: *const blob_attr) -> usize {
    blob_raw_len(attr).saturating_sub(4)
}

/// 下一属性偏移步长（4 字节对齐）
#[inline]
pub unsafe fn blob_pad_len(attr: *const blob_attr) -> usize {
    align4(blob_raw_len(attr))
}

#[inline]
pub unsafe fn blob_data<'a>(attr: *const blob_attr) -> &'a [u8] {
    let len = blob_len(attr);
    let p = (attr as *const u8).add(4);
    std::slice::from_raw_parts(p, len)
}

#[inline]
fn align2(v: usize) -> usize {
    (v + 1) & !1usize
}

#[inline]
fn align4(v: usize) -> usize {
    (v + 3) & !3usize
}

/// blobmsg 名字头长度（blobmsg.h）：BLOBMSG_PADDING(sizeof(blobmsg_hdr) + namelen + 1)
/// = align2(2 + namelen + 1)；BLOBMSG_ALIGN = 2。
#[inline]
fn blobmsg_hdrlen(namelen: usize) -> usize {
    align2(2 + namelen + 1)
}

/// blobmsg 属性视图：类型 + 名字 + 载荷切片（已剥离自身名字头）
#[derive(Clone, Copy)]
pub struct AttrRef<'a> {
    pub ty: u8,
    pub name: Option<&'a str>,
    pub data: &'a [u8],
}

impl<'a> AttrRef<'a> {
    pub fn as_str(&self) -> Option<&'a str> {
        // blobmsg string：载荷含结尾 NUL
        let end = self.data.iter().position(|&b| b == 0).unwrap_or(self.data.len());
        std::str::from_utf8(&self.data[..end]).ok()
    }
    pub fn as_u64(&self) -> Option<u64> {
        if self.data.len() < 8 {
            return None;
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&self.data[..8]);
        Some(u64::from_be_bytes(b))
    }
    pub fn as_u32(&self) -> Option<u32> {
        if self.data.len() < 4 {
            return None;
        }
        let mut b = [0u8; 4];
        b.copy_from_slice(&self.data[..4]);
        Some(u32::from_be_bytes(b))
    }
    /// blobmsg bool/int8：单字节载荷
    pub fn as_bool(&self) -> Option<bool> {
        self.data.first().map(|&b| b != 0)
    }
}

/// 迭代一段 blobmsg 载荷中的连续属性（等价 blobmsg_for_each_attr 的展开）。
/// 载荷须从"属性边界"开始（即调用方已跳过容器自身的名字头）。
/// # Safety
/// payload 必须是 libubox 生成的合法 blobmsg 数据。
pub unsafe fn attrs_from_slice<'a>(payload: &'a [u8]) -> Vec<AttrRef<'a>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 4 <= payload.len() {
        let raw = u32::from_be_bytes([
            payload[off], payload[off + 1], payload[off + 2], payload[off + 3],
        ]);
        let body_len = (raw & BLOB_ATTR_LEN_MASK) as usize;
        if body_len < 4 || off + body_len > payload.len() {
            break;
        }
        let id = raw & BLOB_ATTR_ID_MASK;
        let extended = raw & BLOB_ATTR_EXTENDED != 0;
        let ty = (id >> BLOB_ATTR_ID_SHIFT) as u8;
        let body = &payload[off + 4..off + body_len];

        // blobmsg 头（blobmsg.c blobmsg_new）：{ be16 namelen; char name[namelen]; '\0' }
        // 总头长 = align2(2 + namelen + 1)；未置 EXTENDED 位的普通 blob 属性无名字头
        let (name, data) = if extended && body.len() >= 2 {
            let namelen = u16::from_be_bytes([body[0], body[1]]) as usize;
            let hdr = blobmsg_hdrlen(namelen);
            let nm = body.get(2..2 + namelen).unwrap_or(&[]);
            let dat = if hdr <= body.len() { &body[hdr..] } else { &body[body.len()..] };
            (std::str::from_utf8(nm).ok(), dat)
        } else {
            (None, body)
        };
        out.push(AttrRef { ty, name, data });

        off += align4(body_len);
    }
    out
}

/// 解析顶层 blobmsg 消息（ubus 回包 msg 指针）为直接子属性表。
/// 顶层容器经 blobmsg_open_nested(NULL→"") 创建：名字头 namelen=0（4 字节），
/// 子属性从 blobmsg_data(msg) 起。
/// # Safety
/// msg 必须是 libubox 生成的合法 blobmsg 消息。
pub unsafe fn parse_msg<'a>(msg: *mut blob_attr) -> Vec<AttrRef<'a>> {
    if msg.is_null() {
        return Vec::new();
    }
    let ty = blob_id(msg);
    if ty != 2 && ty != 1 {
        // 2=BLOBMSG_TYPE_TABLE, 1=BLOBMSG_TYPE_ARRAY（blobmsg.h enum blobmsg_type）
        return Vec::new();
    }
    let full = blob_data(msg);
    let hdr = if full.len() >= 2 {
        let namelen = u16::from_be_bytes([full[0], full[1]]) as usize;
        blobmsg_hdrlen(namelen)
    } else {
        0
    };
    if hdr > full.len() {
        return Vec::new();
    }
    attrs_from_slice(&full[hdr..])
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

unsafe extern "C" {
    // blob.c（导出符号）
    pub fn blob_buf_init(buf: *mut blob_buf, id: c_int) -> c_int;
    pub fn blob_buf_free(buf: *mut blob_buf);
    pub fn blob_nest_end(buf: *mut blob_buf, cookie: *mut c_void);

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

/// 等价 blobmsg_open_array（inline → blobmsg_open_nested(.., true)）
/// # Safety
/// buf 指针必须有效。
pub unsafe fn blobmsg_open_array(buf: *mut blob_buf, name: *const c_char) -> *mut c_void {
    blobmsg_open_nested(buf, name, true)
}

/// 等价 blobmsg_close_array（blob.h inline 同 close_table：`buf->head = cookie`）
/// # Safety
/// cookie 必须来自同 buf 的 open。
pub unsafe fn blobmsg_close_array(buf: *mut blob_buf, cookie: *mut c_void) {
    blob_nest_end(buf, cookie);
}

/// 等价 blobmsg_close_table（blob.h inline：`buf->head = cookie`）
/// # Safety
/// cookie 必须来自同 buf 的 open。
pub unsafe fn blobmsg_close_table(buf: *mut blob_buf, cookie: *mut c_void) {
    blob_nest_end(buf, cookie);
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

unsafe extern "C" {
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

// Safety：ubus_method 实例只指向 'static 字符串/policy 表与纯 C 回调，
// 注册后由 libubus 只读访问；跨线程共享（static 方法表）是安全的。
unsafe impl Sync for ubus_method {}

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

unsafe extern "C" {
    pub fn ubus_connect(path: *const c_char) -> *mut ubus_context;
    pub fn ubus_free(ctx: *mut ubus_context);
    pub fn ubus_add_object(ctx: *mut ubus_context, obj: *mut ubus_object) -> c_int;
    pub fn ubus_send_reply(
        ctx: *mut ubus_context,
        req: *mut ubus_request_data,
        msg: *mut blob_attr,
    ) -> c_int;
}

// ---------------------------------------------------------------------------
// ubus 客户端侧（新增：network dump / hostapd get_clients 等主动调用）
// ---------------------------------------------------------------------------

/// `struct ubus_request` — 客户端调用期间由 libubus 管理，回调只透传指针
#[repr(C)]
pub struct ubus_request {
    _opaque: [u8; 0],
}

pub type ubus_data_handler_t =
    Option<unsafe extern "C" fn(req: *mut ubus_request, type_: c_int, msg: *mut blob_attr)>;
#[repr(C)]
pub struct ubus_object_data {
    pub id: u32,
    pub type_id: u32,
    pub path: *const c_char,
    pub signature: *mut blob_attr,
}

pub type ubus_lookup_handler_t =
    Option<unsafe extern "C" fn(ctx: *mut ubus_context, obj: *mut ubus_object_data, priv_: *mut c_void)>;
pub type ubus_complete_handler_t =
    Option<unsafe extern "C" fn(req: *mut ubus_request, ret: c_int)>;

unsafe extern "C" {
    /// 枚举 ubus 对象树（hostapd.* 发现用）；cb 对每个对象回调
    pub fn ubus_lookup(
        ctx: *mut ubus_context,
        path: *const c_char,
        cb: ubus_lookup_handler_t,
        priv_: *mut c_void,
    ) -> c_int;

    pub fn ubus_lookup_id(ctx: *mut ubus_context, path: *const c_char, id: *mut u32) -> c_int;

    /// 同步调用的导出符号；libubus.h 的 ubus_invoke 是 static inline。
    pub fn ubus_invoke_fd(
        ctx: *mut ubus_context,
        obj: u32,
        method: *const c_char,
        msg: *mut blob_attr,
        cb: ubus_data_handler_t,
        priv_: *mut c_void,
        timeout: c_int,
        fd: c_int,
    ) -> c_int;
}

/// 等价 libubus.h 的 static inline ubus_invoke；timeout 单位 ms。
/// # Safety
/// 参数须满足 libubus.h 中 ubus_invoke_fd 的约束。
pub unsafe fn ubus_invoke(
    ctx: *mut ubus_context,
    obj: u32,
    method: *const c_char,
    msg: *mut blob_attr,
    cb: ubus_data_handler_t,
    priv_: *mut c_void,
    timeout: c_int,
) -> c_int {
    ubus_invoke_fd(ctx, obj, method, msg, cb, priv_, timeout, -1)
}

/// 等价 libubus.h inline：构造 blob_attr 头 + blobmsg 名字后作为 ubus_invoke 的 msg。
/// 仅支持"无参数消息"——本项目全部客户端调用均无参（dump/get_clients），
/// 需要带参调用时再扩展（须严格按 blobmsg 编码：4B 头 + align4(name+1) + 4B 对齐载荷）。
/// # Safety
/// buf 须保持存活至 ubus_invoke 返回。
pub unsafe fn empty_blobmsg_msg() -> blob_buf {
    let mut b = blob_buf::new_zeroed();
    blob_buf_init(&mut b, 0);
    b
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
