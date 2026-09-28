//! device.rs — 设备属性合并（ARCHITECTURE §7.3 全量口径）：
//!   - DHCP：dnsmasq /tmp/dhcp.leases（v4 hostname/IP）；
//!   - odhcpd：/tmp/odhcpd.leases（v6，经 DUID-LL/LLT 尽力还原 MAC）；
//!   - neighbour：netlink ARP/NDP（MAC↔IP）；
//!   - hostapd：ubus hostapd.* get_clients（Wi-Fi 归因 + freq→频段）；
//!   - router：本机接口 MAC（netlink links）。
//!
//! 合并优先级：hostname user > dhcp；ip 由租约优先于 neighbour；
//! conn：router > wifi > wired。合并结果只写 RAM，随 checkpoint 落盘。

use std::collections::HashMap;
use std::ffi::{CStr, CString};

use zen_ubus_sys as ubus;

use crate::netlink::LinkInfo;
use crate::state::{Conn, DevState, HostSrc};

/// 一次属性刷新的全部外部输入
pub struct AttrSources {
    pub links: Vec<LinkInfo>,
    pub neigh: Vec<crate::netlink::Neigh>,
    pub dhcp_v4: Vec<(String, String, Option<String>)>, // (mac, ip, hostname)
    pub dhcp_v6: Vec<(String, String)>,                 // (mac, ip)
    pub wifi: Vec<(String, Option<String>)>,            // (mac, band)
}

