/* Execute the production token bucket arithmetic without a kernel dependency. */
#include <stdint.h>
typedef uint64_t __u64;
typedef uint32_t __u32;
struct bpf_spin_lock { __u32 value; };
#ifndef __always_inline
#define __always_inline inline __attribute__((always_inline))
#endif
#include "../zen-traffic/bpf/device_policy.h"
#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)
#ifdef _WIN32
int zen_policy_dllmain(void *module, unsigned reason, void *reserved)
{ (void)module; (void)reason; (void)reserved; return 1; }
__declspec(dllexport)
#endif
int zen_policy_tests(void)
{
    struct device_policy p = {0};
    CHECK(sizeof(p) == 56);
    CHECK(zen_policy_take(&p, 100, 90000, 0));
    p.blocked = 1;
    CHECK(!zen_policy_take(&p, 100, 1, 0));
    CHECK(!zen_policy_take(&p, 100, 1, 1));
    p.blocked = 0; p.upload_bps = 12500;
    CHECK(zen_policy_take(&p, 1000000000ULL, 65536, 0));
    CHECK(!zen_policy_take(&p, 1000000001ULL, 1, 0));
    CHECK(zen_policy_take(&p, 1000080000ULL, 1, 0));
    CHECK(!zen_policy_take(&p, 1000080001ULL, 1, 0));
    CHECK(zen_policy_take(&p, 2000080000ULL, 12500, 0));
    CHECK(!zen_policy_take(&p, 2000080001ULL, 1, 0));
    /* Download has its own unlimited bucket. Upload cannot consume it. */
    CHECK(zen_policy_take(&p, 2000080001ULL, 90000, 1));
    p.download_bps = 1000000;
    CHECK(zen_policy_take(&p, 2000080001ULL, 100000, 1));
    CHECK(!zen_policy_take(&p, 2000080002ULL, 1, 1));
    /* Long idle periods cap credit; a large first GSO skb is admitted. */
    CHECK(zen_policy_take(&p, 20000000000ULL, 65536, 0));
    CHECK(!zen_policy_take(&p, 20000000001ULL, 1, 0));
    /* Fractional-byte refills survive repeated sub-byte packet arrivals. */
    p.upload_tokens = 0; p.upload_last = 21000000000ULL;
    for (__u64 i = 1; i < 80000; i += 1000)
        CHECK(!zen_policy_take(&p, 21000000000ULL + i, 1, 0));
    CHECK(zen_policy_take(&p, 21000080000ULL, 1, 0));
    return 0;
}
#ifdef ZEN_POLICY_STANDALONE
int main(void) { return zen_policy_tests(); }
#endif
