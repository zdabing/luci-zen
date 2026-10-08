//! daemon.rs — 核心状态与 1s 主循环。
//!
//! 采集链路（ARCHITECTURE §3）：BPF map → 1s 差分 → RAM 实时态 → SQLite 批量落盘；
//! 属性合并与全局速率按低频副任务执行；全部访问限于 uloop 主线程。

use std::collections::{HashMap, HashSet};

use aya::Ebpf;
use zen_bpf::{DevStats, MacKey};
use zen_ubus_sys as ubus;

use crate::device::{self, AttrSources};
use crate::netif;
use crate::netlink::{Netlink, LinkInfo};
use crate::persistence::Db;
use crate::state::{now_epoch, now_mono_ms, Config, DevState, HostSrc};
use crate::{accounting, totals};

pub struct Attachment {
    pub name: String,
    ifindex: u32,
    ingress: aya::programs::tc::SchedClassifierLinkId,
    egress: aya::programs::tc::SchedClassifierLinkId,
}

pub struct Daemon {
    pub cfg: Config,
    pub bpf: Ebpf,
    pub devs: HashMap<MacKey, DevState>,
    pub db: Db,
    pub nl: Netlink,
    /// ubus 上下文（可为 null：ubus 不可用时采集继续，仅发布失效）
    pub ubus_ctx: *mut ubus::ubus_context,

    pub realtime: crate::realtime::RealtimeHistory,
    pub wan: crate::wan::WanUsage,
    pub timeline: crate::timeline::DeviceTimeline,
    pub notifications: crate::notifications::Notifications,
    pub wifi: crate::wifi::WifiCache,
    pub local_prefixes: Vec<(i32, Vec<u8>, u32)>,

    // ---- tick 簿记 ----
    pub last_tick_mono: u64,
    pub last_attr_mono: u64,
    /// Last periodic checkpoint attempt, including failed transactions.
    pub last_ckpt_mono: u64,

    // ---- 区间（本地日/月，accounting 维护）----
    pub cur_day: String,
    pub cur_month: String,
    pub pending_periods: accounting::PendingPeriods,

    // ---- getTotal ----
    pub upstream: Vec<u32>,
    pub pppoe_devices: Vec<(String, String)>,
    pub offload: crate::offload::Status,
    pub up_prev: HashMap<u32, (u64, u64)>,
    pub rx_r: u64,
    pub tx_r: u64,
    pub route_checked_mono: u64,
    pub last_totals_mono: u64,

    // ---- 生命周期 ----
    pub ifaces_meta: Vec<Attachment>,
    pub started: u64,
}

// 单线程模型：ubus raw 指针仅在 uloop 主线程解引用；
// Mutex<Option<Daemon>> 需要的 Send 由本声明保证。
unsafe impl Send for Daemon {}

