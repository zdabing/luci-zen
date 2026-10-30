//! Internet application ledger. Classification never changes the device totals.
//! Only application IDs, display names and hourly byte counters reach SQLite.
use std::collections::BTreeMap;
use crate::{persistence::Db, state::{now_mono_ms, time_synced}, timeline::{local_hour, HOURLY_SECS}, wan::Bytes};

pub const ROW_LIMIT: usize = 250_000;
const PENDING_LIMIT: usize = 16_384;
pub type AppBuckets = BTreeMap<(u64, String, u16), AppBytes>;

#[derive(Clone, Debug)]
pub struct AppBytes {
    pub name: String,
    pub identified: bool,
    pub bytes: Bytes,
}

impl AppBytes {
    pub fn kind(&self, id: u16) -> &'static str {
        if id == 0 { return "unknown"; }
        // Compatibility for protocol rows written by the old adapter's broad
        // identified flag. New decisions also use nDPI's application metadata.
        let protocol = ["HLS", "Protobuf", "BitTorrent", "OpenVPN", "Tor", "RakNet",
            "HTTP", "HTTP2", "TLS", "DTLS", "QUIC", "DNS", "MDNS", "DoH_DoT",
            "DNSCrypt", "HTTP_Connect", "HTTP_Proxy", "STUN", "RTP", "NTP", "DHCP",
            "DHCPV6", "NetBIOS", "SMBv1", "SMBv23", "LLMNR", "SSH", "FTP_CONTROL", "FTP_DATA"]
            .iter().any(|name| self.name.eq_ignore_ascii_case(name));
        if self.identified && !protocol { "application" } else { "protocol" }
    }
}

/// Exclusive byte categories. A device/connection counter difference is never
/// presented as an nDPI Unknown decision; protocols are not application names.
pub fn breakdown(value: &mut serde_json::Value, device: Bytes, pending: Bytes, provisional: Bytes) {
    let (mut applications, mut protocols, mut unknown) = (Bytes::default(), Bytes::default(), Bytes::default());
    if let Some(rows) = value["applications"].as_array() {
        for row in rows {
            let target = match row["kind"].as_str() {
                Some("application") => &mut applications,
                Some("protocol") => &mut protocols,
                _ => &mut unknown,
            };
            target.download = target.download.saturating_add(row["download"].as_u64().unwrap_or(0));
            target.upload = target.upload.saturating_add(row["upload"].as_u64().unwrap_or(0));
        }
    }
    unknown.download = unknown.download.saturating_sub(provisional.download);
    unknown.upload = unknown.upload.saturating_sub(provisional.upload);
    let covered = Bytes {
        download:applications.download.saturating_add(protocols.download).saturating_add(unknown.download).saturating_add(pending.download),
        upload:applications.upload.saturating_add(protocols.upload).saturating_add(unknown.upload).saturating_add(pending.upload),
    };
    let difference = Bytes { download:device.download.saturating_sub(covered.download), upload:device.upload.saturating_sub(covered.upload) };
    let excess = Bytes { download:covered.download.saturating_sub(device.download), upload:covered.upload.saturating_sub(device.upload) };
    // Keep the legacy field for older frontends using a newer backend.
    value["unattributed"] = serde_json::json!({"download":device.download.saturating_sub(applications.download),"upload":device.upload.saturating_sub(applications.upload)});
    value["accounting_mismatch"] = serde_json::json!(excess != Bytes::default());
    value["breakdown"] = serde_json::json!({"applications":applications,"protocols":protocols,
        "unknown":unknown,"pending":pending,"difference":difference,"excess":excess});
}

#[cfg(test)]
mod tests {
    use super::*;
    const MAC: &str = "02:00:00:00:00:01";
    fn sample() -> u64 { crate::state::MIN_SYNC_EPOCH + 370 * 86_400 + 12 * 3600 + 120 }
    fn query(usage: &AppUsage, db: &Db, time: u64) -> serde_json::Value {
        usage.query(db, MAC, &crate::state::local_date(time), local_hour(time), time + 1).unwrap()
    }

