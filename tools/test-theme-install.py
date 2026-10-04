"""Run the real theme defaults with isolated UCI and service commands."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HANDLER = '/usr/share/ucode/luci-zen/zen-cache.uc'
OWNED = [prefix + '=' + HANDLER for prefix in (
    '/luci-static/zen', '/luci-static/resources/menu-zen.js',
    '/luci-static/resources/view/zen')]


def mock_uci(args):
    path = Path(os.environ['ZEN_TEST_STATE'])
    state = json.loads(path.read_text(encoding='utf-8'))
    if args[0] == '-q':
        args = args[1:]
    state['calls'].append(args)
    command, key = args[:2]
    code = 0
    if command == 'get':
        if key not in state['values']:
            code = 1
        else:
            value = state['values'][key]
            print(' '.join(value) if isinstance(value, list) else value)
    elif command == 'set':
        key, value = key.split('=', 1)
        state['values'][key] = value
    elif command == 'del_list':
        key, value = key.split('=', 1)
        values = state['values'].get(key, [])
        if value not in values:
            code = 1
        else:
            values.remove(value)
    elif command not in ('commit', 'service'):
        raise AssertionError('Unexpected UCI command: ' + str(args))
    path.write_text(json.dumps(state), encoding='utf-8')
    return code


class InstallTests(unittest.TestCase):
    def run_defaults(self, state, upgrade=False):
        script = (ROOT / 'luci-theme-zen/root/etc/uci-defaults/30_luci-theme-zen').read_text(encoding='utf-8')
        # Only substitute the external init script; run the actual install logic.
        script = script.replace('/etc/init.d/uhttpd', 'zen_test_uhttpd')
        wrapper = '''uci() { "$ZEN_TEST_PYTHON" "$ZEN_TEST_HELPER" --mock-uci "$@"; }
zen_test_uhttpd() { uci service "$@"; }
'''
        with tempfile.TemporaryDirectory() as directory:
            store = Path(directory) / 'state.json'
            store.write_text(json.dumps(state), encoding='utf-8')
            env = dict(os.environ, ZEN_TEST_STATE=store.as_posix(),
                       ZEN_TEST_PYTHON=Path(sys.executable).as_posix(),
                       ZEN_TEST_HELPER=Path(__file__).resolve().as_posix(),
                       PKG_UPGRADE='1' if upgrade else '0', MSYS_NO_PATHCONV='1')
            shell = os.environ.get('ZEN_TEST_BASH') or shutil.which('bash')
            self.assertTrue(shell, 'bash or ZEN_TEST_BASH is required')
            subprocess.run([shell, '--noprofile', '--norc', '-c', wrapper + script],
                           env=env, check=True, capture_output=True, text=True)
            return json.loads(store.read_text(encoding='utf-8'))

    def test_new_install_preserves_theme_and_web_server(self):
        values = {'luci.main.mediaurlbase': '/luci-static/custom',
                  'uhttpd.main.ucode_prefix': ['/custom=/usr/share/custom.uc']}
        result = self.run_defaults({'values': values, 'calls': []})
        self.assertEqual(result['values']['luci.main.mediaurlbase'], '/luci-static/custom')
        self.assertEqual(result['values']['luci.themes.Zen'], '/luci-static/zen')
        self.assertEqual(result['values']['uhttpd.main.ucode_prefix'], values['uhttpd.main.ucode_prefix'])
        self.assertFalse(any(call[0] in ('service', 'del_list', 'add_list') or
                             call == ['commit', 'uhttpd'] for call in result['calls']))

    def test_upgrade_removes_only_owned_prefixes_once(self):
        other = '/custom=/usr/share/custom.uc'
        values = {'luci.themes.Zen': '/luci-static/zen',
                  'luci.main.mediaurlbase': '/luci-static/custom',
                  'uhttpd.main.ucode_prefix': OWNED + [other]}
        result = self.run_defaults({'values': values, 'calls': []}, upgrade=True)
        self.assertEqual(result['values']['uhttpd.main.ucode_prefix'], [other])
        self.assertEqual(result['values']['luci.main.mediaurlbase'], '/luci-static/custom')
        self.assertEqual(result['calls'].count(['service', 'reload']), 1)
        result['calls'] = []
        repeated = self.run_defaults(result, upgrade=True)
        self.assertFalse(any(call[0] != 'get' for call in repeated['calls']))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--mock-uci':
        sys.exit(mock_uci(sys.argv[2:]))
    unittest.main()
