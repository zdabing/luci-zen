//! accounting.rs — 每 MAC 日/月累计、日切/月切、checkpoint、保留期清理。
//!
//! 写盘时机（用户定案，红线：不允许每秒写库）：
//!   - 每 checkpoint_secs（默认 300s）批量事务一次；
//!   - 跨天/跨月立即写；
//!   - daemon 正常退出（SIGTERM）立即写。
//! 写入为绝对值 upsert，崩溃重放安全。
//! 全局 today/month 汇总由 ubus.rs 查询 DB 聚合，不在 RAM 另立口径。

use crate::daemon::Daemon;
use crate::state::{date_shift, local_date, local_month, month_shift, now_epoch, time_synced, now_mono_ms, RETENTION_DAYS, RETENTION_MONTHS};

/// 日切/月切检查（每 tick 调用）。NTP 未同步时跳过，不产生带垃圾日期的数据。
pub fn rollover_if_needed(d: &mut Daemon) {
    let now = now_epoch();
    if !time_synced(now) {
        return;
    }
    let today = local_date(now);
    let month = local_month(now);
    if today == d.cur_day && month == d.cur_month {
        return;
    }

    // 旧区间先落盘（绝对值 upsert 基于 RAM 累计，不受写入时机影响）
    if let Err(e) = checkpoint(d) {
        eprintln!("[zen-trafficd] 切换前 checkpoint 失败: {e}");
    }

    if today != d.cur_day {
        // 保留期清理：daily 90 天
        let before = date_shift(&today, RETENTION_DAYS);
        if let Err(e) = d.db.prune_days(&before) {
            eprintln!("[zen-trafficd] daily 清理失败: {e}");
        }
        for s in d.devs.values_mut() {
            s.rx_today = 0;
            s.tx_today = 0;
        }
        println!("[zen-trafficd] 日切 {} → {}", d.cur_day, today);
        d.cur_day = today;
    }

    if month != d.cur_month {
        // 保留期清理：monthly 12 个月
        let before = month_shift(&month, RETENTION_MONTHS);
        if let Err(e) = d.db.prune_months(&before) {
            eprintln!("[zen-trafficd] monthly 清理失败: {e}");
        }
        for s in d.devs.values_mut() {
            s.rx_month = 0;
            s.tx_month = 0;
        }
        println!("[zen-trafficd] 月切 {} → {}", d.cur_month, month);
        d.cur_month = month;
    }
}

/// 批量 checkpoint：活跃设备 + 当日/当月累计，一次事务。
/// 活跃 = 最近 offline_timeout 内有流量（离线过久的设备属性已无意义）。
pub fn checkpoint(d: &Daemon) -> Result<(), String> {
    let now = now_epoch();
    let active: Vec<&crate::state::DevState> = d
        .devs
        .values()
        .filter(|s| now.saturating_sub(s.last_active) <= d.cfg.offline_timeout)
        .collect();
    d.db.checkpoint(&active, &d.cur_day, &d.cur_month, now as i64)
}

/// 定期 checkpoint 入口（带时间戳去重）
pub fn checkpoint_tick(d: &mut Daemon) {
    let now_mono = now_mono_ms();
    if now_mono.saturating_sub(d.last_ckpt_mono) < d.cfg.checkpoint_secs * 1000 {
        return;
    }
    match checkpoint(d) {
        Ok(()) => {
            d.last_ckpt_mono = now_mono;
            println!("[zen-trafficd] checkpoint 完成（{} 台设备）", d.devs.len());
        }
        Err(e) => eprintln!("[zen-trafficd] checkpoint 失败: {e}"),
    }
}
