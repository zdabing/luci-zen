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
    let idx = d.nl.default_route_ifaces();
    if idx.is_empty() {
        eprintln!("[zen-trafficd] 警告：未发现默认路由接口，getTotal 实时速率将不可用");
    } else {
        println!(
            "[zen-trafficd] 上游接口: {:?}",
            idx.iter()
                .map(|i| i.to_string())
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
