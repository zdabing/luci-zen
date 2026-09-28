//! netlink.rs — 原生 rtnetlink（rtnetlink dump，无外部 crate）：
//!   - links():      RTM_GETLINK  → 接口名/MAC/stats64（getTotal 全局速率、router 识别）
//!   - routes():     RTM_GETROUTE → 默认路由上游接口（WAN 判定，对齐 C PoC 的排除逻辑）
//!   - neighbors():  RTM_GETNEIGH → ARP/NDP 表（MAC↔IP 属性合并）
//!   - clean_stale_tfilters(): RTM_GETTFILTER/RTM_DELTFILTER → 按名字清理本项目残留
//!     filter（等价 C PoC 固定 pref/handle REPLACE 的幂等语义，见 zen-bpf 说明）。
//!
//! 字段解析用固定偏移 + 字节序 cfg（内核字段为 CPU 原生字节序，覆盖 BE 目标）。

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::unix::io::RawFd;

// ---- uapi 常量（libc 未覆盖的部分自行定义，值为内核稳定 ABI）----
const NLM_F_REQUEST: u16 = 0x01;
const NLM_F_MULTI: u16 = 0x02;
const NLM_F_ACK: u16 = 0x04;
const NLM_F_DUMP: u16 = 0x300;

const NLMSG_ERROR: u16 = 0x02;
const NLMSG_DONE: u16 = 0x03;

const RTM_GETLINK: u16 = 18;
const RTM_GETROUTE: u16 = 26;
const RTM_GETNEIGH: u16 = 30;
const RTM_DELTFILTER: u16 = 33;
const RTM_GETTFILTER: u16 = 34;

const IFLA_ADDRESS: u16 = 1;
const IFLA_IFNAME: u16 = 3;
const IFLA_STATS64: u16 = 23;

const RTA_DST: u16 = 1;
const RTA_OIF: u16 = 4;

const NDA_DST: u16 = 1;
const NDA_LLADDR: u16 = 2;

const TCA_KIND: u16 = 1;
const TCA_OPTIONS: u16 = 2;
const TCA_BPF_NAME: u16 = 7; // pkt_cls.h: TCA_BPF_FD=6, TCA_BPF_NAME=7

// nd_state（neighbour 表保留状态）
const NUD_PERMANENT: u16 = 0x40;
const NUD_REACHABLE: u16 = 0x02;
const NUD_STALE: u16 = 0x04;
const NUD_DELAY: u16 = 0x08;
const NUD_PROBE: u16 = 0x10;
const NUD_VALID: u16 = NUD_PERMANENT | NUD_REACHABLE | NUD_STALE | NUD_DELAY | NUD_PROBE;

// tcmsg 内的 clsact parent（TC_H_MAKE(TC_H_CLSACT, minor)）
const TC_H_CLSACT: u32 = 0xffff_fff1;
const TC_H_MIN_INGRESS: u32 = 0xffff_fff2;
const TC_H_MIN_EGRESS: u32 = 0xffff_fff3;

const NETLINK_BUF: usize = 96 * 1024;

