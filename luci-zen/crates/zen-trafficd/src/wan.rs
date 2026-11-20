//! Internet-only accounting. Old WAN+LAN history is never backfilled into this ledger.
use std::collections::{BTreeMap, HashMap};
use zen_bpf::MacKey;
use crate::persistence::{mac_str, Db};

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Bytes {
    pub download: u64,
    pub upload: u64,
}

#[derive(Default)]
pub struct PeriodSummary {
    pub interface: Bytes,
    pub devices: BTreeMap<String, Bytes>,
}

pub struct WanPeriods {
    pub today: String,
    pub since: u64,
    pub day: PeriodSummary,
    pub week: PeriodSummary,
    pub month: PeriodSummary,
}

fn parse_ymd(date: &str) -> Option<(i64, i64, i64)> {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return None;
    }
    let y: i64 = date[0..4].parse().ok()?;
    let m: i64 = date[5..7].parse().ok()?;
    let d: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn week_start_date(today: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(today)?;
    let adj_y = y - i64::from(m <= 2);
    let era = adj_y.div_euclid(400);
    let yoe = adj_y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    // 1970-01-01 was Thursday (Mon=0..Sun=6 => 3).
    let offset = (days + 3).rem_euclid(7) as u32;
    Some(crate::state::date_shift(today, offset))
}

pub struct WanUsage {
    pub since: u64,
    pub interface: Bytes,
    pub devices: HashMap<MacKey, Bytes>,
    /// Internet-only calendar days, including unsaved closed days. Empty MAC is
    /// the upstream interface total; never SUM it with attributed device rows.
    pub daily: BTreeMap<(String, String), Bytes>,
    pub daily_since: u64,
    pub day: String,
    pub day_synced: bool,
}

impl WanUsage {
    pub fn load(db: &Db, now: u64) -> Result<Self, String> {
        let synced = crate::state::time_synced(now);
        let mut usage = Self { since: if synced { now } else { 0 }, interface: Bytes::default(), devices: HashMap::new(),
            daily: db.wan_daily()?, daily_since: db.setting("wan_daily_since")?.and_then(|s| s.parse().ok()).unwrap_or(if synced { now } else { 0 }),
            day: crate::state::local_date(now), day_synced: synced };
        usage.prune_daily();
        if let Some((since, download, upload)) = db.wan_window()? {
            usage.since = since;
            usage.interface = Bytes { download, upload };
        }
        for (mac, download, upload) in db.wan_devices()? {
            if let Some(mac) = crate::daemon::parse_mac(&mac) {
                usage.devices.insert(mac, Bytes { download, upload });
            }
        }
        Ok(usage)
    }

    pub fn device_delta(&mut self, mac: MacKey, download: u64, upload: u64) {
        if self.since == 0 { return; }
        let bytes = self.devices.entry(mac).or_default();
        bytes.download = bytes.download.saturating_add(download);
        bytes.upload = bytes.upload.saturating_add(upload);
        self.daily_delta(mac_str(&mac.b), download, upload);
    }

    pub fn interface_delta(&mut self, download: u64, upload: u64) {
        if self.since == 0 { return; }
        self.interface.download = self.interface.download.saturating_add(download);
        self.interface.upload = self.interface.upload.saturating_add(upload);
        self.daily_delta(String::new(), download, upload);
    }

    fn daily_delta(&mut self, mac: String, download: u64, upload: u64) {
        if self.daily_since == 0 || !self.day_synced { return; }
        let bytes = self.daily.entry((self.day.clone(), mac)).or_default();
        bytes.download = bytes.download.saturating_add(download);
        bytes.upload = bytes.upload.saturating_add(upload);
    }

    fn prune_daily(&mut self) {
        let cutoff = crate::state::date_shift(&self.day, crate::state::RETENTION_DAYS);
        self.daily.retain(|(day, _), _| day >= &cutoff);
    }

    pub fn set_day(&mut self, now: u64) {
        self.day_synced = crate::state::time_synced(now);
        if !self.day_synced { return; }
        if self.daily_since == 0 { self.daily_since = now; }
        let day = crate::state::local_date(now);
        if self.day != day { self.day = day; self.prune_daily(); }
    }

    pub fn today(&self, mac: &str) -> Bytes {
        self.daily.get(&(self.day.clone(), mac.to_owned())).copied().unwrap_or_default()
    }

    pub fn remove_device(&mut self, mac: MacKey) {
        self.devices.remove(&mac);
        let key = mac_str(&mac.b);
        self.daily.retain(|(_, device), _| device != &key);
    }

