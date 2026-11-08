//! ABI for the optional UDP endpoint-isolation filter; OpenWrt retains NAT.
use crate::MacKey;
use aya::maps::lpm_trie::Key as LpmTrieKey;
use aya::maps::{HashMap, LpmTrie, MapError};
use aya::{Ebpf, Pod};

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct P2pPrefix {
    pub address: [u8; 16],
    pub bits: u32,
    pub family: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct P2pPolicy {
    pub mode: u32,
    pub epoch: u32,
    pub idle_seconds: u32,
    pub bypass_count: u32,
    pub bypass: [P2pPrefix; 8],
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct P2pCounters {
    pub conflicts: u64,
    pub dropped: u64,
    pub bypassed: u64,
    pub skipped: u64,
    pub capacity: u64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct EndpointKey {
    mac: [u8; 6],
    family: u8,
    protocol: u8,
    client: [u8; 16],
    port: u16,
    pad: [u8; 6],
}
#[repr(C)]
#[derive(Clone, Copy)]
struct Endpoint {
    lock: u32,
    epoch: u32,
    last: u64,
    remote: [u8; 16],
    port: u16,
    pad: [u8; 6],
}
unsafe impl Pod for P2pPrefix {}
unsafe impl Pod for P2pPolicy {}
unsafe impl Pod for P2pCounters {}
unsafe impl Pod for EndpointKey {}
unsafe impl Pod for Endpoint {}

pub fn set(bpf: &mut Ebpf, mac: MacKey, value: P2pPolicy) -> Result<(), String> {
    // Allocate counters before exposing a policy to the packet path.
    let mut stats: HashMap<_, MacKey, P2pCounters> =
        HashMap::try_from(bpf.map_mut("p2p_stats").ok_or("p2p_unavailable")?)
            .map_err(|_| "p2p_unavailable")?;
    match stats.get(&mac, 0) {
        Ok(_) => {}
        Err(MapError::KeyNotFound) => stats
            .insert(mac, P2pCounters::default(), 1)
            .map_err(|_| "p2p_apply_failed")?,
        Err(_) => return Err("p2p_apply_failed".into()),
    }
    let mut policies: HashMap<_, MacKey, P2pPolicy> =
        HashMap::try_from(bpf.map_mut("p2p_policies").ok_or("p2p_unavailable")?)
            .map_err(|_| "p2p_unavailable")?;
    if value.mode == 0 {
        match policies.remove(&mac) {
            Ok(()) | Err(MapError::KeyNotFound) => Ok(()),
            Err(_) => Err("p2p_apply_failed".into()),
        }
    } else {
        policies
            .insert(mac, value, 0)
            .map_err(|_| "p2p_apply_failed".into())
    }
}
pub fn counters(bpf: &Ebpf, mac: MacKey) -> Result<P2pCounters, String> {
    let stats: HashMap<_, MacKey, P2pCounters> =
        HashMap::try_from(bpf.map("p2p_stats").ok_or("p2p_unavailable")?)
            .map_err(|_| "p2p_unavailable")?;
    match stats.get(&mac, 0) {
        Ok(v) => Ok(v),
        Err(MapError::KeyNotFound) => Ok(P2pCounters::default()),
        Err(_) => Err("p2p_read_failed".into()),
    }
}
/// Replace the domain-resolved allow trie. Addresses are full-length keys:
/// IPv4 is v4-mapped so the datapath can look up both families with one
/// 128-bit prefix, matching the map contract in `bpf/p2p_control.h`.
pub fn allow_sync(bpf: &mut Ebpf, previous: &[[u8; 16]], next: &[[u8; 16]]) -> Result<(), String> {
    let map = bpf
        .map_mut("p2p_allow")
        .ok_or("p2p_unavailable")?;
    let mut trie: LpmTrie<_, [u8; 16], u8> =
        LpmTrie::try_from(map).map_err(|_| "p2p_unavailable")?;
    for address in previous {
        if !next.contains(address) {
            let _ = trie.remove(&LpmTrieKey::new(128, *address));
        }
    }
    for address in next {
        if !previous.contains(address) {
            trie.insert(&LpmTrieKey::new(128, *address), 1, 0)
                .map_err(|_| "p2p_apply_failed".to_string())?;
        }
    }
    Ok(())
}

pub fn prune(bpf: &mut Ebpf, now_ns: u64) -> Result<(), String> {
    let mut endpoints: HashMap<_, EndpointKey, Endpoint> =
        HashMap::try_from(bpf.map_mut("p2p_endpoints").ok_or("p2p_unavailable")?)
            .map_err(|_| "p2p_unavailable")?;
    // Reclaim only entries idle beyond twice the largest configurable timeout.
    // A concurrent refresh may lose its old lock; this best-effort filter is not
    // a security boundary. New outbound traffic always establishes a new lock.
    let stale: Vec<_> = endpoints
        .iter()
        .take(16384)
        .filter_map(|entry| entry.ok())
        .filter(|(_, v)| now_ns.saturating_sub(v.last) > 1_200_000_000_000)
        .map(|(k, _)| k)
        .collect();
    for key in stale {
        let _ = endpoints.remove(&key);
    }
    Ok(())
}
