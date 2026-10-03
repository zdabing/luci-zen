//! accounting.rs — 每 MAC 日/月累计、日切/月切、checkpoint、保留期清理。
//!
//! 写盘时机（用户定案，红线：不允许每秒写库）：
//!   - 每 checkpoint_secs（默认 300s）批量事务一次；
//!   - 跨天/跨月立即写；
//!   - daemon 正常退出（SIGTERM）立即写。
//! 写入为绝对值 upsert，崩溃重放安全。
//! 全局当前用量由 ubus.rs 汇总设备 RAM，持久化仍保持批量事务。

use crate::daemon::Daemon;
use std::collections::{BTreeMap, HashMap};
use crate::{persistence::{Db, mac_str}, state::DevState, wan::WanUsage};
use zen_bpf::MacKey;
use crate::state::{date_shift, local_date, local_month, month_shift, now_epoch, time_synced, now_mono_ms, RETENTION_DAYS, RETENTION_MONTHS};

/// Closed interval absolute values stay in RAM until the entire batch commits.
#[derive(Default)]
pub struct PendingPeriods {
    pub days: BTreeMap<(String, String), (u64, u64)>,
    pub months: BTreeMap<(String, String), (u64, u64)>,
    pub prune_before: Option<(String, String)>,
}

impl PendingPeriods {
    pub fn remove_device(&mut self, mac: &str) {
        self.days.retain(|(_, device), _| device != mac);
        self.months.retain(|(_, device), _| device != mac);
    }
}

/// Switch RAM intervals even while writes fail; reopening an interval restores
/// its latest pending or persisted absolute value instead of overwriting it.
pub(crate) fn prepare_rollover(
    db: &Db, devs: &mut HashMap<MacKey, DevState>,
    day: &mut String, month: &mut String, pending: &mut PendingPeriods,
    today: &str, this_month: &str,
) -> Result<bool, String> {
    let change_day = today != day.as_str();
    let change_month = this_month != month.as_str();
    if !change_day && !change_month { return Ok(false); }
    // Complete fallible reads before changing any RAM counter.
    let restored_days: HashMap<_, _> = if change_day { db.load_day(today)?.into_iter()
        .map(|(mac, rx, tx)| (mac, (rx.max(0) as u64, tx.max(0) as u64))).collect()
    } else { HashMap::new() };
    let restored_months: HashMap<_, _> = if change_month { db.load_month(this_month)?.into_iter()
        .map(|(mac, rx, tx)| (mac, (rx.max(0) as u64, tx.max(0) as u64))).collect()
    } else { HashMap::new() };
    for s in devs.values_mut() {
        let mac = mac_str(&s.mac.b);
        if change_day {
            pending.days.insert((day.clone(), mac.clone()), (s.rx_today, s.tx_today));
            (s.rx_today, s.tx_today) = pending.days.get(&(today.to_owned(), mac.clone()))
                .or_else(|| restored_days.get(&mac)).copied().unwrap_or_default();
        }
        if change_month {
            pending.months.insert((month.clone(), mac.clone()), (s.rx_month, s.tx_month));
            (s.rx_month, s.tx_month) = pending.months.get(&(this_month.to_owned(), mac.clone()))
                .or_else(|| restored_months.get(&mac)).copied().unwrap_or_default();
        }
    }
    let before_day = date_shift(today, RETENTION_DAYS);
    let before_month = month_shift(this_month, RETENTION_MONTHS);
    pending.days.retain(|(period, _), _| period >= &before_day);
    pending.months.retain(|(period, _), _| period >= &before_month);
    pending.prune_before = Some((before_day, before_month));
    *day = today.to_owned();
    *month = this_month.to_owned();
    Ok(true)
}

pub(crate) fn save(
    db: &Db, devs: &HashMap<MacKey, DevState>, day: &str, month: &str,
    wan: &WanUsage, pending: &mut PendingPeriods,
) -> Result<(), String> {
    // Inactivity is a presentation property, not evidence that RAM is saved.
    let devices: Vec<_> = devs.values().collect();
    db.checkpoint_with_pending(&devices, day, month, wan, pending)?;
    *pending = PendingPeriods::default();
    Ok(())
}

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

    let old_day = d.cur_day.clone();
    let old_month = d.cur_month.clone();
    if let Err(e) = prepare_rollover(&d.db, &mut d.devs, &mut d.cur_day, &mut d.cur_month,
        &mut d.pending_periods, &today, &month) {
        eprintln!("[zen-trafficd] 区间恢复失败: {e}");
        return;
    }
    println!("[zen-trafficd] 区间切换 {old_day}/{old_month} → {today}/{month}");
    // Include the closed and new intervals atomically; failure keeps the queue.
    d.last_ckpt_mono = now_mono_ms();
    if let Err(e) = checkpoint(d) {
        eprintln!("[zen-trafficd] 切换 checkpoint 失败（保留旧区间）: {e}");
    }
}

/// 批量 checkpoint：全部 RAM 设备与未提交区间，一次事务。
pub fn checkpoint(d: &mut Daemon) -> Result<(), String> {
    save(&d.db, &d.devs, &d.cur_day, &d.cur_month, &d.wan, &mut d.pending_periods)
}

/// 定期 checkpoint 入口；失败也按配置周期重试，避免每 tick 写满盘并刷日志。
pub fn checkpoint_tick(d: &mut Daemon) {
    let now_mono = now_mono_ms();
    if now_mono.saturating_sub(d.last_ckpt_mono) < d.cfg.checkpoint_secs * 1000 {
        return;
    }
    // RAM absolute counters continue accumulating when a transaction fails.
    // Rate-limit attempts as well as successful writes; the next batch retries all usage.
    d.last_ckpt_mono = now_mono;
    match checkpoint(d) {
        Ok(()) => {
            println!("[zen-trafficd] checkpoint 完成（{} 台设备）", d.devs.len());
        }
        Err(e) => eprintln!("[zen-trafficd] checkpoint 失败: {e}"),
    }
}