impl Daemon {
    /// 初始化：DB 恢复 → netlink → BPF attach → 前缀学习。任何失败直接返回 Err。
    pub fn init(cfg: Config) -> Result<Daemon, String> {
        let now = now_epoch();
        let now_mono = now_mono_ms();

        let db = Db::open(&cfg.db_path)?;
        let wan = crate::wan::WanUsage::load(&db, now)?;
        let notifications = crate::notifications::Notifications::load(&db)?;

        let mut devs: HashMap<MacKey, DevState> = HashMap::new();
        let mut user_hosts: HashMap<String, String> = HashMap::new();

        // 1) DB 恢复：生命周期累计 + 用户指定名
        for row in db.load_devices()? {
            if row.hostname_src == 1 {
                if let Some(h) = row.hostname {
                    user_hosts.insert(row.mac.clone(), h);
                }
            }
            if let Some(mac) = parse_mac(&row.mac) {
                let mut s = DevState::new(mac, DevStats::default(), now, row.rx_total.max(0) as u64, row.tx_total.max(0) as u64);
                s.last_active = row.last_seen.max(0) as u64;
                s.online = now.saturating_sub(s.last_active) <= cfg.offline_timeout;
                s.ip4 = row.ip4;
                s.ip6 = row.ip6;
                devs.insert(mac, s);
            }
        }

        // 2) 今日/当月累计接续
        let cur_day = crate::state::local_date(now);
        let cur_month = crate::state::local_month(now);
        if crate::state::time_synced(now) {
            for (mac, dl, ul) in db.load_day(&cur_day)? {
                if let Some(m) = parse_mac(&mac) {
                    if let Some(s) = devs.get_mut(&m) {
                        s.rx_today = dl.max(0) as u64;
                        s.tx_today = ul.max(0) as u64;
                    }
                }
            }
            for (mac, dl, ul) in db.load_month(&cur_month)? {
                if let Some(m) = parse_mac(&mac) {
                    if let Some(s) = devs.get_mut(&m) {
                        s.rx_month = dl.max(0) as u64;
                        s.tx_month = ul.max(0) as u64;
                    }
                }
            }
        }
        // 用户指定名回填 RAM
        for (mac, host) in &user_hosts {
            if let Some(m) = parse_mac(mac) {
                if let Some(s) = devs.get_mut(&m) {
                    s.host = Some(host.clone());
                    s.host_src = HostSrc::User;
                }
            }
        }

        // 3) netlink
        let nl = Netlink::open().map_err(|e| format!("netlink socket: {e}"))?;

        // 4) BPF：加载 + 残留 filter 清理 + attach
        let bpf = zen_bpf::load(std::path::Path::new(&cfg.bpf_path))?;
        zen_bpf::describe(&bpf);

        let timeline = crate::timeline::DeviceTimeline::load(&db)?;
        let mut d = Daemon {
            cfg,
            bpf,
            devs,
            db,
            nl,
            ubus_ctx: std::ptr::null_mut(),
            wifi: crate::wifi::WifiCache::default(),
            realtime: crate::realtime::RealtimeHistory::default(),
            wan,
            timeline,
            notifications,
            local_prefixes: Vec::new(),
            last_tick_mono: 0,
            last_attr_mono: 0,
            last_ckpt_mono: now_mono,
            cur_day,
            cur_month,
            pending_periods: accounting::PendingPeriods::default(),
            upstream: Vec::new(),
            pppoe_devices: Vec::new(),
            offload: crate::offload::Status::default(),
            up_prev: HashMap::new(),
            rx_r: 0,
            tx_r: 0,
            route_checked_mono: now_mono,
            last_totals_mono: now_mono,
            ifaces_meta: Vec::new(),
            started: now,
        };

        // 5) 全局速率基线 + 本地前缀
        d.reconcile_interfaces()?;
        totals::detect_upstream(&mut d);
        let n = unsafe { netif::refresh(&mut d) }?;
        println!("[zen-trafficd] local_prefixes 已写入 {n} 条");

        Ok(d)
    }

    /// Follow bridge port changes without resetting maps or accounting baselines.
    pub fn reconcile_interfaces(&mut self) -> Result<(), String> {
        let desired = crate::topology::lan_ifaces(&self.cfg.ifaces)?;
        let links = self.nl.links();
        if links.is_empty() { return Err("读取网络接口失败".into()); }
        let mut i = 0;
        while i < self.ifaces_meta.len() {
            let old = &self.ifaces_meta[i];
            if desired.contains(&old.name) && links.iter().any(|l| l.name == old.name && l.ifindex == old.ifindex) {
                i += 1; continue;
            }
            let old = self.ifaces_meta.remove(i);
            let ingress = zen_bpf::detach(&mut self.bpf, "zen_ingress", old.ingress);
            let egress = zen_bpf::detach(&mut self.bpf, "zen_egress", old.egress);
            ingress?; egress?;
        }
        for name in desired {
            if self.ifaces_meta.iter().any(|a| a.name == name) { continue; }
            let Some(link) = links.iter().find(|l| l.name == name) else { continue };
            unsafe { clean_stale(&mut self.nl, &name); }
            zen_bpf::qdisc_ensure(&name)?;
            let ingress = zen_bpf::attach(&mut self.bpf, "zen_ingress", &name, aya::programs::TcAttachType::Ingress)?;
            let egress = match zen_bpf::attach(&mut self.bpf, "zen_egress", &name, aya::programs::TcAttachType::Egress) {
                Ok(link) => link,
                Err(error) => {
                    let _ = zen_bpf::detach(&mut self.bpf, "zen_ingress", ingress);
                    return Err(error);
                }
            };
            println!("[zen-trafficd] attached: {name}");
            self.ifaces_meta.push(Attachment { name, ifindex: link.ifindex, ingress, egress });
        }
        if self.ifaces_meta.is_empty() { return Err("没有可用的 LAN 采集接口".into()); }
        Ok(())
    }

