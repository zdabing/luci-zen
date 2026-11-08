/* SPDX-License-Identifier: GPL-2.0 */
/* Independently implemented endpoint isolation. This does not implement NAT. */
#ifndef ZEN_P2P_CONTROL_H
#define ZEN_P2P_CONTROL_H
#define ZEN_P2P_ENDPOINTS 16384
struct p2p_prefix { __u8 address[16]; __u32 bits, family; };
struct p2p_policy {
	__u32 mode, epoch, idle_seconds, bypass_count;
	struct p2p_prefix bypass[8];
};
struct p2p_key {
	__u8 mac[6], family, protocol, client[16];
	__be16 port;
	__u8 pad[6];
};
struct p2p_endpoint {
	struct bpf_spin_lock lock;
	__u32 epoch;
	__u64 last;
	__u8 remote[16];
	__be16 port;
	__u8 pad[6];
};
struct p2p_counters { __u64 conflicts, dropped, bypassed, skipped, capacity; };
struct { __uint(type,BPF_MAP_TYPE_HASH); __uint(max_entries,4096);
	__type(key,struct mac_key); __type(value,struct p2p_policy);
} p2p_policies SEC(".maps");
struct { __uint(type,BPF_MAP_TYPE_HASH); __uint(max_entries,4096);
	__type(key,struct mac_key); __type(value,struct p2p_counters);
} p2p_stats SEC(".maps");
/* Domain-resolved exceptions: remote prefixes learned from the daemon's DNS
 * refresh. IPv4 is stored v4-mapped so one full-length trie covers both
 * families, matching the per-policy bypass prefixes. */
struct p2p_allow_key { __u32 prefixlen; __u8 data[16]; };
struct { __uint(type,BPF_MAP_TYPE_LPM_TRIE); __uint(max_entries,4096);
	__uint(map_flags,BPF_F_NO_PREALLOC);
	__type(key,struct p2p_allow_key); __type(value,__u8);
} p2p_allow SEC(".maps");
struct { __uint(type,BPF_MAP_TYPE_HASH); __uint(max_entries,ZEN_P2P_ENDPOINTS);
	__type(key,struct p2p_key); __type(value,struct p2p_endpoint);
} p2p_endpoints SEC(".maps");

static __always_inline int p2p_prefix_match(const __u8 *address,const struct p2p_prefix *prefix,__u32 family)
{
	if(prefix->family!=family) return 0;
	int match=1;
#pragma clang loop unroll(full)
	for(int i=0;i<16;i++) {
		__u32 consumed=i*8, bits=prefix->bits;
		if(bits>consumed) {
			__u32 remain=bits-consumed;
			__u8 mask=remain>=8?255:(__u8)(255U<<(8-remain));
			if((address[i]&mask)!=(prefix->address[i]&mask)) match=0;
		}
	}
	return match;
}

static __always_inline int p2p_account(struct __sk_buff *skb,const __u8 *mac,int off,int egress,int v6,__u64 now)
{
	struct mac_key device={}; __builtin_memcpy(device.b,mac,6);
	struct p2p_policy *policy=bpf_map_lookup_elem(&p2p_policies,&device);
	if(!policy || !policy->mode) return 1;
	struct p2p_counters *counts=bpf_map_lookup_elem(&p2p_stats,&device);
	if(!counts) return 1;
	struct p2p_key key={};
	__u8 remote[16]={};
	__be16 ports[4]={};
	struct iphdr ip; struct ipv6hdr ip6;
	int l4; __u32 length;
	__builtin_memcpy(key.mac,mac,6); key.protocol=17;
	if(v6) {
		if(bpf_skb_load_bytes(skb,off,&ip6,sizeof(ip6))) goto skipped;
		if(ip6.nexthdr==6 || ip6.nexthdr==58) return 1;
		if(ip6.nexthdr!=17) goto skipped;
		key.family=6;
		__builtin_memcpy(key.client,egress?&ip6.daddr:&ip6.saddr,16);
		__builtin_memcpy(remote,egress?&ip6.saddr:&ip6.daddr,16);
		l4=off+40; length=bpf_ntohs(ip6.payload_len);
	} else {
		if(bpf_skb_load_bytes(skb,off,&ip,sizeof(ip))) goto skipped;
		if(ip.protocol!=17) return 1;
		if(ip.ihl<5 || (ip.frag_off&bpf_htons(0x3fff))) goto skipped;
		if(bpf_ntohs(ip.tot_len)<ip.ihl*4+8) goto skipped;
		key.family=4; key.client[10]=key.client[11]=255;remote[10]=remote[11]=255;
		__builtin_memcpy(key.client+12,egress?&ip.daddr:&ip.saddr,4);
		__builtin_memcpy(remote+12,egress?&ip.saddr:&ip.daddr,4);
		l4=off+ip.ihl*4; length=bpf_ntohs(ip.tot_len)-ip.ihl*4;
	}
	if(length<8 || bpf_skb_load_bytes(skb,l4,ports,sizeof(ports))) goto skipped;
	if(bpf_ntohs(ports[2])<8 || bpf_ntohs(ports[2])>length) goto skipped;
	key.port=ports[egress?1:0];
	__be16 remote_port=ports[egress?0:1];
	/* Exceptions bypass this packet only; they do not unlock another peer. */
#pragma clang loop unroll(disable)
	for(int i=0;i<8;i++) {
		if((__u32)i>=policy->bypass_count) break;
		if(p2p_prefix_match(remote,&policy->bypass[i],key.family)) {
			__sync_fetch_and_add(&counts->bypassed,1); return 1;
		}
	}
	/* Domain-resolved exceptions refreshed by the daemon. */
	struct p2p_allow_key allow={};
	allow.prefixlen=128;
	__builtin_memcpy(allow.data,remote,16);
	if(bpf_map_lookup_elem(&p2p_allow,&allow)){
		__sync_fetch_and_add(&counts->bypassed,1); return 1;
	}
	struct p2p_endpoint *endpoint=bpf_map_lookup_elem(&p2p_endpoints,&key);
	if(!endpoint && !egress) {
		struct p2p_endpoint initial={};
		initial.epoch=policy->epoch; initial.last=now;
		__builtin_memcpy(initial.remote,remote,16);initial.port=remote_port;
		bpf_map_update_elem(&p2p_endpoints,&key,&initial,BPF_NOEXIST);
		endpoint=bpf_map_lookup_elem(&p2p_endpoints,&key);
		if(!endpoint){__sync_fetch_and_add(&counts->capacity,1);return 1;}
	}
	/* This is not an inbound firewall: never lock a port from inbound traffic. */
	if(!endpoint) return 1;
	int conflict=0;
	__u32 epoch=policy->epoch,mode=policy->mode;
	__u64 idle=(__u64)policy->idle_seconds*1000000000ULL;
	bpf_spin_lock(&endpoint->lock);
	if(endpoint->epoch!=epoch || now<endpoint->last || now-endpoint->last>idle) {
		if(!egress){endpoint->epoch=epoch;endpoint->last=now;
			__builtin_memcpy(endpoint->remote,remote,16);endpoint->port=remote_port;}
	} else if(endpoint->port!=remote_port || __builtin_memcmp(endpoint->remote,remote,16)) {
		conflict=1;
	} else endpoint->last=now;
	bpf_spin_unlock(&endpoint->lock);
	if(conflict) {
		__sync_fetch_and_add(&counts->conflicts,1);
		if(mode==2){__sync_fetch_and_add(&counts->dropped,1);return 0;}
	}
	return 1;
skipped:
	__sync_fetch_and_add(&counts->skipped,1); return 1;
}
#endif
