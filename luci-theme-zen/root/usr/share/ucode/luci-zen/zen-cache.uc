// Copyright 2026 luci-theme-zen maintainers
// Licensed to the public under the Apache License 2.0.
//
// uhttpd ucode_prefix handler: serves luci-theme-zen static assets with
// long-lived Cache-Control headers so browsers can strongly cache them.
//
// Registered prefixes (see /etc/uci-defaults/30_luci-theme-zen):
//   /luci-static/zen
//   /luci-static/resources/menu-zen.js
//   /luci-static/resources/view/zen

// uhttpd compiles ucode_prefix handlers in template mode, so the whole
// script must be wrapped in {% %} blocks (like luci's uhttpd.uc) or it
// is treated as literal output and no handle_request() gets defined.
{%

'use strict';

import { readfile, realpath, stat } from 'fs';

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const MIME_TYPES = {
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.js': 'application/javascript; charset=UTF-8'
};

// URL prefix -> on-disk directory below DOCUMENT_ROOT
const ALLOWED = {
	'/luci-static/zen': 'luci-static/zen',
	'/luci-static/resources/view/zen': 'luci-static/resources/view/zen'
};

const SINGLE_FILE = '/luci-static/resources/menu-zen.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function send_status(code, msg) {
	uhttpd.send(`Status: ${code} ${msg}\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`);
}

function http_date(ts) {
	const t = gmtime(ts);

	// ucode gmtime() returns the full year (e.g. 2026), not a 1900 offset
	return sprintf('%s, %02d %s %04d %02d:%02d:%02d GMT',
		WEEKDAYS[t.wday], t.mday, MONTHS[t.mon], t.year,
		t.hour, t.min, t.sec);
}

global.handle_request = function(env) {
	if (env.REQUEST_METHOD != 'GET' && env.REQUEST_METHOD != 'HEAD') {
		send_status(405, 'Method Not Allowed');
		return;
	}

	const docroot = env.DOCUMENT_ROOT ?? '/www';
	// uhttpd ucode handlers: SCRIPT_NAME is the matched ucode_prefix,
	// PATH_INFO is the remainder of the URL after that prefix
	const prefix = env.SCRIPT_NAME ?? '';
	const rest = env.PATH_INFO ?? '';
	let phys = null;

	if (prefix == SINGLE_FILE) {
		phys = `${docroot}${SINGLE_FILE}`;
	}
	else {
		const dir = ALLOWED[prefix];

		if (dir == null) {
			send_status(404, 'Not Found');
			return;
		}

		phys = `${docroot}${prefix}${rest}`;

		// reject path traversal: resolved path must stay inside the
		// canonical allowed directory
		const real = realpath(phys);
		const base = realpath(`${docroot}${prefix}`);

		if (real == null || base == null ||
		    (real != base && substr(real, 0, length(base) + 1) != base + '/')) {
			send_status(404, 'Not Found');
			return;
		}

		phys = real;
	}

	const st = stat(phys);

	// ucode fs.stat() exposes "type" ("file"/"dir"/...), mtime, size —
	// there are no st_mode/st_mtime/st_size fields
	if (st == null || st.type != 'file') {
		send_status(404, 'Not Found');
		return;
	}

	// content type by extension
	const ext = replace(phys, /^.*\.([a-z]+)$/, '$1');
	const ctype = MIME_TYPES[`.${ext}`] ?? 'application/octet-stream';

	const etag = `"${st.mtime}-${st.size}"`;
	const lastmod = http_date(st.mtime);

	// conditional request support: versioned URLs make this redundant for
	// fresh caches, but plain URLs (old bookmarks, manually referenced
	// files) still benefit from it
	const inm = env.headers?.['if-none-match'];
	const ifms = env.headers?.['if-modified-since'];

	if (inm == etag ||
	    (inm == null && ifms != null && index(WEEKDAYS, substr(ifms, 0, 3)) != -1 &&
	     http_date(st.mtime) == ifms)) {
		uhttpd.send(`Status: 304 Not Modified\r\nETag: ${etag}\r\nLast-Modified: ${lastmod}\r\nCache-Control: ${CACHE_CONTROL}\r\n\r\n`);
		return;
	}

	const data = readfile(phys);

	if (data == null) {
		send_status(404, 'Not Found');
		return;
	}

	uhttpd.send(`Status: 200 OK\r\nContent-Type: ${ctype}\r\nContent-Length: ${length(data)}\r\nETag: ${etag}\r\nLast-Modified: ${lastmod}\r\nCache-Control: ${CACHE_CONTROL}\r\n\r\n`);

	if (env.REQUEST_METHOD != 'HEAD')
		uhttpd.send(data);
};

%}
