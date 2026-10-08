//! Sparse internet-only device usage buckets. No packet logs or daily backfill.
use std::collections::BTreeMap;
use crate::{persistence::Db, state::{time_synced, now_mono_ms}, wan::Bytes};

pub const DETAIL_SECS: u64 = 7 * 86_400;
pub const HOURLY_SECS: u64 = 90 * 86_400;
pub const ROW_LIMIT: usize = 150_000; // Each table; normally ~209k total rows for 50 active devices.
const PENDING_LIMIT: usize = 8_192; // Bound RAM while storage is unavailable.
pub type Buckets = BTreeMap<(u64, String), Bytes>;

pub struct DeviceTimeline {
    pub since: u64,
    pub fine: Buckets,
    pub hours: Buckets,
    pub fine_floor: u64,
    pub hour_floor: u64,
    last_flush: u64,
}

impl DeviceTimeline {
    pub fn load(db: &Db) -> Result<Self, String> {
        let setting = |name| db.setting(name).map(|value| value.and_then(|s| s.parse().ok()).unwrap_or(0));
        Ok(Self { since: setting("timeline_since")?, fine: Buckets::new(), hours: Buckets::new(),
            fine_floor: setting("timeline_fine_floor")?, hour_floor: setting("timeline_hour_floor")?,
            last_flush: now_mono_ms() })
    }

    pub fn record(&mut self, now: u64, mac: String, download: u64, upload: u64) {
        if !time_synced(now) || (download == 0 && upload == 0) { return; }
        if self.since == 0 { self.since = now; }
        for (buckets, start, floor, step) in [
            (&mut self.fine, now / 300 * 300, &mut self.fine_floor, 300),
            (&mut self.hours, local_hour(now), &mut self.hour_floor, 3600),
        ] {
            if start < *floor { continue; }
            let bytes = buckets.entry((start, mac.clone())).or_default();
            bytes.download = bytes.download.saturating_add(download);
            bytes.upload = bytes.upload.saturating_add(upload);
            while buckets.len() > PENDING_LIMIT {
                if let Some(((time, _), _)) = buckets.pop_first() { *floor = (*floor).max(time + step); }
            }
        }
    }

    pub fn remove_device(&mut self, mac: &str) {
        self.fine.retain(|(_, device), _| device != mac);
        self.hours.retain(|(_, device), _| device != mac);
    }

    pub fn flush(&mut self, db: &Db, now: u64, force: bool) -> Result<(), String> {
        let mono = now_mono_ms();
        if !time_synced(now) || (!force && mono.saturating_sub(self.last_flush) < 300_000) { return Ok(()); }
        self.last_flush = mono; // Failures also wait before retrying.
        let floors = db.save_device_timeline(self, now)?;
        self.fine.clear(); self.hours.clear();
        (self.fine_floor, self.hour_floor) = floors;
        Ok(())
    }

    pub fn query(&self, db: &Db, mac: &str, date: &str, hour: Option<u64>, now: u64) -> Result<serde_json::Value, String> {
        let (day_start, day_end) = day_bounds(date)?;
        if day_start > now { return Err("Future date".into()); }
        let (start, end, step, pending, retention, floor) = match hour {
            Some(time) if time >= day_start && time < day_end && local_hour(time) == time =>
                (time, (time + 3600).min(day_end), 300, &self.fine, DETAIL_SECS, self.fine_floor),
            Some(_) => return Err("Invalid hour".into()),
            None => (day_start, day_end, 3600, &self.hours, HOURLY_SECS, self.hour_floor),
        };
        let available_from = self.since.max(now.saturating_sub(retention)).max(floor);
        // Keep partially recorded buckets at the beginning of collection/retention.
        let mut rows: BTreeMap<u64, Bytes> = db.device_timeline(mac, start, end, step)?.into_iter()
            .filter(|(time, _)| *time >= floor && time.saturating_add(step) > available_from).collect();
        for ((time, device), bytes) in pending {
            if device != mac || *time < start || *time >= end || *time < floor || time.saturating_add(step) <= available_from { continue; }
            let total = rows.entry(*time).or_default();
            total.download = total.download.saturating_add(bytes.download);
            total.upload = total.upload.saturating_add(bytes.upload);
        }
        let samples: Vec<_> = rows.into_iter().map(|(time, bytes)| serde_json::json!({
            "time":time, "label":format!("{}–{}", clock(time), clock((time + step).min(day_end))),
            "utc_offset":offset(time), "download":bytes.download, "upload":bytes.upload,
        })).collect();
        Ok(serde_json::json!({"mac":mac,"date":date,"start":start,"end":end,"step":step,
            "since":self.since,"available_from":available_from,"expired":end <= available_from,
            "detail_available_from":self.since.max(now.saturating_sub(DETAIL_SECS)).max(self.fine_floor),
            "detail_days":7,"hourly_days":90,"samples":samples}))
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

    #[test]
    fn buckets_survive_restart_without_replaying_old_totals() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600 + 120;
        let mac = "02:00:00:00:00:01".to_owned();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        timeline.record(now, mac.clone(), 2_000_000_000, 100);
        timeline.record(now + 300, mac.clone(), 1_000_000_000, 200);
        let date = crate::state::local_date(now);
        let before = timeline.query(&db, &mac, &date, None, now + 300).unwrap();
        assert_eq!(before["samples"][0]["download"], 3_000_000_000u64);
        timeline.flush(&db, now + 300, true).unwrap();
        timeline.flush(&db, now + 300, true).unwrap();
        let mut restarted = DeviceTimeline::load(&db).unwrap();
        restarted.record(now + 600, mac.clone(), 17, 0);
        assert_eq!(restarted.query(&db, &mac, &date, None, now + 600).unwrap()["samples"][0]["download"], 3_000_000_017u64);
        let details = restarted.query(&db, &mac, &date, Some(local_hour(now)), now + 600).unwrap();
        assert_eq!(details["samples"].as_array().unwrap().len(), 3);
        db.reset_device(&mac).unwrap(); restarted.remove_device(&mac);
        assert!(restarted.query(&db, &mac, &date, None, now + 600).unwrap()["samples"].as_array().unwrap().is_empty());
    }