pub fn refresh(sources: &AttrSources, devs: &mut HashMap<zen_bpf::MacKey, DevState>) {
    use zen_bpf::MacKey;

    let mut own_macs: Vec<[u8; 6]> = Vec::new();
    for l in &sources.links {
        own_macs.push(l.mac);
    }
    let own_macs = own_macs;

    // neighbour：MAC → [(ip, v6)]
    let mut neigh_map: HashMap<[u8; 6], Vec<(&str, bool)>> = HashMap::new();
    for n in &sources.neigh {
        neigh_map.entry(n.mac).or_default().push((&n.ip, n.v6));
    }

    // DHCP v4：mac → (ip, hostname)
    let mut dhcp4: HashMap<String, (String, Option<String>)> = HashMap::new();
    for (mac, ip, host) in &sources.dhcp_v4 {
        dhcp4.insert(mac.clone(), (ip.clone(), host.clone()));
    }

    // DHCP v6：mac → ip（odhcpd DUID 还原，尽力而为）
    let mut dhcp6: HashMap<String, String> = HashMap::new();
    for (mac, ip) in &sources.dhcp_v6 {
        dhcp6.insert(mac.clone(), ip.clone());
    }

    // hostapd：mac → band
    let mut wifi_map: HashMap<String, Option<String>> = HashMap::new();
    for (mac, band) in &sources.wifi {
        wifi_map.insert(mac.clone(), band.clone());
    }

    for d in devs.values_mut() {
        let mac_str = d.mac.to_str();

        // ---- conn / band ----
        if own_macs.contains(&d.mac.b) {
            d.conn = Conn::Router;
            d.band = None;
        } else if let Some(band) = wifi_map.get(&mac_str) {
            d.conn = Conn::Wifi;
            d.band = band.clone();
        } else {
            d.conn = Conn::Wired;
            d.band = None;
        }

        // ---- ip4：租约优先，neighbour 兜底 ----
        if let Some((ip, _)) = dhcp4.get(&mac_str) {
            d.ip4 = Some(ip.clone());
        } else if let Some(list) = neigh_map.get(&d.mac.b) {
            if let Some((ip, false)) = list.iter().find(|(_, v6)| !*v6) {
                d.ip4 = Some((*ip).to_string());
            }
        }

        // ---- ip6：odhcpd 优先，neighbour v6 兜底（fe80 已在采集侧排除）----
        if let Some(ip) = dhcp6.get(&mac_str) {
            d.ip6 = Some(ip.clone());
        } else if let Some(list) = neigh_map.get(&d.mac.b) {
            if let Some((ip, true)) = list.iter().find(|(_, v6)| *v6) {
                d.ip6 = Some((*ip).to_string());
            }
        }

        // ---- hostname：user > dhcp ----
        if d.host_src < HostSrc::User {
            let host = dhcp4
                .get(&mac_str)
                .and_then(|(_, h)| h.clone())
                .filter(|h| !h.is_empty() && h != "*");
            if let Some(h) = host {
                d.host = Some(h);
                d.host_src = HostSrc::Dhcp;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// DHCP 文件解析
// ---------------------------------------------------------------------------

/// dnsmasq /tmp/dhcp.leases：`<expiry> <mac> <ip> <hostname> [clientid]`
pub fn parse_dhcp_leases(path: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    for line in text.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() >= 3 {
            let mac = t[1].to_ascii_lowercase();
            if mac.len() == 17 && mac.matches(':').count() == 5 {
                let host = t.get(3).map(|s| s.to_string()).filter(|s| !s.is_empty() && s != "*");
                out.push((mac, t[2].to_string(), host));
            }
        }
    }
    out
}

/// odhcpd /tmp/odhcpd.leases：`# <duid>` 注释行 + 租约行。
/// 租约行字段（odhcpd write_leases）：`<expires> <iaid> <length> <name> <addr...>`。
/// DUID → MAC 还原：DUID-LLT（type 1，MAC @ bytes 8..14）、DUID-LL（type 3，MAC @ bytes 4..10）。
pub fn parse_odhcpd_leases(path: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    let mut duid_mac: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(hex) = line.strip_prefix('#') {
            duid_mac = duid_to_mac(&hex.trim().replace(' ', ""));
            continue;
        }
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() >= 5 {
            if let (Some(mac), Some(ip)) = (duid_mac.clone(), t.last()) {
                if is_ipv6(ip) {
                    out.push((mac, ip.to_string()));
                }
            }
        }
    }
    out
}

/// DUID 十六进制串 → MAC（尽力而为）
fn duid_to_mac(hex: &str) -> Option<String> {
    let b = hex.as_bytes();
    if b.len() < 20 || !b.iter().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok();
    let t = ((byte(0)? as u16) << 8) | byte(1)? as u16;
    let off = match t {
        1 => 8, // DUID-LLT：type(2) htype(2) time(4) mac(6)
        3 => 4, // DUID-LL：type(2) htype(2) mac(6)
        _ => return None,
    };
    let mut mac = Vec::with_capacity(6);
    for i in 0..6 {
        mac.push(byte(off + i)?);
    }
    Some(mac.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":"))
}

fn is_ipv6(s: &str) -> bool {
    s.contains(':')
}

// ---------------------------------------------------------------------------
// hostapd（ubus）
// ---------------------------------------------------------------------------

/// 频段推断：freq < 3000 → 2.4G；< 5945 → 5G；否则 6G
fn band_from_freq(f: u32) -> String {
    if f < 3000 {
        "2.4G".into()
    } else if f < 5945 {
        "5G".into()
    } else {
        "6G".into()
    }
}

/// ubus 枚举 hostapd.* 对象并逐个 get_clients，汇总已关联客户端。
/// # Safety
/// ctx 必须是有效的 ubus_context（uloop 线程内调用）。
pub unsafe fn wifi_clients(ctx: *mut ubus::ubus_context) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    if ctx.is_null() {
        return out;
    }

    // 1) 枚举对象：收集 hostapd.<iface> 名字
    let mut names: Vec<String> = Vec::new();
    unsafe {
        SCRATCH.lock().expect("scratch").names = std::mem::take(&mut names);
        let cb: ubus::ubus_object_handler_t = Some(collect_hostapd);
        ubus::ubus_lookup(ctx, std::ptr::null(), cb, std::ptr::null_mut());
        names = std::mem::take(&mut SCRATCH.lock().expect("scratch").names);
    }

    // 2) 逐对象 get_clients
    for name in names {
        let cname = match CString::new(name.as_str()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut id: u32 = 0;
        if ubus::ubus_lookup_id(ctx, cname.as_ptr(), &mut id) != ubus::UBUS_STATUS_OK {
            continue;
        }
        let mut clients: Vec<(String, Option<String>)> = Vec::new();
        unsafe {
            SCRATCH.lock().expect("scratch").clients = std::mem::take(&mut clients);
            let cb: ubus::ubus_data_handler_t = Some(parse_clients);
            let mut msg = ubus::empty_blobmsg_msg();
            ubus::ubus_invoke(
                ctx,
                id,
                c"get_clients".as_ptr(),
                msg.head,
                cb,
                std::ptr::null_mut(),
                1500,
            );
            ubus::blob_buf_free(&mut msg);
            clients = std::mem::take(&mut SCRATCH.lock().expect("scratch").clients);
        }
        out.extend(clients);
    }
    out
}

/// ubus 回调与 Rust 侧数据交换的暂存区（uloop 单线程模型，Mutex 仅满足 static 约束）
struct Scratch {
    names: Vec<String>,
    clients: Vec<(String, Option<String>)>,
}

static SCRATCH: std::sync::Mutex<Scratch> = std::sync::Mutex::new(Scratch {
    names: Vec::new(),
    clients: Vec::new(),
});

unsafe extern "C" fn collect_hostapd(
    _ctx: *mut ubus::ubus_context,
    obj: *mut ubus::ubus_object,
    _priv_: *mut std::os::raw::c_void,
) {
    let name = (*obj).name;
    if name.is_null() {
        return;
    }
    let s = CStr::from_ptr(name).to_string_lossy().into_owned();
    if s.starts_with("hostapd.") {
        if let Ok(mut g) = SCRATCH.lock() {
            g.names.push(s);
        }
    }
}

/// 解析 get_clients 回包：
/// { freq: N, clients: { "<mac>": { assoc: true, ... }, ... } }
unsafe extern "C" fn parse_clients(
    _req: *mut ubus::ubus_request,
    _type_: std::os::raw::c_int,
    msg: *mut ubus::blob_attr,
) {
    let Ok(mut g) = SCRATCH.lock() else { return };
    let attrs = ubus::parse_msg(msg);
    let mut freq: Option<u32> = None;
    let mut clients: Option<Vec<ubus::AttrRef>> = None;
    for a in &attrs {
        match a.name {
            Some("freq") => freq = a.as_u32(),
            Some("clients") => {
                // clients 为嵌套 table：a.data 已剥离自身名字头，直接迭代子属性
                clients = Some(ubus::attrs_from_slice(a.data));
            }
            _ => {}
        }
    }
    let band = freq.map(band_from_freq);
    if let Some(cl) = clients {
        for c in cl {
            // clients 表的 key = MAC（AttrRef.name）
            let mac = match c.name {
                Some(m) => m.to_ascii_lowercase(),
                None => continue,
            };
            if mac.len() == 17 && mac.matches(':').count() == 5 {
                g.clients.push((mac, band.clone()));
            }
        }
    }
}
