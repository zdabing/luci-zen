//! Sparse internet-only device usage buckets. No packet logs or daily backfill.
use std::collections::BTreeMap;
use crate::{persistence::Db, state::{time_synced, now_mono_ms}, wan::Bytes};

pub const HOURLY_SECS: u64 = 30 * 86_400;
pub const ROW_LIMIT: usize = 150_000; // ~36k hourly rows for 50 continuously active devices.
const PENDING_LIMIT: usize = 8_192; // Bound RAM while storage is unavailable.
pub type Buckets = BTreeMap<(u64, String), Bytes>;

pub struct DeviceTimeline {
    pub since: u64,
    pub hours: Buckets,
    pub hour_floor: u64,
    last_flush: u64,
}

impl DeviceTimeline {
    pub fn load(db: &Db) -> Result<Self, String> {
        let setting = |name| db.setting(name).map(|value| value.and_then(|s| s.parse().ok()).unwrap_or(0));
        Ok(Self { since: setting("timeline_since")?, hours: Buckets::new(),
            hour_floor: setting("timeline_hour_floor")?,
            last_flush: now_mono_ms() })
    }

    pub fn record(&mut self, now: u64, mac: String, download: u64, upload: u64) {
        if !time_synced(now) || (download == 0 && upload == 0) { return; }
        if self.since == 0 { self.since = now; }
        let start = local_hour(now);
        if start < self.hour_floor { return; }
        let bytes = self.hours.entry((start, mac)).or_default();
        bytes.download = bytes.download.saturating_add(download);
        bytes.upload = bytes.upload.saturating_add(upload);
        while self.hours.len() > PENDING_LIMIT {
            if let Some(((time, _), _)) = self.hours.pop_first() {
                self.hour_floor = self.hour_floor.max(time + 3600);
            }
        }
    }

    pub fn remove_device(&mut self, mac: &str) {
        self.hours.retain(|(_, device), _| device != mac);
    }

    pub fn flush(&mut self, db: &Db, now: u64, force: bool) -> Result<(), String> {
        let mono = now_mono_ms();
        if !time_synced(now) || (!force && mono.saturating_sub(self.last_flush) < 300_000) { return Ok(()); }
        self.last_flush = mono; // Failures also wait before retrying.
        let floor = db.save_device_timeline(self, now)?;
        self.hours.clear();
        self.hour_floor = floor;
        Ok(())
    }

    pub fn query(&self, db: &Db, mac: &str, date: &str, now: u64) -> Result<serde_json::Value, String> {
        let (day_start, day_end) = day_bounds(date)?;
        if day_start > now { return Err("Future date".into()); }
        let (start, end, step, floor) = (day_start, day_end, 3600, self.hour_floor);
        let available_from = self.since.max(now.saturating_sub(HOURLY_SECS)).max(floor);
        // Keep partially recorded buckets at the beginning of collection/retention.
        let mut rows: BTreeMap<u64, Bytes> = db.device_timeline(mac, start, end)?.into_iter()
            .filter(|(time, _)| *time >= floor && time.saturating_add(step) > available_from).collect();
        for ((time, device), bytes) in &self.hours {
            if device != mac || *time < start || *time >= end || *time < floor || time.saturating_add(step) <= available_from { continue; }
            let total = rows.entry(*time).or_default();
            total.download = total.download.saturating_add(bytes.download);
            total.upload = total.upload.saturating_add(bytes.upload);
        }
        let expired = end <= now.saturating_sub(HOURLY_SECS).max(floor);
        let samples: Vec<_> = if self.since == 0 || end <= self.since || expired { Vec::new() } else {
            (start..end).step_by(3600).map(|time| {
                let bytes = rows.get(&time).copied().unwrap_or_default();
                serde_json::json!({
                    "time":time, "label":format!("{}–{}", clock(time),
                        if time + step >= end { "24:00".to_owned() } else { clock(time + step) }),
                    "utc_offset":offset(time), "download":bytes.download, "upload":bytes.upload,
                    "recorded":rows.contains_key(&time),
                    "available":time >= floor && time + step > available_from && time <= now,
                    "partial":time < available_from && time + step > available_from,
                    "in_progress":time <= now && now < time + step,
                    "future":time > now,
                })
            }).collect()
        };
        Ok(serde_json::json!({"mac":mac,"date":date,"start":start,"end":end,"step":step,
            "since":self.since,"now":now,"available_from":available_from,"expired":expired,
            "hourly_days":HOURLY_SECS / 86_400,"samples":samples}))
    }
}

