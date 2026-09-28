// SPDX-License-Identifier: GPL-2.0
/*
 * zen-trafficd-poc.c — luci-zen 设备流量守护进程 PoC（Phase 0）
 *
 * 职责边界（docs/ARCHITECTURE.md §3/§7）：
 *   - libbpf 加载 zen_traffic.bpf.o，netlink 原生 attach 到 LAN 桥设备的
 *     clsact ingress/egress（cls_bpf direct-action，幂等 REPLACE）；
 *   - 1s uloop timer 遍历 devices map，差分计算每设备实时速率（B/s）；
 *   - 维护 local_prefixes LPM map：defaults + ubus network.interface dump + CLI 追加；
 *   - 直接发布 ubus 对象 zen.traffic.poc（getStats / reset / reloadPrefixes）——
 *     不建 HTTP server、不开 TCP 端口、不经 shell rpcd 桥；
 *   - SIGTERM/SIGINT：detach filter、（可选）清理 pin、退出。
 *
 * 正式包的持久化/日切/属性合并（DHCP/neighbour/hostapd）在 zen-traffic Phase B 演进。
 *
 * 构建：见 poc/Makefile；运行：见 poc/README.md。
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <errno.h>
#include <getopt.h>
#include <signal.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/statfs.h>
#include <arpa/inet.h>
#include <net/if.h>

#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <linux/if_ether.h>
#include <linux/rtnetlink.h>
#include <linux/pkt_sched.h>
#include <linux/pkt_cls.h>
#include <linux/magic.h>

#include <ubus/ubus.h>
#include <libubox/uloop.h>
#include <libubox/blob.h>
#include <libubox/blobmsg.h>

#ifndef BPF_FS_MAGIC
#define BPF_FS_MAGIC 0xcafe4a11
#endif

#ifndef ARRAY_SIZE
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#endif

#define PIN_DIR		"/sys/fs/bpf/zen-traffic"
#define DEFAULT_IFACE	"br-lan"
#define DEFAULT_BPF_OBJ	"build/zen_traffic.bpf.o"
#define MAX_IFACES	8
#define MAX_EXTRA_PREFIX 32

/* 与 eBPF 侧 struct dev_stats 严格一致（9 × u64） */
struct dev_stats {
	uint64_t last_seen;
	uint64_t wan_rx_b, wan_rx_p;
	uint64_t wan_tx_b, wan_tx_p;
	uint64_t lan_rx_b, lan_rx_p;
	uint64_t lan_tx_b, lan_tx_p;
};

struct dev_ent {
	uint8_t mac[6];
	struct dev_stats cur;		/* 本 tick 的 map 值 */
	struct dev_stats prev;		/* 上一 tick 值（差分基准） */
	uint64_t wan_rx_r, wan_tx_r;	/* Internet 速率 B/s */
	uint64_t lan_rx_r, lan_tx_r;	/* LAN-local 速率 B/s */
	bool alive;
	struct dev_ent *next;
};

struct iface_ent {
	char name[IFNAMSIZ];
	int ifindex;
	bool qdisc_created;
	bool filter_in;		/* 我们装上的 ingress filter（用于卸载） */
	bool filter_eg;
};

static struct bpf_object *bpf_obj;
static int map_devices_fd = -1;
static int map_prefixes_fd = -1;
static int nlfd = -1;

static struct iface_ent ifaces[MAX_IFACES];
static int n_ifaces;

static struct dev_ent *dev_list;
static uint64_t last_tick_ms;

static bool opt_pin;
static bool opt_keep_maps;
static bool opt_quiet;
static unsigned opt_interval_ms = 1000;
static char opt_bpf_path[512];
static char opt_extra_prefix[MAX_EXTRA_PREFIX][64];
static int n_extra_prefix;

static struct ubus_context *ubus_ctx;
static struct blob_buf bbuf;
static struct uloop_timeout tick_tm;

static volatile sig_atomic_t g_stop;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

