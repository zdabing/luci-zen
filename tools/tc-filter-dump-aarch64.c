/* SPDX-License-Identifier: GPL-2.0
 * Read-only RTM_GETTFILTER dump for AArch64 Linux without libc or installed tc.
 * Linux v6.12 UAPI: asm-generic/unistd.h, rtnetlink.h, pkt_sched.h.
 * clang --target=aarch64-linux-gnu -Os -ffreestanding -fno-stack-protector
 *   -nostdlib -static -fuse-ld=lld tools/tc-filter-dump-aarch64.c -o tc-filter-dump
 * Usage: tc-filter-dump <ifindex> > filters.netlink
 * stdout is raw netlink messages; ingress sequence=1, egress sequence=2.
 * Add `tcx` for two binary TCX query records: u32 attach_type/count, i64 result,
 * u64 revision, then count u32 program IDs and count u32 link IDs.
 */
typedef unsigned int u32;
typedef unsigned short u16;
void *memset(void *dst, int value, unsigned long size) {
    volatile unsigned char *p=dst;
    for (unsigned long i=0; i<size; i++) p[i]=(unsigned char)value;
    return dst;
}
static long call(long n, long a, long b, long c, long d, long e, long f) {
    register long x8 __asm__("x8")=n, x0 __asm__("x0")=a, x1 __asm__("x1")=b;
    register long x2 __asm__("x2")=c, x3 __asm__("x3")=d, x4 __asm__("x4")=e;
    register long x5 __asm__("x5")=f;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2),
                     "r"(x3), "r"(x4), "r"(x5) : "memory", "cc");
    return x0;
}
static void finish(long code) { call(93,code,0,0,0,0,0); for (;;) {} }
struct header { u32 len; u16 type, flags; u32 seq, pid; };
struct address { u16 family, pad; u32 pid, groups; };
struct request { struct header h; unsigned char family, pad1; u16 pad2;
                 int index; u32 handle, parent, info; };
_Static_assert(sizeof(struct request)==36, "tcmsg request layout");
static unsigned char buffer[65536] __attribute__((aligned(8)));
static void write_all(const void *buf, long size) {
    long written=0;
    while (written<size) { long n=call(64,1,(long)buf+written,size-written,0,0,0);
                          if (n<=0) finish(11); written+=n; }
}
static void query_tcx(int index) {
    for (u32 ty=46; ty<=47; ty++) {
        u32 ids[64]={0}, links[64]={0};
        struct { u32 index, type, flags, attach_flags;
                 unsigned long ids; u32 count, pad;
                 unsigned long prog_flags, links, link_flags, revision;
        } q={index,ty,0,0,(unsigned long)ids,64,0,0,(unsigned long)links,0,0};
        _Static_assert(sizeof(q)==64, "BPF_PROG_QUERY layout");
        long result=call(280,16,(long)&q,sizeof(q),0,0,0);
        if (q.count>64) finish(13);
        struct { u32 type, count; long result; unsigned long revision; }
          out={ty,result<0?0:q.count,result,q.revision};
        write_all(&out,sizeof(out));
        write_all(ids,out.count*4); write_all(links,out.count*4);
    }
}
void dump_main(long *stack) {
    if (stack[0]!=2 && stack[0]!=3) finish(2);
    char *arg=(char *)stack[2]; int index=0;
    for (; *arg; arg++) { if (*arg<'0'||*arg>'9'||index>1000000) finish(2);
                         index=index*10+*arg-'0'; }
    if (index<=0) finish(2);
    if (stack[0]==3) {
        char *mode=(char *)stack[3];
        if (mode[0]!='t'||mode[1]!='c'||mode[2]!='x'||mode[3]) finish(2);
        query_tcx(index); finish(0);
    }
    long fd=call(198,16,3,0,0,0,0); if (fd<0) finish(3);
    struct address addr={16,0,0,0};
    if (call(200,fd,(long)&addr,sizeof(addr),0,0,0)<0) finish(4);
    long timeout[2]={5,0};
    if (call(208,fd,1,20,(long)timeout,sizeof(timeout),0)<0) finish(5);
    for (u32 seq=1; seq<=2; seq++) {
        struct request req={{36,46,0x301,seq,0},0,0,0,index,0,
                            seq==1?0xfffffff2u:0xfffffff3u,0};
        if (call(206,fd,(long)&req,sizeof(req),0,(long)&addr,sizeof(addr))!=36) finish(6);
        int done=0;
        for (int page=0; page<128 && !done; page++) {
            long size=call(207,fd,(long)buffer,sizeof(buffer),0,0,0);
            if (size<=0 || size==(long)sizeof(buffer)) finish(7);
            for (long pos=0; pos<size;) {
                if (size-pos<16) finish(8);
                struct header *h=(struct header *)(buffer+pos);
                if (h->len<16 || h->len>(u32)(size-pos) || h->seq!=seq) finish(8);
                if (h->type==2 && (h->len<20 || *(int *)(buffer+pos+16)!=0)) finish(9);
                if (h->type==3) {
                    if (h->flags & 0x10) finish(10); /* NLM_F_DUMP_INTR */
                    if (h->len>=20 && *(int *)(buffer+pos+16)!=0) finish(9);
                    done=1;
                }
                pos+=(h->len+3)&~3u;
            }
            write_all(buffer,size);
        }
        if (!done) finish(12);
    }
    call(57,fd,0,0,0,0,0); finish(0);
}
__attribute__((naked)) void _start(void) {
    __asm__ volatile("mov x0, sp\n b dump_main");
}
