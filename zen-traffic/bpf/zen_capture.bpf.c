// SPDX-License-Identifier: GPL-2.0
/*
 * zen_capture.bpf.c — luci-zen 按设备抓包数据面（docs/PACKET_CAPTURE.md §M2）
 *
 * zen-capture 自有的 TC 程序，与 zen_traffic.bpf.o 完全独立（独立对象、独立
 * attach、独立 map），崩溃互不影响。
 *
 * 设计约束：
 *   - per-MAC 开关（capture_enable HASH）：start 写入、stop 删除，恒无全网抓包；
 *   - 命中帧 push 到 RINGBUF，由用户态组装 pcap 并做 DNS/SNI 解析（BPF 无脑）；
 *   - verdict 恒 TC_ACT_UNSPEC：cls_bpf 过滤链继续匹配（TCX 语义 = TCX_NEXT），
 *     zen_ingress/zen_egress 会计与策略照常执行；
 *   - 挂载顺序必须先于 zen 会计程序（TCX: LinkOrder::first()；netlink: priority 1），
 *     否则会计程序的 TC_ACT_OK 会终止链，capture 永远看不到包；
 *   - 只依赖稳定 UAPI 与基础 helper：无 CO-RE、无 kfunc，不依赖目标内核 BTF。
 *     RINGBUF 需要内核 ≥5.8（目标 6.6/6.12 满足）。
 */

#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <linux/if_ether.h>
#include <linux/if_vlan.h>
#include <linux/ip.h>
#include <linux/ipv6.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

#ifndef VLAN_VID_MASK
struct vlan_hdr {
	__be16 h_vlan_TCI;
	__be16 h_vlan_encapsulated_proto;
};
#endif

#define MAX_CAPTURES		16
#define CAP_FRAME_DATA		256

/* 每设备抓包开关：value 保留为标志位（bit0 = 抓包中） */
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_CAPTURES);
	__type(key, __u8[6]);
	__type(value, __u8);
} capture_enable SEC(".maps");

/* 用户态每 tick 排空；忙时丢帧由用户态按 orig_len 口径解释 */
struct capture_frame {
	__u64 ts_ns;			/* bpf_ktime_get_ns() */
	__u32 orig_len;			/* skb->len（L2 字节口径） */
	__u32 cap_len;			/* data 内有效字节数 */
	__u8 mac[6];
	__u8 _pad[2];
	__u8 data[CAP_FRAME_DATA];
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);	/* 1 MiB，页对齐由内核保证 */
} capture_events SEC(".maps");

/*
 * egress=1：帧发往设备，设备 MAC = h_dest；ingress=0：帧来自设备，MAC = h_source。
 * 与 zen_traffic 相反的 MAC 选择方向在这里无所谓——两个方向都命中同一开关条目。
 */
static __always_inline int zen_capture(struct __sk_buff *skb, int egress)
{
	struct capture_frame *frame;
	struct ethhdr eth;
	__u8 mac[6];
	__u8 *enabled;
	__u32 n, cap_len;

	if (bpf_skb_load_bytes(skb, 0, &eth, sizeof(eth)))
		return TC_ACT_UNSPEC;

	if (egress)
		__builtin_memcpy(mac, eth.h_dest, 6);
	else
		__builtin_memcpy(mac, eth.h_source, 6);

	/* 组播/广播（I/G 位）不抓 */
	if (mac[0] & 1)
		return TC_ACT_UNSPEC;

	enabled = bpf_map_lookup_elem(&capture_enable, mac);
	if (!enabled || !*enabled)
		return TC_ACT_UNSPEC;

	frame = bpf_ringbuf_reserve(&capture_events, sizeof(*frame), 0);
	if (!frame)
		return TC_ACT_UNSPEC;	/* ringbuf 满：丢帧，会计不受影响 */

	frame->ts_ns = bpf_ktime_get_ns();
	frame->orig_len = skb->len;
	__builtin_memcpy(frame->mac, mac, 6);

	n = skb->len;
	cap_len = n > CAP_FRAME_DATA ? CAP_FRAME_DATA : n;
	/* cap_len ∈ [0, CAP_FRAME_DATA]，bpf_skb_load_bytes 接受运行时长度 */
	if (cap_len && bpf_skb_load_bytes(skb, 0, frame->data, cap_len)) {
		bpf_ringbuf_discard(frame, 0);
		return TC_ACT_UNSPEC;
	}
	frame->cap_len = cap_len;

	bpf_ringbuf_submit(frame, 0);
	return TC_ACT_UNSPEC;
}

SEC("classifier")
int zen_cap_ingress(struct __sk_buff *skb)
{
	return zen_capture(skb, 0);
}

SEC("classifier")
int zen_cap_egress(struct __sk_buff *skb)
{
	return zen_capture(skb, 1);
}

char _license[] SEC("license") = "GPL";
