//! Persistent opt-in UDP endpoint control, independent of recognition and NAT.
use crate::policy::valid_mac;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::IpAddr;
use zen_bpf::p2p::{P2pPolicy, P2pPrefix};
const SETTING: &str = "p2p_policies_v1";
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Off,
    Observe,
    Enforce,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub mode: Mode,
    pub idle_seconds: u32,
    pub bypass: Vec<String>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            mode: Mode::Off,
            idle_seconds: 120,
            bypass: vec![],
        }
    }
}
fn prefix(input: &str) -> Result<P2pPrefix, String> {
    let (address, bits) = input
        .split_once('/')
        .map_or((input, None), |(a, b)| (a, Some(b)));
    let ip: IpAddr = address.parse().map_err(|_| "invalid_p2p_bypass")?;
    let maximum = if ip.is_ipv4() { 32 } else { 128 };
    let bits = bits
        .map(|b| b.parse::<u32>())
        .transpose()
        .map_err(|_| "invalid_p2p_bypass")?
        .unwrap_or(maximum);
    if bits > maximum || matches!(ip,IpAddr::V6(v) if v.to_ipv4_mapped().is_some()) {
        return Err("invalid_p2p_bypass".into());
    }
    Ok(match ip {
        IpAddr::V4(v) => P2pPrefix {
            address: v.to_ipv6_mapped().octets(),
            bits: 96 + bits,
            family: 4,
        },
        IpAddr::V6(v) => P2pPrefix {
            address: v.octets(),
            bits,
            family: 6,
        },
    })
}
impl Policy {
    fn runtime(&self, epoch: u32) -> Result<P2pPolicy, String> {
        if !(30..=600).contains(&self.idle_seconds) || self.bypass.len() > 8 {
            return Err("invalid_p2p_policy".into());
        }
        let mut value = P2pPolicy {
            mode: match self.mode {
                Mode::Off => 0,
                Mode::Observe => 1,
                Mode::Enforce => 2,
            },
            epoch,
            idle_seconds: self.idle_seconds,
            bypass_count: self.bypass.len() as u32,
            ..Default::default()
        };
        for (i, rule) in self.bypass.iter().enumerate() {
            value.bypass[i] = prefix(rule)?;
        }
        Ok(value)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    mac: String,
    policy: Policy,
}
#[derive(Default)]
pub struct Policies {
    entries: BTreeMap<String, Policy>,
    epoch: u32,
    last_prune: u64,
}
impl Policies {
    pub fn load(db: &crate::persistence::Db) -> Result<Self, String> {
        let entries: BTreeMap<String, Policy> = match db.setting(SETTING)? {
            Some(s) => serde_json::from_str(&s).map_err(|_| "p2p_storage_invalid")?,
            None => BTreeMap::new(),
        };
        if entries.len() > 4096
            || entries.iter().any(|(m, p)| {
                !valid_mac(m) || m != &m.to_ascii_lowercase() || p.runtime(1).is_err()
            })
        {
            return Err("p2p_storage_invalid".into());
        }
        Ok(Self {
            entries,
            epoch: 1,
            last_prune: 0,
        })
    }
    pub fn get(&self, mac: &str) -> Policy {
        self.entries.get(mac).cloned().unwrap_or_default()
    }
    pub fn restore(&mut self, bpf: &mut aya::Ebpf) -> Result<(), String> {
        for (mac, p) in &self.entries {
            zen_bpf::p2p::set(
                bpf,
                crate::daemon::parse_mac(mac).ok_or("invalid_mac")?,
                p.runtime(self.epoch)?,
            )?;
        }
        Ok(())
    }
    pub fn tick(&mut self, bpf: &mut aya::Ebpf, now_ms: u64) {
        if now_ms.saturating_sub(self.last_prune) < 30_000 {
            return;
        }
        self.last_prune = now_ms;
        if let Err(e) = zen_bpf::p2p::prune(bpf, now_ms.saturating_mul(1_000_000)) {
            eprintln!("[zen-trafficd] P2P cleanup: {e}");
        }
    }
    pub fn apply(
        &mut self,
        input: &str,
        enforceable: bool,
        mut runtime: impl FnMut(&str, P2pPolicy) -> Result<(), String>,
        mut persist: impl FnMut(&str) -> Result<(), String>,
    ) -> Result<Policy, String> {
        if input.len() > 4096 {
            return Err("invalid_request".into());
        }
        let req: Request = serde_json::from_str(input).map_err(|_| "invalid_request")?;
        if !valid_mac(&req.mac) {
            return Err("invalid_mac".into());
        }
        let mac = req.mac.to_ascii_lowercase();
        let next = req.policy;
        // Off is always available; observation also needs a complete packet path.
        if next.mode != Mode::Off && !enforceable {
            return Err("p2p_offload_or_interface_unavailable".into());
        }
        let rollback_epoch = self.epoch.checked_add(2).ok_or("p2p_epoch_exhausted")?;
        self.epoch += 1;
        let value = next.runtime(self.epoch)?;
        let previous = self.get(&mac);
        let mut entries = self.entries.clone();
        if next.mode == Mode::Off {
            entries.remove(&mac);
        } else {
            entries.insert(mac.clone(), next.clone());
        }
        if entries.len() > 4096 {
            return Err("policy_capacity".into());
        }
        let json = serde_json::to_string(&entries).map_err(|_| "p2p_storage_invalid")?;
        runtime(&mac, value)?;
        if persist(&json).is_err() {
            self.epoch = rollback_epoch;
            runtime(&mac, previous.runtime(self.epoch)?).map_err(|_| "p2p_rollback_failed")?;
            return Err("p2p_storage_failed".into());
        }
        self.entries = entries;
        Ok(next)
    }
    pub fn save_key() -> &'static str {
        SETTING
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    const OBSERVE: &str = r#"{"mac":"02:00:00:00:00:01","policy":{"mode":"observe","idle_seconds":120,"bypass":["8.8.8.8/32","2001:db8::/32"]}}"#;
    #[test]
    fn dual_stack_prefixes_and_bounded_input() {
        let v4 = prefix("0.0.0.0/0").unwrap();
        assert_eq!(v4.bits, 96);
        assert_eq!(&v4.address[10..12], &[255, 255]);
        assert_eq!(prefix("2001:db8::/32").unwrap().bits, 32);
        for rule in [
            "example.com",
            "1.2.3.4/33",
            "::/129",
            "::ffff:1.2.3.4",
            "1.2.3.4/-1",
        ] {
            assert!(prefix(rule).is_err());
        }
        assert_eq!(std::mem::size_of::<P2pPolicy>(), 208);
    }
    #[test]
    fn persists_and_off_remains_available_with_offload() {
        let db = crate::persistence::Db::open(":memory:").unwrap();
        let mut policies = Policies::load(&db).unwrap();
        assert_eq!(policies.get("02:00:00:00:00:01").mode, Mode::Off);
        policies
            .apply(
                OBSERVE,
                true,
                |_, p| {
                    assert_eq!(p.mode, 1);
                    assert_eq!(p.bypass_count, 2);
                    Ok(())
                },
                |s| db.save_setting(SETTING, s),
            )
            .unwrap();
        let mut restored = Policies::load(&db).unwrap();
        assert_eq!(restored.get("02:00:00:00:00:01").mode, Mode::Observe);
        assert!(
            restored
                .apply(OBSERVE, false, |_, _| panic!(), |_| panic!())
                .is_err()
        );
        let off = OBSERVE.replace("observe", "off");
        restored
            .apply(
                &off,
                false,
                |_, p| {
                    assert_eq!(p.mode, 0);
                    Ok(())
                },
                |s| db.save_setting(SETTING, s),
            )
            .unwrap();
        assert_eq!(
            Policies::load(&db).unwrap().get("02:00:00:00:00:01").mode,
            Mode::Off
        );
    }
    #[test]
    fn rollback_has_a_fresh_epoch_and_keeps_saved_policy() {
        let mut policies = Policies::default();
        let runtime = RefCell::new(Vec::new());
        assert_eq!(
            policies.apply(
                OBSERVE,
                true,
                |_, p| {
                    runtime.borrow_mut().push((p.mode, p.epoch));
                    Ok(())
                },
                |_| Err("disk_full".into())
            ),
            Err("p2p_storage_failed".into())
        );
        let applied = runtime.borrow();
        assert_eq!(applied[0].0, 1);
        assert_eq!(applied[1].0, 0);
        assert_ne!(applied[0].1, applied[1].1);
        assert_eq!(policies.get("02:00:00:00:00:01").mode, Mode::Off);
        assert!(
            policies
                .apply(OBSERVE, true, |_, _| Err("kernel".into()), |_| panic!())
                .is_err()
        );
    }
    #[test]
    fn malformed_requests_never_reach_the_kernel() {
        let mut policies = Policies::default();
        for request in [
            OBSERVE.replace("observe", "unknown"),
            OBSERVE.replace("120", "0"),
            OBSERVE.replace("02:00:00:00:00:01", "ff:ff:ff:ff:ff:ff"),
            OBSERVE.replace("8.8.8.8/32", "host.invalid"),
            OBSERVE.replace("\"mode\"", "\"unexpected\""),
        ] {
            assert!(
                policies
                    .apply(&request, true, |_, _| panic!(), |_| panic!())
                    .is_err()
            );
        }
    }
}