#[derive(Debug, Clone)]
pub struct LinkInfo {
    pub ifindex: u32,
    pub name: String,
    pub mac: [u8; 6],
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct Neigh {
    pub mac: [u8; 6],
    pub ip: String,
    pub v6: bool,
}

pub struct Netlink {
    fd: RawFd,
    seq: u32,
}

// ---------------------------------------------------------------------------
// 字节序感知的读取辅助（内核 netlink 字段为 CPU 原生序）
// ---------------------------------------------------------------------------

#[inline]
fn rd_u16(b: &[u8], off: usize) -> u16 {
    #[cfg(target_endian = "big")]
    {
        u16::from_be_bytes([b[off], b[off + 1]])
    }
    #[cfg(target_endian = "little")]
    {
        u16::from_le_bytes([b[off], b[off + 1]])
    }
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> u32 {
    #[cfg(target_endian = "big")]
    {
        u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
    }
    #[cfg(target_endian = "little")]
    {
        u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
    }
}

#[inline]
fn wr_u32(b: &mut [u8], off: usize, v: u32) {
    #[cfg(target_endian = "big")]
    {
        b[off..off + 4].copy_from_slice(&v.to_be_bytes());
    }
    #[cfg(target_endian = "little")]
    {
        b[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }
}

#[inline]
fn align4(v: usize) -> usize {
    (v + 3) & !3usize
}

/// rtattr 迭代：返回 (type, 载荷切片)
fn rta_iter(buf: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 4 <= buf.len() {
        let len = rd_u16(buf, off) as usize;
        if len < 4 || off + len > buf.len() {
            break;
        }
        out.push((rd_u16(buf, off + 2), &buf[off + 4..off + len]));
        off += align4(len);
    }
    out
}

/// nlmsghdr 迭代：返回 (type, 消息体切片)
fn nlmsg_iter(buf: &[u8]) -> Vec<(u16, &[u8])> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 16 <= buf.len() {
        let len = rd_u32(buf, off) as usize;
        if len < 16 || off + len > buf.len() {
            break;
        }
        out.push((rd_u16(buf, off + 4), &buf[off + 16..off + len]));
        off += align4(len);
    }
    out
}

impl Netlink {
    fn sockaddr_nl() -> libc::sockaddr_nl {
        // nl_pad is private in recent libc versions, so initialize the C
        // structure first and then assign its public fields.
        let mut sa: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
        sa.nl_family = libc::AF_NETLINK as u16;
        sa
    }

    pub fn open() -> io::Result<Netlink> {
        let fd = unsafe {
            libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_RAW | libc::SOCK_CLOEXEC,
                libc::NETLINK_ROUTE,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let sa = Self::sockaddr_nl();
        let rc = unsafe {
            libc::bind(
                fd,
                &sa as *const libc::sockaddr_nl as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_nl>() as u32,
            )
        };
        if rc < 0 {
            let e = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(e);
        }
        Ok(Netlink { fd, seq: 0 })
    }

    /// 发送 dump 请求并收集 multipart 响应（直到 NLMSG_DONE / 错误）
    fn dump(&mut self, msg_type: u16, payload: &[u8]) -> io::Result<Vec<u8>> {
        self.seq = self.seq.wrapping_add(1);
        let total = 16 + align4(payload.len());
        let mut req = vec![0u8; total];
        wr_u32(&mut req, 0, total as u32); // len
        wr_u32(&mut req, 8, 1); // seq
        wr_u32(&mut req, 12, 0); // pid
        req[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        req[6..8].copy_from_slice(&(NLM_F_REQUEST | NLM_F_ACK | NLM_F_DUMP | NLM_F_MULTI).to_ne_bytes());
        req[16..16 + payload.len()].copy_from_slice(payload);

        let sa = Self::sockaddr_nl();
        let rc = unsafe {
            libc::sendto(
                self.fd,
                req.as_ptr() as *const libc::c_void,
                req.len(),
                0,
                &sa as *const libc::sockaddr_nl as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_nl>() as u32,
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }

        let mut out = Vec::with_capacity(NETLINK_BUF);
        let mut rbuf = vec![0u8; NETLINK_BUF];
        loop {
            let n = unsafe {
                libc::recv(self.fd, rbuf.as_mut_ptr() as *mut libc::c_void, rbuf.len(), 0)
            };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(e);
            }
            let n = n as usize;
            for (ty, body) in nlmsg_iter(&rbuf[..n]) {
                match ty {
                    NLMSG_DONE => return Ok(out),
                    NLMSG_ERROR => {
                        if body.len() >= 4 && rd_u32(body, 0) != 0 {
                            return Err(io::Error::from_raw_os_error(rd_u32(body, 0) as i32));
                        }
                        // error==0 为 ACK，dump 场景等待 DONE
                    }
                    _ => out.extend_from_slice(body),
                }
            }
        }
    }

    /// RTM_GETLINK：接口清单 + stats64
    pub fn links(&mut self) -> Vec<LinkInfo> {
        let mut out = Vec::new();
        // rtgenmsg: 1 字节 family（AF_UNSPEC=0）
        let Ok(raw) = self.dump(RTM_GETLINK, &[0u8]) else {
            return out;
        };
        for (ty, body) in nlmsg_iter(&raw) {
            if ty != RTM_GETLINK || body.len() < 16 {
                continue;
            }
            let ifindex = rd_u32(body, 4); // ifinfomsg.ifi_index @4
            let attrs = &body[16..];
            let mut li = LinkInfo {
                ifindex,
                name: String::new(),
                mac: [0; 6],
                rx_bytes: 0,
                tx_bytes: 0,
            };
            for (at, av) in rta_iter(attrs) {
                match at {
                    IFLA_IFNAME => {
                        let end = av.iter().position(|&b| b == 0).unwrap_or(av.len());
                        li.name = String::from_utf8_lossy(&av[..end]).into_owned();
                    }
                    IFLA_ADDRESS if av.len() == 6 => {
                        li.mac.copy_from_slice(av);
                    }
                    IFLA_STATS64 if av.len() >= 16 => {
                        // rtnl_link_stats64: rx_bytes @0, tx_bytes @8
                        li.rx_bytes = rd_u64(av, 0);
                        li.tx_bytes = rd_u64(av, 8);
                    }
                    _ => {}
                }
            }
            if !li.name.is_empty() {
                out.push(li);
            }
        }
        out
    }

    /// RTM_GETROUTE：默认路由（dst_len=0）所在接口（上游/WAN 判定）
    pub fn default_route_ifaces(&mut self) -> Vec<u32> {
        let mut out = Vec::new();
        // rtmsg: family@0, dst_len@1 ...
        let mut msg = [0u8; 12];
        for family in [libc::AF_INET as u8, libc::AF_INET6 as u8] {
            msg[0] = family;
            let Ok(raw) = self.dump(RTM_GETROUTE, &msg) else {
                continue;
            };
            for (ty, body) in nlmsg_iter(&raw) {
                if ty != RTM_GETROUTE || body.len() < 12 {
                    continue;
                }
                if body[1] != 0 {
                    continue; // rtm_dst_len != 0 → 非默认路由
                }
                let mut has_dst = false;
                let mut oif: Option<u32> = None;
                for (at, av) in rta_iter(&body[12..]) {
                    match at {
                        RTA_DST => has_dst = true, // 带目的地址的"默认路由"（policy routing）不作数
                        RTA_OIF if av.len() == 4 => oif = Some(rd_u32(av, 0)),
                        _ => {}
                    }
                }
                if !has_dst {
                    if let Some(o) = oif {
                        if !out.contains(&o) {
                            out.push(o);
                        }
                    }
                }
            }
        }
        out
    }

    /// RTM_GETNEIGH：可达/永久的 ARP/NDP 邻居
    pub fn neighbors(&mut self) -> Vec<Neigh> {
        let mut out = Vec::new();
        let Ok(raw) = self.dump(RTM_GETNEIGH, &[0u8]) else {
            return out;
        };
        for (ty, body) in nlmsg_iter(&raw) {
            if ty != RTM_GETNEIGH || body.len() < 16 {
                continue;
            }
            // ndmsg: family@0, ifindex@4, state@8
            let state = rd_u32(body, 8) as u16;
            if state & NUD_VALID == 0 {
                continue;
            }
            let mut mac = [0u8; 6];
            let mut ip: Option<(bool, String)> = None;
            for (at, av) in rta_iter(&body[16..]) {
                match at {
                    NDA_DST if av.len() == 4 => {
                        let a = Ipv4Addr::new(av[0], av[1], av[2], av[3]);
                        // 排除 0.0.0.0
                        if !a.is_unspecified() {
                            ip = Some((false, a.to_string()));
                        }
                    }
                    NDA_DST if av.len() == 16 => {
                        let mut b = [0u8; 16];
                        b.copy_from_slice(av);
                        let a = Ipv6Addr::from(b);
                        if !a.is_unspecified() && !a.is_unicast_link_local() {
                            ip = Some((true, a.to_string()));
                        }
                    }
                    NDA_LLADDR if av.len() == 6 => mac.copy_from_slice(av),
                    _ => {}
                }
            }
            if let Some((v6, s)) = ip {
                if mac != [0; 6] {
                    out.push(Neigh { mac, ip: s, v6 });
                }
            }
        }
        out
    }

    /// 清理本项目的残留 TC filter（daemon 崩溃后 Aya link 不会自动 detach）。
    /// 返回删除数量。minor: TC_H_MIN_INGRESS / TC_H_MIN_EGRESS。
    pub fn clean_stale_tfilters(&mut self, ifindex: u32, minor: u32, names: &[&str]) -> usize {
        let parent = TC_H_CLSACT | minor;
        // tcmsg: family@0, ifindex@4, handle@8, parent@12, info@16（共 20B）
        let mut msg = [0u8; 20];
        wr_u32(&mut msg, 4, ifindex);
        wr_u32(&mut msg, 12, parent);

        let Ok(raw) = self.dump(RTM_GETTFILTER, &msg) else {
            return 0;
        };
        let mut removed = 0usize;
        for (ty, body) in nlmsg_iter(&raw) {
            if ty != RTM_GETTFILTER || body.len() < 20 {
                continue;
            }
            let handle = rd_u32(body, 8);
            let info = rd_u32(body, 16);
            let mut name_ok = false;
            for (at, av) in rta_iter(&body[20..]) {
                if at == TCA_OPTIONS {
                    for (at2, av2) in rta_iter(av) {
                        if at2 == TCA_BPF_NAME {
                            let end = av2.iter().position(|&b| b == 0).unwrap_or(av2.len());
                            let n = String::from_utf8_lossy(&av2[..end]);
                            if names.iter().any(|x| *x == n) {
                                name_ok = true;
                            }
                        }
                        // TCA_KIND 检查可选：非 bpf filter 不会带 TCA_BPF_NAME
                    }
                }
            }
            if name_ok {
                let mut del = [0u8; 20];
                wr_u32(&mut del, 4, ifindex);
                wr_u32(&mut del, 8, handle);
                wr_u32(&mut del, 12, parent);
                wr_u32(&mut del, 16, info);
                if self.talk(RTM_DELTFILTER, &del).is_ok() {
                    removed += 1;
                }
            }
        }
        if removed > 0 {
            println!(
                "[zen-trafficd] 清理残留 TC filter {removed} 条（ifindex {ifindex} minor {minor:#x}）"
            );
        }
        removed
    }

    /// 发送单条请求并等待 ACK
    fn talk(&mut self, msg_type: u16, payload: &[u8]) -> io::Result<()> {
        self.seq = self.seq.wrapping_add(1);
        let total = 16 + align4(payload.len());
        let mut req = vec![0u8; total];
        wr_u32(&mut req, 0, total as u32);
        wr_u32(&mut req, 8, self.seq);
        req[4..6].copy_from_slice(&msg_type.to_ne_bytes());
        req[6..8].copy_from_slice(&(NLM_F_REQUEST | NLM_F_ACK).to_ne_bytes());
        req[16..16 + payload.len()].copy_from_slice(payload);

        let sa = Self::sockaddr_nl();
        let rc = unsafe {
            libc::sendto(
                self.fd,
                req.as_ptr() as *const libc::c_void,
                req.len(),
                0,
                &sa as *const libc::sockaddr_nl as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_nl>() as u32,
            )
        };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut rbuf = [0u8; 4096];
        loop {
            let n = unsafe {
                libc::recv(self.fd, rbuf.as_mut_ptr() as *mut libc::c_void, rbuf.len(), 0)
            };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(e);
            }
            let n = n as usize;
            for (ty, body) in nlmsg_iter(&rbuf[..n]) {
                if ty == NLMSG_ERROR {
                    if body.len() >= 4 {
                        let err = rd_u32(body, 0) as i32;
                        if err != 0 {
                            return Err(io::Error::from_raw_os_error(err));
                        }
                    }
                    return Ok(());
                }
            }
        }
    }
}

impl Drop for Netlink {
    fn drop(&mut self) {
        if self.fd >= 0 {
            unsafe { libc::close(self.fd) };
        }
    }
}

// stats64 内字段同为原生字节序
fn rd_u64(b: &[u8], off: usize) -> u64 {
    #[cfg(target_endian = "big")]
    {
        u64::from_be_bytes([
            b[off], b[off + 1], b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6],
            b[off + 7],
        ])
    }
    #[cfg(target_endian = "little")]
    {
        u64::from_le_bytes([
            b[off], b[off + 1], b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6],
            b[off + 7],
        ])
    }
}
