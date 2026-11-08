#!/usr/bin/env python3
"""Helpers for the scheduled rule refresh.

Kept as a script so the workflow needs no inline Python (a YAML block scalar
would hand the interpreter indented source).
"""
import argparse
import datetime
import json
import pathlib
import re
import sys

VERSION = re.compile(r'^(zen-cn-[0-9]{8})\.([0-9]+)$')


def next_version(current, today=None):
    """Return the next version for today, continuing an existing counter."""
    day = (today or datetime.datetime.now(datetime.UTC)).strftime('%Y-%m-%d').replace('-', '')
    prefix = f'zen-cn-{day}.'
    match = VERSION.fullmatch(current or '')
    if match and match.group(1) == f'zen-cn-{day}':
        return f'{prefix}{int(match.group(2)) + 1}'
    return f'{prefix}1'


def set_version(path, version):
    """Rewrite only the manifest version token so the diff stays minimal."""
    manifest = pathlib.Path(path)
    text = manifest.read_text(encoding='utf-8')
    old = json.loads(text)['version']
    if old == version:
        return old
    updated, count = re.subn(r'"version"\s*:\s*"' + re.escape(old) + r'"',
                             f'"version":"{version}"', text, count=1)
    if count != 1:
        raise SystemExit('Manifest version token not found')
    manifest.write_text(updated, encoding='utf-8')
    return old


def summary(old_path, new_path):
    old = json.loads(pathlib.Path(old_path).read_text(encoding='utf-8'))
    new = json.loads(pathlib.Path(new_path).read_text(encoding='utf-8'))
    key = lambda rule: (rule['domain'], rule['match'])
    before = {key(rule): rule['app'] for rule in old['rules']}
    after = {key(rule): rule['app'] for rule in new['rules']}
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    moved = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    old_rules = {key(rule): {k: v for k, v in rule.items() if k != 'revision'} for rule in old['rules']}
    new_rules = {key(rule): {k: v for k, v in rule.items() if k != 'revision'} for rule in new['rules']}
    modified = sorted(k for k in set(before) & set(after)
                      if before[k] == after[k] and old_rules[k] != new_rules[k])
    lines = [
        f"version: {old['version']} -> {new['version']}",
        f"rules: {len(before)} -> {len(after)}",
        f"added: {len(added)}",
        f"removed: {len(removed)}",
        f"reassigned: {len(moved)}",
        f"modified: {len(modified)}",
    ]
    for label, items in (('added', added), ('removed', removed), ('reassigned', moved), ('modified', modified)):
        for host, match in items[:40]:
            if label == 'reassigned':
                lines.append(f'{label}: {host} ({match}) {before[(host, match)]} -> {after[(host, match)]}')
            elif label == 'modified':
                lines.append(f'{label}: {host} ({match}) {old_rules[(host, match)]} -> {new_rules[(host, match)]}')
            else:
                lines.append(f'{label}: {host} ({match})')
        if len(items) > 40:
            lines.append(f'{label}: ... {len(items) - 40} more')
    return '\n'.join(lines)


def content(path):
    """Ignore provenance timestamps/revisions, but retain classification changes."""
    package = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    package.pop('version', None)
    package.pop('source_revision', None)
    package['rules'] = sorted(
        ({k: v for k, v in rule.items() if k != 'revision'} for rule in package['rules']),
        key=lambda rule: json.dumps(rule, sort_keys=True))
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    item = sub.add_parser('next-version')
    item.add_argument('current')
    item = sub.add_parser('set-version')
    item.add_argument('manifest', type=pathlib.Path)
    item.add_argument('version')
    item = sub.add_parser('summary')
    item.add_argument('old', type=pathlib.Path)
    item.add_argument('new', type=pathlib.Path)
    item = sub.add_parser('same-content')
    item.add_argument('old', type=pathlib.Path)
    item.add_argument('new', type=pathlib.Path)
    args = parser.parse_args()

    if args.command == 'next-version':
        print(next_version(args.current))
    elif args.command == 'set-version':
        print(set_version(args.manifest, args.version))
    elif args.command == 'summary':
        print(summary(args.old, args.new))
    else:
        sys.exit(0 if content(args.old) == content(args.new) else 1)


if __name__ == '__main__':
    main()
