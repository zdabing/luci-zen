"""Publish exact package revisions and hashes for the Zen update panel."""
import argparse
import hashlib
import json
import re
from pathlib import Path

PACKAGES = ('luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic')


def generate(root, assets, target, sdk_version, tag, packages=PACKAGES, compatible_systems=None, filename_suffix=''):
    if not packages or len(set(packages)) != len(packages) or any(name not in PACKAGES for name in packages):
        raise ValueError('Expected a nonempty selection of distinct Zen packages')
    if filename_suffix and not re.fullmatch(r'[a-z0-9_-]+', filename_suffix):
        raise ValueError('Invalid package filename suffix')
    rows = []
    for name in packages:
        source = (root / name / 'Makefile').read_text(encoding='utf-8')
        version = re.search(r'^PKG_VERSION:=(.+)$', source, re.M)[1].strip()
        revision = re.search(r'^PKG_RELEASE:=(\d+)$', source, re.M)[1]
        filename = f'{name}-{version}-r{revision}' + (f'-{filename_suffix}' if filename_suffix else '') + '.apk'
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
            raise ValueError('Expected 1..32 tested system records')
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


def merge_builds(root, assets, tag):
    builds = []
    targets = set()
    filenames = set()
    records = sorted(assets.glob('*/zen-update.json'))
    if not records or len(records) > 32:
        raise ValueError('Expected 1..32 build metadata files')
    for record in records:
        build = json.loads(record.read_text(encoding='utf-8'))
        target = build.get('target')
        if not isinstance(target, str) or not re.fullmatch(r'[a-z0-9_-]+/[a-z0-9_-]+', target) or target in targets:
            raise ValueError('Invalid or duplicate build target')
        if not isinstance(build.get('sdk_version'), str) or not re.fullmatch(r'[A-Za-z0-9.+_-]{1,80}', build['sdk_version']):
            raise ValueError('Invalid build SDK version')
        expected = generate(root, record.parent, target, build.get('sdk_version'), tag,
                            filename_suffix=target.replace('/', '-'))
        if build != expected:
            raise ValueError(f'Build metadata does not match source and APKs: {target}')
        for package in build['packages']:
            if package['filename'] in filenames:
                raise ValueError('Duplicate release asset filename')
            filenames.add(package['filename'])
        targets.add(target)
        builds.append(build)
    result = dict(builds[0])
    if len(builds) > 1:
        result['builds'] = builds[1:]
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--target')
    parser.add_argument('--sdk-version')
    parser.add_argument('--tag', required=True)
    parser.add_argument('--notes', required=True, type=Path)
    parser.add_argument('--packages', nargs='+', choices=PACKAGES, default=PACKAGES)
    parser.add_argument('--compatible-system', action='append', help='Tested distribution@version record; does not restrict target/major matching; repeat for additional systems')
    parser.add_argument('--filename-suffix', default='', help='Append a target suffix to APK filenames in a multi-target release')
    parser.add_argument('--merge-builds', action='store_true', help='Verify and merge target metadata from artifact subdirectories')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.merge_builds:
        metadata = merge_builds(root, args.assets, args.tag)
    else:
        if not args.target or not args.sdk_version:
            parser.error('--target and --sdk-version are required unless --merge-builds is used')
        metadata = generate(root, args.assets, args.target, args.sdk_version, args.tag, args.packages,
                            args.compatible_system, args.filename_suffix)
    body = json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))
    (args.assets / 'zen-update.json').write_text(body + '\n', encoding='utf-8')
    with args.notes.open('a', encoding='utf-8') as notes:
        notes.write('\n\n<!-- zen-update-metadata\n' + body + '\n-->\n')
