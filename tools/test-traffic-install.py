"""Run the runtime checker in an isolated fixture; never attach BPF programs."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASH = os.environ.get('ZEN_TEST_BASH') or shutil.which('bash')


class TrafficPrerequisites(unittest.TestCase):
    def run_check(self, missing='', daemon_exit=0, bpf=True):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            command = root / 'bin'
            command.mkdir()
            (root / 'filesystems').write_text('nodev\tbpf\n' if bpf else 'nodev\tproc\n')
            (root / 'object').write_bytes(b'fixture BPF object')
            (root / 'daemon').write_text('#!/bin/sh\n[ "$1" = --help ] || exit 90\nexit ' + str(daemon_exit) + '\n', newline='\n')
            (root / 'daemon').chmod(0o755)
            for name, script in {
                'apk': '#!/bin/sh\n[ "$1 $2" = "info -e" ] || exit 90\n[ "$3" != "$ZEN_MISSING_MODULE" ]\n',
                'ubus': '#!/bin/sh\nexit 1\n'
            }.items():
                path = command / name
                path.write_text(script, newline='\n')
                path.chmod(0o755)
            script = (ROOT / 'zen-traffic/files/usr/libexec/zen-traffic-check').read_text(encoding='utf-8')
            replacements = {'/proc/filesystems': root / 'filesystems',
                            '/usr/share/zen-traffic/zen_traffic.bpf.o': root / 'object',
                            '/usr/bin/zen-trafficd': root / 'daemon'}
            for original, path in replacements.items():
                script = script.replace(original, '"' + path.as_posix() + '"')
            # Let Git Bash translate Windows fixture paths into its PATH format.
            launcher = 'export PATH="$(cygpath -u "$1"):$PATH"\n' if os.name == 'nt' else 'export PATH="$1:$PATH"\n'
            env = dict(os.environ, ZEN_MISSING_MODULE=missing)
            return subprocess.run([BASH, '-c', launcher + script, 'check', command.as_posix()], env=env, capture_output=True, text=True)

    def test_service_not_started_is_informational(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('service is not responding', result.stdout)

    def test_missing_module_bpf_or_wrong_abi_blocks_start(self):
        for options in ({'missing': 'kmod-sched-bpf'}, {'missing': 'kmod-sched-core'}, {'bpf': False}, {'daemon_exit': 127}):
            result = self.run_check(**options)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn('ERROR:', result.stdout)


if __name__ == '__main__':
    unittest.main()
