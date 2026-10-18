"""Serve the local LuCI renderer without caching editable preview assets."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse

ROOT = Path(__file__).resolve().parents[1]


class PreviewHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    args = argparse.ArgumentParser()
    args.add_argument('--port', type=int, default=8770)
    options = args.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', options.port), partial(PreviewHandler, directory=str(ROOT)))
    print(f'Zen preview: http://127.0.0.1:{options.port}/dev-preview/runtime.html?page=dashboard', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
