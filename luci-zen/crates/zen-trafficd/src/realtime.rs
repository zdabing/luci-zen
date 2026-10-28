//! Seven-day WAN rate history; 5-second snapshots, 5-minute batched SQLite writes.
use std::collections::{BTreeMap, HashMap};
use crate::netlink::LinkInfo;
use crate::persistence::Db;
use crate::state::time_synced;

pub const RETENTION_SECS: u64 = 7 * 86_400;
const SAMPLE_MS: u64 = 5_000;
const FLUSH_MS: u64 = 300_000;
const MAX_PENDING: usize = 120_960; // Bound RAM even if storage remains unavailable.

#[derive(Clone)]
pub struct Sample {
    pub time: u64,
    pub interface: String,
    pub download: u64,
    pub upload: u64,
}

#[derive(Default)]
pub struct RealtimeHistory {
    pending: Vec<Sample>,
    baseline: HashMap<u32, (String, u64, u64)>,
    last_sample: Option<u64>,
    last_time: u64,
    last_flush: u64,
    pub primary: Option<String>,
}

pub struct Query {
    pub interface: String,
    pub interfaces: Vec<String>,
    pub start: u64,
    pub end: u64,
    pub step: u64,
    pub samples: Vec<Sample>,
}

impl RealtimeHistory {
    pub fn sample(&mut self, upstream: &[u32], links: &[LinkInfo], mono: u64, now: u64) {
        if !time_synced(now) {
            self.baseline.clear(); self.last_sample = None;
            return;
        }
        if self.last_sample.is_some_and(|last| mono.saturating_sub(last) < SAMPLE_MS) { return; }
        let elapsed = self.last_sample.map(|last| mono.saturating_sub(last).max(1));
        let mut current = HashMap::new();
        self.primary = upstream.iter().find_map(|index| links.iter().find(|link| link.ifindex == *index).map(|link| link.name.clone()));
        for link in links.iter().filter(|link| upstream.contains(&link.ifindex)).take(16) {
            if now > self.last_time {
                if let (Some(dt), Some((name, rx, tx))) = (elapsed, self.baseline.get(&link.ifindex)) {
                    if name == &link.name && link.rx_bytes >= *rx && link.tx_bytes >= *tx {
                        self.pending.push(Sample {
                            time: now, interface: link.name.clone(),
                            download: (link.rx_bytes - *rx).saturating_mul(1000) / dt,
                            upload: (link.tx_bytes - *tx).saturating_mul(1000) / dt,
                        });
                    }
                }
            }
            current.insert(link.ifindex, (link.name.clone(), link.rx_bytes, link.tx_bytes));
        }
        self.baseline = current;
        self.last_sample = Some(mono);
        self.last_time = self.last_time.max(now);
        let cutoff = now.saturating_sub(RETENTION_SECS);
        self.pending.retain(|sample| sample.time >= cutoff);
        if self.pending.len() > MAX_PENDING {
            let excess = self.pending.len() - MAX_PENDING;
            self.pending.drain(..excess);
            eprintln!("[zen-trafficd] 实时历史缓存已满，丢弃最早 {excess} 条未落盘记录");
        }
    }

    pub fn flush(&mut self, db: &Db, mono: u64, now: u64, force: bool) {
        if !time_synced(now) || (!force && mono.saturating_sub(self.last_flush) < FLUSH_MS) { return; }
        // Rate-limit retries as well; a full disk must not trigger a write every second.
        self.last_flush = mono;
        match db.save_realtime(&self.pending, now.saturating_sub(RETENTION_SECS)) {
            Ok(()) => self.pending.clear(),
            Err(e) => eprintln!("[zen-trafficd] 实时历史落盘失败（保留缓存）: {e}"),
        }
    }

    pub fn query(&self, db: &Db, interface: Option<&str>, start: u64, end: u64,
        limit: usize, now: u64) -> Result<Query, String> {
        if start > end || end > now || end < now.saturating_sub(RETENTION_SECS) || end - start > RETENTION_SECS || !(2..=1200).contains(&limit) {
            return Err("查询范围必须在最近7天内，点数为2至1200".into());
        }
        let start = start.max(now.saturating_sub(RETENTION_SECS));
        let mut interfaces = db.realtime_interfaces()?;
        interfaces.extend(self.pending.iter().map(|s| s.interface.clone()));
        interfaces.extend(self.primary.iter().cloned());
        interfaces.sort(); interfaces.dedup();
        let interface = interface.filter(|name| !name.is_empty()).map(str::to_string)
            .or_else(|| self.primary.clone()).or_else(|| interfaces.first().cloned()).unwrap_or_default();
        if interface.len() > 64 { return Err("接口名称过长".into()); }
        let step = ((end - start) / limit as u64 / 5 + 1) * 5;
        let pending_from = self.pending.iter().filter(|s| s.interface == interface)
            .map(|s| s.time).min().unwrap_or(i64::MAX as u64);
        let mut buckets = BTreeMap::new();
        for (time, dl, ul, count) in db.realtime_buckets(&interface, start, end, step, pending_from)? {
            buckets.insert(time, (dl, ul, count));
        }
        for sample in self.pending.iter().filter(|s| s.interface == interface && s.time >= start && s.time <= end) {
            let time = (sample.time - start) / step * step + start;
            let bucket = buckets.entry(time).or_insert((0u64, 0u64, 0u64));
            bucket.0 = bucket.0.saturating_add(sample.download);
            bucket.1 = bucket.1.saturating_add(sample.upload);
            bucket.2 += 1;
        }
        let samples = buckets.into_iter().map(|(time, (dl, ul, count))| Sample {
            time, interface: interface.clone(), download: dl / count.max(1), upload: ul / count.max(1),
        }).collect();
        Ok(Query { interface, interfaces, start, end, step, samples })
    }
}
