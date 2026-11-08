//! Global domain exceptions for the P2P filter.
//!
//! Operators list BT/PT or other hosts that legitimately need many peers.
//! The daemon resolves the list off the packet path, keeps the previous set
//! when a refresh fails, and publishes the result to the kernel allow trie.
//! The list is global: a device under P2P control always honours it.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::mpsc::{self, Receiver, TryRecvError};

const SETTING: &str = "p2p_domains_v1";
pub const MAX_DOMAINS: usize = 16;
const MAX_ADDRESSES: usize = 4096;
const REFRESH_MS: u64 = 300_000;
const RESOLVE_TIMEOUT_MS: u64 = 90_000;
/// Filled in by tests that need a deterministic clock.
const STARTUP_DELAY_MS: u64 = 5_000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    domains: Vec<String>,
}

#[derive(Default)]
pub struct Domains {
    entries: Vec<String>,
    resolved: Vec<[u8; 16]>,
    last_refresh_ms: u64,
    error: Option<String>,
    refreshing: bool,
    rx: Option<Receiver<Result<Vec<IpAddr>, String>>>,
}

/// Lower-case a domain and reject anything that is not a plain ASCII name.
pub fn normalize(input: &str) -> Option<String> {
    let domain = input.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() || domain.len() > 253 {
        return None;
    }
    let mut labels = 0usize;
    for label in domain.split('.') {
        labels += 1;
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        if !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return None;
        }
    }
    // A single label is almost always a typo; require a dotted public name.
    if labels < 2 {
        return None;
    }
    Some(domain)
}

fn address_key(ip: IpAddr) -> [u8; 16] {
    match ip {
        IpAddr::V4(v4) => v4.to_ipv6_mapped().octets(),
        IpAddr::V6(v6) => v6.octets(),
    }
}

fn address_text(key: &[u8; 16]) -> String {
    if key[10] == 0xff && key[11] == 0xff {
        let mut octets = [0u8; 4];
        octets.copy_from_slice(&key[12..16]);
        return Ipv4Addr::from(octets).to_string();
    }
    let mut octets = [0u8; 16];
    octets.copy_from_slice(key);
    Ipv6Addr::from(octets).to_string()
}

fn resolve(domains: &[String]) -> Result<Vec<IpAddr>, String> {
    let mut addresses: BTreeSet<IpAddr> = BTreeSet::new();
    let mut resolved_any = false;
    for domain in domains {
        let Ok(addrs) = (domain.as_str(), 443u16).to_socket_addrs() else {
            continue;
        };
        resolved_any = true;
        for addr in addrs {
            addresses.insert(addr.ip());
            if addresses.len() >= MAX_ADDRESSES {
                break;
            }
        }
        if addresses.len() >= MAX_ADDRESSES {
            break;
        }
    }
    if !resolved_any {
        return Err("p2p_domain_resolve_failed".into());
    }
    Ok(addresses.into_iter().collect())
}

impl Domains {
    pub fn load(db: &crate::persistence::Db) -> Result<Self, String> {
        let entries = match db.setting(SETTING)? {
            Some(raw) => {
                let store: Store =
                    serde_json::from_str(&raw).map_err(|_| "p2p_domains_invalid")?;
                if store.domains.len() > MAX_DOMAINS {
                    return Err("p2p_domains_invalid".into());
                }
                store
                    .domains
                    .iter()
                    .map(|domain| normalize(domain).ok_or("p2p_domains_invalid"))
                    .collect::<Result<Vec<_>, _>>()?
            }
            None => Vec::new(),
        };
        Ok(Self {
            entries,
            resolved: Vec::new(),
            last_refresh_ms: 0,
            error: None,
            refreshing: false,
            rx: None,
        })
    }

