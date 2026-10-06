"""Prevent a slow older build from rolling an SDK-specific feed backwards."""
import argparse
import json
import re
from pathlib import Path


def versions(data):
    result = {}
    for row in data['packages']:
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)-r(\d+)', row['version'])
        if not match or row['name'] in result:
            raise ValueError('Invalid or duplicate package version')
        result[row['name']] = tuple(map(int, match.groups()))
    return result


def check(candidate, current):
    for field in ('schema', 'repo', 'target', 'sdk_version'):
        if candidate.get(field) != current.get(field):
            raise ValueError('Feed identity mismatch: ' + field)
    new, old = versions(candidate), versions(current)
    if new.keys() != old.keys():
        raise ValueError('Feed package set changed')
    for name in new:
        if new[name] < old[name]:
            raise ValueError('Refusing feed downgrade: ' + name)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('current', type=Path)
    args = parser.parse_args()
    check(json.loads(args.candidate.read_text()), json.loads(args.current.read_text()))
