/* Shared token-bucket arithmetic; no helpers may be called with a lock held. */
#ifndef ZEN_DEVICE_POLICY_H
#define ZEN_DEVICE_POLICY_H
#ifndef __always_inline
#define __always_inline inline __attribute__((always_inline))
#endif

struct device_policy {
	struct bpf_spin_lock lock;
	__u32 blocked;
	__u64 upload_bps, download_bps;
	__u64 upload_tokens, download_tokens;
	__u64 upload_last, download_last;
};

static __always_inline __u64 zen_policy_burst(__u64 rate)
{
	/* A full GSO skb must fit even at a low configured rate. */
	return rate / 10 > 65536 ? rate / 10 : 65536;
}

static __always_inline int zen_policy_take(struct device_policy *p,
		__u64 now, __u64 len, int download)
{
	__u64 rate = download ? p->download_bps : p->upload_bps;
	__u64 tokens = download ? p->download_tokens : p->upload_tokens;
	__u64 last = download ? p->download_last : p->upload_last;
	__u64 capacity, elapsed, refill;
	int allowed;

	if (p->blocked)
		return 0;
	if (!rate)
		return 1;
	capacity = zen_policy_burst(rate);
	if (!last || now < last) {
		tokens = capacity;
		last = now;
	} else {
		elapsed = now - last;
		/* Bound arithmetic while still refilling a low-rate GSO bucket after idle. */
		if (elapsed / 1000000000ULL >= (capacity + rate - 1) / rate)
			refill = capacity;
		else
			refill = rate * (elapsed / 1000000000ULL) +
				rate * (elapsed % 1000000000ULL) / 1000000000ULL;
		if (refill) {
			tokens = tokens + refill > capacity ? capacity : tokens + refill;
			/* Preserve fractional credit instead of losing it per packet. */
			last = now;
		}
	}
	allowed = tokens >= len;
	if (allowed)
		tokens -= len;
	if (download) {
		p->download_tokens = tokens;
		p->download_last = last;
	} else {
		p->upload_tokens = tokens;
		p->upload_last = last;
	}
	return allowed;
}
#endif
