"""Preview responses must not retain HTML or assets from earlier themes."""
from functools import partial
from http.server import ThreadingHTTPServer
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('preview_server', root / 'dev-preview/serve.py')
preview = module_from_spec(spec)
spec.loader.exec_module(preview)
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(preview.PreviewHandler, directory=str(root)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
try:
    for path in ['dev-preview/runtime.html?page=dashboard', 'dev-preview/runtime.js?v=mist-2',
                 'luci-theme-zen/htdocs/luci-static/zen/theme.css?v=mist-2',
                 'luci-theme-zen/htdocs/luci-static/zen/preferences.js?v=mist-2']:
        with urlopen(f'{base}/{path}') as response:
            assert response.status == 200, path
            assert 'no-store' in response.headers['Cache-Control'], path
            assert response.headers['Pragma'] == 'no-cache', path
            assert response.headers['Expires'] == '0', path
    try:
        urlopen(f'{base}/luci-theme-zen/htdocs/luci-static/zen/appearance.css')
        raise AssertionError('Removed theme stylesheet still served')
    except HTTPError as error:
        assert error.code == 404
        assert 'no-store' in error.headers['Cache-Control']
    print('PASS: preview HTML, JS, CSS and removed assets are never cached')
finally:
    server.shutdown()
    server.server_close()
    thread.join()
