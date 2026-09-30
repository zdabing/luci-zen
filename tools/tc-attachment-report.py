"""Decode read-only AArch64 output. stats contains private MACs/traffic counters."""
import argparse
import json
import struct
from pathlib import Path


def attributes(data):
    pos = 0
    while pos < len(data):
        if len(data) - pos < 4:
            raise ValueError('truncated attribute')
        size, kind = struct.unpack_from('<HH', data, pos)
        if size < 4 or pos + size > len(data):
            raise ValueError('invalid attribute length')
        yield kind & 0x3fff, data[pos + 4:pos + size]
        pos += (size + 3) & ~3


def decode(data, mode):
    if mode == 'stats':
        magic, map_id, count, record_size = struct.unpack_from('<IIII', data)
        if magic != 0x4154535a or count > 4096 or record_size != 78 or len(data) != 16 + count * 78:
            raise ValueError('invalid or incomplete devices map dump')
        names = ['last_seen_ns', 'wan_rx_bytes', 'wan_rx_packets', 'wan_tx_bytes',
                 'wan_tx_packets', 'lan_rx_bytes', 'lan_rx_packets', 'lan_tx_bytes', 'lan_tx_packets']
        rows = []
        for pos in range(16, len(data), 78):
            row = dict(zip(names, struct.unpack_from('<9Q', data, pos + 6)))
            row.update(mac=':'.join(f'{v:02x}' for v in data[pos:pos + 6]), map_id=map_id)
            rows.append(row)
        if len({row['mac'] for row in rows}) != count:
            raise ValueError('map changed during enumeration; repeat the read')
        return rows
    rows = []
    pos = 0
    done = []
    while pos < len(data):
        if mode == 'tcx':
            kind, count, result, revision = struct.unpack_from('<IIqQ', data, pos)
            pos += 24
            if kind not in (46, 47) or result != 0 or count > 64:
                raise ValueError(f'TCX query failed: type={kind}, result={result}, count={count}')
            ids = struct.unpack_from('<' + 'I' * count, data, pos)
            pos += count * 4
            links = struct.unpack_from('<' + 'I' * count, data, pos)
            pos += count * 4
            rows.append({'hook': 'ingress' if kind == 46 else 'egress',
                         'count': count, 'revision': revision,
                         'program_ids': ids, 'link_ids': links})
            done.append(kind)
        else:
            size, kind, flags, seq, _ = struct.unpack_from('<IHHII', data, pos)
            if size < 16 or pos + size > len(data) or seq not in (1, 2):
                raise ValueError('invalid netlink message')
            body = data[pos + 16:pos + size]
            if kind == 2 and (len(body) < 4 or struct.unpack_from('<i', body)[0]):
                raise ValueError('netlink error')
            if kind == 3:
                if flags & 0x10 or (len(body) >= 4 and struct.unpack_from('<i', body)[0]):
                    raise ValueError('incomplete netlink dump')
                done.append(seq)
            if kind == 44:
                _, _, _, index, handle, parent, info = struct.unpack_from('<BBHiIII', body)
                attrs = dict(attributes(body[20:]))
                options = dict(attributes(attrs.get(2, b'')))
                rows.append({'hook': 'ingress' if seq == 1 else 'egress',
                             'ifindex': index, 'handle': handle, 'parent': hex(parent),
                             'priority': info >> 16,
                             'kind': attrs.get(1, b'').rstrip(b'\0').decode(),
                             'name': options.get(7, b'').rstrip(b'\0').decode()
                             if attrs.get(1) == b'bpf\0' else None})
            pos += (size + 3) & ~3
    if done != ([46, 47] if mode == 'tcx' else [1, 2]):
        raise ValueError('missing or duplicate completed hook queries')
    return rows


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['tcx', 'netlink', 'stats'])
    parser.add_argument('path', type=Path)
    args = parser.parse_args()
    print(json.dumps(decode(args.path.read_bytes(), args.mode), indent=2))
