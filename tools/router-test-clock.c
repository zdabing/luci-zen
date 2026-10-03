/* SPDX-License-Identifier: GPL-2.0
 * Test-only LD_PRELOAD clock. Never installed in a firmware package.
 * ZEN_TEST_EPOCH_FILE contains a decimal Unix second (2024..2100).
 * Only this process's realtime clock changes; monotonic clocks use the kernel.
 * AArch64 build: clang --target=aarch64-linux-gnu -O2 -fPIC -shared -nostdlib
 *   -fno-stack-protector -fuse-ld=lld tools/router-test-clock.c -o test-clock.so
 */
extern char *getenv(const char *name);
struct test_timespec { long sec, nsec; };
struct test_timeval { long sec, usec; };
#if defined(__aarch64__)
#define NR_CLOCK 113
#define NR_OPEN 56
#define NR_READ 63
#define NR_CLOSE 57
static long call(long number, long a, long b, long c, long d) {
    register long x8 __asm__("x8")=number, x0 __asm__("x0")=a;
    register long x1 __asm__("x1")=b, x2 __asm__("x2")=c, x3 __asm__("x3")=d;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2), "r"(x3) : "memory", "cc");
    return x0;
}
#elif defined(__x86_64__)
#define NR_CLOCK 228
#define NR_OPEN 257
#define NR_READ 0
#define NR_CLOSE 3
static long call(long number, long a, long b, long c, long d) {
    register long r10 __asm__("r10")=d;
    long result;
    __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(a), "S"(b), "d"(c), "r"(r10) : "rcx", "r11", "memory");
    return result;
}
#else
#error Unsupported test architecture
#endif

int clock_gettime(int clock_id, struct test_timespec *ts) {
    if (call(NR_CLOCK,clock_id,(long)ts,0,0)<0) return -1;
    if (clock_id!=0) return 0;
    const char *path=getenv("ZEN_TEST_EPOCH_FILE");
    if (!path || !*path) return 0;
    long fd=call(NR_OPEN,-100,(long)path,0,0);
    if (fd<0) return 0;
    char buffer[32];
    long length=call(NR_READ,fd,(long)buffer,sizeof(buffer),0);
    call(NR_CLOSE,fd,0,0,0);
    if (length<1 || length>12) return 0;
    long value=0, digits=0;
    for (long i=0; i<length; i++) {
        if (buffer[i]=='\n' && i==length-1) break;
        if (buffer[i]<'0' || buffer[i]>'9') return 0;
        value=value*10+(buffer[i]-'0'); digits++;
    }
    if (digits && value>=1704067200L && value<=4102444800L) ts->sec=value;
    return 0;
}

int gettimeofday(struct test_timeval *tv, void *unused_timezone) {
    (void)unused_timezone;
    struct test_timespec ts;
    if (clock_gettime(0,&ts)<0) return -1;
    if (tv) { tv->sec=ts.sec; tv->usec=ts.nsec/1000; }
    return 0;
}
