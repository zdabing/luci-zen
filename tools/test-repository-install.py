"""Execute the installer with isolated system paths and a mock APK solver."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('ZEN_TEST_BASH') or shutil.which('bash')


class InstallerTests(unittest.TestCase):
    def install(self, fail=False, distribution='OpenWrt', bad_key=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            etc = root / 'etc'
            etc.mkdir()
            (etc / 'openwrt_release').write_text(f"DISTRIB_ID={distribution}\nDISTRIB_RELEASE=25.12.5\nDISTRIB_TARGET=rockchip/armv8\n")
            key = root / 'public.pem'
            key.write_bytes(b'-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n')
            fingerprint = '0' * 64 if bad_key else hashlib.sha256(key.read_bytes()).hexdigest()
            bin = root / 'bin'
            bin.mkdir()
            log = root / 'apk-calls'
            mock = bin / 'apk'
            mock.write_text('''#!/bin/sh
echo "$*" >> "$ZEN_APK_INSTALL_LOG"
[ "$*" != 'add --simulate luci-theme-zen' ] || [ "$ZEN_APK_SOLVER_FAIL" = 0 ]
''', newline='\n')
            mock.chmod(0o755)
            script = (ROOT / 'tools/install-zen.sh').read_text(encoding='utf-8')
            script = script.replace('/etc/', etc.as_posix() + '/')
            installer = root / 'install.sh'
            installer.write_text(script, newline='\n')
            path = '$(cygpath -u "$1")' if os.name == 'nt' else '$1'
            launcher = 'export PATH="' + path + ':$PATH"\nshift\nsh "$@"'
            env = dict(os.environ, ZEN_APK_INSTALL_LOG=log.as_posix(), ZEN_APK_SOLVER_FAIL=str(int(fail)))
            result = subprocess.run([BASH, '-c', launcher, 'install', bin.as_posix(), installer.as_posix(), key.as_posix(), fingerprint, 'theme'], env=env, capture_output=True, text=True)
            return result, log.read_text().splitlines() if log.exists() else [], (etc / 'apk/repositories.d/zen.list').exists()

    def test_simulation_precedes_installation(self):
        result, calls, configured = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(configured)
        self.assertEqual(calls, ['update', 'add --simulate luci-theme-zen', 'add luci-theme-zen'])

    def test_missing_kernel_dependency_cannot_force_install(self):
        result, calls, _ = self.install(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('add luci-theme-zen', calls)

    def test_unknown_distribution_or_key_rejected_before_configuration(self):
        for options in ({'distribution': 'ImmortalWrt'}, {'bad_key': True}):
            result, calls, configured = self.install(**options)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])
            self.assertFalse(configured)


if __name__ == '__main__':
    unittest.main()
