//! netif.rs — 本地前缀学习（等价 C PoC 的两趟逻辑）：
//!   defaults（169.254/16、fe80::/10）+ UCI/CLI 追加 + ubus `network.interface dump`
//!   全部接口子网，**排除持有默认路由的上游接口**（WAN 网段属于 Internet 方向）。
//! 供启动与 reloadPrefixes（netifd hotplug）调用。

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;

use zen_ubus_sys as ubus;

use crate::daemon::Daemon;
use crate::netlink::Netlink;

/// ubus dump 回调 ↔ 主流程的暂存区（uloop 单线程，Mutex 仅为 static 约束）
struct DumpScratch {
    ifaces: Vec<IfEntry>,
}

struct IfEntry {
    name: String,
    v4: Vec<(Ipv4Addr, u8)>,
    v6: Vec<(Ipv6Addr, u8)>,
    upstream: bool,
}

static SCRATCH: Mutex<DumpScratch> = Mutex::new(DumpScratch { ifaces: Vec::new() });

/// 刷新 local_prefixes：返回写入条数
pub unsafe fn refresh(d: &mut Daemon) -> usize {
    let mut count = 0usize;

    // 1) defaults：IPv4 链路本地 169.254/16、IPv6 链路本地 fe80::/10
    count += insert(d, false, &Ipv4Addr::new(169, 254, 0, 0).octets(), 16);
    let mut fe80 = [0u8; 16];
    fe80[0] = 0xfe;
    fe80[1] = 0x80;
    count += insert(d, true, &fe80, 10);

    // 2) UCI/CLI 追加
    let extra = d.cfg.extra_prefixes.clone();
    for cidr in &extra {
        if let Some((v6, bytes, mask)) = parse_cidr(cidr) {
            count += insert(d, v6, &bytes, mask);
        }
    }

    // 3) ubus network.interface dump（排除默认路由上游接口）
    if !d.ubus_ctx.is_null() {
        if let Some(dump) = unsafe { network_dump(d.ubus_ctx) } {
            for e in dump {
                if e.upstream {
                    continue;
                }
                for (a, m) in &e.v4 {
                    count += insert(d, false, &a.octets(), *m);
                }
                for (a, m) in &e.v6 {
                    count += insert(d, true, &a.octets(), *m);
                }
            }
        }
    }
    count
}

fn insert(d: &mut Daemon, v6: bool, bytes: &[u8], mask: u8) -> usize {
    let family = if v6 { libc::AF_INET6 } else { libc::AF_INET };
    match zen_bpf::prefix_insert(&mut d.bpf, family, bytes, mask as u32) {
        Ok(()) => 1,
        Err(e) => {
            eprintln!("[zen-trafficd] 前缀写入失败: {e}");
            0
        }
    }
}

fn parse_cidr(cidr: &str) -> Option<(bool, [u8; 16], u8)> {
    let (addr, mask) = cidr.split_once('/')?;
    let mask: u8 = mask.parse().ok()?;
    if let Ok(v4) = addr.parse::<Ipv4Addr>() {
        if mask > 32 {
            return None;
        }
        let mut b = [0u8; 16];
        b[12..16].copy_from_slice(&v4.octets());
        return Some((false, b, mask));
    }
    if let Ok(v6) = addr.parse::<Ipv6Addr>() {
        if mask > 128 {
            return None;
        }
        return Some((true, v6.octets(), mask));
    }
    None
}

