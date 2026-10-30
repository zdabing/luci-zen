/* SPDX-License-Identifier: GPL-2.0 */
#ifndef ZEN_APP_FLOW_H
#define ZEN_APP_FLOW_H

#define ZEN_APP_FLOWS 16384
#define ZEN_APP_SAMPLE_SIZE 4096
#define ZEN_APP_SAMPLE_PACKETS 128
#define ZEN_APP_CONTROL_PACKETS 8

/* Device-normalized five tuple: both directions use the same key. */
struct app_flow_key {
	__u8 mac[6], family, protocol;
	__u8 client[16], server[16];
	__be16 client_port, server_port;
};
struct app_flow_stats {
	__u64 first_seen, last_seen, download, upload, samples, control_samples;
};
struct app_flow_sample {
	struct app_flow_key key;
	__u32 length;
	__u64 first_seen, time;
	__u8 packet[ZEN_APP_SAMPLE_SIZE];
};
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, ZEN_APP_FLOWS);
	__type(key, struct app_flow_key);
	__type(value, struct app_flow_stats);
} app_flows SEC(".maps");
struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 8 * 1024 * 1024);
} app_samples SEC(".maps");
struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u32);
} app_enabled SEC(".maps");
/* map full, sample queue full, unsupported L4: visible coverage diagnostics. */
struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 3);
	__type(key, __u32);
	__type(value, __u64);
} app_errors SEC(".maps");

static __always_inline void app_error(__u32 index)
{
	__u64 *value = bpf_map_lookup_elem(&app_errors, &index);
	if (value) __sync_fetch_and_add(value, 1);
}

static __always_inline void app_account(struct __sk_buff *skb, const __u8 *mac,
				       int off, int egress, int v6)
{
	__u32 zero = 0;
	__u32 *enabled = bpf_map_lookup_elem(&app_enabled, &zero);
	struct app_flow_key key = {};
	struct app_flow_stats initial = {}, *stats;
	struct app_flow_sample *event;
	struct iphdr ip;
	struct ipv6hdr ip6;
	__be16 ports[2];
	int l4;
	__u32 length, ip_length;
	__u64 now = bpf_ktime_get_ns();
	if (!enabled || !*enabled) return;
	__builtin_memcpy(key.mac, mac, 6);
	if (v6) {
		if (bpf_skb_load_bytes(skb, off, &ip6, sizeof(ip6))) return;
		key.family = 6; key.protocol = ip6.nexthdr;
		__builtin_memcpy(key.client, egress ? &ip6.daddr : &ip6.saddr, 16);
		__builtin_memcpy(key.server, egress ? &ip6.saddr : &ip6.daddr, 16);
		l4 = off + sizeof(ip6);
		ip_length = sizeof(ip6) + bpf_ntohs(ip6.payload_len);
	} else {
		if (bpf_skb_load_bytes(skb, off, &ip, sizeof(ip))) return;
		if (ip.ihl < 5 || (ip.frag_off & bpf_htons(0x3fff))) { app_error(2); return; }
		key.family = 4; key.protocol = ip.protocol;
		__builtin_memcpy(key.client, egress ? &ip.daddr : &ip.saddr, 4);
		__builtin_memcpy(key.server, egress ? &ip.saddr : &ip.daddr, 4);
		l4 = off + ip.ihl * 4;
		ip_length = bpf_ntohs(ip.tot_len);
	}
	/* Fragment/extension headers and other protocols remain in device totals.
	 * They must appear as unattributed bytes, never as a guessed application. */
	if (key.protocol != 6 && key.protocol != 17) { app_error(2); return; }
	if (bpf_skb_load_bytes(skb, l4, &ports, sizeof(ports))) return;
	key.client_port = ports[egress ? 1 : 0];
	key.server_port = ports[egress ? 0 : 1];
	stats = bpf_map_lookup_elem(&app_flows, &key);
	if (!stats) {
		initial.first_seen = now;
		bpf_map_update_elem(&app_flows, &key, &initial, BPF_NOEXIST);
		stats = bpf_map_lookup_elem(&app_flows, &key);
	}
	if (!stats) { app_error(0); return; }
	stats->last_seen = now;
	if (egress) __sync_fetch_and_add(&stats->download, skb->len);
	else __sync_fetch_and_add(&stats->upload, skb->len);
	/* Empty TCP ACKs must not consume the useful-payload inspection budget. */
	__u64 *counter = &stats->samples;
	__u64 budget = ZEN_APP_SAMPLE_PACKETS;
	if (key.protocol == 6) {
		__u8 tcp[2];
		if (bpf_skb_load_bytes(skb, l4 + 12, tcp, sizeof(tcp))) return;
		__u32 tcp_length = (tcp[0] >> 4) * 4;
		if (tcp_length < 20 || ip_length < (__u32)(l4 - off) + tcp_length) return;
		if (ip_length == (__u32)(l4 - off) + tcp_length) {
			if (!(tcp[1] & 0x07)) return; /* FIN, SYN or RST only. */
			counter = &stats->control_samples;
			budget = ZEN_APP_CONTROL_PACKETS;
		}
	} else if (ip_length <= (__u32)(l4 - off) + 8) {
		return;
	}
	if (*counter >= budget) return;
	if (__sync_fetch_and_add(counter, 1) >= budget) {
		__sync_fetch_and_sub(counter, 1);
		return;
	}
	event = bpf_ringbuf_reserve(&app_samples, sizeof(*event), 0);
	if (!event) { __sync_fetch_and_sub(counter, 1); app_error(1); return; }
	event->key = key;
	event->first_seen = stats->first_seen;
	event->time = now;
	length = skb->len > (__u32)off ? skb->len - off : 0;
	if (length > ZEN_APP_SAMPLE_SIZE) length = ZEN_APP_SAMPLE_SIZE;
	event->length = length;
	/* Clear unused tail: ring records never expose uninitialized kernel data. */
	/* Volatile stores prevent LLVM from lowering a large clear to an
	 * unsupported BPF memset call. This loop has a verifier-visible bound. */
#pragma clang loop unroll(disable)
	for (int i = 0; i < ZEN_APP_SAMPLE_SIZE / 8; i++)
		((volatile __u64 *)event->packet)[i] = 0;
	/* Reload through volatile memory so both LLVM and the kernel verifier
	 * retain the explicit positive-length check at the helper call. */
	__u32 read_length = *(volatile __u32 *)&event->length;
	if (read_length == 0 || read_length > ZEN_APP_SAMPLE_SIZE) {
		__sync_fetch_and_sub(counter, 1);
		bpf_ringbuf_discard(event, 0); return;
	}
	if (bpf_skb_load_bytes(skb, off, event->packet, read_length)) {
		__sync_fetch_and_sub(counter, 1);
		bpf_ringbuf_discard(event, 0); return;
	}
	bpf_ringbuf_submit(event, 0);
}
#endif
