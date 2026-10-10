//! persistence.rs — SQLite 持久化（rusqlite bundled）。
//!
//! 设计（用户定案 + ARCHITECTURE §8 改版）：
//!   - 四张表：devices、daily_usage、monthly_usage、realtime_usage（WAN 5s 速率）；
//!   - RAM 是实时态，DB 是批量 checkpoint（默认 300s）+ 日切/月切 + SIGTERM 写入，
//!     严禁每秒写库；写事务一次性提交（单 transaction）；
//!   - 写入语义为**绝对值 upsert**（幂等，崩溃重放安全）；
//!   - 保留期：daily 90 天、monthly 12 个月，日切/月切时清理；
//!   - getHistory 直接查询本模块（不引入 JSON 历史层）。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::state::DevState;

pub struct Db {
    conn: Connection,
}

fn nonnegative(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| rusqlite::Error::FromSqlConversionFailure(
        index, rusqlite::types::Type::Integer, Box::new(error),
    ))
}

pub struct DeviceRow {
    pub mac: String,
    pub hostname: Option<String>,
    pub hostname_src: i64,
    pub ip4: Option<String>,
    pub ip6: Option<String>,
    pub last_seen: i64,
    pub rx_total: i64,
    pub tx_total: i64,
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use crate::wan::WanUsage;
    use zen_bpf::{DevStats, MacKey};
    use crate::accounting::{prepare_rollover, save, PendingPeriods};
    use std::collections::HashMap;

