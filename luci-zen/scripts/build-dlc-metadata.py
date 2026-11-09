#!/usr/bin/env python3
"""Build the DLC metadata index consumed by build-app-rules.py.

v2fly/domain-list-community stores one plain-text file per list. The packaged
rule set needs a host -> list-name index instead, so this converts a checkout
into the schema-1 MIT metadata the generator already accepts. Hosts keep the
name of the file they appear in (not the including parent), which is what makes
``bilibili-cdn`` distinguishable from ``bilibili``.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

SOURCE = 'v2fly/domain-list-community'
NAME = re.compile(r'[a-z0-9][a-z0-9_-]{0,80}')
HOST = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')


def normalize(value):
    value = value.lstrip('\ufeff').lower().removesuffix('.')
    if len(value) > 253 or not all(HOST.fullmatch(label) for label in value.split('.')):
        raise ValueError('Invalid domain: ' + value)
    return value


def build(data, revision, services=None):
    if not re.fullmatch(r'[a-f0-9]{40}', revision or ''):
        raise ValueError('A full DLC commit SHA is required')
    files = {path.name: path for path in data.iterdir() if path.is_file() and not path.name.startswith('.')}
    unmapped = []
    if services is not None:
        selected = {name for service, item in services.items() for name in item.get('lists', [service])}
        missing = selected - files.keys()
        if missing:
            raise ValueError('Missing reviewed source lists: ' + ', '.join(sorted(missing)))
        unmapped = sorted(name for name in files.keys() - selected
                          if any(name == service or name.startswith(service + '-') for service in services))
        files = {name: files[name] for name in selected}

    exact, suffix, skipped = {}, {}, []
    for path in sorted(files.values()):
        if not NAME.fullmatch(path.name):
            raise ValueError('Invalid list name: ' + path.name)
        for raw in path.read_text(encoding='utf-8').splitlines():
            item = raw.split('#', 1)[0].strip().split()
            if not item:
                continue
            token = item[0]
            if '@ads' in item[1:]:
                skipped.append(path.name + ':' + token + ' @ads')
                continue
            if token.startswith(('include:', 'regexp:', 'keyword:')):
                skipped.append(path.name + ':' + token)
                continue
            mode = 'exact' if token.startswith('full:') else 'suffix'
            host = normalize(token.removeprefix('full:').removeprefix('domain:'))
            table = exact if mode == 'exact' else suffix
            names = table.setdefault(host, [])
            if path.name not in names:
                names.append(path.name)
    return {
        'schema': 1,
        'source': SOURCE,
        'revision': revision,
        'license': 'MIT',
        'labels': {},
        'sources': [{'id': 'dlc', 'revision': revision, 'license': 'MIT'}],
        'default_rule_source': 'dlc',
        'reviewed_rule_files': [],
        'rule_sources': {'exact': {}, 'suffix': {}},
        'exact': exact,
        'suffix': suffix,
        'skipped': skipped,
        'unmapped_lists': unmapped,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, required=True, help='DLC data/ directory')
    parser.add_argument('--manifest', type=Path, help='Read only the reviewed lists in this Zen manifest')
    parser.add_argument('--revision', required=True, help='DLC commit SHA the checkout is pinned to')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.data.is_dir():
        raise SystemExit('Not a directory: ' + str(args.data))
    services = json.loads(args.manifest.read_text(encoding='utf-8'))['services'] if args.manifest else None
    metadata = build(args.data, args.revision, services)
    encoded = (json.dumps(metadata, ensure_ascii=True, separators=(',', ':')) + '\n').encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(encoded)
    print(json.dumps({
        'revision': metadata['revision'],
        'exact': len(metadata['exact']),
        'suffix': len(metadata['suffix']),
        'skipped': len(metadata['skipped']),
        'unmapped_lists': metadata['unmapped_lists'],
        'sha256': hashlib.sha256(encoded).hexdigest(),
    }))


if __name__ == '__main__':
    main()
