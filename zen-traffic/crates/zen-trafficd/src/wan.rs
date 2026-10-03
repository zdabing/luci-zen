//! Internet-only accounting. Old WAN+LAN history is never backfilled into this ledger.
use std::collections::{BTreeMap, HashMap};
use zen_bpf::MacKey;
use crate::persistence::{mac_str, Db};

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Bytes {
    pub download: u64,
    pub upload: u64,
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

    pub fn history(&self, agg: &str, mac: &str) -> serde_json::Value {
        let mut periods = BTreeMap::<String, Bytes>::new();
        for ((date, device), bytes) in &self.daily {
            if device != mac { continue; }
            let key = if agg == "month" { &date[..7] } else { date.as_str() };
            let total = periods.entry(key.to_owned()).or_default();
            total.download = total.download.saturating_add(bytes.download);
            total.upload = total.upload.saturating_add(bytes.upload);
        }
        let rows: Vec<_> = periods.into_iter().map(|(date, bytes)| if agg == "month" {
            serde_json::json!({"month":date,"download":bytes.download,"upload":bytes.upload})
        } else { serde_json::json!({"date":date,"download":bytes.download,"upload":bytes.upload}) }).collect();
        // Month totals cover the daily ledger's retained 90-day window only.
        let mut result = if agg == "month" { serde_json::json!({"agg":agg,"months":rows,"since":self.daily_since,"retention_days":90}) }
        else { serde_json::json!({"agg":agg,"days":rows,"since":self.daily_since,"retention_days":90}) };
        let mut by_device = BTreeMap::<String, Bytes>::new();
        for ((_, device), bytes) in &self.daily {
            let b = by_device.entry(device.clone()).or_default();
            b.download = b.download.saturating_add(bytes.download);
            b.upload = b.upload.saturating_add(bytes.upload);
        }
        let network = by_device.remove("").unwrap_or_default();
        let attributed = by_device.values().fold(Bytes::default(), |mut b, v| {
            b.download = b.download.saturating_add(v.download); b.upload = b.upload.saturating_add(v.upload); b
        });
        let mut ranking: Vec<_> = by_device.into_iter().collect();
        ranking.sort_by_key(|(_, b)| std::cmp::Reverse(b.upload.saturating_add(b.download)));
        result["ranking"] = serde_json::json!(ranking.into_iter().map(|(mac,b)| serde_json::json!({"mac":mac,"upload":b.upload,"download":b.download})).collect::<Vec<_>>());
        for (key, value) in [("network_upload",network.upload),("network_download",network.download),
            ("unassigned_upload",network.upload.saturating_sub(attributed.upload)),("unassigned_download",network.download.saturating_sub(attributed.download)),
            ("excess_upload",attributed.upload.saturating_sub(network.upload)),("excess_download",attributed.download.saturating_sub(network.download))] {
            result[key] = serde_json::json!(value);
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
}
