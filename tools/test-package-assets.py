"""Execute actual LuCI install recipes and verify their browser module dependencies.

This checks staging, not APK signing or target ABI. Full SDK installation remains necessary.
"""
import re
import subprocess
import tempfile
import os
import shlex
import shutil
from pathlib import Path

repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='zen-package-assets-') as temp:
    root = Path(temp)
    for package, translation in [('luci-theme-zen', 'zen'), ('luci-app-zen-traffic', 'zen-traffic')]:
        source = repo / package
        makefile = (source / 'Makefile').read_text(encoding='utf-8')
        name = f'Package/{package}/install'
        recipe = re.search(r'define ' + re.escape(name) + r'\n(.*?)\nendef', makefile, re.S).group(1)
        stage = root / package / 'stage'; build = root / package / 'build'
        build.mkdir(parents=True)
        (build / (translation + '.zh-cn.lmo')).write_bytes(b'test translation placeholder')
        fixture = root / (package + '.mk')
        fixture.write_text('INSTALL_DIR := mkdir -p\nINSTALL_DATA := cp\nINSTALL_BIN := cp\nINSTALL_CONF := cp\n'
            + f'PKG_BUILD_DIR := {build.as_posix()}\ndefine {name}\n{recipe}\nendef\n'
            + f'.PHONY: stage\nstage:\n\t$(call {name},{stage.as_posix()})\n', encoding='utf-8')
        if shutil.which('make'):
            subprocess.run(['make', '--no-print-directory', '-f', str(fixture), 'stage'], cwd=source,
                           check=True, stdout=subprocess.PIPE)
        else:
            # Windows developers can execute this simple install recipe with Git Bash.
            # Expand only its known variables; reject unknown make expressions.
            bash = os.environ.get('ZEN_TEST_BASH')
            if not bash:
                raise RuntimeError('Install GNU make, or set ZEN_TEST_BASH to Git Bash')
            expanded = recipe
            substitutions = {'$(INSTALL_DIR)': 'mkdir -p', '$(INSTALL_DATA)': 'cp', '$(INSTALL_CONF)': 'cp',
                             '$(INSTALL_BIN)': 'cp', '$(1)': shlex.quote(stage.as_posix()),
                             '$(PKG_BUILD_DIR)': shlex.quote(build.as_posix())}
            for token, value in substitutions.items():
                expanded = expanded.replace(token, value)
            assert '$(' not in expanded, 'Unsupported make expression in install recipe'
            subprocess.run([bash, '--noprofile', '--norc', '-c', 'set -eu\n' + expanded],
                           cwd=source, check=True, stdout=subprocess.PIPE)
        for asset in (source / 'htdocs').rglob('*'):
            if asset.is_file():
                destination = stage / 'www' / asset.relative_to(source / 'htdocs')
                assert destination.is_file(), f'{package}: missing packaged asset {asset.name}'
                assert destination.read_bytes() == asset.read_bytes(), f'{package}: asset bytes changed'
        for asset in (source / 'root/usr/share/luci/menu.d').glob('*.json'):
            destination = stage / asset.relative_to(source / 'root')
            assert destination.is_file() and destination.read_bytes() == asset.read_bytes(), \
                f'{package}: missing or changed route file {asset.name}'
        resource_root = stage / 'www/luci-static/resources'
        if package == 'luci-theme-zen':
            assert (stage / 'etc/config/zen').read_bytes() == (source / 'root/etc/config/zen').read_bytes()
            for asset in ['THIRD_PARTY_NOTICES.md', 'sunny-ui-GPL-3.0.txt']:
                installed = stage / 'usr/share/licenses/luci-theme-zen' / asset
                original = source / ('licenses/' + asset if asset.endswith('.txt') else asset)
                assert installed.is_file() and installed.read_bytes() == original.read_bytes(), \
                    f'{package}: missing or changed license asset {asset}'
        for script in resource_root.rglob('*.js'):
            for dependency in re.findall(r"['\"]require (view\.[\w.-]+)(?: as \w+)?['\"]", script.read_text(encoding='utf-8')):
                if dependency.startswith(('view.zen.', 'view.zen-traffic.')):
                    dependency_path = resource_root / (dependency.replace('.', '/') + '.js')
                    assert dependency_path.is_file(), f'{script.name}: missing browser dependency {dependency}'
        print(f'PASS: {package} install recipe stages all assets and local browser dependencies')
