// SPDX-License-Identifier: GPL-2.0
/*
 * zen_traffic.bpf.c — luci-zen 设备流量数据面（Phase 0 PoC）
 *
 * TC ingress/egress 每设备（MAC 为唯一 key）流量计数。
 *
 * 设计约束（docs/ARCHITECTURE.md §7）：
 *   - eBPF 层只负责 bytes / packets / last_seen，不做速率/统计/设备信息；
 *   - IPv4 与 IPv6 归并到同一 MAC 条目；
 *   - TC ingress（帧自设备进入 LAN 侧）= 设备上传；TC egress（帧发往设备）= 设备下载；
 *   - local_prefixes LPM map 保存本地 IPv4/IPv6 前缀（IPv4 以 v4-mapped 归一化进同一张
 *     trie），目的/源地址命中前缀的流量记为 LAN-local，不参与 WAN（Internet）计数；
 *   - 组播/广播（MAC I/G 位、IPv4 224/4 与 255.255.255.255、IPv6 ff00::/8）跳过；
 *   - 只依赖稳定 UAPI 结构与基础 helper：无 CO-RE 重定位、无 kfunc，
 *     不依赖目标内核 BTF（对象内 BTF 仅用于 BTF-defined maps，随 .o 自带）。
 *
 * 挂载点：LAN 桥设备（br-lan 等）的 clsact ingress/egress，cls_bpf direct-action，
 * verdict 恒为 TC_ACT_OK（旁路观测）。路由流量分析见 ARCHITECTURE.md §3。
 */

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/if_vlan.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#define MAX_DEVICES		4096
#define MAX_PREFIXES		256

/* 与用户态 zen-trafficd-poc.c 中的 struct dev_stats 严格一致 */
struct dev_stats {
	__u64 last_seen;		/* bpf_ktime_get_ns()，ns */
	__u64 wan_rx_b, wan_rx_p;	/* 下载：egress，dst MAC = 设备，Internet */
	__u64 wan_tx_b, wan_tx_p;	/* 上传：ingress，src MAC = 设备，Internet */
	__u64 lan_rx_b, lan_rx_p;	/* 下载：LAN-local */
	__u64 lan_tx_b, lan_tx_p;	/* 上传：LAN-local */
};

struct mac_key {
	__u8 b[6];
};

/* LPM key：IPv4 归一化为 ::ffff:a.b.c.d（prefixlen = 96 + 掩码位），IPv6 原生 */
struct lpm_key {
	__u32 prefixlen;
	__u8 data[16];
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_DEVICES);
	__type(key, struct mac_key);
	__type(value, struct dev_stats);
} devices SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_LPM_TRIE);
	__uint(max_entries, MAX_PREFIXES);
	__uint(map_flags, BPF_F_NO_PREALLOC);
	__type(key, struct lpm_key);
	__type(value, __u8);
} local_prefixes SEC(".maps");

static __always_inline int is_local_v4(__be32 addr)
{
	struct lpm_key k;
	__u8 *hit;

	__builtin_memset(&k, 0, sizeof(k));
	k.prefixlen = 96 + 32;
	k.data[10] = 0xff;
	k.data[11] = 0xff;
	__builtin_memcpy(&k.data[12], &addr, 4);

	hit = bpf_map_lookup_elem(&local_prefixes, &k);
	return hit != NULL;
}

static __always_inline int is_local_v6(const __u8 *addr16)
{
	struct lpm_key k;
	__u8 *hit;

	__builtin_memset(&k, 0, sizeof(k));
	k.prefixlen = 128;
	__builtin_memcpy(k.data, addr16, 16);

	hit = bpf_map_lookup_elem(&local_prefixes, &k);
	return hit != NULL;
}

/* 取或创建设备条目（并发下 BPF_NOEXIST 竞态安全） */
static __always_inline struct dev_stats *dev_get_or_create(const __u8 *mac)
{
	struct mac_key mk;
	struct dev_stats zero = {};
	struct dev_stats *s;

	__builtin_memcpy(mk.b, mac, 6);
	s = bpf_map_lookup_elem(&devices, &mk);
	if (s)
		return s;

	if (bpf_map_update_elem(&devices, &mk, &zero, BPF_NOEXIST) == 0)
		return bpf_map_lookup_elem(&devices, &mk);

	return bpf_map_lookup_elem(&devices, &mk);
}