fn local_tm(epoch: u64) -> libc::tm {
    let time = epoch as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&time, &mut tm); }
    tm
}

pub fn local_hour(epoch: u64) -> u64 {
    let tm = local_tm(epoch);
    epoch.saturating_sub((tm.tm_min.max(0) * 60 + tm.tm_sec.max(0)) as u64)
}

fn format_time(epoch: u64, format: &[u8]) -> String {
    let tm = local_tm(epoch);
    let mut buffer = [0u8; 32];
    let count = unsafe { libc::strftime(buffer.as_mut_ptr().cast(), buffer.len(), format.as_ptr().cast(), &tm) };
    String::from_utf8_lossy(&buffer[..count]).into_owned()
}
fn clock(epoch: u64) -> String { format_time(epoch, b"%H:%M\0") }
fn offset(epoch: u64) -> String { format_time(epoch, b"%z\0") }

pub fn day_bounds(date: &str) -> Result<(u64, u64), String> {
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' ||
        !date.bytes().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) { return Err("Invalid date".into()); }
    let year: i32 = date[..4].parse().map_err(|_| "Invalid date")?;
    let month: i32 = date[5..7].parse().map_err(|_| "Invalid date")?;
    let day: i32 = date[8..].parse().map_err(|_| "Invalid date")?;
    if !(2024..=2099).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) { return Err("Invalid date".into()); }
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900; tm.tm_mon = month - 1; tm.tm_mday = day; tm.tm_isdst = -1;
    let start = unsafe { libc::mktime(&mut tm) };
    if start < 0 || crate::state::local_date(start as u64) != date { return Err("Invalid date".into()); }
    // Reconstruct the next local midnight, including 23/25-hour DST days.
    tm.tm_hour = 0; tm.tm_min = 0; tm.tm_sec = 0; tm.tm_mday += 1; tm.tm_isdst = -1;
    let end = unsafe { libc::mktime(&mut tm) };
    if end <= start { return Err("Invalid date".into()); }
    Ok((start as u64, end as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recorded(value: &serde_json::Value) -> &serde_json::Value {
        value["samples"].as_array().unwrap().iter().find(|row| row["recorded"] == true).unwrap()
    }

    #[test]
    fn buckets_survive_restart_without_replaying_old_totals() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600 + 120;
        let mac = "02:00:00:00:00:01".to_owned();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        timeline.record(now, mac.clone(), 2_000_000_000, 100);
        timeline.record(now + 300, mac.clone(), 1_000_000_000, 200);
        let date = crate::state::local_date(now);
        let before = timeline.query(&db, &mac, &date, now + 300).unwrap();
        assert_eq!(recorded(&before)["download"], 3_000_000_000u64);
        timeline.flush(&db, now + 300, true).unwrap();
        timeline.flush(&db, now + 300, true).unwrap();
        let mut restarted = DeviceTimeline::load(&db).unwrap();
        restarted.record(now + 600, mac.clone(), 17, 0);
        assert_eq!(recorded(&restarted.query(&db, &mac, &date, now + 600).unwrap())["download"], 3_000_000_017u64);
        db.reset_device(&mac).unwrap(); restarted.remove_device(&mac);
        assert!(restarted.query(&db, &mac, &date, now + 600).unwrap()["samples"].as_array().unwrap().iter().all(|row| row["recorded"] == false));
    }

    #[test]
    fn failed_batch_retries_once_and_does_not_write_zeros_or_unsynced_samples() {
        let db = Db::open(":memory:").unwrap();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        let mac = "02:00:00:00:00:02".to_owned();
        let now = crate::state::MIN_SYNC_EPOCH + 3600;
        timeline.record(0, mac.clone(), 123, 456);
        timeline.record(now, mac.clone(), 0, 0);
        assert!(timeline.hours.is_empty());
        timeline.record(now, mac.clone(), 100, 20);
        db.conn_for_test_reject_settings();
        assert!(timeline.flush(&db, now, true).is_err());
        assert_eq!(timeline.hours.len(), 1);
        assert!(db.device_timeline(&mac, now - 3600, now + 3600).unwrap().is_empty());
        db.conn_for_test_allow_settings(); timeline.flush(&db, now, true).unwrap();
        assert_eq!(db.device_timeline(&mac, now - 3600, now + 3600).unwrap()[0].1.download, 100);
        assert!(day_bounds("2026-02-30").is_err());
        assert!(day_bounds("2026-2-01").is_err());
        assert!(timeline.query(&db, &mac, "2099-01-01", now).is_err());
    }

    #[test]
    fn hourly_retention_keeps_30_days() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mac = "02:00:00:00:00:03".to_owned();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        timeline.record(now, mac.clone(), 123, 456);
        timeline.flush(&db, now, true).unwrap();
        let date = crate::state::local_date(now);
        timeline.flush(&db, now + 8 * 86400, true).unwrap();
        assert_eq!(recorded(&timeline.query(&db, &mac, &date, now + 8 * 86400).unwrap())["download"], 123);
        assert_eq!(timeline.query(&db, &mac, &date, now + 29 * 86400).unwrap()["hourly_days"], 30);
        timeline.flush(&db, now + 31 * 86400, true).unwrap();
        let hours = timeline.query(&db, &mac, &date, now + 31 * 86400).unwrap();
        assert_eq!(hours["expired"], true);
        assert!(hours["samples"].as_array().unwrap().is_empty());
    }

    #[test]
    fn full_day_distinguishes_current_future_unavailable_and_empty_hours() {
        let db = Db::open(":memory:").unwrap();
        let (start, end) = day_bounds("2026-10-10").unwrap();
        let now = start + 13 * 3600 + 120;
        let mac = "02:00:00:00:00:04".to_owned();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        assert!(timeline.query(&db, &mac, "2026-10-10", now).unwrap()["samples"].as_array().unwrap().is_empty());
        timeline.record(start + 3600 + 60, mac.clone(), 10 * 1024 * 1024 * 1024, 0);
        timeline.record(now, mac.clone(), 100, 20);
        let reply = timeline.query(&db, &mac, "2026-10-10", now).unwrap();
        let rows = reply["samples"].as_array().unwrap();
        assert_eq!(rows.len() as u64, (end - start) / 3600);
        assert_eq!(rows[0]["available"], false);
        assert_eq!(rows[1]["download"], 10 * 1024 * 1024 * 1024u64);
        assert_eq!(rows[1]["partial"], true);
        assert_eq!(rows[2]["download"], 0);
        assert_eq!(rows[2]["recorded"], false);
        assert_eq!(rows[13]["in_progress"], true);
        assert_eq!(rows[14]["future"], true);
        assert_eq!(rows.last().unwrap()["label"], "23:00–24:00");
        assert!(reply.get("detail_days").is_none());
        let before_collection = timeline.query(&db, &mac, "2026-10-09", now).unwrap();
        assert_eq!(before_collection["expired"], false);
        assert!(before_collection["samples"].as_array().unwrap().is_empty());
    }

    #[test]
    fn failed_storage_buffer_is_bounded_and_hides_the_cut_boundary_bucket() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        for device in 0..=PENDING_LIMIT {
            timeline.record(now, device.to_string(), 1, 0);
        }
        assert!(timeline.hours.len() <= PENDING_LIMIT);
        assert_eq!(timeline.hour_floor, local_hour(now) + 3600);
        // Whole bucket is incomplete; never display the surviving subset as complete.
        timeline.flush(&db, now, true).unwrap();
        assert!(db.device_timeline("1", now, now + 3600).unwrap().is_empty());
        let restarted = DeviceTimeline::load(&db).unwrap();
        assert_eq!(restarted.hour_floor, timeline.hour_floor);
    }
}
