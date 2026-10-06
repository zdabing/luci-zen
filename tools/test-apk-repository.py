"""Exercise signing orchestration with a real EC key and a mock SDK APK tool.

This does not replace an SDK APK signature/installation acceptance run.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('ZEN_TEST_BASH') or shutil.which('bash')
spec = importlib.util.spec_from_file_location('feed', ROOT / 'tools/check-feed-update.py')
feed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feed)


class RepositoryTests(unittest.TestCase):
    def build(self, missing=False, fail_verify=False):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            packages = directory / 'packages'
            packages.mkdir()
            names = ['luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic', 'zen-full']
            for name in names[:-1] if missing else names:
                (packages / (name + '-0.2.0-r1.apk')).write_bytes(b'fixture')
            key = directory / 'private.pem'
            subprocess.run([BASH, '-c', 'openssl ecparam -name prime256v1 -genkey -noout -out "$1"', 'keygen', key.as_posix()], check=True)
            log = directory / 'calls'
            mock = directory / 'apk'
            mock.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$ZEN_APK_TEST_LOG"
case "$1" in
  adbsign) exit 0 ;;
  mkndx) printf 'fixture index' > packages.adb ;;
  --keys-dir) [ "${ZEN_APK_FAIL_VERIFY:-0}" = 0 ] ;;
  *) exit 9 ;;
esac
''', encoding='utf-8', newline='\n')
            mock.chmod(0o755)
            env = dict(os.environ, ZEN_APK_TEST_LOG=log.as_posix(), ZEN_APK_FAIL_VERIFY=str(int(fail_verify)),
                       APK_PACKAGE_BASE='https://github.com/zdabing/luci-zen/releases/download/feed-build-123')
            result = subprocess.run([BASH, str(ROOT / 'tools/build-apk-repository.sh'), mock.as_posix(), key.as_posix(), packages.as_posix()], env=env, capture_output=True, text=True)
            return result, log.read_text() if log.exists() else '', (packages / 'SHA256SUMS').exists()

    def test_sign_packages_and_index_then_verify(self):
        result, calls, sums = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(sums)
        self.assertIn('adbsign --reset-signatures --sign', calls)
        self.assertIn('mkndx --allow-untrusted --sign', calls)
        self.assertIn('https://github.com/zdabing/luci-zen/releases/download/feed-build-123/${name}-${version}.apk', calls)
        self.assertIn('verify packages.adb', calls)

    def test_missing_package_or_failed_signature_blocks_feed(self):
        for options in ({'missing': True}, {'fail_verify': True}):
            result, _, sums = self.build(**options)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(sums)

    def test_cannot_downgrade_or_cross_targets(self):
        current = dict(schema=1, repo='zdabing/luci-zen', target='rockchip/armv8', sdk_version='25.12.5',
                       packages=[dict(name='zen-traffic', version='0.2.0-r13')])
        feed.check(current, current)
        for candidate in ({**current, 'target': 'x86/64'}, {**current, 'packages': [dict(name='zen-traffic', version='0.2.0-r12')]}):
            with self.assertRaises(ValueError):
                feed.check(candidate, current)


if __name__ == '__main__':
    unittest.main()
