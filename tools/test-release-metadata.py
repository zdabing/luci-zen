import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('metadata', ROOT / 'tools/make-release-metadata.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MetadataTests(unittest.TestCase):
    def test_theme_only_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'luci-theme-zen').mkdir()
            (root / 'luci-theme-zen/Makefile').write_text('PKG_VERSION:=0.2.0\nPKG_RELEASE:=11\n')
            assets = root / 'assets'
            assets.mkdir()
            (assets / 'luci-theme-zen-0.2.0-r11.apk').write_bytes(b'fixture package')
            data = module.generate(root, assets, 'x86/64', '25.12.5', 'theme-v0.2.0-r11', ('luci-theme-zen',))
            self.assertEqual([row['name'] for row in data['packages']], ['luci-theme-zen'])
            tested = module.generate(root, assets, 'x86/64', '25.12.5', 'theme-v0.2.0-r11',
                                     ('luci-theme-zen',), ['OpenWrt@25.12.5', 'ImmortalWrt@25.12-SNAPSHOT'])
            self.assertEqual(tested['compatible_systems'][1]['distribution'], 'ImmortalWrt')
            for systems in ([], ['Other@25.12.5'], ['OpenWrt@'], ['OpenWrt@25.12.5'] * 2):
                with self.assertRaises(ValueError):
                    module.generate(root, assets, 'x86/64', '25.12.5', 'theme-v0.2.0-r11', ('luci-theme-zen',), systems)
            for invalid in ((), ('luci-theme-zen', 'luci-theme-zen'), ('unrelated',)):
                with self.assertRaises(ValueError):
                    module.generate(root, assets, 'x86/64', '25.12.5', 'theme-v0.2.0-r11', invalid)

    def test_exact_versions_and_missing_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory) / 'assets'
            assets.mkdir()
            source = Path(directory) / 'source'
            for name in module.PACKAGES:
                (source / name).mkdir(parents=True)
                (source / name / 'Makefile').write_text('PKG_VERSION:=0.2.0\nPKG_RELEASE:=10\n')
                (assets / f'{name}-0.2.0-r10.apk').write_bytes(b'fixture package')
            data = module.generate(source, assets, 'rockchip/armv8', '25.12.5', 'v0.2.0')
            self.assertEqual([p['version'] for p in data['packages']], ['0.2.0-r10'] * 3)
            self.assertEqual(data['target'], 'rockchip/armv8')
            self.assertEqual(data['sdk_version'], '25.12.5')
            self.assertNotIn('compatible_systems', data)
            self.assertTrue(all(len(p['sha256']) == 64 and p['size'] == 15 for p in data['packages']))
            (assets / 'zen-traffic-0.2.0-r10.apk').unlink()
            with self.assertRaises(ValueError):
                module.generate(source, assets, 'rockchip/armv8', '25.12.5', 'v0.2.0')
            (assets / 'zen-traffic-0.2.0-r9.apk').write_bytes(b'old package')
            (source / 'zen-traffic/Makefile').write_text('PKG_VERSION:=0.2.0\nPKG_RELEASE:=9\n')
            data = module.generate(source, assets, 'rockchip/armv8', '25.12.5', 'v0.2.0')
            self.assertEqual([p['version'] for p in data['packages']], ['0.2.0-r10', '0.2.0-r10', '0.2.0-r9'])

    def test_cli_test_records_are_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            source = (ROOT / 'luci-theme-zen/Makefile').read_text(encoding='utf-8')
            version = re.search(r'^PKG_VERSION:=(.+)$', source, re.M)[1].strip()
            revision = re.search(r'^PKG_RELEASE:=(\d+)$', source, re.M)[1]
            (assets / f'luci-theme-zen-{version}-r{revision}.apk').write_bytes(b'fixture package')
            notes = assets / 'notes.md'
            command = [sys.executable, str(ROOT / 'tools/make-release-metadata.py'),
                       '--assets', str(assets), '--target', 'rockchip/armv8',
                       '--sdk-version', '25.12.5', '--tag', 'theme-test',
                       '--notes', str(notes), '--packages', 'luci-theme-zen']
            for systems in ([], ['OpenWrt@25.12.5', 'ImmortalWrt@25.12-SNAPSHOT']):
                with self.subTest(systems=systems):
                    notes.write_text('Release notes\n', encoding='utf-8')
                    options = [value for system in systems for value in ('--compatible-system', system)]
                    subprocess.run(command + options, check=True, capture_output=True, text=True)
                    data = json.loads((assets / 'zen-update.json').read_text(encoding='utf-8'))
                    self.assertEqual(data['sdk_version'], '25.12.5')
                    body = notes.read_text(encoding='utf-8')
                    embedded = re.search(r'<!-- zen-update-metadata\s+([\s\S]*?)\s*-->', body)[1]
                    self.assertEqual(json.loads(embedded), data)
                    if systems:
                        self.assertEqual([row['distribution'] + '@' + row['version']
                                          for row in data['compatible_systems']], systems)
                    else:
                        self.assertNotIn('compatible_systems', data)

    def test_merge_target_builds_and_verify_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            assets = Path(directory) / 'assets'
            for name in module.PACKAGES:
                (root / name).mkdir(parents=True)
                (root / name / 'Makefile').write_text('PKG_VERSION:=0.2.1\nPKG_RELEASE:=1\n')
            records = []
            for index, target in enumerate(('x86/64', 'rockchip/armv8')):
                build_assets = assets / f'zen-suite-apk-{index}'
                build_assets.mkdir(parents=True)
                suffix = target.replace('/', '-')
                for name in module.PACKAGES:
                    (build_assets / f'{name}-0.2.1-r1-{suffix}.apk').write_bytes(target.encode())
                data = module.generate(root, build_assets, target, '25.12.5', 'v0.2.1', filename_suffix=suffix)
                record = build_assets / 'zen-update.json'
                record.write_text(json.dumps(data), encoding='utf-8')
                records.append(record)
            merged = module.merge_builds(root, assets, 'v0.2.1')
            self.assertEqual(merged['schema'], 1, 'Older clients can still find the top-level theme')
            self.assertEqual([merged['target'], merged['builds'][0]['target']], ['x86/64', 'rockchip/armv8'])
            self.assertEqual(len({p['filename'] for build in [merged, *merged['builds']]
                                  for p in build['packages']}), 6)
            with self.assertRaises(ValueError):
                module.merge_builds(root, assets, 'wrong-tag')
            original = records[1].read_text(encoding='utf-8')
            duplicate = json.loads(original)
            duplicate['target'] = 'x86/64'
            records[1].write_text(json.dumps(duplicate), encoding='utf-8')
            with self.assertRaises(ValueError):
                module.merge_builds(root, assets, 'v0.2.1')
            records[1].write_text(original, encoding='utf-8')
            native = records[1].parent / 'zen-traffic-0.2.1-r1-rockchip-armv8.apk'
            native.write_bytes(b'corrupted APK')
            with self.assertRaises(ValueError):
                module.merge_builds(root, assets, 'v0.2.1')


if __name__ == '__main__':
    unittest.main()