    #[test]
    #[cfg(unix)]
    fn opening_legacy_database_restricts_existing_wal_and_shm_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("zen-db-mode-{}-{}",std::process::id(),crate::state::now_mono_ms()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("traffic.db"); let filename = path.to_str().unwrap();
        let first = Db::open(filename).unwrap(); first.save_setting("fixture", "value").unwrap();
        let files = [filename.to_owned(),format!("{filename}-wal"),format!("{filename}-shm")];
        for file in &files { assert!(Path::new(file).exists());
            std::fs::set_permissions(file,std::fs::Permissions::from_mode(0o644)).unwrap(); }
        let reopened = Db::open(filename).unwrap();
        assert_eq!(reopened.setting("fixture").unwrap(),Some("value".into()));
        for file in &files { assert_eq!(std::fs::metadata(file).unwrap().permissions().mode() & 0o777,0o600); }
        drop(reopened); drop(first); std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_rollovers_preserve_old_periods_and_offline_usage_until_atomic_retry() {
        let db = Db::open(":memory:").unwrap();
        let mac = MacKey { b: [2, 0, 0, 0, 0, 9] };
        let key = mac_str(&mac.b);
        let mut device = DevState::new(mac, DevStats::default(), 1, 10, 20);
        device.rx_today = 10; device.tx_today = 20;
        device.rx_month = 10; device.tx_month = 20;
        db.checkpoint(&[&device], "2026-09-30", "2026-09", 1).unwrap();
        db.conn.execute("INSERT INTO daily_usage VALUES(?1,'2020-01-01',1,2)", params![key]).unwrap();
        db.conn.execute("INSERT INTO monthly_usage VALUES(?1,'2020-01',1,2)", params![key]).unwrap();
        // Traffic arrives before a full-storage month boundary, then goes offline.
        device.rx_today = 100; device.tx_today = 200;
        device.rx_month = 100; device.tx_month = 200;
        device.rx_total = 100; device.tx_total = 200;
        device.online = false;
        let mut devs = HashMap::from([(mac, device)]);
        let mut day = "2026-09-30".to_owned();
        let mut month = "2026-09".to_owned();
        let mut pending = PendingPeriods::default();
        let mut wan = WanUsage::load(&db, crate::state::MIN_SYNC_EPOCH).unwrap();
        wan.device_delta(mac, 33, 44);
        db.conn.execute_batch("CREATE TRIGGER reject_wan BEFORE INSERT ON wan_devices BEGIN SELECT RAISE(ABORT,'full storage'); END;").unwrap();
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-10-01", "2026-10").unwrap();
        assert_eq!((devs[&mac].rx_today, devs[&mac].rx_month), (0, 0));
        assert!(save(&db, &devs, &day, &month, &wan, &mut pending).is_err());
        assert_eq!(pending.days[&("2026-09-30".into(), key.clone())], (100, 200));
        assert_eq!(db.load_day("2026-09-30").unwrap(), [(key.clone(), 10, 20)]);
        assert!(db.load_day("2026-10-01").unwrap().is_empty());
        assert_eq!(db.lifetime_totals(), (10, 20));
        assert!(db.wan_window().unwrap().is_none());
        assert_eq!(db.load_day("2020-01-01").unwrap().len(), 1);
        assert_eq!(db.load_month("2020-01").unwrap().len(), 1);
        let d = devs.get_mut(&mac).unwrap();
        d.rx_today = 5; d.tx_today = 7; d.rx_month = 5; d.tx_month = 7;
        d.rx_total += 5; d.tx_total += 7;
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-10-02", "2026-10").unwrap();
        assert_eq!((devs[&mac].rx_today, devs[&mac].rx_month), (0, 5));
        assert!(save(&db, &devs, &day, &month, &wan, &mut pending).is_err());
        let d = devs.get_mut(&mac).unwrap();
        d.rx_today = 11; d.tx_today = 13; d.rx_month += 11; d.tx_month += 13;
        d.rx_total += 11; d.tx_total += 13;
        db.conn.execute_batch("DROP TRIGGER reject_wan").unwrap();
        for _ in 0..2 {
            save(&db, &devs, &day, &month, &wan, &mut pending).unwrap();
            assert!(pending.days.is_empty() && pending.months.is_empty());
            assert_eq!(db.load_day("2026-09-30").unwrap(), [(key.clone(), 100, 200)]);
            assert_eq!(db.load_day("2026-10-01").unwrap(), [(key.clone(), 5, 7)]);
            assert_eq!(db.load_day("2026-10-02").unwrap(), [(key.clone(), 11, 13)]);
            assert_eq!(db.load_month("2026-09").unwrap(), [(key.clone(), 100, 200)]);
            assert_eq!(db.load_month("2026-10").unwrap(), [(key.clone(), 16, 20)]);
            assert_eq!(db.lifetime_totals(), (116, 220));
            assert_eq!(db.wan_devices().unwrap(), [(key.clone(), 33, 44)]);
            assert!(db.load_day("2020-01-01").unwrap().is_empty());
            assert!(db.load_month("2020-01").unwrap().is_empty());
        }
    }

    #[test]
    fn reopened_intervals_restore_pending_values_and_reset_drops_closed_usage() {
        let db = Db::open(":memory:").unwrap();
        let mac = MacKey { b: [2, 0, 0, 0, 0, 10] };
        let key = mac_str(&mac.b);
        let mut device = DevState::new(mac, DevStats::default(), 1, 10, 20);
        device.rx_today = 10; device.tx_today = 20;
        device.rx_month = 10; device.tx_month = 20;
        db.checkpoint(&[&device], "2026-09-30", "2026-09", 1).unwrap();
        device.rx_today = 100; device.tx_today = 200;
        device.rx_month = 100; device.tx_month = 200;
        device.rx_total = 100; device.tx_total = 200;
        let mut devs = HashMap::from([(mac, device)]);
        let mut day = "2026-09-30".to_owned(); let mut month = "2026-09".to_owned();
        let mut pending = PendingPeriods::default();
        let wan = WanUsage::load(&db, crate::state::MIN_SYNC_EPOCH).unwrap();
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-10-01", "2026-10").unwrap();
        // Clock goes back before the pending old interval was saved.
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-09-30", "2026-09").unwrap();
        assert_eq!((devs[&mac].rx_today, devs[&mac].tx_today, devs[&mac].rx_month), (100, 200, 100));
        let d = devs.get_mut(&mac).unwrap();
        d.rx_today += 3; d.rx_month += 3; d.rx_total += 3;
        save(&db, &devs, &day, &month, &wan, &mut pending).unwrap();
        assert_eq!(db.load_day("2026-09-30").unwrap(), [(key.clone(), 103, 200)]);
        // Reopening after a commit restores SQLite, too.
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-10-01", "2026-10").unwrap();
        save(&db, &devs, &day, &month, &wan, &mut pending).unwrap();
        prepare_rollover(&db, &mut devs, &mut day, &mut month, &mut pending, "2026-09-30", "2026-09").unwrap();
        assert_eq!((devs[&mac].rx_today, devs[&mac].rx_month), (103, 103));
        db.reset_device(&key).unwrap();
        pending.remove_device(&key);
        let d = devs.get_mut(&mac).unwrap();
        d.rx_today = 0; d.tx_today = 0; d.rx_month = 0; d.tx_month = 0;
        d.rx_total = 0; d.tx_total = 0;
        save(&db, &devs, &day, &month, &wan, &mut pending).unwrap();
        assert_eq!(db.lifetime_totals(), (0, 0));
        assert!(db.load_day("2026-10-01").unwrap().is_empty());
        assert_eq!(db.load_day("2026-09-30").unwrap(), [(key, 0, 0)]);
    }

    #[test]
    fn failed_wan_write_rolls_back_legacy_and_window_counters_together() {
        let db = Db::open(":memory:").unwrap();
        let mac = MacKey { b: [2, 0, 0, 0, 0, 3] };
        let mut device = DevState::new(mac, DevStats::default(), 1, 10, 20);
        device.rx_today = 10;
        device.tx_today = 20;
        device.rx_month = 10;
        device.tx_month = 20;
        db.checkpoint(&[&device], "2026-10-03", "2026-10", 1).unwrap();
        let mut wan = WanUsage::load(&db, crate::state::MIN_SYNC_EPOCH).unwrap();
        wan.device_delta(mac, 30, 40);
        device.rx_total = 100;
        device.tx_total = 200;
        device.rx_today = 100;
        device.tx_today = 200;
        device.rx_month = 100;
        device.tx_month = 200;
        db.conn.execute_batch("CREATE TRIGGER reject_wan BEFORE INSERT ON wan_devices BEGIN SELECT RAISE(ABORT,'test full storage'); END;").unwrap();
        assert!(db.checkpoint_with_wan(&[&device], "2026-10-03", "2026-10", 2, &wan).is_err());
        assert_eq!(db.lifetime_totals(), (10, 20));
        assert_eq!(db.load_day("2026-10-03").unwrap(), [(mac_str(&mac.b), 10, 20)]);
        assert_eq!(db.load_month("2026-10").unwrap(), [(mac_str(&mac.b), 10, 20)]);
        assert!(db.wan_window().unwrap().is_none());
        assert!(db.wan_devices().unwrap().is_empty());

        db.conn.execute_batch("DROP TRIGGER reject_wan").unwrap();
        for _ in 0..2 {
            db.checkpoint_with_wan(&[&device], "2026-10-03", "2026-10", 3, &wan).unwrap();
            assert_eq!(db.lifetime_totals(), (100, 200));
            assert_eq!(db.load_day("2026-10-03").unwrap(), [(mac_str(&mac.b), 100, 200)]);
            assert_eq!(db.load_month("2026-10").unwrap(), [(mac_str(&mac.b), 100, 200)]);
            assert_eq!(db.wan_window().unwrap(), Some((crate::state::MIN_SYNC_EPOCH, 0, 0)));
            assert_eq!(db.wan_devices().unwrap(), [(mac_str(&mac.b), 30, 40)]);
        }
    }
}

impl Db {
    #[cfg(test)]
    pub fn conn_for_test_reject_settings(&self) {
        self.conn.execute_batch("CREATE TRIGGER reject_settings BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'full storage'); END;").unwrap();
    }
    #[cfg(test)]
    pub fn conn_for_test_reject_notification_delivery(&self) {
        self.conn.execute_batch("CREATE TRIGGER reject_settings BEFORE INSERT ON app_settings WHEN NEW.name='notifications_deliveries' BEGIN SELECT RAISE(ABORT,'full storage'); END;").unwrap();
    }
    #[cfg(test)]
    pub fn conn_for_test_allow_settings(&self) {
        self.conn.execute_batch("DROP TRIGGER reject_settings").unwrap();
    }
    pub fn open(path: &str) -> Result<Db, String> {
        if let Some(dir) = Path::new(path).parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开 {path} 失败: {e}"))?;
        #[cfg(unix)]
        if path != ":memory:" {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Unable to restrict database permissions".to_owned())?;
        }
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if path != ":memory:" {
            use std::os::unix::fs::PermissionsExt;
            for sidecar in [format!("{path}-wal"), format!("{path}-shm")] {
                if Path::new(&sidecar).exists() {
                    std::fs::set_permissions(sidecar, std::fs::Permissions::from_mode(0o600))
                        .map_err(|_| "Unable to restrict database journal permissions".to_owned())?;
                }
            }
        }
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                 mac          TEXT PRIMARY KEY,
                 hostname     TEXT,
                 hostname_src INTEGER NOT NULL DEFAULT 0,   -- 0=dhcp/探测 1=用户指定
                 last_ipv4    TEXT,
                 last_ipv6    TEXT,
                 first_seen   INTEGER NOT NULL DEFAULT 0,
                 last_seen    INTEGER NOT NULL DEFAULT 0,
                 rx_total     INTEGER NOT NULL DEFAULT 0,
                 tx_total     INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS daily_usage (
                 mac            TEXT NOT NULL,
                 date           TEXT NOT NULL,              -- 本地日期 YYYY-MM-DD
                 download_bytes INTEGER NOT NULL DEFAULT 0,
                 upload_bytes   INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (mac, date)
             );
             CREATE TABLE IF NOT EXISTS realtime_usage (
                 interface TEXT NOT NULL,
                 timestamp INTEGER NOT NULL,
                 download_rate INTEGER NOT NULL,
                 upload_rate INTEGER NOT NULL,
                 PRIMARY KEY (interface, timestamp)
             );
             CREATE INDEX IF NOT EXISTS realtime_usage_timestamp ON realtime_usage(timestamp);
             CREATE TABLE IF NOT EXISTS device_usage_hour (
                 mac TEXT NOT NULL, time INTEGER NOT NULL,
                 download INTEGER NOT NULL, upload INTEGER NOT NULL,
                 PRIMARY KEY(mac,time)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS device_usage_hour_time ON device_usage_hour(time);
             CREATE TABLE IF NOT EXISTS monthly_usage (
                 mac            TEXT NOT NULL,
                 month          TEXT NOT NULL,              -- 本地月份 YYYY-MM
                 download_bytes INTEGER NOT NULL DEFAULT 0,
                 upload_bytes   INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (mac, month)
             );
             CREATE TABLE IF NOT EXISTS wan_devices (
                 mac TEXT PRIMARY KEY,
                 download_bytes INTEGER NOT NULL DEFAULT 0,
                 upload_bytes INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS wan_daily (
                 date TEXT NOT NULL, mac TEXT NOT NULL,
                 download_bytes INTEGER NOT NULL, upload_bytes INTEGER NOT NULL,
                 PRIMARY KEY(date,mac)
             );
             CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS wan_window (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 since INTEGER NOT NULL,
                 download_bytes INTEGER NOT NULL DEFAULT 0,
                 upload_bytes INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|e| format!("建表失败: {e}"))?;
        // Hourly totals are already independent; retire only the obsolete detail table.
        conn.execute_batch(
            "BEGIN;
             DROP TABLE IF EXISTS device_usage_5m;
             DELETE FROM app_settings WHERE name='timeline_fine_floor';
             COMMIT;",
        ).map_err(|e| format!("清理旧分时明细失败: {e}"))?;
        Ok(Db { conn })
    }

    /// 启动恢复：设备属性 + 生命周期累计
    pub fn load_devices(&self) -> Result<Vec<DeviceRow>, String> {
        let mut st = self
            .conn
            .prepare(
                "SELECT mac, hostname, hostname_src, last_ipv4, last_ipv6,
                        last_seen, rx_total, tx_total FROM devices",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| {
                Ok(DeviceRow {
                    mac: r.get(0)?,
                    hostname: r.get(1)?,
                    hostname_src: r.get(2)?,
                    ip4: r.get(3)?,
                    ip6: r.get(4)?,
                    last_seen: r.get(5)?,
                    rx_total: r.get(6)?,
                    tx_total: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 启动恢复：指定日期的每设备累计（daemon 重启后接续今日累计）
    pub fn load_day(&self, date: &str) -> Result<Vec<(String, i64, i64)>, String> {
        self.load_kv("daily_usage", "date", date)
    }

    /// 启动恢复：指定月份的每设备累计
    pub fn load_month(&self, month: &str) -> Result<Vec<(String, i64, i64)>, String> {
        self.load_kv("monthly_usage", "month", month)
    }

    fn load_kv(
        &self,
        table: &str,
        col: &str,
        key: &str,
    ) -> Result<Vec<(String, i64, i64)>, String> {
        let sql = format!("SELECT mac, download_bytes, upload_bytes FROM {table} WHERE {col} = ?1");
        let mut st = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// checkpoint：一次事务内写入全部活跃设备 + 当日/当月累计（绝对值 upsert）。
    /// date/month 为当前本地日期/月份（RAM 累计所属区间）。
    pub fn checkpoint(
        &self,
        devs: &[&DevState],
        date: &str,
        month: &str,
        _now_epoch: i64,
    ) -> Result<(), String> {
        self.checkpoint_inner(devs, date, month, None, None)
    }

    pub fn checkpoint_with_wan(
        &self, devs: &[&DevState], date: &str, month: &str, _now_epoch: i64,
        wan: &crate::wan::WanUsage,
    ) -> Result<(), String> {
        self.checkpoint_inner(devs, date, month, Some(wan), None)
    }

    pub fn checkpoint_with_pending(
        &self, devs: &[&DevState], date: &str, month: &str,
        wan: &crate::wan::WanUsage, pending: &crate::accounting::PendingPeriods,
    ) -> Result<(), String> {
        self.checkpoint_inner(devs, date, month, Some(wan), Some(pending))
    }

    fn checkpoint_inner(
        &self, devs: &[&DevState], date: &str, month: &str,
        wan: Option<&crate::wan::WanUsage>,
        pending: Option<&crate::accounting::PendingPeriods>,
    ) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(pending) = pending {
            for (table, period_column, rows) in [
                ("daily_usage", "date", &pending.days),
                ("monthly_usage", "month", &pending.months),
            ] {
                let sql = format!("INSERT INTO {table}(mac,{period_column},download_bytes,upload_bytes)
                    VALUES(?1,?2,?3,?4) ON CONFLICT(mac,{period_column}) DO UPDATE SET
                    download_bytes=excluded.download_bytes,upload_bytes=excluded.upload_bytes");
                let mut insert = tx.prepare_cached(&sql).map_err(|e| e.to_string())?;
                for ((period, mac), (rx, tx_bytes)) in rows {
                    insert.execute(params![mac, period, *rx as i64, *tx_bytes as i64])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        // Current counters win if a clock adjustment reopens a pending period.
        for d in devs {
            let mac = mac_str(&d.mac.b);
            tx.execute(
                "INSERT INTO devices (mac, hostname, hostname_src, last_ipv4, last_ipv6,
                                      first_seen, last_seen, rx_total, tx_total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(mac) DO UPDATE SET
                     hostname     = COALESCE(?2, hostname),
                     hostname_src = MAX(hostname_src, ?3),
                     last_ipv4    = COALESCE(?4, last_ipv4),
                     last_ipv6    = COALESCE(?5, last_ipv6),
                     last_seen    = ?7,
                     rx_total     = ?8,
                     tx_total     = ?9",
                params![
                    mac,
                    d.host,
                    d.host_src as i64,
                    d.ip4,
                    d.ip6,
                    d.last_active as i64, // first_seen：仅插入时生效，冲突时保留原值
                    d.last_active as i64,
                    d.rx_total as i64,
                    d.tx_total as i64,
                ],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO daily_usage (mac, date, download_bytes, upload_bytes)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(mac, date) DO UPDATE SET
                     download_bytes = excluded.download_bytes,
                     upload_bytes   = excluded.upload_bytes",
                params![mac, date, d.rx_today as i64, d.tx_today as i64],
            )
            .map_err(|e| e.to_string())?;

            tx.execute(
                "INSERT INTO monthly_usage (mac, month, download_bytes, upload_bytes)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(mac, month) DO UPDATE SET
                     download_bytes = excluded.download_bytes,
                     upload_bytes   = excluded.upload_bytes",
                params![mac, month, d.rx_month as i64, d.tx_month as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(wan) = wan {
            let integer = |value: u64| value.min(i64::MAX as u64) as i64;
            tx.execute(
                "INSERT INTO wan_window (id,since,download_bytes,upload_bytes) VALUES (1,?1,?2,?3)
                 ON CONFLICT(id) DO UPDATE SET since=excluded.since,
                 download_bytes=excluded.download_bytes,upload_bytes=excluded.upload_bytes",
                params![integer(wan.since), integer(wan.interface.download), integer(wan.interface.upload)],
            ).map_err(|e| e.to_string())?;
            for (mac, download, upload) in wan.rows() {
                tx.execute(
                    "INSERT INTO wan_devices (mac,download_bytes,upload_bytes) VALUES (?1,?2,?3)
                     ON CONFLICT(mac) DO UPDATE SET download_bytes=excluded.download_bytes,
                     upload_bytes=excluded.upload_bytes",
                    params![mac, integer(download), integer(upload)],
                ).map_err(|e| e.to_string())?;
            }
            for ((day, mac), bytes) in &wan.daily {
                tx.execute("INSERT INTO wan_daily VALUES(?1,?2,?3,?4) ON CONFLICT(date,mac)
                    DO UPDATE SET download_bytes=excluded.download_bytes,upload_bytes=excluded.upload_bytes",
                    params![day, mac, integer(bytes.download), integer(bytes.upload)]).map_err(|e| e.to_string())?;
            }
            tx.execute("INSERT INTO app_settings VALUES('wan_daily_since',?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                params![wan.daily_since.to_string()]).map_err(|e| e.to_string())?;
            let cutoff = crate::state::date_shift(&wan.day, crate::state::RETENTION_DAYS);
            tx.execute("DELETE FROM wan_daily WHERE date < ?1", params![cutoff]).map_err(|e| e.to_string())?;
        }
        if let Some((before_day, before_month)) = pending.and_then(|p| p.prune_before.as_ref()) {
            tx.execute("DELETE FROM daily_usage WHERE date < ?1", params![before_day])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM monthly_usage WHERE month < ?1", params![before_month])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| format!("checkpoint 提交失败: {e}"))
    }

    /// Add pending deltas and clear expired/over-quota rows in one transaction.
    pub fn save_device_timeline(&self, timeline: &crate::timeline::DeviceTimeline, now: u64) -> Result<u64, String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let table = "device_usage_hour";
        let (floor, step) = (timeline.hour_floor, 3600);
        let cutoff = now.saturating_sub(crate::timeline::HOURLY_SECS).max(floor);
        let sql = format!("INSERT INTO {table}(mac,time,download,upload) VALUES(?1,?2,?3,?4)
            ON CONFLICT(mac,time) DO UPDATE SET
            download=MIN(9223372036854775807,download+excluded.download),
            upload=MIN(9223372036854775807,upload+excluded.upload)");
        {
            let mut insert = tx.prepare_cached(&sql).map_err(|e| e.to_string())?;
            for ((time, mac), bytes) in &timeline.hours {
                if time.saturating_add(step) <= cutoff || *time < floor { continue; }
                insert.execute(params![mac, *time as i64, bytes.download.min(i64::MAX as u64) as i64,
                    bytes.upload.min(i64::MAX as u64) as i64]).map_err(|e| e.to_string())?;
            }
        }
        tx.execute(&format!("DELETE FROM {table} WHERE time <= ?1 OR time < ?2"),
            params![cutoff.saturating_sub(step) as i64, floor as i64]).map_err(|e| e.to_string())?;
        let overflow: Option<i64> = tx.query_row(&format!(
            "SELECT MAX(time) FROM (SELECT time FROM {table} ORDER BY time,mac
             LIMIT MAX(0,(SELECT COUNT(*) FROM {table})-?1))"),
            params![crate::timeline::ROW_LIMIT as i64], |r| r.get(0)).map_err(|e| e.to_string())?;
        let kept_from = overflow.map(|time| (time.max(0) as u64).saturating_add(step)).unwrap_or(floor).max(floor);
        if overflow.is_some() {
            // Drop the complete boundary bucket: never present a partial quota-cut bucket as complete.
            tx.execute(&format!("DELETE FROM {table} WHERE time < ?1"), params![kept_from as i64]).map_err(|e| e.to_string())?;
        }
        tx.execute("INSERT INTO app_settings VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
            params!["timeline_hour_floor", kept_from.to_string()]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO app_settings VALUES('timeline_since',?1) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
            params![timeline.since.to_string()]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(kept_from)
    }

    pub fn device_timeline(&self, mac: &str, start: u64, end: u64) -> Result<Vec<(u64,crate::wan::Bytes)>, String> {
        let mut query = self.conn.prepare("SELECT time,download,upload FROM device_usage_hour
            WHERE mac=?1 AND time>=?2 AND time<?3 ORDER BY time LIMIT 25").map_err(|e| e.to_string())?;
        let rows = query.query_map(params![mac,start as i64,end as i64], |r| Ok((nonnegative(r,0)?, crate::wan::Bytes {
            download:nonnegative(r,1)?, upload:nonnegative(r,2)?,
        }))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn wan_window(&self) -> Result<Option<(u64, u64, u64)>, String> {
        self.conn.query_row("SELECT since,download_bytes,upload_bytes FROM wan_window WHERE id=1", [],
            |r| Ok((nonnegative(r, 0)?, nonnegative(r, 1)?, nonnegative(r, 2)?))).optional().map_err(|e| e.to_string())
    }

    pub fn wan_daily(&self) -> Result<std::collections::BTreeMap<(String, String), crate::wan::Bytes>, String> {
        let mut query = self.conn.prepare("SELECT date,mac,download_bytes,upload_bytes FROM wan_daily").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), crate::wan::Bytes {
            download: nonnegative(r, 2)?, upload: nonnegative(r, 3)?,
        }))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn setting(&self, name: &str) -> Result<Option<String>, String> {
        self.conn.query_row("SELECT value FROM app_settings WHERE name=?1", params![name], |r| r.get(0))
            .optional().map_err(|e| e.to_string())
    }

    pub fn save_setting(&self, name: &str, value: &str) -> Result<(), String> {
        self.conn.execute("INSERT INTO app_settings VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
            params![name, value]).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn save_settings(&self, values: &[(&str, String)]) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|_| "Unable to save settings".to_owned())?;
        for (name, value) in values {
            tx.execute("INSERT INTO app_settings VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                params![name, value]).map_err(|_| "Unable to save settings".to_owned())?;
        }
        tx.commit().map_err(|_| "Unable to save settings".to_owned())
    }

    pub fn wan_devices(&self) -> Result<Vec<(String, u64, u64)>, String> {
        let mut query = self.conn.prepare("SELECT mac,download_bytes,upload_bytes FROM wan_devices").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |r| Ok((r.get(0)?, nonnegative(r, 1)?, nonnegative(r, 2)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 日切仅清理日记录；保留截止日期本身。
    pub fn prune_days(&self, before_date: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM daily_usage WHERE date < ?1", params![before_date])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// 月切仅清理月记录；保留截止月份本身。
    pub fn prune_months(&self, before_month: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM monthly_usage WHERE month < ?1", params![before_month])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Persist a batch and prune the seven-day window in the same transaction.
    pub fn save_realtime(&self, samples: &[crate::realtime::Sample], cutoff: u64) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO realtime_usage (interface, timestamp, download_rate, upload_rate)
                 VALUES (?1, ?2, ?3, ?4) ON CONFLICT(interface, timestamp) DO UPDATE SET
                 download_rate = excluded.download_rate, upload_rate = excluded.upload_rate"
            ).map_err(|e| e.to_string())?;
            for sample in samples {
                if sample.time < cutoff { continue; }
                insert.execute(params![sample.interface, sample.time as i64,
                    sample.download.min(i64::MAX as u64) as i64,
                    sample.upload.min(i64::MAX as u64) as i64]).map_err(|e| e.to_string())?;
            }
        }
        tx.execute("DELETE FROM realtime_usage WHERE timestamp < ?1", params![cutoff as i64])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn realtime_interfaces(&self) -> Result<Vec<String>, String> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT interface FROM realtime_usage ORDER BY interface")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// One interface, at most limit buckets; return sums/counts to merge pending RAM samples.
    pub fn realtime_buckets(&self, interface: &str, start: u64, end: u64, step: u64,
        pending_from: u64) -> Result<Vec<(u64, u64, u64, u64)>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT ((timestamp - ?2) / ?4) * ?4 + ?2 AS bucket,
                    SUM(download_rate), SUM(upload_rate), COUNT(*)
             FROM realtime_usage WHERE interface = ?1 AND timestamp >= ?2
                  AND timestamp <= ?3 AND timestamp < ?5
             GROUP BY bucket ORDER BY bucket"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![interface, start as i64, end as i64, step as i64, pending_from as i64],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64,
                r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// setHostname：用户指定名（src=1，合并且优先）
    pub fn set_hostname(&self, mac: &str, host: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO devices (mac, hostname, hostname_src) VALUES (?1, ?2, 1)
                 ON CONFLICT(mac) DO UPDATE SET hostname = ?2, hostname_src = 1",
                params![mac, host],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// resetDevice：删除设备及其全部累计
    pub fn reset_device(&self, mac: &str) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx
            .execute("DELETE FROM devices WHERE mac = ?1", params![mac])
            .map_err(|e| e.to_string())?;
        tx
            .execute("DELETE FROM daily_usage WHERE mac = ?1", params![mac])
            .map_err(|e| e.to_string())?;
        tx
            .execute("DELETE FROM monthly_usage WHERE mac = ?1", params![mac])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM wan_devices WHERE mac=?1", params![mac]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM wan_daily WHERE mac=?1", params![mac]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM device_usage_hour WHERE mac=?1", params![mac]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// getHistory：按日聚合（mac=None 时全设备 SUM），范围 [start,end]（含端点）
    pub fn history_days(
        &self,
        mac: Option<&str>,
        start: &str,
        end: &str,
    ) -> Result<Vec<(String, i64, i64)>, String> {
        self.history_kv("daily_usage", "date", mac, start, end)
    }

    /// getHistory：按月聚合
    pub fn history_months(
        &self,
        mac: Option<&str>,
        start: &str,
        end: &str,
    ) -> Result<Vec<(String, i64, i64)>, String> {
        self.history_kv("monthly_usage", "month", mac, start, end)
    }

    fn history_kv(
        &self,
        table: &str,
        col: &str,
        mac: Option<&str>,
        start: &str,
        end: &str,
    ) -> Result<Vec<(String, i64, i64)>, String> {
        let sql = match mac {
            Some(_) => format!(
                "SELECT {col}, download_bytes, upload_bytes FROM {table}
                 WHERE mac = ?1 AND {col} >= ?2 AND {col} <= ?3 ORDER BY {col}"
            ),
            None => format!(
                "SELECT {col}, SUM(download_bytes), SUM(upload_bytes) FROM {table}
                 WHERE {col} >= ?2 AND {col} <= ?3 GROUP BY {col} ORDER BY {col}"
            ),
        };
        let mut st = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![mac.unwrap_or(""), start, end], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 全局生命周期累计（getTotal.rx_total/tx_total）
    pub fn lifetime_totals(&self) -> (u64, u64) {
        let r: Option<i64> = self
            .conn
            .query_row("SELECT SUM(rx_total) FROM devices", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        let t: Option<i64> = self
            .conn
            .query_row("SELECT SUM(tx_total) FROM devices", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        (r.unwrap_or(0).max(0) as u64, t.unwrap_or(0).max(0) as u64)
    }
}

pub fn mac_str(mac: &[u8; 6]) -> String {
    mac.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":")
}