    #[test]
    fn app_hours_survive_restart_and_do_not_replay_saved_deltas() {
        let directory=std::env::temp_dir().join(format!("zen-app-restore-{}-{}",std::process::id(),now_mono_ms()));
        std::fs::create_dir_all(&directory).unwrap();
        let filename=directory.join("traffic.db");
        let db = Db::open(filename.to_str().unwrap()).unwrap();
        let time = sample();
        let mut usage = AppUsage::load(&db).unwrap();
        usage.record(time, MAC, 54, "iQIYI", true, Bytes { download:6_000_000_000,upload:133_000_000 });
        usage.record(time, MAC, 91, "TLS", false, Bytes { download:200,upload:10 });
        usage.flush(&db, time, true).unwrap(); usage.flush(&db, time, true).unwrap();
        drop(usage);drop(db);
        let db=Db::open(filename.to_str().unwrap()).unwrap();
        let mut restored = AppUsage::load(&db).unwrap();
        restored.record(time + 3, MAC, 54, "iQIYI", true, Bytes { download:17,upload:9 });
        let data = query(&restored, &db, time + 3);
        assert_eq!(data["applications"][0]["download"],6_000_000_017u64);
        assert_eq!(data["applications"][0]["upload"],133_000_009u64);
        assert_eq!(data["applications"][0]["identified"],true);
        assert_eq!(data["applications"][1]["identified"],false);
        restored.record(time + 3600, MAC, 197, "WeChat", true, Bytes { download:100,upload:2 });
        assert_eq!(query(&restored,&db,time + 3600)["applications"][0]["id"],197);
        drop(restored);drop(db);std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_transaction_keeps_pending_bytes_and_retries_exactly_once() {
        let db = Db::open(":memory:").unwrap(); let time = sample();
        let mut usage = AppUsage::load(&db).unwrap();
        usage.record(time, MAC, 120, "Twitter", true, Bytes { download:100,upload:50 });
        db.conn_for_test_reject_settings();
        assert!(usage.flush(&db,time,true).is_err());
        assert!(db.app_usage(MAC,local_hour(time)).unwrap().is_empty());
        assert_eq!(query(&usage,&db,time)["applications"][0]["download"],100);
        db.conn_for_test_allow_settings();
        usage.flush(&db,time,true).unwrap(); usage.flush(&db,time,true).unwrap();
        assert_eq!(query(&usage,&db,time)["applications"][0]["download"],100);
    }

    #[test]
    fn late_classification_preserves_the_original_hour_and_collection_start() {
        let db = Db::open(":memory:").unwrap(); let first = sample();
        let later = local_hour(first) + 3600 + 2;
        let mut usage = AppUsage::load(&db).unwrap();
        usage.record(later,MAC,197,"WeChat",true,Bytes{download:100,upload:0});
        // A slower connection finishes identification after a newer flow.
        usage.record(first,MAC,54,"iQIYI",true,Bytes{download:200,upload:0});
        assert_eq!(usage.since,first);
        let data = usage.query(&db,MAC,&crate::state::local_date(first),local_hour(first),later).unwrap();
        assert_eq!(data["available"],true);
        assert_eq!(data["applications"][0]["id"],54);
        usage.flush(&db,later,true).unwrap();
        assert_eq!(AppUsage::load(&db).unwrap().since,first);
    }

    #[test]
    fn reset_retention_and_invalid_hours_never_manufacture_history() {
        let db = Db::open(":memory:").unwrap(); let time = sample();
        let mut usage = AppUsage::load(&db).unwrap();
        usage.record(12, MAC, 54, "iQIYI", true, Bytes { download:100,upload:0 });
        assert_eq!(usage.since,0);
        usage.record(time, MAC, 54, "iQIYI", true, Bytes { download:100,upload:0 });
        usage.flush(&db,time,true).unwrap();
        assert!(usage.query(&db,MAC,&crate::state::local_date(time),local_hour(time)+1,time).is_err());
        assert!(usage.query(&db,MAC,&crate::state::local_date(time),local_hour(time)+3600,time).is_err());
        usage.flush(&db,time+HOURLY_SECS+3600,true).unwrap();
        assert!(db.app_usage(MAC,local_hour(time)).unwrap().is_empty());
        usage.record(time+HOURLY_SECS+3600,MAC,54,"iQIYI",true,Bytes{download:1,upload:0});
        db.reset_device(MAC).unwrap(); usage.remove_device(MAC);
        assert!(usage.hours.is_empty());
        assert!(db.app_usage(MAC,local_hour(time)).unwrap().is_empty());
    }
}

pub struct AppUsage {
    pub since: u64,
    pub floor: u64,
    pub hours: AppBuckets,
    pub(crate) corrections: BTreeMap<(u64, String), Bytes>,
    pub(crate) last_flush: u64,
}

impl AppUsage {
    pub fn load(db: &Db) -> Result<Self, String> {
        let setting = |key| db.setting(key).map(|v| v.and_then(|s| s.parse().ok()).unwrap_or(0));
        Ok(Self { since: setting("app_usage_since")?, floor: setting("app_usage_floor")?,
            hours: BTreeMap::new(), corrections:BTreeMap::new(), last_flush: now_mono_ms() })
    }

    /// `time` is the observation time, never the later classification time.
    pub fn record(&mut self, time: u64, mac: &str, app: u16, name: &str, identified: bool, bytes: Bytes) {
        if !time_synced(time) || bytes == Bytes::default() { return; }
        let hour = local_hour(time);
        if hour < self.floor { return; }
        self.since = if self.since == 0 { time } else { self.since.min(time) };
        let name = if app == 0 { "Unknown".to_owned() } else {
            name.chars().filter(|c| !c.is_control()).take(64).collect()
        };
        let row = self.hours.entry((hour, mac.to_owned(), app))
            .or_insert_with(|| AppBytes { name, identified:app != 0 && identified, bytes: Bytes::default() });
        row.bytes.download = row.bytes.download.saturating_add(bytes.download).min(i64::MAX as u64);
        row.bytes.upload = row.bytes.upload.saturating_add(bytes.upload).min(i64::MAX as u64);
        while self.hours.len() > PENDING_LIMIT {
            // In a prolonged storage outage, remove complete hours and report
            // the new availability floor rather than silently losing one app.
            let Some((time, _, _)) = self.hours.keys().next().cloned() else { break };
            self.floor = self.floor.max(time.saturating_add(3600));
            self.hours.retain(|(hour, _, _), _| *hour >= self.floor);
            self.corrections.retain(|(hour, _), _| *hour >= self.floor);
        }
    }

