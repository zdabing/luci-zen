import importlib.util
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
            self.assertTrue(all(len(p['sha256']) == 64 and p['size'] == 15 for p in data['packages']))
            (assets / 'zen-traffic-0.2.0-r10.apk').unlink()
            with self.assertRaises(ValueError):
                module.generate(source, assets, 'rockchip/armv8', '25.12.5', 'v0.2.0')
            (assets / 'zen-traffic-0.2.0-r9.apk').write_bytes(b'old package')
            (source / 'zen-traffic/Makefile').write_text('PKG_VERSION:=0.2.0\nPKG_RELEASE:=9\n')
            data = module.generate(source, assets, 'rockchip/armv8', '25.12.5', 'v0.2.0')
            self.assertEqual([p['version'] for p in data['packages']], ['0.2.0-r10', '0.2.0-r10', '0.2.0-r9'])


if __name__ == '__main__':
    unittest.main()