    /// 1s 主循环（uloop timer 回调调用）
    pub fn tick(&mut self) {
        let now_mono = now_mono_ms();
        let now = now_epoch();
        let wan_started = self.wan.begin_if_synced(now);
        self.wan.set_day(now);
        if wan_started { self.up_prev.clear(); }
        let dt = if self.last_tick_mono > 0 {
            now_mono.saturating_sub(self.last_tick_mono)
        } else {
            self.cfg.interval_ms
        }
        .max(1);

        // Close the previous calendar interval before attributing this tick.
        accounting::rollover_if_needed(self);

        // ---- 1) BPF map 差分 ----
        match zen_bpf::read_devices(&mut self.bpf) {
            Ok(rows) => {
                let mut seen: HashSet<MacKey> = HashSet::with_capacity(rows.len());
                for row in rows {
                    seen.insert(row.mac);
                    // 新设备由 or_insert_with 创建：prev 初始化为当前计数，
                    // 首 tick 差分天然为 0，不会重复计入累计
                    let s = self
                        .devs
                        .entry(row.mac)
                        .or_insert_with(|| DevState::new(row.mac, row.stats, now, 0, 0));
                    s.alive = true;
                    s.cur = row.stats;

                    // 计数重置/回绕保护：cur < prev 时按 0 计
                    let dd = |cur: u64, prev: u64| cur.saturating_sub(prev);
                    let wan_rx = dd(s.cur.wan_rx_b, s.prev.wan_rx_b);
                    let wan_tx = dd(s.cur.wan_tx_b, s.prev.wan_tx_b);
                    let lan_rx = dd(s.cur.lan_rx_b, s.prev.lan_rx_b);
                    let lan_tx = dd(s.cur.lan_tx_b, s.prev.lan_tx_b);
                    // The first tick also establishes the interface baseline.
                    // Exclude it from the new ledger even for restored devices.
                    if !wan_started && self.last_tick_mono != 0 {
                        self.wan.device_delta(row.mac, wan_rx, wan_tx);
                        // A delayed/paused collector cannot locate an entire delta in time.
                        if dt <= 10_000 {
                            self.timeline.record(now, crate::persistence::mac_str(&row.mac.b), wan_rx, wan_tx);
                        }
                    }

                    s.wan_rx_r = wan_rx * 1000 / dt;
                    s.wan_tx_r = wan_tx * 1000 / dt;
                    s.lan_rx_r = lan_rx * 1000 / dt;
                    s.lan_tx_r = lan_tx * 1000 / dt;

                    // 累计：WAN+LAN 全口径（rx=下载 tx=上传）
                    let rx_d = wan_rx + lan_rx;
                    let tx_d = wan_tx + lan_tx;
                    s.rx_today += rx_d;
                    s.tx_today += tx_d;
                    s.rx_month += rx_d;
                    s.tx_month += tx_d;
                    s.rx_total += rx_d;
                    s.tx_total += tx_d;

                    if rx_d + tx_d > 0 {
                        s.last_active = now;
                    }
                    s.prev = s.cur;
                }

                // ---- 2) 离线/在线与休眠 ----
                for (k, s) in self.devs.iter_mut() {
                    if !seen.contains(k) {
                        s.alive = false;
                        s.wan_rx_r = 0;
                        s.wan_tx_r = 0;
                        s.lan_rx_r = 0;
                        s.lan_tx_r = 0;
                    }
                    s.online = now.saturating_sub(s.last_active) <= self.cfg.offline_timeout;
                }
                // 休眠设备（>7 天）保留在 RAM（保累计连续性），getDevices 输出侧过滤
            }
            Err(e) => eprintln!("[zen-trafficd] tick 读 map 失败: {e}"),
        }

        self.last_tick_mono = now_mono;

        // ---- 4) 全局速率 ----
        let links = self.nl.links();
        totals::refresh(self, &links);
        self.realtime.sample(&self.upstream, &links, now_mono, now);
        self.realtime.flush(&self.db, now_mono, now, false);
        if let Err(e) = self.timeline.flush(&self.db, now, false) {
            eprintln!("[zen-trafficd] 分时记录落盘失败（保留缓存）: {e}");
        }
        unsafe { self.wifi.tick(self.ubus_ctx, now_mono); }

        // ---- 5) 属性合并（5s 低频）----
        if now_mono.saturating_sub(self.last_attr_mono) >= 5000 {
            self.last_attr_mono = now_mono;
            self.refresh_attrs(links);
        }

        // ---- 6) checkpoint ----
        accounting::checkpoint_tick(self);
        self.notifications.tick(&self.db, &self.wan, &self.devs, now, now_mono);
    }

