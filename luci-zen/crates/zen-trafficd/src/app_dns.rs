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
        let candidate = rules
            .find(&question)
            .filter(|rule| rule.level == Level::Dedicated);
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
            // Preserve ambiguity rather than overwriting the first owner.
            let app = candidate.map(|rule| rule.app_id()).unwrap_or(0);
            let until = now + u64::from(answer_ttl.min(*chain_ttl)) * 1000;
            if apps.len() < 16 || apps.contains_key(&app) {
                let until = apps
                    .get(&app)
                    .map(|(_, old)| until.max(*old))
                    .unwrap_or(until);
                apps.insert(app, (candidate.cloned(), until));
            } else {
                apps.insert(0, (None, now + 3_600_000));
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
        apps.values().next().and_then(|(rule, _)| rule.clone())
    }
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"queries":self.queries,"replies":self.replies,"rejected":self.rejected,"fake_ip_rejected":self.fake_ip,"ambiguous":self.ambiguous,"hits":self.hits,"pending":self.pending.len(),"addresses":self.addresses.len(),"persisted":false})
    }
}
