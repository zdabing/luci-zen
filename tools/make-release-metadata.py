"""Publish exact package revisions and hashes for the Zen update panel."""
import argparse
import hashlib
import json
import re
from pathlib import Path

PACKAGES = ('luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic')


def generate(root, assets, target, sdk_version, tag, packages=PACKAGES, compatible_systems=None):
    if not packages or len(set(packages)) != len(packages) or any(name not in PACKAGES for name in packages):
        raise ValueError('Expected a nonempty selection of distinct Zen packages')
    rows = []
    for name in packages:
        source = (root / name / 'Makefile').read_text(encoding='utf-8')
        version = re.search(r'^PKG_VERSION:=(.+)$', source, re.M)[1].strip()
        revision = re.search(r'^PKG_RELEASE:=(\d+)$', source, re.M)[1]
        filename = f'{name}-{version}-r{revision}.apk'
        matches = list(assets.rglob(filename))
        if len(matches) != 1 or matches[0].stat().st_size == 0:
            raise ValueError(f'Expected exactly one nonempty {filename}, got {matches}')
        file = matches[0]
        rows.append(dict(name=name, version=f'{version}-r{revision}', filename=filename,
                         size=file.stat().st_size, sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
    result = dict(schema=1, repo='zdabing/luci-zen', tag=tag, target=target,
                  sdk_version=sdk_version, packages=rows)
    if compatible_systems is not None:
        if not compatible_systems or len(compatible_systems) > 32:
            raise ValueError('Expected 1..32 explicitly tested systems')
        systems = []
        for entry in compatible_systems:
            distribution, separator, version = entry.partition('@')
            if not separator or distribution not in ('OpenWrt', 'ImmortalWrt') or not re.fullmatch(r'[A-Za-z0-9.+_-]{1,80}', version):
                raise ValueError('Expected OpenWrt@version or ImmortalWrt@version')
            system = dict(distribution=distribution, version=version, target=target)
            if system in systems:
                raise ValueError('Duplicate compatible system')
            systems.append(system)
        result['compatible_systems'] = systems
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--target', required=True)
    parser.add_argument('--sdk-version', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--notes', required=True, type=Path)
    parser.add_argument('--packages', nargs='+', choices=PACKAGES, default=PACKAGES)
    parser.add_argument('--compatible-system', action='append', help='Explicitly tested distribution@version; repeat for additional systems')
    args = parser.parse_args()
    metadata = generate(Path(__file__).resolve().parents[1], args.assets, args.target, args.sdk_version, args.tag, args.packages,
                        args.compatible_system or ['OpenWrt@' + args.sdk_version])
    body = json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))
    (args.assets / 'zen-update.json').write_text(body + '\n', encoding='utf-8')
    with args.notes.open('a', encoding='utf-8') as notes:
        notes.write('\n\n<!-- zen-update-metadata\n' + body + '\n-->\n')
