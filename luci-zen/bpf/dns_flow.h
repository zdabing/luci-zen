/* SPDX-License-Identifier: GPL-2.0
 * Separate passive DNS metadata path, including router-local DNS. It never
 * updates device/application counters, changes DNS, or alters packet verdicts. */
#ifndef ZEN_DNS_FLOW_H
#define ZEN_DNS_FLOW_H
struct {__uint(type,BPF_MAP_TYPE_ARRAY);__uint(max_entries,1);__type(key,__u32);__type(value,__u32);} dns_enabled SEC(".maps");
struct {__uint(type,BPF_MAP_TYPE_RINGBUF);__uint(max_entries,512*1024);} dns_samples SEC(".maps");
struct {__uint(type,BPF_MAP_TYPE_ARRAY);__uint(max_entries,2);__type(key,__u32);__type(value,__u64);} dns_errors SEC(".maps");
static __always_inline void dns_error(__u32 index) {__u64 *v=bpf_map_lookup_elem(&dns_errors,&index);if(v)__sync_fetch_and_add(v,1);}
static __always_inline void dns_account(struct __sk_buff *skb,const __u8 *mac,int off,int egress,int v6)
{
    __u32 zero=0,*enabled=bpf_map_lookup_elem(&dns_enabled,&zero);
    if(!enabled||!*enabled)return;
    struct app_flow_key key={};struct iphdr ip;struct ipv6hdr ip6;
    __be16 udp[4];int l4;__u32 ip_length,header;
    if(v6){
        if(bpf_skb_load_bytes(skb,off,&ip6,sizeof(ip6))||ip6.nexthdr!=17)return;
        header=40;ip_length=40+bpf_ntohs(ip6.payload_len);key.family=6;
        __builtin_memcpy(key.client,egress?&ip6.daddr:&ip6.saddr,16);
        __builtin_memcpy(key.server,egress?&ip6.saddr:&ip6.daddr,16);
    }else{
        if(bpf_skb_load_bytes(skb,off,&ip,sizeof(ip))||ip.protocol!=17||ip.ihl<5||(ip.frag_off&bpf_htons(0x3fff)))return;
        header=ip.ihl*4;ip_length=bpf_ntohs(ip.tot_len);key.family=4;
        __builtin_memcpy(key.client,egress?&ip.daddr:&ip.saddr,4);
        __builtin_memcpy(key.server,egress?&ip.saddr:&ip.daddr,4);
    }
    l4=off+header;
    if(bpf_skb_load_bytes(skb,l4,udp,sizeof(udp)))return;
    key.client_port=udp[egress?1:0];key.server_port=udp[egress?0:1];
    if(key.server_port!=bpf_htons(53))return;
    __u32 length=bpf_ntohs(udp[2]);
    if(length<20||length+header>ip_length)return;
    length-=8;
    /* Keep the lower bound visible to the verifier after subtraction; LLVM
     * otherwise folds it into the UDP-length check across a spilled value. */
    asm volatile("" : "+r"(length));
    if(length<12||length>ZEN_APP_SAMPLE_SIZE){dns_error(1);return;}
    struct app_flow_sample *event=bpf_ringbuf_reserve(&dns_samples,sizeof(*event),0);
    if(!event){dns_error(0);return;}
    __builtin_memcpy(key.mac,mac,6);key.protocol=17;
    event->key=key;event->length=length;event->first_seen=egress;event->time=bpf_ktime_get_ns();
    if(bpf_skb_load_bytes(skb,l4+8,event->packet,length)){bpf_ringbuf_discard(event,0);return;}
    bpf_ringbuf_submit(event,0);
}
#endif
