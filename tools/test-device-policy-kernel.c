/* Real verifier + TC test-run; no host interfaces or firewall rules are changed. */
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include "../zen-traffic/bpf/device_policy.h"

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #test); return 1; } } while (0)
struct mac_key { unsigned char b[6]; };
struct lpm_key { __u32 prefixlen; unsigned char bytes[16]; };
static unsigned char packet[80];

static int run(int fd, int ipv6, int local, int expected)
{
    memset(packet, 0, sizeof(packet));
    packet[0] = packet[6] = 2; packet[5] = packet[11] = 9;
    packet[12] = ipv6 ? 0x86 : 8; packet[13] = ipv6 ? 0xdd : 0;
    if (ipv6) {
        packet[14] = 0x60; packet[19] = 8; packet[20] = 17; packet[21] = 64;
        packet[22] = packet[38] = 0x20; packet[23] = packet[39] = 1;
        packet[24] = packet[40] = 0x48; packet[25] = packet[41] = 0x60;
        packet[37] = 9; packet[53] = 10;
    } else {
        packet[14] = 0x45; packet[17] = 28; packet[22] = 64; packet[23] = 17;
        memset(packet + 26, 8, 8);
        if (local) { packet[26] = packet[30] = 192; packet[27] = packet[31] = 168;
            packet[28] = packet[32] = 1; packet[29] = 9; packet[33] = 10; }
    }
    struct bpf_test_run_opts opts = { .sz = sizeof(opts), .data_in = packet,
        .data_size_in = ipv6 ? 62 : 42, .repeat = 1 };
    int status = bpf_prog_test_run_opts(fd, &opts);
    if (status || opts.retval != (unsigned)expected) {
        fprintf(stderr, "TC run status=%d verdict=%u expected=%d\n",status,opts.retval,expected); return 0;
    }
    return 1;
}

int main(int argc, char **argv)
{
    CHECK(argc == 2);
    struct bpf_object *object = bpf_object__open_file(argv[1], NULL);
    CHECK(!libbpf_get_error(object));
    CHECK(bpf_object__load(object) == 0);
    int ingress = bpf_program__fd(bpf_object__find_program_by_name(object, "zen_ingress"));
    int egress = bpf_program__fd(bpf_object__find_program_by_name(object, "zen_egress"));
    int policies = bpf_object__find_map_fd_by_name(object, "device_policies");
    int prefixes = bpf_object__find_map_fd_by_name(object, "local_prefixes");
    CHECK(ingress >= 0 && egress >= 0 && policies >= 0 && prefixes >= 0);
    struct mac_key key = { .b = {2,0,0,0,0,9} };
    struct device_policy policy = { .blocked = 1 };
    CHECK(bpf_map_update_elem(policies,&key,&policy,BPF_ANY | BPF_F_LOCK) == 0);
    CHECK(run(ingress,0,0,TC_ACT_SHOT)); CHECK(run(egress,0,0,TC_ACT_SHOT));
    CHECK(run(ingress,1,0,TC_ACT_SHOT)); CHECK(run(egress,1,0,TC_ACT_SHOT));
    struct lpm_key prefix = { .prefixlen = 120, .bytes = {0,0,0,0,0,0,0,0,0,0,255,255,192,168,1,0} };
    unsigned char one = 1;
    CHECK(bpf_map_update_elem(prefixes,&prefix,&one,BPF_ANY) == 0);
    CHECK(run(ingress,0,1,TC_ACT_OK)); CHECK(run(egress,0,1,TC_ACT_OK));
    /* A different MAC must remain unrestricted. */
    key.b[5] = 10;
    CHECK(bpf_map_update_elem(policies,&key,&policy,BPF_ANY | BPF_F_LOCK) == 0);
    key.b[5] = 9; CHECK(bpf_map_delete_elem(policies,&key) == 0);
    CHECK(run(ingress,0,0,TC_ACT_OK)); CHECK(run(egress,1,0,TC_ACT_OK));
    /* Upload and download token state are independent, including kernel locking. */
    struct timespec now; CHECK(clock_gettime(CLOCK_MONOTONIC,&now) == 0);
    memset(&policy,0,sizeof(policy)); policy.upload_bps = 1;
    policy.upload_last = (__u64)now.tv_sec * 1000000000ULL + now.tv_nsec;
    CHECK(bpf_map_update_elem(policies,&key,&policy,BPF_ANY | BPF_F_LOCK) == 0);
    CHECK(run(ingress,0,0,TC_ACT_SHOT)); CHECK(run(egress,0,0,TC_ACT_OK));
    CHECK(bpf_map_delete_elem(policies,&key) == 0); CHECK(run(ingress,0,0,TC_ACT_OK));
    bpf_object__close(object);
    puts("PASS: real verifier, per-MAC IPv4/IPv6 deny, LAN bypass, directional policing and removal");
    return 0;
}
