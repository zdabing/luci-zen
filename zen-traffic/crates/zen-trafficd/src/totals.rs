//! totals.rs — getTotal 全局口径：上游（默认路由）接口 netlink 统计差分。
//!
//! ARCHITECTURE §3：全局总量走接口级统计（WAN 侧 src MAC 无归因价值）。
//! rx = WAN 接口收（下载）、tx = WAN 接口发（上传）；上游接口每 60s 重探测。

use std::collections::HashMap;

use crate::daemon::Daemon;
use crate::state::now_mono_ms;

const REFRESH_ROUTE_SECS: u64 = 60;

/// 启动时首次探测上游接口
pub fn detect_upstream(d: &mut Daemon) {
    d.offload = crate::offload::Status::detect();
    if let Err(e) = d.reconcile_interfaces() {
        eprintln!("[zen-trafficd] 更新采集接口失败: {e}");
    }
    // A temporary ubus failure must not switch back to bypassed PPP counters.
    match unsafe { crate::netif::pppoe_devices(d.ubus_ctx) } {
        Ok(devices) => d.pppoe_devices = devices,
        Err(e) => eprintln!("[zen-trafficd] 保留 WAN 设备映射: {e}"),
    }
    let routes = d.nl.default_route_ifaces();
    let links = d.nl.links();
    let idx = counter_ifaces(&routes, &links, &d.pppoe_devices);
    if idx.is_empty() {
        eprintln!("[zen-trafficd] 警告：未发现默认路由接口，getTotal 实时速率将不可用");
    } else {
        println!(
            "[zen-trafficd] 上游接口: {:?}",
            links.iter().filter(|l| idx.contains(&l.ifindex))
                .map(|l| l.name.clone())
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    if d.upstream != idx {
        d.upstream = idx;
        d.up_prev.clear();
    }
    d.route_checked_mono = now_mono_ms();
}

/// Observe either a logical WAN or its PPPoE lower device, never both.
/// Lower-device counters include link/encapsulation overhead, not just payload.
fn counter_ifaces(routes: &[u32], links: &[crate::netlink::LinkInfo], pppoe: &[(String, String)]) -> Vec<u32> {
    let mut result = Vec::new();
    for index in routes {
        let Some(link) = links.iter().find(|l| l.ifindex == *index) else { continue };
        let counter = pppoe.iter().find(|(logical, _)| logical == &link.name)
            .and_then(|(_, lower)| links.iter().find(|l| &l.name == lower))
            .unwrap_or(link);
        if !result.contains(&counter.ifindex) { result.push(counter.ifindex); }
    }
    result.sort_unstable();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link(ifindex: u32, name: &str) -> crate::netlink::LinkInfo {
        crate::netlink::LinkInfo { ifindex, name: name.into(), mac: [0; 6], rx_bytes: 0, tx_bytes: 0 }
    }
    #[test]
    fn pppoe_fastpath_uses_lower_device_once_for_ipv4_ipv6_and_shared_routes() {
        let links = vec![link(2,"eth1"), link(6,"pppoe-wan"), link(7,"pppoe-other"), link(8,"eth1.20")];
        let map = vec![("pppoe-wan".into(),"eth1".into()), ("pppoe-other".into(),"eth1.20".into())];
        assert_eq!(counter_ifaces(&[6,6,2,7], &links, &map), [2,8]);
        assert_eq!(counter_ifaces(&[6], &links[..1], &map), Vec::<u32>::new());
        assert_eq!(counter_ifaces(&[6], &links[1..2], &map), [6]);
        assert_eq!(counter_ifaces(&[8], &links, &map), [8]);
    }
}

/// 每 tick 调用：差分上游接口 stats64 → 全局实时速率
pub fn refresh(d: &mut Daemon, links: &[crate::netlink::LinkInfo]) {
    let now_mono = now_mono_ms();
    if now_mono.saturating_sub(d.route_checked_mono) >= REFRESH_ROUTE_SECS * 1000 {
        detect_upstream(d);
    }

    let mut cur: HashMap<u32, (u64, u64)> = HashMap::new();
    for l in links {
        if d.upstream.contains(&l.ifindex) {
            cur.insert(l.ifindex, (l.rx_bytes, l.tx_bytes));
        }
    }

    let dt = now_mono.saturating_sub(d.last_totals_mono).max(1);
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (idx, (crx, ctx)) in &cur {
        if let Some((prx, ptx)) = d.up_prev.get(idx) {
            if *crx >= *prx {
                rx += (*crx - *prx) * 1000 / dt;
                d.wan.interface_delta(*crx - *prx, 0);
            }
            if *ctx >= *ptx {
                tx += (*ctx - *ptx) * 1000 / dt;
                d.wan.interface_delta(0, *ctx - *ptx);
            }
        }
    }
    d.up_prev = cur;
    d.last_totals_mono = now_mono;
    d.rx_r = rx;
    d.tx_r = tx;
}
