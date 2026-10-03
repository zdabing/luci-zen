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
    pub fn open(path: &str) -> Result<Db, String> {
        if let Some(dir) = Path::new(path).parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("创建 {} 失败: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("打开 {path} 失败: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
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
             CREATE TABLE IF NOT EXISTS wan_window (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 since INTEGER NOT NULL,
                 download_bytes INTEGER NOT NULL DEFAULT 0,
                 upload_bytes INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|e| format!("建表失败: {e}"))?;
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
        self.checkpoint_inner(devs, date, month, None)
    }

    pub fn checkpoint_with_wan(
        &self, devs: &[&DevState], date: &str, month: &str, _now_epoch: i64,
        wan: &crate::wan::WanUsage,
    ) -> Result<(), String> {
        self.checkpoint_inner(devs, date, month, Some(wan))
    }

    fn checkpoint_inner(
        &self, devs: &[&DevState], date: &str, month: &str,
        wan: Option<&crate::wan::WanUsage>,
    ) -> Result<(), String> {
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
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
        }
        tx.commit().map_err(|e| format!("checkpoint 提交失败: {e}"))
    }

    pub fn wan_window(&self) -> Result<Option<(u64, u64, u64)>, String> {
        self.conn.query_row("SELECT since,download_bytes,upload_bytes FROM wan_window WHERE id=1", [],
            |r| Ok((nonnegative(r, 0)?, nonnegative(r, 1)?, nonnegative(r, 2)?))).optional().map_err(|e| e.to_string())
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
