"""Execute actual LuCI install recipes and verify their browser module dependencies.

This checks staging, not APK signing or target ABI. Full SDK installation remains necessary.
"""
import re
import subprocess
import tempfile
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
        fixture.write_text('INSTALL_DIR := mkdir -p\nINSTALL_DATA := cp\nINSTALL_BIN := cp\n'
            + f'PKG_BUILD_DIR := {build.as_posix()}\ndefine {name}\n{recipe}\nendef\n'
            + f'.PHONY: stage\nstage:\n\t$(call {name},{stage.as_posix()})\n', encoding='utf-8')
        subprocess.run(['make', '--no-print-directory', '-f', str(fixture), 'stage'], cwd=source,
                       check=True, stdout=subprocess.PIPE)
        for asset in (source / 'htdocs').rglob('*'):
            if asset.is_file():
                destination = stage / 'www' / asset.relative_to(source / 'htdocs')
                assert destination.is_file(), f'{package}: missing packaged asset {asset.name}'
                assert destination.read_bytes() == asset.read_bytes(), f'{package}: asset bytes changed'
        resource_root = stage / 'www/luci-static/resources'
        for script in resource_root.rglob('*.js'):
            for dependency in re.findall(r"['\"]require (view\.[\w.-]+)(?: as \w+)?['\"]", script.read_text(encoding='utf-8')):
                if dependency.startswith(('view.zen.', 'view.zen-traffic.')):
                    dependency_path = resource_root / (dependency.replace('.', '/') + '.js')
                    assert dependency_path.is_file(), f'{script.name}: missing browser dependency {dependency}'
        print(f'PASS: {package} install recipe stages all assets and local browser dependencies')