    pub fn periods(&self) -> Option<WanPeriods> {
        if self.daily_since == 0 || !self.day_synced {
            return None;
        }
        let today = self.day.as_str();
        let week_start = week_start_date(today)?;
        let month_start = format!("{}-01", &today[..7]);
        let earliest = if week_start.as_str() < month_start.as_str() {
            week_start.as_str()
        } else {
            month_start.as_str()
        };
        let mut day = PeriodSummary::default();
        let mut week = PeriodSummary::default();
        let mut month = PeriodSummary::default();
        for ((date, mac), bytes) in &self.daily {
            if date.as_str() > today || date.as_str() < earliest {
                continue;
            }
            let targets: [(&mut PeriodSummary, bool); 3] = [
                (&mut day, date.as_str() == today),
                (&mut week, date.as_str() >= week_start.as_str()),
                (&mut month, date.as_str() >= month_start.as_str()),
            ];
            if mac.is_empty() {
                for (summary, active) in targets {
                    if active {
                        summary.interface.download =
                            summary.interface.download.saturating_add(bytes.download);
                        summary.interface.upload =
                            summary.interface.upload.saturating_add(bytes.upload);
                    }
                }
            } else if bytes.download > 0 || bytes.upload > 0 {
                for (summary, active) in targets {
                    if active {
                        let entry = summary.devices.entry(mac.clone()).or_default();
                        entry.download = entry.download.saturating_add(bytes.download);
                        entry.upload = entry.upload.saturating_add(bytes.upload);
                    }
                }
            }
        }
        Some(WanPeriods {
            today: self.day.clone(),
            since: self.daily_since,
            day,
            week,
            month,
        })
    }

    pub fn history(&self, agg: &str, mac: &str) -> serde_json::Value {
        self.history_with_devices(agg, mac, false)
    }

    pub fn history_with_devices(
        &self,
        agg: &str,
        mac: &str,
        include_devices: bool,
    ) -> serde_json::Value {
        let collect_devices = include_devices && agg == "day" && mac.is_empty();
        let mut periods = BTreeMap::<String, Bytes>::new();
        let mut by_device = BTreeMap::<String, Bytes>::new();
        let mut per_device_days = BTreeMap::<&str, Vec<(&str, Bytes)>>::new();
        for ((date, device), bytes) in &self.daily {
            if device == mac {
                let key = if agg == "month" {
                    date.get(..7).unwrap_or(date.as_str())
                } else {
                    date.as_str()
                };
                let total = periods.entry(key.to_owned()).or_default();
                total.download = total.download.saturating_add(bytes.download);
                total.upload = total.upload.saturating_add(bytes.upload);
            }
            let b = by_device.entry(device.clone()).or_default();
            b.download = b.download.saturating_add(bytes.download);
            b.upload = b.upload.saturating_add(bytes.upload);
            if collect_devices && !device.is_empty() && (bytes.download > 0 || bytes.upload > 0) {
                per_device_days
                    .entry(device.as_str())
                    .or_default()
                    .push((date.as_str(), *bytes));
            }
        }
        let rows: Vec<_> = periods
            .into_iter()
            .map(|(date, bytes)| {
                if agg == "month" {
                    serde_json::json!({"month":date,"download":bytes.download,"upload":bytes.upload})
                } else {
                    serde_json::json!({"date":date,"download":bytes.download,"upload":bytes.upload})
                }
            })
            .collect();
        // Month totals cover the daily ledger's retained 90-day window only.
        let mut result = if agg == "month" {
            serde_json::json!({"agg":agg,"months":rows,"since":self.daily_since,"retention_days":90})
        } else {
            serde_json::json!({"agg":agg,"days":rows,"since":self.daily_since,"retention_days":90})
        };
        if self.day_synced && parse_ymd(&self.day).is_some() {
            result["today"] = serde_json::json!(self.day);
        }
        let network = by_device.remove("").unwrap_or_default();
        let attributed = by_device.values().fold(Bytes::default(), |mut b, v| {
            b.download = b.download.saturating_add(v.download);
            b.upload = b.upload.saturating_add(v.upload);
            b
        });
        let mut ranking: Vec<_> = by_device.into_iter().collect();
        ranking.sort_by_key(|(_, b)| std::cmp::Reverse(b.upload.saturating_add(b.download)));
        result["ranking"] = serde_json::json!(
            ranking
                .iter()
                .map(|(mac, b)| serde_json::json!({"mac":mac,"upload":b.upload,"download":b.download}))
                .collect::<Vec<_>>()
        );
        for (key, value) in [
            ("network_upload", network.upload),
            ("network_download", network.download),
            (
                "unassigned_upload",
                network.upload.saturating_sub(attributed.upload),
            ),
            (
                "unassigned_download",
                network.download.saturating_sub(attributed.download),
            ),
            (
                "excess_upload",
                attributed.upload.saturating_sub(network.upload),
            ),
            (
                "excess_download",
                attributed.download.saturating_sub(network.download),
            ),
        ] {
            result[key] = serde_json::json!(value);
        }
        if collect_devices {
            const MAX_DEVICE_DAYS_BYTES: usize = 512 * 1024;
            let mut device_days = serde_json::Map::new();
            let mut used_bytes = 2usize;
            let mut complete = true;
            for (dev_mac, _) in &ranking {
                let rows = per_device_days
                    .get(dev_mac.as_str())
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let encoded = serde_json::Value::Array(
                    rows.iter()
                        .map(|(date, b)| serde_json::json!([date, b.download, b.upload]))
                        .collect(),
                );
                let entry_bytes = dev_mac.len() + 6 + encoded.to_string().len();
                if !device_days.is_empty() && used_bytes + entry_bytes > MAX_DEVICE_DAYS_BYTES {
                    complete = false;
                    break;
                }
                used_bytes += entry_bytes;
                device_days.insert(dev_mac.clone(), encoded);
            }
            result["device_days"] = serde_json::Value::Object(device_days);
            result["devices_complete"] = serde_json::json!(complete);
        }
        result
    }

