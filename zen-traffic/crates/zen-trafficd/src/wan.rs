//! Internet-only accounting. Old WAN+LAN history is never backfilled into this ledger.
use std::collections::HashMap;
use zen_bpf::MacKey;
use crate::persistence::{mac_str, Db};

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Bytes {
    pub download: u64,
    pub upload: u64,
}

pub struct WanUsage {
    pub since: u64,
    pub interface: Bytes,
    pub devices: HashMap<MacKey, Bytes>,
}

impl WanUsage {
    pub fn load(db: &Db, now: u64) -> Result<Self, String> {
        let mut usage = Self { since: if crate::state::time_synced(now) { now } else { 0 }, interface: Bytes::default(), devices: HashMap::new() };
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
    }

    pub fn interface_delta(&mut self, download: u64, upload: u64) {
        if self.since == 0 { return; }
        self.interface.download = self.interface.download.saturating_add(download);
        self.interface.upload = self.interface.upload.saturating_add(upload);
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