    /// Move provisional Unknown bytes without double-counting, even if a
    /// checkpoint has already persisted them. SQL corrections and new app
    /// bytes are committed in the same transaction as the device ledger.
    pub fn reclassify(&mut self, time: u64, mac: &str, app: u16, name: &str, identified: bool, bytes: Bytes) {
        let hour = local_hour(time);
        if app == 0 || hour < self.floor || !time_synced(time) { return; }
        let mut persisted = bytes;
        if let Some(row) = self.hours.get_mut(&(hour,mac.to_owned(),0)) {
            let download = row.bytes.download.min(bytes.download);
            let upload = row.bytes.upload.min(bytes.upload);
            row.bytes.download -= download; row.bytes.upload -= upload;
            persisted.download -= download; persisted.upload -= upload;
        }
        if persisted != Bytes::default() {
            let correction = self.corrections.entry((hour,mac.to_owned())).or_default();
            correction.download = correction.download.saturating_add(persisted.download);
            correction.upload = correction.upload.saturating_add(persisted.upload);
        }
        self.record(time,mac,app,name,identified,bytes);
        while self.corrections.len() > PENDING_LIMIT {
            let Some((hour,_)) = self.corrections.keys().next().cloned() else { break };
            self.floor = self.floor.max(hour.saturating_add(3600));
            self.corrections.retain(|(hour,_),_| *hour >= self.floor);
            self.hours.retain(|(hour,_,_),_| *hour >= self.floor);
        }
    }

    pub fn remove_device(&mut self, mac: &str) {
        self.hours.retain(|(_, device, _), _| device != mac);
        self.corrections.retain(|(_, device), _| device != mac);
    }

    #[cfg(test)]
    pub fn flush(&mut self, db: &Db, now: u64, force: bool) -> Result<(), String> {
        let mono = now_mono_ms();
        if !time_synced(now) || (!force && mono.saturating_sub(self.last_flush) < 300_000) { return Ok(()); }
        self.last_flush = mono;
        let floor = db.save_app_usage(self, now)?;
        self.hours.clear();
        self.corrections.clear();
        self.floor = floor;
        Ok(())
    }

    pub fn query(&self, db: &Db, mac: &str, date: &str, hour: u64, now: u64) -> Result<serde_json::Value, String> {
        let (start, end) = crate::timeline::day_bounds(date)?;
        if hour < start || hour >= end || (hour - start) % 3600 != 0 || hour > now {
            return Err("Invalid hour".into());
        }
        let until = (hour + 3600).min(end);
        let available_from = self.since.max(self.floor).max(now.saturating_sub(HOURLY_SECS));
        let available = self.since != 0 && hour >= self.floor && until > available_from;
        let mut rows = if available { db.app_usage(mac, hour)? } else { BTreeMap::new() };
        if available {
            if let Some(correction) = self.corrections.get(&(hour,mac.to_owned())) {
                if let Some(row) = rows.get_mut(&0) {
                    row.bytes.download = row.bytes.download.saturating_sub(correction.download);
                    row.bytes.upload = row.bytes.upload.saturating_sub(correction.upload);
                }
            }
            for ((time, device, app), pending) in &self.hours {
                if *time != hour || device != mac { continue; }
                let row = rows.entry(*app).or_insert_with(|| AppBytes { name: pending.name.clone(), identified:pending.identified, bytes: Bytes::default() });
                row.bytes.download = row.bytes.download.saturating_add(pending.bytes.download);
                row.bytes.upload = row.bytes.upload.saturating_add(pending.bytes.upload);
            }
        }
        let mut applications: Vec<_> = rows.into_iter().map(|(id, row)| {
            let kind = row.kind(id);
            serde_json::json!({
            "id":id,"name":row.name,"download":row.bytes.download,"upload":row.bytes.upload,
            "total":row.bytes.download.saturating_add(row.bytes.upload),"identified":kind == "application","kind":kind,
        })}).collect();
        applications.sort_by_key(|row| (std::cmp::Reverse(row["total"].as_u64().unwrap_or(0)), row["id"].as_u64().unwrap_or(0)));
        Ok(serde_json::json!({"mac":mac,"date":date,"hour":hour,"end":until,
            "since":self.since,"available_from":available_from,"available":available,
            "partial":available && hour < available_from,"in_progress":hour <= now && now < until,
            "retention_days":HOURLY_SECS/86_400,"applications":applications}))
    }
}
