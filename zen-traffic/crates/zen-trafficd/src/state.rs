//! state.rs — 共享类型：配置、每设备实时态、时间/格式工具。
//!
//! 实时速率与今日/月累计只存 RAM（红线：不允许每秒写库）；
//! 累计落盘由 persistence.rs 按 checkpoint/日切/月切/SIGTERM 批量执行。

use std::time::{SystemTime, UNIX_EPOCH};

use zen_bpf::{DevStats, MacKey};

pub const DORMANT_DAYS: u64 = 7;
pub const RETENTION_DAYS: u32 = 90;
pub const RETENTION_MONTHS: u32 = 12;

/// NTP 同步守卫：系统时间早于 2024-01-01 视为未同步，不做日切/月切、不落带日期的数据
pub const MIN_SYNC_EPOCH: u64 = 1704067200;

#[derive(Clone)]
pub struct Config {
    pub bpf_path: String,
    pub ifaces: Vec<String>,
    pub interval_ms: u64,
    /// 设备离线判定秒数（ARCHITECTURE §8，默认 600）
    pub offline_timeout: u64,
    /// SQLite checkpoint 周期秒数（默认 300）
    pub checkpoint_secs: u64,
    pub db_path: String,
    /// UCI/CLI 追加的本地前缀（CIDR）
    pub extra_prefixes: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            bpf_path: "/usr/share/zen-traffic/zen_traffic.bpf.o".into(),
            ifaces: vec!["br-lan".into()],
            interval_ms: 1000,
            offline_timeout: 600,
            checkpoint_secs: 300,
            db_path: "/etc/zen-traffic/traffic.db".into(),
            extra_prefixes: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Conn {
    Wifi,
    Wired,
    Router,
}

impl Conn {
    pub fn as_str(self) -> &'static str {
        match self {
            Conn::Wifi => "wifi",
            Conn::Wired => "wired",
            Conn::Router => "router",
        }
    }
}

/// hostname 来源优先级：user > dhcp（setHostname 写入的永远压过 DHCP）
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum HostSrc {
    Dhcp = 0,
    User = 1,
}

/// 每设备实时态（RAM）
pub struct DevState {
    pub mac: MacKey,
    /// 上一 tick 的 BPF 计数（差分基准）
    pub prev: DevStats,
    pub cur: DevStats,
    /// 本 tick 是否在 BPF map 中出现（对齐 C PoC 的 alive 语义）
    pub alive: bool,
    /// 实时速率 B/s（差分 / dt）
    pub wan_rx_r: u64,
    pub wan_tx_r: u64,
    pub lan_rx_r: u64,
    pub lan_tx_r: u64,

    /// 累计字节（WAN+LAN 合计；rx=下载 tx=上传）
    pub rx_today: u64,
    pub tx_today: u64,
    pub rx_month: u64,
    pub tx_month: u64,
    /// 生命周期累计（跨重启，SQLite devices 表恢复）
    pub rx_total: u64,
    pub tx_total: u64,

    // ---- 属性（device.rs 合并）----
    pub ip4: Option<String>,
    pub ip6: Option<String>,
    pub host: Option<String>,
    pub host_src: HostSrc,
    pub conn: Conn,
    pub band: Option<String>,
    /// 最近有流量的 epoch 秒（RAM 内维护；落盘到 devices.last_seen）
    pub last_active: u64,
    pub online: bool,
}

impl DevState {
    pub fn new(mac: MacKey, first: DevStats, now_epoch: u64, rx_total: u64, tx_total: u64) -> Self {
        DevState {
            mac,
            prev: first,
            cur: first,
            alive: true,
            wan_rx_r: 0,
            wan_tx_r: 0,
            lan_rx_r: 0,
            lan_tx_r: 0,
            rx_today: 0,
            tx_today: 0,
            rx_month: 0,
            tx_month: 0,
            rx_total,
            tx_total,
            ip4: None,
            ip6: None,
            host: None,
            host_src: HostSrc::Dhcp,
            conn: Conn::Wired,
            band: None,
            last_active: now_epoch,
            online: true,
        }
    }

    pub fn rx_r(&self) -> u64 {
        self.wan_rx_r + self.lan_rx_r
    }
    pub fn tx_r(&self) -> u64 {
        self.wan_tx_r + self.lan_tx_r
    }
    pub fn is_dormant(&self, now: u64, dormant_days: u64) -> bool {
        now.saturating_sub(self.last_active) > dormant_days * 86400
    }
}

// ---------------------------------------------------------------------------
// 时间工具（libc，无 chrono 依赖）
// ---------------------------------------------------------------------------

pub fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn now_mono_ms() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1000 + ts.tv_nsec as u64 / 1_000_000
}

fn localtime(epoch: u64) -> libc::tm {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = epoch as libc::time_t;
    unsafe { libc::localtime_r(&t, &mut tm) };
    tm
}

/// 本地日期 "YYYY-MM-DD"
pub fn local_date(epoch: u64) -> String {
    let tm = localtime(epoch);
    format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday)
}

/// 本地月份 "YYYY-MM"
pub fn local_month(epoch: u64) -> String {
    let tm = localtime(epoch);
    format!("{:04}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1)
}

pub fn time_synced(epoch: u64) -> bool {
    epoch >= MIN_SYNC_EPOCH
}

/// "2026-09-28" 附近日期的朴素偏移（仅用于保留期清理的下界）
pub fn date_shift(date: &str, minus_days: u32) -> String {
    let mut y: i64 = date.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(2024);
    let mut m: i64 = date.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    let mut d: i64 = date.get(8..10).and_then(|s| s.parse().ok()).unwrap_or(1);
    d -= minus_days as i64;
    while d <= 0 {
        m -= 1;
        if m == 0 {
            m = 12;
            y -= 1;
        }
        d += days_in_month(y, m);
    }
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// "2026-09" 月份偏移
pub fn month_shift(month: &str, minus_months: u32) -> String {
    let mut y: i64 = month.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(2024);
    let mut m: i64 = month.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(1);
    m -= minus_months as i64;
    while m <= 0 {
        m += 12;
        y -= 1;
    }
    format!("{:04}-{:02}", y, m)
}

pub fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}
