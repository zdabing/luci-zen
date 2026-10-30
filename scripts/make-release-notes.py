"""Extract one version's release notes and attach reproducible build details."""
import argparse
import re
from pathlib import Path


def release_notes(root, tag):
    if tag.startswith('build-'):
        source = (root / 'luci-app-zen/Makefile').read_text(encoding='utf-8')
        version = re.search(r'^PKG_VERSION:=(.+)$', source, re.M)[1].strip()
        revision = re.search(r'^PKG_RELEASE:=(\d+)$', source, re.M)[1]
        version = f'{version}-r{revision}'
    else:
        version = tag.removeprefix('frontend-').removeprefix('v')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-r\d+)?', version):
        raise ValueError('Expected a version tag or an SDK build tag')
    changelog = (root / 'CHANGELOG.md').read_text(encoding='utf-8')
    heading = re.search(r'^## v?' + re.escape(version) + r'(?=[ \t（(]|$)[^\n]*$', changelog, re.M)
    if heading is None:
        raise ValueError('Missing CHANGELOG entry for ' + version)
    body = changelog[heading.end():]
    next_version = re.search(r'^## ', body, re.M)
    if next_version:
        body = body[:next_version.start()]
    if not body.strip():
        raise ValueError('Empty CHANGELOG entry for ' + version)
    return '# Zen ' + tag + '\n\n' + body.strip() + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--sdk-version', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--source-build')
    parser.add_argument('--output', type=Path, default=Path('release-notes.md'))
    args = parser.parse_args()
    notes = release_notes(Path(__file__).resolve().parents[1], args.tag)
    notes += '\n## 构建信息\n\n'
    notes += f'- OpenWrt SDK: {args.sdk_version}\n- Target: {args.target}\n'
    notes += f'- Commit: `{args.commit}`\n'
    if args.source_build:
        notes += f'- Source build: {args.source_build}\n'
    notes += '\n内核模块必须与路由器固件 ABI 匹配。\n'
    args.output.write_text(notes, encoding='utf-8')
