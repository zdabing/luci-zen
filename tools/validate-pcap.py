#!/usr/bin/env python3
"""Validate a pcap file written by zen-capture (little-endian, Ethernet linktype).

Checks: global header magic/version/snaplen/linktype, per-record header sanity
(includes original length, monotonic timestamps, capped capture length), and
prints totals. Exits non-zero on any structural violation.
"""
import struct
import sys

def main(path):
    data = open(path, "rb").read()
    if len(data) < 24:
        print(f"FAIL: file too small ({len(data)}B)"); return 1
    magic, vmaj, vmin, tz, sig, snap, link = struct.unpack("<IHHiIII", data[:24])
    if magic != 0xA1B2C3D4:
        print(f"FAIL: bad magic {magic:#x}"); return 1
    if (vmaj, vmin) != (2, 4):
        print(f"FAIL: version {vmaj}.{vmin}"); return 1
    if link != 1:
        print(f"FAIL: linktype {link} != Ethernet"); return 1
    print(f"global: v{vmaj}.{vmin} snaplen={snap} linktype={link}")
    off, count, total_orig, last_ts = 24, 0, 0, 0
    while off + 16 <= len(data):
        secs, usecs, incl, orig = struct.unpack("<IIII", data[off:off + 16])
        if incl > snap:
            print(f"FAIL: record {count} incl_len {incl} > snaplen {snap}"); return 1
        if incl > len(data) - off - 16:
            print(f"FAIL: record {count} truncated"); return 1
        ts = secs + usecs / 1e6
        if count and ts < last_ts:
            print(f"FAIL: record {count} timestamp regressed"); return 1
        last_ts = ts
        total_orig += orig
        count += 1
        off += 16 + incl
    if off != len(data):
        print(f"FAIL: trailing {len(data)-off} bytes"); return 1
    print(f"records={count} orig_bytes_total={total_orig} span_end={last_ts:.6f}")
    print("PCAP_OK" if count else "PCAP_EMPTY(Structural OK, no records)")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