    pub fn attributed(&self) -> Bytes {
        self.devices.values().fold(Bytes::default(), |mut total, bytes| {
            total.download = total.download.saturating_add(bytes.download);
            total.upload = total.upload.saturating_add(bytes.upload);
            total
        })
    }

    pub fn rows(&self) -> Vec<(String, u64, u64)> {
        self.devices.iter().map(|(mac, bytes)| (mac_str(&mac.b), bytes.download, bytes.upload)).collect()
    }

    pub fn begin_if_synced(&mut self, now: u64) -> bool {
        if self.since == 0 && crate::state::time_synced(now) {
            self.since = now;
            self.set_day(now);
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DevState;
    use zen_bpf::DevStats;

    #[test]
    fn daily_wan_survives_failed_rollover_checkpoint_restart_and_clock_reopen() {
        let db = Db::open(":memory:").unwrap();
        let epoch = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mac = MacKey { b: [2, 0, 0, 0, 0, 7] };
        let key = mac_str(&mac.b);
        let mut wan = WanUsage::load(&db, epoch).unwrap();
        let first_day = wan.day.clone();
        wan.device_delta(mac, 100, 20); wan.interface_delta(120, 25);
        db.checkpoint_with_wan(&[], &first_day, "2024-01", 0, &wan).unwrap();
        // A failed batch must not partially save a new day's internet counters.
        db.conn_for_test_reject_settings();
        wan.set_day(epoch + 86400); let second_day = wan.day.clone();
        wan.device_delta(mac, 200, 30); wan.interface_delta(240, 35);
        assert!(db.checkpoint_with_wan(&[], &second_day, "2024-01", 0, &wan).is_err());
        assert!(!db.wan_daily().unwrap().contains_key(&(second_day.clone(), key.clone())));
        db.conn_for_test_allow_settings();
        db.checkpoint_with_wan(&[], &second_day, "2024-01", 0, &wan).unwrap();
        let mut restored = WanUsage::load(&db, epoch + 86400).unwrap();
        assert_eq!(restored.today(&key), Bytes { download:200, upload:30 });
        restored.set_day(epoch); restored.device_delta(mac, 1, 2);
        assert_eq!(restored.today(&key), Bytes { download:101, upload:22 });
        db.checkpoint_with_wan(&[], &first_day, "2024-01", 0, &restored).unwrap();
        assert_eq!(restored.history("day", "")["ranking"][0]["download"], 301);
        assert_eq!(restored.history("day", "")["network_download"], 360);
        let mut unsynced = WanUsage::load(&db, 0).unwrap();
        let before = unsynced.daily.clone();
        unsynced.device_delta(mac, 999, 999); unsynced.interface_delta(999, 999);
        assert_eq!(unsynced.daily, before,"Restored lifetime counters must not enable calendar writes before clock sync");
        unsynced.set_day(epoch); unsynced.device_delta(mac,1,1);
        assert!(unsynced.today(&key).download > 0);
        assert_eq!(restored.history("day", "")["unassigned_download"], 59);
        db.reset_device(&key).unwrap(); restored.remove_device(mac);
        db.checkpoint_with_wan(&[], &first_day, "2024-01", 0, &restored).unwrap();
        assert!(db.wan_daily().unwrap().keys().all(|(_, device)| device != &key));
        assert_eq!(restored.history("day", "")["network_download"], 360);
    }

    #[test]
    fn migration_starts_empty_then_restores_only_wan_after_checkpoint() {
        let db = Db::open(":memory:").unwrap();
        let mac = MacKey { b: [2, 0, 0, 0, 0, 1] };
        let device = DevState::new(mac, DevStats::default(), 100, 9000, 5000);
        db.checkpoint(&[&device], "2026-10-03", "2026-10", 100).unwrap();
        let epoch = crate::state::MIN_SYNC_EPOCH + 200;
        let mut wan = WanUsage::load(&db, epoch).unwrap();
        assert_eq!(wan.attributed(), Bytes::default());
        wan.device_delta(mac, 100, 20);
        wan.interface_delta(120, 25);
        db.checkpoint_with_wan(&[&device], "2026-10-03", "2026-10", 201, &wan).unwrap();
        let restored = WanUsage::load(&db, 300).unwrap();
        assert_eq!(restored.since, epoch);
        assert_eq!(restored.attributed(), Bytes { download: 100, upload: 20 });
        assert_eq!(restored.interface, Bytes { download: 120, upload: 25 });
        assert_eq!(db.lifetime_totals(), (9000, 5000));
        db.reset_device("02:00:00:00:00:01").unwrap();
        assert_eq!(WanUsage::load(&db, 400).unwrap().attributed(), Bytes::default());
    }

    #[test]
    fn unsynchronised_start_does_not_record_a_false_collection_date() {
        let db = Db::open(":memory:").unwrap();
        let mut wan = WanUsage::load(&db, 0).unwrap();
        let mac = MacKey { b: [2, 0, 0, 0, 0, 2] };
        wan.device_delta(mac, 500, 300);
        wan.interface_delta(500, 300);
        assert_eq!(wan.since, 0);
        assert_eq!(wan.attributed(), Bytes::default());
        assert!(wan.begin_if_synced(crate::state::MIN_SYNC_EPOCH));
        assert!(!wan.begin_if_synced(crate::state::MIN_SYNC_EPOCH + 1));
        wan.device_delta(mac, 40, 10);
        assert_eq!(wan.attributed(), Bytes { download: 40, upload: 10 });
    }

    #[test]
    fn periods_and_batched_history_handle_cross_month_weeks_and_compact_rows() {
        let db = Db::open(":memory:").unwrap();
        let epoch = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mac1 = "02:00:00:00:00:11".to_owned();
        let mac2 = "02:00:00:00:00:12".to_owned();
        let mut wan = WanUsage::load(&db, epoch).unwrap();
        wan.day = "2026-11-01".to_owned(); // Sunday; week starts 2026-10-26, month starts 2026-11-01
        wan.day_synced = true;
        wan.daily_since = epoch;

        assert_eq!(week_start_date("2026-11-01").as_deref(), Some("2026-10-26"));
        assert_eq!(week_start_date("2026-11-20").as_deref(), Some("2026-11-16"));

        wan.daily.insert(("2026-10-25".into(), String::new()), Bytes { download: 1000, upload: 100 });
        wan.daily.insert(("2026-10-25".into(), mac1.clone()), Bytes { download: 900, upload: 90 });
        wan.daily.insert(("2026-10-28".into(), String::new()), Bytes { download: 300, upload: 30 });
        wan.daily.insert(("2026-10-28".into(), mac1.clone()), Bytes { download: 250, upload: 25 });
        wan.daily.insert(("2026-11-01".into(), String::new()), Bytes { download: 500, upload: 50 });
        wan.daily.insert(("2026-11-01".into(), mac1.clone()), Bytes { download: 400, upload: 40 });
        wan.daily.insert(("2026-11-01".into(), mac2.clone()), Bytes { download: 80, upload: 8 });
        // Future date should be ignored by periods()
        wan.daily.insert(("2026-11-02".into(), String::new()), Bytes { download: 9999, upload: 999 });

        let p = wan.periods().expect("periods available");
        assert_eq!(p.today, "2026-11-01");
        assert_eq!(p.day.interface, Bytes { download: 500, upload: 50 });
        assert_eq!(p.day.devices.get(&mac1).copied(), Some(Bytes { download: 400, upload: 40 }));
        assert_eq!(p.day.devices.get(&mac2).copied(), Some(Bytes { download: 80, upload: 8 }));
        assert_eq!(p.week.interface, Bytes { download: 800, upload: 80 });
        assert_eq!(p.week.devices.get(&mac1).copied(), Some(Bytes { download: 650, upload: 65 }));
        assert_eq!(p.month.interface, Bytes { download: 500, upload: 50 });
        assert_eq!(p.month.devices.get(&mac1).copied(), Some(Bytes { download: 400, upload: 40 }));

        let plain = wan.history("day", "");
        assert_eq!(plain["today"], "2026-11-01");
        assert!(plain.get("device_days").is_none());

        let batched = wan.history_with_devices("day", "", true);
        assert_eq!(batched["today"], "2026-11-01");
        assert_eq!(batched["devices_complete"], true);
        assert_eq!(
            batched["device_days"][&mac1],
            serde_json::json!([
                ["2026-10-25", 900, 90],
                ["2026-10-28", 250, 25],
                ["2026-11-01", 400, 40]
            ])
        );
        assert_eq!(
            batched["device_days"][&mac2],
            serde_json::json!([["2026-11-01", 80, 8]])
        );
    }
}
