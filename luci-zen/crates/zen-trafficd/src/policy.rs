//! Persistent per-MAC Internet policies. Runtime failures never report success.
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use zen_bpf::DevicePolicy;
use crate::daemon::parse_mac;

const SETTING: &str = "device_policies_v1";
const MAX_KBPS: u64 = 100_000_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub upload_kbps: u64,
    pub download_kbps: u64,
    pub blocked: bool,
}
impl Policy {
    pub fn active(self) -> bool { self.blocked || self.upload_kbps > 0 || self.download_kbps > 0 }
    pub fn valid(self) -> bool { self.upload_kbps <= MAX_KBPS && self.download_kbps <= MAX_KBPS }
    pub fn runtime(self) -> Option<DevicePolicy> {
        self.active().then(|| DevicePolicy { blocked: u32::from(self.blocked),
            upload_bps: self.upload_kbps * 125, download_bps: self.download_kbps * 125,
            ..DevicePolicy::default() })
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Change {
    Limit { mac: String, upload_kbps: u64, download_kbps: u64 },
    Block { mac: String, blocked: bool },
}

pub fn valid_mac(mac: &str) -> bool {
    mac.split(':').all(|part| part.len() == 2) && parse_mac(mac).is_some_and(|key| key.b[0] & 1 == 0 && key.b != [0; 6])
}

#[derive(Default)]
pub struct Policies { entries: BTreeMap<String, Policy> }
impl Policies {
    pub fn load(db: &crate::persistence::Db) -> Result<Self, String> {
        let Some(data) = db.setting(SETTING)? else { return Ok(Self::default()) };
        let entries: BTreeMap<String, Policy> = serde_json::from_str(&data).map_err(|_| "policy_storage_invalid")?;
        if entries.len() > 4096 || entries.iter().any(|(mac, policy)| !valid_mac(mac) || mac != &mac.to_ascii_lowercase() || !policy.valid()) {
            return Err("policy_storage_invalid".into());
        }
        Ok(Self { entries })
    }
    pub fn get(&self, mac: &str) -> Policy { self.entries.get(mac).copied().unwrap_or_default() }
    pub fn restore(&self, bpf: &mut aya::Ebpf) -> Result<(), String> {
        for (mac, policy) in &self.entries {
            zen_bpf::set_device_policy(bpf, parse_mac(mac).ok_or("invalid_mac")?, policy.runtime())?;
        }
        Ok(())
    }
    pub fn apply(&mut self, input: &str, enforceable: bool,
        mut runtime: impl FnMut(&str, Policy) -> Result<(), String>,
        mut persist: impl FnMut(&str) -> Result<(), String>) -> Result<Policy, String> {
        if input.len() > 1024 { return Err("invalid_request".into()); }
        let change: Change = serde_json::from_str(input).map_err(|_| "invalid_request")?;
        let raw_mac = match &change { Change::Limit { mac, .. } | Change::Block { mac, .. } => mac };
        if !valid_mac(raw_mac) { return Err("invalid_mac".into()); }
        let mac = raw_mac.to_ascii_lowercase();
        let previous = self.get(&mac);
        let next = match change {
            Change::Limit { upload_kbps, download_kbps, .. } => Policy { upload_kbps, download_kbps, ..previous },
            Change::Block { blocked, .. } => Policy { blocked, ..previous },
        };
        if !next.valid() { return Err("invalid_rate".into()); }
        // Removing a restriction must remain possible even after offload changes.
        if !enforceable && ((next.blocked && !previous.blocked) ||
            (next.upload_kbps > 0 && next.upload_kbps != previous.upload_kbps) ||
            (next.download_kbps > 0 && next.download_kbps != previous.download_kbps)) {
            return Err("hardware_offload_or_interface_unavailable".into());
        }
        let mut updated = self.entries.clone();
        if next.active() { updated.insert(mac.clone(), next); } else { updated.remove(&mac); }
        if updated.len() > 4096 { return Err("policy_capacity".into()); }
        let data = serde_json::to_string(&updated).map_err(|_| "policy_storage_invalid")?;
        runtime(&mac, next)?;
        if persist(&data).is_err() {
            runtime(&mac, previous).map_err(|_| "policy_rollback_failed")?;
            return Err("policy_storage_failed".into());
        }
        self.entries = updated;
        Ok(next)
    }
    pub fn save_key() -> &'static str { SETTING }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn limits_and_blocking_are_independent_persistent_and_reversible() {
        let db = crate::persistence::Db::open(":memory:").unwrap();
        let mut policies = Policies::load(&db).unwrap();
        let save = |data: &str| db.save_setting(SETTING, data);
        let limit = r#"{"action":"limit","mac":"02:00:00:00:00:01","upload_kbps":10000,"download_kbps":50000}"#;
        policies.apply(limit, true, |_, p| { assert_eq!(p.runtime().unwrap().upload_bps, 1_250_000); Ok(()) }, save).unwrap();
        let blocked = r#"{"action":"block","mac":"02:00:00:00:00:01","blocked":true}"#;
        policies.apply(blocked, true, |_, _| Ok(()), save).unwrap();
        let mut reopened = Policies::load(&db).unwrap();
        assert_eq!(reopened.get("02:00:00:00:00:01"), Policy { upload_kbps: 10000, download_kbps: 50000, blocked: true });
        reopened.apply(r#"{"action":"block","mac":"02:00:00:00:00:01","blocked":false}"#, false, |_, _| Ok(()), save).unwrap();
        reopened.apply(r#"{"action":"limit","mac":"02:00:00:00:00:01","upload_kbps":0,"download_kbps":0}"#, false, |_, p| { assert!(p.runtime().is_none()); Ok(()) }, save).unwrap();
        assert!(!Policies::load(&db).unwrap().get("02:00:00:00:00:01").active());
    }
    #[test]
    fn storage_failure_restores_runtime_and_runtime_failure_does_not_write() {
        let mut policies = Policies::default();
        let applied = RefCell::new(Vec::new());
        let request = r#"{"action":"block","mac":"02:00:00:00:00:01","blocked":true}"#;
        assert_eq!(policies.apply(request, true, |_, p| { applied.borrow_mut().push(p.blocked); Ok(()) }, |_| Err("disk_full".into())), Err("policy_storage_failed".into()));
        assert_eq!(*applied.borrow(), [true, false]);
        assert!(!policies.get("02:00:00:00:00:01").active());
        assert!(policies.apply(request, true, |_, _| Err("kernel".into()), |_| panic!("must not save")).is_err());
        assert!(policies.apply(request, false, |_, _| panic!("must not apply"), |_| panic!("must not save")).is_err());
    }
    #[test]
    fn rejects_multicast_zero_and_invalid_requests() {
        let mut policies = Policies::default();
        for request in [r#"{"action":"block","mac":"ff:ff:ff:ff:ff:ff","blocked":true}"#,
            r#"{"action":"block","mac":"00:00:00:00:00:00","blocked":true}"#,
            r#"{"action":"block","mac":"02:00:00:00:00:01","blocked":"true"}"#,
            r#"{"action":"limit","mac":"02:00:00:00:00:01","upload_kbps":100000001,"download_kbps":0}"#] {
            assert!(policies.apply(request, true, |_, _| panic!("invalid"), |_| panic!("invalid")).is_err());
        }
        assert_eq!(std::mem::size_of::<DevicePolicy>(), 56);
    }
}