    pub fn save_key() -> &'static str {
        SETTING
    }

    /// Validate, persist and schedule a refresh. The in-memory list changes
    /// only after the write succeeds.
    pub fn set(
        &mut self,
        input: &str,
        persist: impl Fn(&str) -> Result<(), String>,
    ) -> Result<Vec<String>, String> {
        if input.len() > 4096 {
            return Err("invalid_p2p_domains".into());
        }
        let store: Store = serde_json::from_str(input).map_err(|_| "invalid_p2p_domains")?;
        if store.domains.len() > MAX_DOMAINS {
            return Err("invalid_p2p_domains".into());
        }
        let mut entries: Vec<String> = Vec::with_capacity(store.domains.len());
        for domain in &store.domains {
            let domain = normalize(domain).ok_or("invalid_p2p_domains")?;
            if !entries.contains(&domain) {
                entries.push(domain);
            }
        }
        let json =
            serde_json::to_string(&Store { domains: entries.clone() }).map_err(|_| "invalid_p2p_domains")?;
        persist(&json).map_err(|_| "p2p_domains_storage_failed")?;
        self.entries = entries.clone();
        // A refresh for the previous list may still be in flight; drop its
        // receiver so a stale answer can never overwrite the new list.
        self.rx = None;
        self.refreshing = false;
        self.last_refresh_ms = 0;
        self.error = None;
        Ok(entries)
    }

    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({
            "ok": true,
            "domains": self.entries,
            "resolved": self.resolved.iter().take(64).map(address_text).collect::<Vec<_>>(),
            "resolved_count": self.resolved.len(),
            "limit": MAX_DOMAINS,
            "refreshing": self.refreshing,
            "error": self.error,
            "refresh_seconds": REFRESH_MS / 1000,
            "scope": "global",
        })
    }

    fn poll(&mut self, bpf: &mut aya::Ebpf) {
        let outcome = match self.rx.as_ref() {
            None => return,
            Some(rx) => rx.try_recv(),
        };
        match outcome {
            Ok(Ok(addresses)) => {
                let mut next: Vec<[u8; 16]> =
                    addresses.iter().map(|ip| address_key(*ip)).collect();
                next.sort_unstable();
                next.dedup();
                let previous = std::mem::take(&mut self.resolved);
                match zen_bpf::p2p::allow_sync(bpf, &previous, &next) {
                    Ok(()) => {
                        self.resolved = next;
                        self.error = None;
                    }
                    Err(error) => {
                        eprintln!("[zen-trafficd] P2P domain allow update: {error}");
                        self.resolved = previous;
                        self.error = Some("p2p_apply_failed".into());
                    }
                }
                self.refreshing = false;
                self.rx = None;
            }
            Ok(Err(error)) => {
                self.error = Some(error);
                self.refreshing = false;
                self.rx = None;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                self.error = Some("p2p_domain_resolve_failed".into());
                self.refreshing = false;
                self.rx = None;
            }
        }
    }

    /// Called from the 1s loop. DNS work happens on a detached thread; the
    /// loop only starts a refresh and collects the result.
    pub fn tick(&mut self, bpf: &mut aya::Ebpf, now_ms: u64) {
        self.poll(bpf);
        if self.entries.is_empty() {
            if !self.resolved.is_empty() {
                let previous = std::mem::take(&mut self.resolved);
                if let Err(error) = zen_bpf::p2p::allow_sync(bpf, &previous, &[]) {
                    eprintln!("[zen-trafficd] P2P domain allow clear: {error}");
                    self.resolved = previous;
                }
            }
            self.refreshing = false;
            self.rx = None;
            self.error = None;
            return;
        }
        if self.refreshing {
            if now_ms.saturating_sub(self.last_refresh_ms) > RESOLVE_TIMEOUT_MS {
                self.refreshing = false;
                self.rx = None;
                self.error = Some("p2p_domain_resolve_timeout".into());
            }
            return;
        }
        let due = self.last_refresh_ms == 0
            || now_ms.saturating_sub(self.last_refresh_ms) >= REFRESH_MS + STARTUP_DELAY_MS
            || (self.error.is_some()
                && now_ms.saturating_sub(self.last_refresh_ms) >= 60_000);
        if !due {
            return;
        }
        self.refreshing = true;
        self.last_refresh_ms = now_ms;
        let (tx, rx) = mpsc::channel();
        self.rx = Some(rx);
        let domains = self.entries.clone();
        std::thread::spawn(move || {
            let _ = tx.send(resolve(&domains));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_plain_domains_and_rejects_noise() {
        assert_eq!(normalize(" Tracker.Example.COM. ").as_deref(), Some("tracker.example.com"));
        let mut values: Vec<String> = [
            "",
            "localhost",
            "*.example.com",
            "http://example.com",
            "a..b",
            "-a.example.com",
            "a-.example.com",
            "exa mple.com",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        values.push(format!("{}.com", "a".repeat(64)));
        values.push(format!("{}.{}", "a".repeat(60), "b".repeat(200)));
        for value in values {
            assert!(normalize(&value).is_none(), "accepted {value:?}");
        }
    }

    #[test]
    fn persists_valid_domains_and_keeps_previous_on_failure() {
        let db = crate::persistence::Db::open(":memory:").unwrap();
        let mut domains = Domains::load(&db).unwrap();
        let saved = domains
            .set(
                r#"{"domains":["Tracker.Example.com","tracker.example.com","pt.example.org"]}"#,
                |json| db.save_setting(SETTING, json),
            )
            .unwrap();
        assert_eq!(saved, vec!["tracker.example.com", "pt.example.org"]);
        let reloaded = Domains::load(&db).unwrap();
        assert_eq!(reloaded.entries, saved);
        assert_eq!(reloaded.summary()["resolved_count"], 0);

        let before = domains.entries.clone();
        assert_eq!(
            domains.set(r#"{"domains":["bad..name"]}"#, |_| panic!()),
            Err("invalid_p2p_domains".into())
        );
        assert_eq!(domains.entries, before);
        assert_eq!(
            domains.set(r#"{"domains":[]}"#, |_| Err("disk".into())),
            Err("p2p_domains_storage_failed".into())
        );
        assert_eq!(domains.entries, before);
    }

    #[test]
    fn address_keys_are_v4_mapped_full_length() {
        let mapped = address_key("8.8.8.8".parse().unwrap());
        assert_eq!(mapped[10], 0xff);
        assert_eq!(mapped[11], 0xff);
        assert_eq!(&mapped[12..16], &[8, 8, 8, 8][..]);
        assert_eq!(address_text(&mapped), "8.8.8.8");
        let v6 = address_key("2001:db8::1".parse().unwrap());
        assert_eq!(address_text(&v6), "2001:db8::1");
    }

    #[test]
    fn rejects_unknown_fields_and_oversized_lists() {
        let db = crate::persistence::Db::open(":memory:").unwrap();
        let mut domains = Domains::load(&db).unwrap();
        assert!(domains
            .set(r#"{"domains":[],"extra":true}"#, |_| panic!())
            .is_err());
        let many = (0..MAX_DOMAINS + 1)
            .map(|i| format!("\"d{i}.example.com\""))
            .collect::<Vec<_>>()
            .join(",");
        assert!(domains
            .set(&format!(r#"{{"domains":[{many}]}}"#), |_| panic!())
            .is_err());
    }
}