/// 调 `network.interface dump`（无参），解析子网与默认路由归属。
/// # Safety
/// ctx 必须是有效的 ubus_context。
unsafe fn network_dump(ctx: *mut ubus::ubus_context) -> Option<Vec<IfEntry>> {
    // 1) 上游接口名（netlink 默认路由 → 接口名，dump 里按名字对齐）
    let mut nl = Netlink::open().ok()?;
    let up_idx = nl.default_route_ifaces();
    let links = nl.links();
    let upstream_names: Vec<String> = links
        .iter()
        .filter(|l| up_idx.contains(&l.ifindex))
        .map(|l| l.name.clone())
        .collect();
    drop(nl);

    // 2) ubus invoke
    SCRATCH.lock().ok()?.ifaces = Vec::new();
    let mut id: u32 = 0;
    if ubus::ubus_lookup_id(ctx, c"network.interface".as_ptr(), &mut id)
        != ubus::UBUS_STATUS_OK
    {
        SCRATCH.lock().ok()?.ifaces = Vec::new();
        return None;
    }
    let cb: ubus::ubus_data_handler_t = Some(dump_cb);
    let mut msg = ubus::empty_blobmsg_msg();
    let rc = ubus::ubus_invoke(
        ctx,
        id,
        c"dump".as_ptr(),
        msg.head,
        cb,
        std::ptr::null_mut(),
        2000,
    );
    ubus::blob_buf_free(&mut msg);
    if rc != ubus::UBUS_STATUS_OK {
        SCRATCH.lock().ok()?.ifaces = Vec::new();
        return None;
    }

    // 3) 上游标记
    let mut ifaces = std::mem::take(&mut SCRATCH.lock().ok()?.ifaces);
    for e in ifaces.iter_mut() {
        if upstream_names.iter().any(|n| *n == e.name) {
            e.upstream = true;
        }
    }
    Some(ifaces)
}

/// dump 回包：{ "interface": [ { "interface": "wan", "route": [...],
///   "ipv4-address": [ { "address": "...", "mask": N } ], "ipv6-address": [...] }, ... ] }
unsafe extern "C" fn dump_cb(
    _req: *mut ubus::ubus_request,
    _type_: std::os::raw::c_int,
    msg: *mut ubus::blob_attr,
) {
    let Ok(mut g) = SCRATCH.lock() else { return };
    let top = ubus::parse_msg(msg);
    for a in &top {
        if a.name != Some("interface") {
            continue;
        }
        // a.data = 数组载荷：连续的 table 属性（每个有名但名字无关紧要）
        for itf in ubus::attrs_from_slice(a.data) {
            let mut entry = IfEntry {
                name: String::new(),
                v4: Vec::new(),
                v6: Vec::new(),
                upstream: false,
            };
            for f in ubus::attrs_from_slice(itf.data) {
                match f.name {
                    Some("interface") => {
                        entry.name = f.as_str().unwrap_or("").to_string();
                    }
                    Some("ipv4-address") => {
                        for item in ubus::attrs_from_slice(f.data) {
                            let (mut addr, mut mask) = (None, 255u8);
                            for p in ubus::attrs_from_slice(item.data) {
                                match p.name {
                                    Some("address") => addr = p.as_str().and_then(|s| s.parse().ok()),
                                    Some("mask") => mask = p.as_u32().unwrap_or(255) as u8,
                                    _ => {}
                                }
                            }
                            if let Some(a) = addr {
                                entry.v4.push((a, mask));
                            }
                        }
                    }
                    Some("ipv6-address") => {
                        for item in ubus::attrs_from_slice(f.data) {
                            let (mut addr, mut mask) = (None, 255u8);
                            for p in ubus::attrs_from_slice(item.data) {
                                match p.name {
                                    Some("address") => addr = p.as_str().and_then(|s| s.parse().ok()),
                                    Some("mask") => mask = p.as_u32().unwrap_or(255) as u8,
                                    _ => {}
                                }
                            }
                            if let Some(a) = addr {
                                entry.v6.push((a, mask));
                            }
                        }
                    }
                    Some("route") => {
                        for item in ubus::attrs_from_slice(f.data) {
                            let (mut target, mut mask) = (None, 255u32);
                            for p in ubus::attrs_from_slice(item.data) {
                                match p.name {
                                    Some("target") => target = p.as_str().map(|s| s.to_string()),
                                    Some("mask") => mask = p.as_u32().unwrap_or(255),
                                    _ => {}
                                }
                            }
                            if mask == 0
                                && matches!(target.as_deref(), Some("0.0.0.0") | Some("::"))
                            {
                                entry.upstream = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
            g.ifaces.push(entry);
        }
    }
}