    /// 属性合并：netlink（links/neigh）+ DHCP 文件 + hostapd
    fn refresh_attrs(&mut self, links: Vec<LinkInfo>) {
        let neigh = self.nl.neighbors();
        let dhcp_v4 = device::parse_dhcp_leases("/tmp/dhcp.leases");
        let dhcp_v6 = device::parse_odhcpd_leases("/tmp/odhcpd.leases");
        let wifi = self.wifi.clients();

        let sources = AttrSources {
            links,
            neigh,
            dhcp_v4,
            dhcp_v6,
            wifi,
        };
        device::refresh(&sources, &mut self.devs);
    }

    /// SIGTERM / 退出前最终 checkpoint
    pub fn shutdown_checkpoint(&mut self) {
        match accounting::checkpoint(self) {
            Ok(()) => println!("[zen-trafficd] 退出 checkpoint 完成"),
            Err(e) => eprintln!("[zen-trafficd] 退出 checkpoint 失败: {e}"),
        }
        if let Err(e) = self.timeline.flush(&self.db, crate::state::now_epoch(), true) {
            eprintln!("[zen-trafficd] timeline shutdown checkpoint: {e}");
        }
    }
}

/// 清理本项目残留 TC filter（zen-bpf attach 幂等语义的另一半）
unsafe fn clean_stale(nl: &mut Netlink, iface: &str) {
    let cname = match std::ffi::CString::new(iface) {
        Ok(c) => c,
        Err(_) => return,
    };
    let idx = unsafe { libc::if_nametoindex(cname.as_ptr()) };
    if idx == 0 {
        return;
    }
    nl.clean_stale_tfilters(idx, 0xffff_fff2 /* TC_H_MIN_INGRESS */, &["zen-ingress"]);
    nl.clean_stale_tfilters(idx, 0xffff_fff3 /* TC_H_MIN_EGRESS */, &["zen-egress"]);
}

pub fn parse_mac(s: &str) -> Option<MacKey> {
    if s.len() != 17 || s.matches(':').count() != 5 {
        return None;
    }
    let mut b = [0u8; 6];
    for (i, part) in s.split(':').enumerate() {
        b[i] = u8::from_str_radix(part, 16).ok()?;
    }
    Some(MacKey { b })
}