/*
 * egress=1：帧发往设备（下载），key = eth->h_dest，scope 取决于源地址；
 * egress=0：帧来自设备（上传），key = eth->h_source，scope 取决于目的地址。
 * len：skb->len（TC 层为 L3 字节，GSO skb 已含聚合长度）。
 */
static __always_inline void account(struct __sk_buff *skb, const __u8 *mac,
				    int is_v6, const void *scope_addr, int egress)
{
	struct dev_stats *s = dev_get_or_create(mac);
	__u64 len = skb->len;
	int local;

	if (!s)
		return;

	s->last_seen = bpf_ktime_get_ns();
	local = is_v6 ? is_local_v6((const __u8 *)scope_addr)
		      : is_local_v4(*(__be32 *)scope_addr);

	if (egress) {
		if (local) {
			__sync_fetch_and_add(&s->lan_rx_b, len);
			__sync_fetch_and_add(&s->lan_rx_p, 1);
		} else {
			__sync_fetch_and_add(&s->wan_rx_b, len);
			__sync_fetch_and_add(&s->wan_rx_p, 1);
		}
	} else {
		if (local) {
			__sync_fetch_and_add(&s->lan_tx_b, len);
			__sync_fetch_and_add(&s->lan_tx_p, 1);
		} else {
			__sync_fetch_and_add(&s->wan_tx_b, len);
			__sync_fetch_and_add(&s->wan_tx_p, 1);
		}
	}
}

static __always_inline int zen_account(struct __sk_buff *skb, int egress)
{
	struct ethhdr eth;
	struct vlan_hdr vh;
	struct iphdr ip;
	struct ipv6hdr ip6;
	__u8 mac[6];
	__u16 proto;
	int off = ETH_HLEN;

	/* 头部经 bpf_skb_load_bytes 读取，规避直接指针边界推导的复杂度 */
	if (bpf_skb_load_bytes(skb, 0, &eth, sizeof(eth)))
		return TC_ACT_OK;

	if (egress)
		__builtin_memcpy(mac, eth.h_dest, 6);
	else
		__builtin_memcpy(mac, eth.h_source, 6);

	/* 组播/广播 MAC（I/G 位）：ARP/mDNS/NDP/广播噪声不计数 */
	if (mac[0] & 1)
		return TC_ACT_OK;

	proto = bpf_ntohs(eth.h_proto);
	if (proto == ETH_P_8021Q || proto == ETH_P_8021AD) {
		if (bpf_skb_load_bytes(skb, off, &vh, sizeof(vh)))
			return TC_ACT_OK;
		proto = bpf_ntohs(vh.h_vlan_encapsulated_proto);
		off += sizeof(vh);
	}

	if (proto == ETH_P_IP) {
		if (bpf_skb_load_bytes(skb, off, &ip, sizeof(ip)))
			return TC_ACT_OK;

		/* IPv4 组播 224/4 与受限广播 255.255.255.255 跳过 */
		if ((ip.daddr & bpf_htonl(0xF0000000U)) == bpf_htonl(0xE0000000U) ||
		    ip.daddr == bpf_htonl(0xFFFFFFFFU))
			return TC_ACT_OK;

		/*
		 * 分片非首包同样计数：scope 判定只需 IP 头（分片包 IP 头恒存在），
		 * 字节仍归属该设备，避免分片流量漏计。
		 */
		if (egress)
			account(skb, mac, 0, &ip.saddr, egress);
		else
			account(skb, mac, 0, &ip.daddr, egress);
	} else if (proto == ETH_P_IPV6) {
		if (bpf_skb_load_bytes(skb, off, &ip6, sizeof(ip6)))
			return TC_ACT_OK;

		if (ip6.daddr.s6_addr[0] == 0xff)
			return TC_ACT_OK;	/* IPv6 组播（含 NDP）跳过 */

		if (egress)
			account(skb, mac, 1, &ip6.saddr, egress);
		else
			account(skb, mac, 1, &ip6.daddr, egress);
	}
	/* 其余协议（ARP 等）不计 */

	return TC_ACT_OK;
}

SEC("tc")
int zen_ingress(struct __sk_buff *skb)
{
	return zen_account(skb, 0);	/* 帧自设备进入：上传 */
}

SEC("tc")
int zen_egress(struct __sk_buff *skb)
{
	return zen_account(skb, 1);	/* 帧发往设备：下载 */
}

char _license[] SEC("license") = "GPL";
