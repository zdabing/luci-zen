//! Device-scoped DNS association. Queries must be observed before replies;
//! only answer-section A/AAAA records connected by CNAMEs to the question
//! count. Shared/mixed identities and Fake-IP are never application evidence.
use crate::app_rule_store::{DomainRule, Level, RuleSet};
use std::collections::{BTreeMap, HashMap};
type Device = [u8; 6];
type Address = (u8, [u8; 16]);
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Peer {
    pub mac: Device,
    pub family: u8,
    pub server: [u8; 16],
    pub client: [u8; 16],
    pub port: u16,
}
#[derive(Default)]
pub struct Cache {
    pending: HashMap<(Peer, u16), (String, u16, u64)>,
    addresses: HashMap<(Device, Address), BTreeMap<u32, (Option<DomainRule>, u64)>>,
    last_expire: u64,
    pub queries: u64,
    pub replies: u64,
    pub rejected: u64,
    pub fake_ip: u64,
    pub ambiguous: u64,
    pub hits: u64,
}
fn word(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}
fn name(data: &[u8], start: usize) -> Option<(String, usize)> {
    let (mut offset, mut end, mut labels, mut jumps) = (start, None, Vec::new(), 0);
    loop {
        let length = *data.get(offset)?;
        if length & 0xc0 == 0xc0 {
            let target = ((usize::from(length) & 63) << 8) | usize::from(*data.get(offset + 1)?);
            if target >= offset || jumps >= 16 {
                return None;
            }
            end.get_or_insert(offset + 2);
            offset = target;
            jumps += 1;
            continue;
        }
        if length & 0xc0 != 0 {
            return None;
        }
        offset += 1;
        if length == 0 {
            break;
        }
        let label = std::str::from_utf8(data.get(offset..offset + usize::from(length))?).ok()?;
        labels.push(label);
        offset += usize::from(length);
        if labels.len() > 127 {
            return None;
        }
    }
    let text = crate::app_rules::normalize_hostname(&labels.join("."))?;
    Some((text, end.unwrap_or(offset)))
}
pub fn fake_or_local(address: Address) -> bool {
    if address.0 == 4 {
        let a = address.1;
        matches!(a[0], 0 | 10 | 127 | 224..=255)
            || (a[0] == 172 && (16..=31).contains(&a[1]))
            || (a[0] == 192 && a[1] == 168)
            || (a[0] == 169 && a[1] == 254)
            || (a[0] == 198 && (18..=19).contains(&a[1]))
            || (a[0] == 100 && (64..=127).contains(&a[1]))
    } else {
        if let Some(ip) = std::net::Ipv6Addr::from(address.1).to_ipv4_mapped() {
            let mut bytes = [0; 16];
            bytes[..4].copy_from_slice(&ip.octets());
            return fake_or_local((4, bytes));
        }
        address.1[0] == 0xff
            || address.1[0] & 0xfe == 0xfc
            || (address.1[0] == 0xfe && address.1[1] & 0xc0 == 0x80)
            || address.1 == [0; 16]
            || address.1 == std::net::Ipv6Addr::LOCALHOST.octets()
    }
}
impl Cache {
    pub fn clear(&mut self) {
        self.pending.clear();
        self.addresses.clear();
    }
    pub fn expire(&mut self, now: u64) {
        if now.saturating_sub(self.last_expire) < 1000 {
            return;
        }
        self.last_expire = now;
        self.pending.retain(|_, (_, _, until)| *until > now);
        self.addresses.retain(|_, apps| {
            apps.retain(|_, (_, until)| *until > now);
            !apps.is_empty()
        });
    }
    #[cfg(test)]
    pub fn observe(&mut self, peer: Peer, data: &[u8], now: u64, rules: &RuleSet) {
        self.observe_direction(
            peer,
            data,
            now,
            rules,
            data.get(2).is_some_and(|flags| flags & 0x80 != 0),
        );
    }
    pub fn observe_direction(
        &mut self,
        peer: Peer,
        data: &[u8],
        now: u64,
        rules: &RuleSet,
        response: bool,
    ) {
        if data
            .get(2)
            .is_none_or(|flags| (*flags & 0x80 != 0) != response)
            || self.parse(peer, data, now, rules).is_none()
        {
            self.rejected = self.rejected.saturating_add(1);
        }
    }
    fn parse(&mut self, peer: Peer, data: &[u8], now: u64, rules: &RuleSet) -> Option<()> {
        if data.len() < 12 || data.len() > 4096 {
            return None;
        }
        let id = word(data, 0)?;
        let flags = word(data, 2)?;
        if flags & 0x7a0f != 0 || word(data, 4)? != 1 {
            return None;
        }
        let (question, end) = name(data, 12)?;
        let qtype = word(data, end)?;
        if !matches!(qtype, 1 | 28) || word(data, end + 2)? != 1 {
            return None;
        }
        self.expire(now);
        if flags & 0x8000 == 0 {
            if self.pending.len() >= 4096 {
                return None;
            }
            self.pending
                .insert((peer, id), (question, qtype, now + 10_000));
            self.queries += 1;
            return Some(());
        }
        let (expected, expected_type, until) = self.pending.remove(&(peer.clone(), id))?;
        if expected != question || expected_type != qtype || until <= now {
            return None;
        }
        self.replies += 1;
        let count = word(data, 6)?;
        if count > 64 {
            return None;
        }
        let mut offset = end + 4;
        let mut aliases = HashMap::new();
        let mut answers = Vec::new();
        for _ in 0..count {
            let (owner, next) = name(data, offset)?;
            let kind = word(data, next)?;
            let class = word(data, next + 2)?;
            let ttl = u32::from_be_bytes(data.get(next + 4..next + 8)?.try_into().ok()?).min(3600);
            let length = usize::from(word(data, next + 8)?);
            offset = next + 10;
            let bytes = data.get(offset..offset + length)?;
            if class == 1 && ttl > 0 {
                if kind == 5 {
                    let (target, consumed) = name(data, offset)?;
                    if consumed > offset + length {
                        return None;
                    }
                    if aliases.insert(owner, (target, ttl)).is_some() {
                        return None;
                    }
                } else if kind == qtype && (kind == 1 && length == 4 || kind == 28 && length == 16)
                {
                    let mut ip = [0; 16];
                    ip[..length].copy_from_slice(bytes);
                    answers.push((owner, (if kind == 1 { 4 } else { 6 }, ip), ttl));
                }
            }
            offset += length;
        }
        let mut chain = HashMap::new();
        let mut current = question.as_str();
        let mut ttl = 3600;
        chain.insert(current.to_owned(), ttl);
        for _ in 0..8 {
            let Some((target, alias_ttl)) = aliases.get(current) else {
                break;
            };
            ttl = ttl.min(*alias_ttl);
            if chain.insert(target.clone(), ttl).is_some() {
                return None;
            }
            current = target;
        }
        // The original queried service owns the CNAME chain; an intermediate
        // cloud hostname does not turn unrelated addresses into that service.
        let Some(candidate) = rules
            .find(&question)
            .filter(|rule| matches!(rule.level, Level::Dedicated | Level::Candidate))
        else {
            return Some(());
        };
        for (owner, ip, answer_ttl) in answers {
            let Some(chain_ttl) = chain.get(&owner) else {
                continue;
            };
            if fake_or_local(ip) {
                self.fake_ip += 1;
                continue;
            }
            let key = (peer.mac, ip);
            if !self.addresses.contains_key(&key) && self.addresses.len() >= 8192 {
                return None;
            }
            let apps = self.addresses.entry(key).or_default();
            // Preserve ambiguity when multiple distinct applications share one IP,
            // and retain unambiguous CDN endpoints across multi-minute video streams
            // or long-lived application sessions.
            let app = candidate.app_id();
            let min_ttl = if candidate.level == Level::Dedicated {
                3600
            } else {
                600
            };
            let ttl_secs = answer_ttl.min(*chain_ttl).max(min_ttl);
            let until = now + u64::from(ttl_secs) * 1000;
            if apps.len() < 16 || apps.contains_key(&app) {
                let until = apps
                    .get(&app)
                    .map(|(_, old)| until.max(*old))
                    .unwrap_or(until);
                apps.insert(app, (Some(candidate.clone()), until));
            } else {
                apps.insert(0, (None, now + 600_000));
            }
        }
        Some(())
    }
    pub fn lookup(&mut self, mac: Device, address: Address, now: u64) -> Option<DomainRule> {
        if fake_or_local(address) {
            return None;
        }
        let apps = self.addresses.get_mut(&(mac, address))?;
        apps.retain(|_, (_, until)| *until > now);
        if apps.is_empty() {
            return None;
        }
        if apps.len() != 1 || apps.contains_key(&0) {
            self.ambiguous += 1;
            return None;
        }
        self.hits += 1;
        let (rule, until) = apps.values_mut().next()?;
        let refresh_ms = if rule.as_ref().is_some_and(|r| r.level == Level::Dedicated) {
            1_800_000
        } else {
            300_000
        };
        *until = (*until).max(now + refresh_ms);
        rule.clone()
    }
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"queries":self.queries,"replies":self.replies,"rejected":self.rejected,"fake_ip_rejected":self.fake_ip,"ambiguous":self.ambiguous,"hits":self.hits,"pending":self.pending.len(),"addresses":self.addresses.len(),"persisted":false})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_name(host: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for label in host.split('.') {
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
        out.push(0);
        out
    }

    fn dns_query(id: u16, host: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&0x0100u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&[0; 6]);
        out.extend_from_slice(&encode_name(host));
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out
    }

    fn dns_reply(id: u16, host: &str, ip: [u8; 4], ttl: u32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&id.to_be_bytes());
        out.extend_from_slice(&0x8180u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&[0; 4]);
        let name = encode_name(host);
        out.extend_from_slice(&name);
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&name);
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&1u16.to_be_bytes());
        out.extend_from_slice(&ttl.to_be_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&ip);
        out
    }

    fn v4_addr(ip: [u8; 4]) -> Address {
        let mut bytes = [0; 16];
        bytes[..4].copy_from_slice(&ip);
        (4, bytes)
    }

    #[test]
    fn dedicated_dns_entries_have_hour_floor_and_sliding_refresh_while_shared_ips_stay_ambiguous() {
        let rules = RuleSet::parse(
            r#"{"schema":1,"version":"test-1","source_revision":"0000000000000000000000000000000000000000","rules":[
                {"domain":"ug.link","match":"suffix","app":"community:ugreen","level":"dedicated","source":"test","revision":"test-1","license":"MIT"},
                {"domain":"cand.example","match":"suffix","app":"community:baidu","level":"candidate","source":"test","revision":"test-1","license":"MIT"}
            ]}"#,
        )
        .unwrap();
        let mac = [0x6c, 0x1f, 0xf7, 0x0c, 0xf2, 0x75];
        let peer = Peer {
            mac,
            family: 4,
            server: [8, 8, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            client: [10, 0, 0, 194, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            port: 53000,
        };
        let mut cache = Cache::default();
        let ug_ip = [43, 248, 128, 18];
        let cand_ip = [47, 96, 1, 2];

        cache.observe(peer.clone(), &dns_query(1, "nas.cn58.ug.link"), 1_000_000, &rules);
        cache.observe(
            peer.clone(),
            &dns_reply(1, "nas.cn58.ug.link", ug_ip, 60),
            1_000_010,
            &rules,
        );
        cache.observe(peer.clone(), &dns_query(2, "cand.example"), 1_000_000, &rules);
        cache.observe(
            peer.clone(),
            &dns_reply(2, "cand.example", cand_ip, 60),
            1_000_010,
            &rules,
        );

        // Candidate entry expires after 600s; Dedicated entry persists with a 3600s floor.
        cache.expire(2_000_000);
        assert!(cache.lookup(mac, v4_addr(cand_ip), 2_000_000).is_none());
        let hit = cache.lookup(mac, v4_addr(ug_ip), 2_000_000);
        assert_eq!(hit.as_ref().map(|r| r.app.as_str()), Some("community:ugreen"));

        // An active lookup at +3000s extends the entry by 1800s past the initial +3600s expiry.
        assert!(cache.lookup(mac, v4_addr(ug_ip), 4_000_000).is_some());
        cache.expire(5_000_000);
        assert!(cache.lookup(mac, v4_addr(ug_ip), 5_000_000).is_some());

        // Adding a second app on the same IP marks it ambiguous and refuses guessing.
        cache.observe(peer.clone(), &dns_query(3, "cand.example"), 5_001_000, &rules);
        cache.observe(
            peer,
            &dns_reply(3, "cand.example", ug_ip, 60),
            5_001_010,
            &rules,
        );
        assert!(cache.lookup(mac, v4_addr(ug_ip), 5_001_020).is_none());
        assert_eq!(cache.ambiguous, 1);
    }
}