static void mac_to_str(const uint8_t mac[6], char out[18])
{
	snprintf(out, 18, "%02x:%02x:%02x:%02x:%02x:%02x",
		 mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static uint64_t now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ------------------------------------------------------------------ */
/* 原生 netlink（rtnetlink）：clsact qdisc + cls_bpf filter             */
/* ------------------------------------------------------------------ */

struct nlmsg_buf {
	struct nlmsghdr n;
	struct tcmsg t;
	char buf[512];
};

static struct rtattr *nl_addattr(struct nlmsghdr *n, size_t maxlen,
				 int type, const void *data, size_t dlen)
{
	struct rtattr *rta;
	size_t len = RTA_LENGTH(dlen);

	if (NLMSG_ALIGN(n->nlmsg_len) + RTA_ALIGN(len) > maxlen)
		return NULL;

	rta = (struct rtattr *)((char *)n + NLMSG_ALIGN(n->nlmsg_len));
	rta->rta_type = type;
	rta->rta_len = (unsigned short)len;
	if (dlen)
		memcpy(RTA_DATA(rta), data, dlen);
	n->nlmsg_len = (unsigned int)(NLMSG_ALIGN(n->nlmsg_len) + RTA_ALIGN(len));
	return rta;
}

static struct rtattr *nl_nest_start(struct nlmsghdr *n, size_t maxlen, int type)
{
	return nl_addattr(n, maxlen, type, NULL, 0);
}

static void nl_nest_end(struct nlmsghdr *n, struct rtattr *nest)
{
	nest->rta_len = (unsigned short)((char *)n + n->nlmsg_len - (char *)nest);
}

/* 发送并等待 ACK；返回 0 或负 errno（-EEXIST 等由调用方判定） */
static int nl_talk(struct nlmsghdr *n)
{
	struct sockaddr_nl sa = { .nl_family = AF_NETLINK };
	struct iovec iov;
	struct msghdr mh;
	char rbuf[4096];
	ssize_t len;
	struct nlmsghdr *rh;
	struct nlmsgerr *err;

	iov.iov_base = n;
	iov.iov_len = n->nlmsg_len;
	mh.msg_name = &sa;
	mh.msg_namelen = sizeof(sa);
	mh.msg_iov = &iov;
	mh.msg_iovlen = 1;
	mh.msg_control = NULL;
	mh.msg_controllen = 0;
	mh.msg_flags = 0;

	if (sendmsg(nlfd, &mh, 0) < 0)
		return -errno;

	iov.iov_base = rbuf;
	iov.iov_len = sizeof(rbuf);
	len = recvmsg(nlfd, &mh, 0);
	if (len < 0)
		return -errno;

	rh = (struct nlmsghdr *)rbuf;
	if (!NLMSG_OK(rh, (size_t)len))
		return -EBADMSG;

	if (rh->nlmsg_type == NLMSG_ERROR) {
		err = (struct nlmsgerr *)NLMSG_DATA(rh);
		/* ACK（error==0）或错误码 */
		return err->error ? err->error : 0;
	}
	return 0;
}

/* 确保 clsact qdisc 存在；记录是否由我们创建（退出时决定是否删除） */
static int tc_qdisc_ensure(int ifindex, bool *created)
{
	struct nlmsg_buf req;

	memset(&req, 0, sizeof(req));
	req.n.nlmsg_len = NLMSG_LENGTH(sizeof(struct tcmsg));
	req.n.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
	req.n.nlmsg_type = RTM_NEWQDISC;
	req.t.tcm_family = AF_UNSPEC;
	req.t.tcm_ifindex = ifindex;
	req.t.tcm_handle = TC_H_MAKE(TC_H_CLSACT, 0);
	req.t.tcm_parent = TC_H_CLSACT;

	if (!nl_addattr(&req.n, sizeof(req), TCA_KIND, "clsact", 7))
		return -ENOSPC;

	switch (nl_talk(&req.n)) {
	case 0:
		*created = true;
		return 0;
	case -EEXIST:
		*created = false;
		return 0;
	default:
		return -1;
	}
}

static int tc_qdisc_del(int ifindex)
{
	struct nlmsg_buf req;

	memset(&req, 0, sizeof(req));
	req.n.nlmsg_len = NLMSG_LENGTH(sizeof(struct tcmsg));
	req.n.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
	req.n.nlmsg_type = RTM_DELQDISC;
	req.t.tcm_family = AF_UNSPEC;
	req.t.tcm_ifindex = ifindex;
	req.t.tcm_handle = TC_H_MAKE(TC_H_CLSACT, 0);
	req.t.tcm_parent = TC_H_CLSACT;
	return nl_talk(&req.n);
}

/*
 * 装/替换 cls_bpf filter（direct-action）。
 * 固定 pref/handle（1/1）+ NLM_F_REPLACE ⇒ 重复启动幂等，不产生重复 filter。
 */
static int tc_filter_set(int ifindex, __u32 minor, int prog_fd, const char *name)
{
	struct nlmsg_buf req;
	struct rtattr *opts;
	__u32 flags = TCA_BPF_FLAG_ACT_DIRECT;
	__u32 prio = 1;
	int rc;

	memset(&req, 0, sizeof(req));
	req.n.nlmsg_len = NLMSG_LENGTH(sizeof(struct tcmsg));
	req.n.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_REPLACE;
	req.n.nlmsg_type = RTM_NEWTFILTER;
	req.t.tcm_family = AF_UNSPEC;
	req.t.tcm_ifindex = ifindex;
	req.t.tcm_handle = 1;
	req.t.tcm_parent = TC_H_MAKE(TC_H_CLSACT, minor);
	req.t.tcm_info = TC_H_MAKE(prio << 16, htons(ETH_P_ALL));

	opts = nl_nest_start(&req.n, sizeof(req), TCA_OPTIONS);
	if (!opts)
		return -ENOSPC;
	if (!nl_addattr(&req.n, sizeof(req), TCA_BPF_FD, &prog_fd, sizeof(prog_fd)))
		return -ENOSPC;
	if (!nl_addattr(&req.n, sizeof(req), TCA_BPF_NAME, name, strlen(name) + 1))
		return -ENOSPC;
	if (!nl_addattr(&req.n, sizeof(req), TCA_BPF_FLAGS, &flags, sizeof(flags)))
		return -ENOSPC;
	nl_nest_end(&req.n, opts);

	rc = nl_talk(&req.n);
	if (rc)
		fprintf(stderr, "tc filter set %s on ifindex %d: %s\n",
			name, ifindex, strerror(-rc));
	return rc;
}

static int tc_filter_del(int ifindex, __u32 minor)
{
	struct nlmsg_buf req;
	__u32 prio = 1;

	memset(&req, 0, sizeof(req));
	req.n.nlmsg_len = NLMSG_LENGTH(sizeof(struct tcmsg));
	req.n.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
	req.n.nlmsg_type = RTM_DELTFILTER;
	req.t.tcm_family = AF_UNSPEC;
	req.t.tcm_ifindex = ifindex;
	req.t.tcm_handle = 1;
	req.t.tcm_parent = TC_H_MAKE(TC_H_CLSACT, minor);
	req.t.tcm_info = TC_H_MAKE(prio << 16, htons(ETH_P_ALL));
	return nl_talk(&req.n);
}

/* ------------------------------------------------------------------ */
/* BPF：加载 / pin / 卸载                                              */
/* ------------------------------------------------------------------ */

static int bpffs_ready(void)
{
	struct statfs st;

	if (statfs("/sys/fs/bpf", &st) == 0 &&
	    (unsigned long)st.f_type == (unsigned long)BPF_FS_MAGIC)
		return 1;
	fprintf(stderr, "警告: /sys/fs/bpf 未挂载 bpffs（init.d 会自动挂载；"
			"手动: mount -t bpf bpf /sys/fs/bpf）\n");
	return 0;
}

static int bpf_load(void)
{
	struct bpf_program *p_in, *p_eg;
	struct bpf_map *m;
	int err;

	bpf_obj = bpf_object__open_file(opt_bpf_path, NULL);
	err = libbpf_get_error(bpf_obj);
	if (err) {
		bpf_obj = NULL;
		fprintf(stderr, "bpf_object__open_file(%s): %s\n",
			opt_bpf_path, strerror(-err));
		return err;
	}

	/* pin 模式：load 前设置 pin_path；已存在同名 pin 时 libbpf 自动复用（计数连续） */
	if (opt_pin) {
		bpf_object__for_each_map(m, bpf_obj) {
			char path[256];

			snprintf(path, sizeof(path), "%s/%s", PIN_DIR, bpf_map__name(m));
			err = bpf_map__set_pin_path(m, path);
			if (err) {
				fprintf(stderr, "set pin path %s: %s\n", path, strerror(-err));
				return err;
			}
		}
	}

	err = bpf_object__load(bpf_obj);
	if (err) {
		fprintf(stderr, "bpf_object__load: %s\n"
			"（检查内核 CONFIG_BPF_SYSCALL / kmod-sched-bpf / eBPF atomics 支持）\n",
			strerror(-err));
		return err;
	}

	p_in = bpf_object__find_program_by_name(bpf_obj, "zen_ingress");
	p_eg = bpf_object__find_program_by_name(bpf_obj, "zen_egress");
	if (!p_in || !p_eg) {
		fprintf(stderr, "bpf 对象缺少 zen_ingress/zen_egress 程序\n");
		return -EINVAL;
	}

	m = bpf_object__find_map_by_name(bpf_obj, "devices");
	if (!m)
		return -EINVAL;
	map_devices_fd = bpf_map__fd(m);

	m = bpf_object__find_map_by_name(bpf_obj, "local_prefixes");
	if (!m)
		return -EINVAL;
	map_prefixes_fd = bpf_map__fd(m);

	return 0;
}

static int bpf_attach_all(void)
{
	struct bpf_program *p_in, *p_eg;
	int fd_in, fd_eg;
	int i, err;

	p_in = bpf_object__find_program_by_name(bpf_obj, "zen_ingress");
	p_eg = bpf_object__find_program_by_name(bpf_obj, "zen_egress");
	fd_in = bpf_program__fd(p_in);
	fd_eg = bpf_program__fd(p_eg);

	for (i = 0; i < n_ifaces; i++) {
		struct iface_ent *ifc = &ifaces[i];

		err = tc_qdisc_ensure(ifc->ifindex, &ifc->qdisc_created);
		if (err) {
			fprintf(stderr, "clsact qdisc on %s: %s\n",
				ifc->name, strerror(-err));
			return err;
		}

		if (!tc_filter_set(ifc->ifindex, TC_H_MIN_INGRESS, fd_in, "zen-ingress"))
			ifc->filter_in = true;
		else
			return -1;

		if (!tc_filter_set(ifc->ifindex, TC_H_MIN_EGRESS, fd_eg, "zen-egress"))
			ifc->filter_eg = true;
		else
			return -1;

		printf("attached: %s (clsact %s)\n", ifc->name,
		       ifc->qdisc_created ? "created" : "existing");
	}
	return 0;
}

static void bpf_detach_all(void)
{
	int i;

	for (i = 0; i < n_ifaces; i++) {
		struct iface_ent *ifc = &ifaces[i];

		if (ifc->filter_in)
			tc_filter_del(ifc->ifindex, TC_H_MIN_INGRESS);
		if (ifc->filter_eg)
			tc_filter_del(ifc->ifindex, TC_H_MIN_EGRESS);
		/* 只删我们创建的 qdisc，不动用户已有配置 */
		if (ifc->qdisc_created)
			tc_qdisc_del(ifc->ifindex);
	}
}

static void bpf_unpin_maps(void)
{
	struct bpf_map *m;

	if (!opt_pin || opt_keep_maps)
		return;

	bpf_object__for_each_map(m, bpf_obj) {
		char path[256];

		snprintf(path, sizeof(path), "%s/%s", PIN_DIR, bpf_map__name(m));
		bpf_map__unpin(m, path);
	}
}

/* ------------------------------------------------------------------ */
/* local prefixes：defaults + ubus network dump + CLI 追加             */
/* ------------------------------------------------------------------ */

static int prefix_insert(int family, const unsigned char *bytes, int mask)
{
	struct {
		__u32 prefixlen;
		__u8 data[16];
	} k;
	__u8 one = 1;

	if (mask < 0)
		return -1;
	memset(&k, 0, sizeof(k));

	if (family == AF_INET) {
		if (mask > 32)
			return -1;
		k.prefixlen = 96 + mask;
		k.data[10] = 0xff;
		k.data[11] = 0xff;
		memcpy(&k.data[12], bytes, 4);
	} else if (family == AF_INET6) {
		if (mask > 128)
			return -1;
		k.prefixlen = mask;
		memcpy(k.data, bytes, 16);
	} else {
		return -1;
	}

	return bpf_map_update_elem(map_prefixes_fd, &k, &one, BPF_ANY);
}

static void prefix_defaults(void)
{
	static const unsigned char ll16[4] = { 169, 254, 0, 0 };
	unsigned char p10[16];

	/* IPv4 链路本地 169.254.0.0/16 */
	prefix_insert(AF_INET, ll16, 16);
	/* IPv6 链路本地 fe80::/10（RA/DHCPv6/NDP 单播噪声） */
	memset(p10, 0, sizeof(p10));
	p10[0] = 0xfe;
	p10[1] = 0x80;
	prefix_insert(AF_INET6, p10, 10);
}

/* 解析 a.b.c.d/nn 或 v6/nn */
static int prefix_from_cidr(const char *cidr)
{
	char buf[64], *slash;
	int family, mask;
	unsigned char bytes[16];

	snprintf(buf, sizeof(buf), "%s", cidr);
	slash = strchr(buf, '/');
	if (!slash)
		return -1;
	*slash = '\0';
	mask = atoi(slash + 1);

	if (strchr(buf, ':')) {
		family = AF_INET6;
		if (mask < 0 || mask > 128)
			return -1;
	} else {
		family = AF_INET;
		if (mask < 0 || mask > 32)
			return -1;
	}

	if (inet_pton(family, buf, bytes) != 1)
		return -1;
	return prefix_insert(family, bytes, mask);
}

/* ---- ubus 客户端：network.interface dump → LAN 侧本地子网 ----
 * 两趟处理：先收集全部接口的地址与默认路由归属，排除持有默认路由的
 * 上游接口（WAN），再把其余子网写入 LPM —— 上游网段属于 Internet 方向，
 * 不应标记为 local（否则 WAN 归因会误判）。
 */

#define MAX_COLLECTED	64
#define MAX_UPSTREAM	8

struct prefix_tmp {
	int family;
	int mask;
	unsigned char bytes[16];
	char ifname[IFNAMSIZ];
};

static struct prefix_tmp collected[MAX_COLLECTED];
static int n_collected;
static char upstream_names[MAX_UPSTREAM][IFNAMSIZ];
static int n_upstream;

static bool is_upstream(const char *ifname)
{
	int i;

	for (i = 0; i < n_upstream; i++)
		if (!strcmp(upstream_names[i], ifname))
			return true;
	return false;
}

static void collect_addr(const char *ifname, const char *addr, uint32_t mask, int family)
{
	struct prefix_tmp *p;

	if (n_collected >= MAX_COLLECTED)
		return;
	p = &collected[n_collected];
	p->family = family;
	p->mask = (int)mask;
	snprintf(p->ifname, IFNAMSIZ, "%s", ifname);
	if (inet_pton(family, addr, p->bytes) != 1)
		return;
	n_collected++;
}

static void ifdump_entry(struct blob_attr *table, int depth)
{
	struct blob_attr *pos;
	size_t rem;
	const char *ifname = NULL;

	if (depth > 6)
		return;

	blobmsg_for_each_attr(pos, table, rem) {
		const char *name = blobmsg_name(pos);

		if (!strcmp(name, "interface") && blobmsg_type(pos) == BLOBMSG_TYPE_STRING) {
			ifname = blobmsg_get_string(pos);
		} else if (ifname && (!strcmp(name, "ipv4-address") || !strcmp(name, "ipv6-address"))) {
			int family = name[3] == '4' ? AF_INET : AF_INET6;
			struct blob_attr *a2;
			size_t rem2;

			blobmsg_for_each_attr(a2, pos, rem2) {
				struct blob_attr *c2;
				size_t rem3;
				const char *addr = NULL;
				uint32_t mask = 255;

				blobmsg_for_each_attr(c2, a2, rem3) {
					const char *cn = blobmsg_name(c2);

					if (!strcmp(cn, "address") &&
					    blobmsg_type(c2) == BLOBMSG_TYPE_STRING)
						addr = blobmsg_get_string(c2);
					else if (!strcmp(cn, "mask") &&
						 blobmsg_type(c2) == BLOBMSG_TYPE_INT32)
						mask = blobmsg_get_u32(c2);
				}
				if (addr && mask <= (family == AF_INET ? 32u : 128u))
					collect_addr(ifname, addr, mask, family);
			}
		} else if (ifname && !strcmp(name, "route") && blobmsg_type(pos) == BLOBMSG_TYPE_ARRAY) {
			struct blob_attr *a2;
			size_t rem2;

			/* target 0.0.0.0 / :: 的默认路由 → 该接口为上游（WAN） */
			blobmsg_for_each_attr(a2, pos, rem2) {
				struct blob_attr *c2;
				size_t rem3;
				const char *target = NULL;
				uint32_t mask = 255;

				blobmsg_for_each_attr(c2, a2, rem3) {
					const char *cn = blobmsg_name(c2);

					if (!strcmp(cn, "target") &&
					    blobmsg_type(c2) == BLOBMSG_TYPE_STRING)
						target = blobmsg_get_string(c2);
					else if (!strcmp(cn, "mask") &&
						 blobmsg_type(c2) == BLOBMSG_TYPE_INT32)
						mask = blobmsg_get_u32(c2);
				}
				if (target && mask == 0 &&
				    (!strcmp(target, "0.0.0.0") || !strcmp(target, "::")) &&
				    n_upstream < MAX_UPSTREAM)
					snprintf(upstream_names[n_upstream++],
						 IFNAMSIZ, "%s", ifname);
			}
		}
	}
}

static void ifdump_walk(struct blob_attr *attr, int depth)
{
	struct blob_attr *pos;
	size_t rem;

	if (depth > 6 || blobmsg_type(attr) != BLOBMSG_TYPE_ARRAY)
		return;

	blobmsg_for_each_attr(pos, attr, rem) {
		if (blobmsg_type(pos) == BLOBMSG_TYPE_TABLE)
			ifdump_entry(pos, depth);
	}
}

static void ifdump_cb(struct ubus_request *req __attribute__((unused)),
		      int type __attribute__((unused)),
		      struct blob_attr *msg)
{
	struct blob_attr *pos;
	size_t rem;
	int i;

	if (!msg)
		return;

	n_collected = 0;
	n_upstream = 0;

	/* 顶层 table: { "interface": [ ... ] } */
	blobmsg_for_each_attr(pos, msg, rem) {
		if (!strcmp(blobmsg_name(pos), "interface") &&
		    blobmsg_type(pos) == BLOBMSG_TYPE_ARRAY)
			ifdump_walk(pos, 0);
	}

	for (i = 0; i < n_collected; i++) {
		if (!is_upstream(collected[i].ifname))
			prefix_insert(collected[i].family, collected[i].bytes,
				      collected[i].mask);
	}
}

static void prefixes_from_ubus(void)
{
	uint32_t id;

	if (!ubus_ctx)
		return;
	if (ubus_lookup_id(ubus_ctx, "network.interface", &id))
		return;
	ubus_invoke(ubus_ctx, id, "dump", NULL, ifdump_cb, NULL, 2000);
}

/* ------------------------------------------------------------------ */
/* devices map 轮询 + 差分                                             */
/* ------------------------------------------------------------------ */

static struct dev_ent *dev_find_or_add(const uint8_t mac[6])
{
	struct dev_ent *d, **pp = &dev_list;

	for (d = dev_list; d; d = d->next)
		if (!memcmp(d->mac, mac, 6))
			return d;

	d = calloc(1, sizeof(*d));
	if (!d)
		return NULL;
	memcpy(d->mac, mac, 6);
	d->next = *pp;
	*pp = d;
	return d;
}

static void fmt_rate(uint64_t bps, char out[24])
{
	double v = (double)bps;
	const char *u[] = { "B/s", "KB/s", "MB/s", "GB/s" };
	int i = 0;

	while (v >= 1024.0 && i < 3) {
		v /= 1024.0;
		i++;
	}
	snprintf(out, 24, "%.1f %s", v, u[i]);
}

static void tick(struct uloop_timeout *tm __attribute__((unused)))
{
	uint8_t key[6], next_key[6];
	struct dev_stats st;
	struct dev_ent *d;
	uint64_t now = now_ms(), dt;
	int first;

	first = bpf_map_get_next_key(map_devices_fd, NULL, next_key);
	while (!first) {
		if (bpf_map_lookup_elem(map_devices_fd, next_key, &st) == 0) {
			d = dev_find_or_add(next_key);
			if (d) {
				d->cur = st;
				d->alive = true;
			}
		}
		memcpy(key, next_key, 6);
		first = bpf_map_get_next_key(map_devices_fd, key, next_key);
	}

	dt = last_tick_ms ? (now - last_tick_ms) : opt_interval_ms;
	if (dt == 0)
		dt = opt_interval_ms;

	for (d = dev_list; d; d = d->next) {
		char macs[18], r1[24], r2[24], r3[24], r4[24];

		if (!d->alive) {
			memset(&d->cur, 0, sizeof(d->cur));
			memset(&d->prev, 0, sizeof(d->prev));
			d->wan_rx_r = d->wan_tx_r = d->lan_rx_r = d->lan_tx_r = 0;
			continue;
		}
		d->wan_rx_r = (d->cur.wan_rx_b - d->prev.wan_rx_b) * 1000 / dt;
		d->wan_tx_r = (d->cur.wan_tx_b - d->prev.wan_tx_b) * 1000 / dt;
		d->lan_rx_r = (d->cur.lan_rx_b - d->prev.lan_rx_b) * 1000 / dt;
		d->lan_tx_r = (d->cur.lan_tx_b - d->prev.lan_tx_b) * 1000 / dt;

		if (!opt_quiet && (d->wan_rx_r || d->wan_tx_r || d->lan_rx_r || d->lan_tx_r)) {
			mac_to_str(d->mac, macs);
			fmt_rate(d->wan_rx_r, r1);
			fmt_rate(d->wan_tx_r, r2);
			fmt_rate(d->lan_rx_r, r3);
			fmt_rate(d->lan_tx_r, r4);
			printf("%s  WAN↓ %s  WAN↑ %s  LAN↓ %s  LAN↑ %s\n",
			       macs, r1, r2, r3, r4);
		}
		d->prev = d->cur;
		d->alive = false;	/* 下一轮未出现则视为离线 */
	}
	fflush(stdout);

	last_tick_ms = now;
	uloop_timeout_set(tm, (int)opt_interval_ms);
}

/* ------------------------------------------------------------------ */
/* ubus 服务对象：zen.traffic.poc                                      */
/* ------------------------------------------------------------------ */

static int poc_get_stats(struct ubus_context *ctx, struct ubus_object *obj,
			 struct ubus_request_data *req, const char *method,
			 struct blob_attr *msg)
{
	struct dev_ent *d;

	(void)obj; (void)method; (void)msg;

	blob_buf_init(&bbuf, 0);
	void *arr = blobmsg_open_array(&bbuf, "devices");

	for (d = dev_list; d; d = d->next) {
		char macs[18];
		void *t;

		mac_to_str(d->mac, macs);
		t = blobmsg_open_table(&bbuf, NULL);
		blobmsg_add_string(&bbuf, "mac", macs);
		blobmsg_add_u64(&bbuf, "wan_rx_b", d->cur.wan_rx_b);
		blobmsg_add_u64(&bbuf, "wan_tx_b", d->cur.wan_tx_b);
		blobmsg_add_u64(&bbuf, "lan_rx_b", d->cur.lan_rx_b);
		blobmsg_add_u64(&bbuf, "lan_tx_b", d->cur.lan_tx_b);
		blobmsg_add_u64(&bbuf, "wan_rx_r", d->wan_rx_r);
		blobmsg_add_u64(&bbuf, "wan_tx_r", d->wan_tx_r);
		blobmsg_add_u64(&bbuf, "lan_rx_r", d->lan_rx_r);
		blobmsg_add_u64(&bbuf, "lan_tx_r", d->lan_tx_r);
		blobmsg_add_u64(&bbuf, "last_seen_ms", d->cur.last_seen / 1000000);
		blobmsg_close_table(&bbuf, t);
	}
	blobmsg_close_array(&bbuf, arr);
	blobmsg_add_u32(&bbuf, "interval_ms", opt_interval_ms);
	ubus_send_reply(ctx, req, bbuf.head);
	return 0;
}

static int poc_reset(struct ubus_context *ctx, struct ubus_object *obj,
		     struct ubus_request_data *req, const char *method,
		     struct blob_attr *msg)
{
	uint8_t key[6], next_key[6];
	struct dev_stats zero = {};
	struct dev_ent *d, *dn;
	int first;

	(void)obj; (void)method; (void)msg;

	first = bpf_map_get_next_key(map_devices_fd, NULL, next_key);
	while (!first) {
		bpf_map_update_elem(map_devices_fd, next_key, &zero, BPF_EXIST);
		memcpy(key, next_key, 6);
		first = bpf_map_get_next_key(map_devices_fd, key, next_key);
	}

	for (d = dev_list; d; d = dn) {
		dn = d->next;
		free(d);
	}
	dev_list = NULL;

	blob_buf_init(&bbuf, 0);
	blobmsg_add_u8(&bbuf, "ok", 1);
	ubus_send_reply(ctx, req, bbuf.head);
	return 0;
}

static int poc_reload_prefixes(struct ubus_context *ctx, struct ubus_object *obj,
			       struct ubus_request_data *req, const char *method,
			       struct blob_attr *msg)
{
	(void)obj; (void)method; (void)msg;

	prefix_defaults();
	prefixes_from_ubus();

	blob_buf_init(&bbuf, 0);
	blobmsg_add_u8(&bbuf, "ok", 1);
	ubus_send_reply(ctx, req, bbuf.head);
	return 0;
}

static const struct ubus_method poc_methods[] = {
	UBUS_METHOD_NOARG("getStats", poc_get_stats),
	UBUS_METHOD_NOARG("reset", poc_reset),
	UBUS_METHOD_NOARG("reloadPrefixes", poc_reload_prefixes),
};

static struct ubus_object_type poc_obj_type =
	UBUS_OBJECT_TYPE("zen_traffic_poc", poc_methods);

static struct ubus_object poc_obj = {
	.name = "zen.traffic.poc",
	.type = &poc_obj_type,
	.methods = poc_methods,
	.n_methods = ARRAY_SIZE(poc_methods),
};

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

static void sig_handler(int sig __attribute__((unused)))
{
	g_stop = 1;
	uloop_end();
}

static void usage(const char *prog)
{
	fprintf(stderr,
		"用法: %s [选项]\n"
		"  -i, --iface NAME     LAN 桥设备（可重复，默认 br-lan）\n"
		"  -b, --bpf PATH       BPF 对象路径（默认 %s）\n"
		"  -t, --interval-ms N  轮询周期（默认 1000）\n"
		"  -P, --prefix CIDR    额外本地前缀（可重复，如 10.0.0.0/24）\n"
		"  -p, --pin            pin maps 到 " PIN_DIR "（重启计数连续）\n"
		"      --keep-maps      退出时不清理 pin\n"
		"  -q, --quiet          不打印逐 tick 速率\n"
		"  -h, --help\n",
		prog, DEFAULT_BPF_OBJ);
}

int main(int argc, char **argv)
{
	static const char *shortopts = "i:b:t:P:pqh";
	static const struct option longopts[] = {
		{ "iface", required_argument, 0, 'i' },
		{ "bpf", required_argument, 0, 'b' },
		{ "interval-ms", required_argument, 0, 't' },
		{ "prefix", required_argument, 0, 'P' },
		{ "pin", no_argument, 0, 'p' },
		{ "keep-maps", no_argument, 0, 1 },
		{ "quiet", no_argument, 0, 'q' },
		{ "help", no_argument, 0, 'h' },
		{ 0, 0, 0, 0 }
	};
	int opt, idx, err, i;

	snprintf(opt_bpf_path, sizeof(opt_bpf_path), "%s", DEFAULT_BPF_OBJ);
	/* 默认挂 br-lan；首个 -i 替换默认项，后续 -i 追加 */
	ifaces[0].qdisc_created = false;
	snprintf(ifaces[0].name, IFNAMSIZ, "%s", DEFAULT_IFACE);
	n_ifaces = 1;

	while ((opt = getopt_long(argc, argv, shortopts, longopts, &idx)) != -1) {
		switch (opt) {
		case 'i':
			if (n_ifaces == 1 && !strcmp(ifaces[0].name, DEFAULT_IFACE) &&
			    ifaces[0].ifindex == 0)
				snprintf(ifaces[0].name, IFNAMSIZ, "%s", optarg);
			else if (n_ifaces < MAX_IFACES)
				snprintf(ifaces[n_ifaces++].name, IFNAMSIZ, "%s", optarg);
			break;
		case 'b':
			snprintf(opt_bpf_path, sizeof(opt_bpf_path), "%s", optarg);
			break;
		case 't':
			opt_interval_ms = (unsigned)atoi(optarg);
			if (opt_interval_ms < 100)
				opt_interval_ms = 100;
			break;
		case 'P':
			if (n_extra_prefix < MAX_EXTRA_PREFIX)
				snprintf(opt_extra_prefix[n_extra_prefix++], 64, "%s", optarg);
			break;
		case 'p':
			opt_pin = true;
			break;
		case 1:
			opt_keep_maps = true;
			break;
		case 'q':
			opt_quiet = true;
			break;
		default:
			usage(argv[0]);
			return 1;
		}
	}

	signal(SIGINT, sig_handler);
	signal(SIGTERM, sig_handler);
	signal(SIGPIPE, SIG_IGN);

	uloop_init();

	nlfd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
	if (nlfd < 0) {
		perror("netlink socket");
		return 1;
	}

	err = bpf_load();
	if (err)
		goto out;

	if (opt_pin)
		bpffs_ready();

	/* 本地前缀：defaults → CLI 追加 → ubus dump（覆盖实际子网） */
	prefix_defaults();
	for (i = 0; i < n_extra_prefix; i++)
		prefix_from_cidr(opt_extra_prefix[i]);

	for (i = 0; i < n_ifaces; i++)
		ifaces[i].ifindex = (int)if_nametoindex(ifaces[i].name);

	err = bpf_attach_all();
	if (err)
		goto out;

	ubus_ctx = ubus_connect(NULL);
	if (!ubus_ctx)
		fprintf(stderr, "警告: 无法连接 ubus（getStats 不可用，采集继续）\n");
	else {
		ubus_add_uloop(ubus_ctx);
		ubus_add_object(ubus_ctx, &poc_obj);
		prefixes_from_ubus();
	}

	memset(&tick_tm, 0, sizeof(tick_tm));
	tick_tm.cb = tick;
	uloop_timeout_set(&tick_tm, (int)opt_interval_ms);

	printf("zen-trafficd-poc running: ifaces=%d interval=%ums pin=%d bpf=%s\n",
	       n_ifaces, opt_interval_ms, opt_pin, opt_bpf_path);

	uloop_run();

out:
	bpf_detach_all();
	bpf_unpin_maps();
	if (bpf_obj)
		bpf_object__close(bpf_obj);
	if (ubus_ctx)
		ubus_free(ubus_ctx);
	if (nlfd >= 0)
		close(nlfd);
	uloop_done();
	return err ? 1 : (g_stop ? 0 : 1);
}