    #[test]
    fn failed_batch_retries_once_and_does_not_write_zeros_or_unsynced_samples() {
        let db = Db::open(":memory:").unwrap();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        let mac = "02:00:00:00:00:02".to_owned();
        let now = crate::state::MIN_SYNC_EPOCH + 3600;
        timeline.record(0, mac.clone(), 123, 456);
        timeline.record(now, mac.clone(), 0, 0);
        assert!(timeline.fine.is_empty());
        timeline.record(now, mac.clone(), 100, 20);
        db.conn_for_test_reject_settings();
        assert!(timeline.flush(&db, now, true).is_err());
        assert_eq!(timeline.fine.len(), 1);
        assert!(db.device_timeline(&mac, now - 3600, now + 3600, 300).unwrap().is_empty());
        db.conn_for_test_allow_settings(); timeline.flush(&db, now, true).unwrap();
        assert_eq!(db.device_timeline(&mac, now - 3600, now + 3600, 300).unwrap()[0].1.download, 100);
        assert!(day_bounds("2026-02-30").is_err());
        assert!(day_bounds("2026-2-01").is_err());
        assert!(timeline.query(&db, &mac, &crate::state::local_date(now), Some(now + 1), now).is_err());
    }

    #[test]
    fn detail_expires_before_hourly() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mac = "02:00:00:00:00:03".to_owned();
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        timeline.record(now, mac.clone(), 123, 456);
        timeline.flush(&db, now, true).unwrap();
        let date = crate::state::local_date(now);
        timeline.flush(&db, now + 8 * 86400, true).unwrap();
        let detail = timeline.query(&db, &mac, &date, Some(local_hour(now)), now + 8 * 86400).unwrap();
        assert_eq!(detail["expired"], true);
        assert!(detail["samples"].as_array().unwrap().is_empty());
        assert_eq!(timeline.query(&db, &mac, &date, None, now + 8 * 86400).unwrap()["samples"][0]["download"], 123);
        timeline.flush(&db, now + 91 * 86400, true).unwrap();
        let hours = timeline.query(&db, &mac, &date, None, now + 91 * 86400).unwrap();
        assert_eq!(hours["expired"], true);
        assert!(hours["samples"].as_array().unwrap().is_empty());
    }

    #[test]
    fn failed_storage_buffer_is_bounded_and_hides_the_cut_boundary_bucket() {
        let db = Db::open(":memory:").unwrap();
        let now = crate::state::MIN_SYNC_EPOCH + 12 * 3600;
        let mut timeline = DeviceTimeline::load(&db).unwrap();
        for device in 0..=PENDING_LIMIT {
            timeline.record(now, device.to_string(), 1, 0);
        }
        assert!(timeline.fine.len() <= PENDING_LIMIT);
        assert!(timeline.hours.len() <= PENDING_LIMIT);
        assert_eq!(timeline.fine_floor, now / 300 * 300 + 300);
        assert_eq!(timeline.hour_floor, local_hour(now) + 3600);
        // Whole bucket is incomplete; never display the surviving subset as complete.
        timeline.flush(&db, now, true).unwrap();
        assert!(db.device_timeline("1", now, now + 3600, 300).unwrap().is_empty());
        let restarted = DeviceTimeline::load(&db).unwrap();
        assert_eq!(restarted.fine_floor, timeline.fine_floor);
        assert_eq!(restarted.hour_floor, timeline.hour_floor);
    }
}
