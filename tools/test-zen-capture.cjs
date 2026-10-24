// Per-device packet capture (M1–M4): view behavior, routing, ACL, recipes, BPF object.
const fs = require('node:fs'), assert = require('node:assert/strict');

class Element {
 constructor(tag, attrs = {}, children = []) {this.tag = tag;this.attrs = attrs;this.value = attrs.value || '';this.hidden = false;this.checked = !!attrs.checked;
  this.children = Array.isArray(children) ? children : [children];this.events = {};
  if (tag === 'a') {this.click = () => {this.clicked = true;};this.remove = () => {this.removed = true;};}}
 replaceChildren(...nodes) {this.children = nodes;}
 appendChild(node) {this.children.push(node);return node;}
 setAttribute(key, value) {this.attrs[key] = String(value);}
 addEventListener(key, fn) {this.events[key] = fn;}
}
const E = (...args) => new Element(...args);
const findAll = (n, p) => Array.isArray(n)
 ? n.flatMap(c => findAll(c, p))
 : (n && typeof n === 'object' && !(n instanceof String)
    ? [...(p(n) ? [n] : []), ...(n.children || []).flatMap(c => findAll(c, p))]
    : []);
const text = n => n === null || n === undefined ? ''
 : typeof n !== 'object' ? String(n) : n instanceof String ? String(n)
 : Array.isArray(n) ? n.map(text).join(' ')
 : (n.children || []).map(text).join(' ');
const clickables = (root, label) => findAll(root, n => n.tag === 'button' && String(text(n.children)).startsWith(label));

const document = {
 createElement: tag => E(tag),
 getElementById: () => null,
 head: {appendChild() {}},
 body: {children: [], appendChild(node) {this.children.push(node);}}
};
const polls = [];
const notifications = [];
const L = {bind: (fn, scope) => fn.bind(scope), poll: {add: (fn, interval) => polls.push({fn, interval})}};
const ui = {
 notifications,
 addNotification: (scope, msg, type) => notifications.push({msg: text(msg), type}),
 createHandlerFn: (scope, name, ...rest) => ev => scope[name](ev, ...rest),
 confirm: () => true
};

const source = fs.readFileSync('luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/capture.js', 'utf8');
const declared = [], queued = [];
const rpc = {declare: spec => {
 declared.push(spec);
 return (...args) => new Promise((resolve, reject) => queued.push({spec, args, resolve, reject}));
}};
const readCalls = [];
const fsMock = {read: (path, format) => {readCalls.push({path, format}); return Promise.resolve({blob: path});}};
const _ = s => Object.assign(new String(s), {
 format(...a) {let i = 0; return String(s).replace(/%[sd]/g, () => String(a[i++]));}
});
class MockBlob {constructor(parts, options) {this.parts = parts;this.type = options && options.type;}}
const window = {
 location: {search: '?mac=AA:BB:CC:DD:EE:09'},
 URL: {createObjectURL: blob => 'blob:mock', revokeObjectURL() {}},
 Blob: MockBlob
};

const component = new Function('view', 'rpc', 'fs', 'poll', 'ui', 'L', 'window', 'document', 'E', '_', 'trafficStyle', source)(
 {extend: p => p}, rpc, fsMock, L.poll, ui, L, window, document, E, _, {inject() {}});
const drain = () => queued.splice(0);
/* 冲洗微任务：rpc resolve 后 view 的 .then 链才把下一个调用入队。 */
const settle = async () => {
 for (let i = 0; i < 10 && queued.length === 0; i++)
  await Promise.resolve();
};
const reply = value => ({json: JSON.stringify(value)});

const caps = {max_sessions: 2, max_duration: 600, max_file_mb: 8, dir: '/tmp/zen-capture'};
const statusData = extra => ({ok: true, ca_ready: false, caps, sessions: [
 {id: 'a-0001', mac: 'aa:bb:cc:dd:ee:01', mode: 'tap', decrypt: false, port: 0,
  ifaces: ['eth0'], files: ['/tmp/zen-capture/a-0001.pcap'],
  started: 1760000000, seconds: 300, max_bytes: 8388608, bytes: 4096, state: 'running', stop_reason: ''},
 {id: 'a-0000', mac: 'aa:bb:cc:dd:ee:02', mode: 'http', decrypt: true, port: 18765,
  ifaces: ['eth0'], files: [],
  started: 1759999000, seconds: 60, max_bytes: 8388608, bytes: 2048, state: 'done', stop_reason: 'time'},
 {id: 'a-0003', mac: 'aa:bb:cc:dd:ee:03', mode: 'tap', decrypt: false, port: 0,
  ifaces: ['eth0'], files: ['/tmp/zen-capture/a-0003.pcap'],
  started: 1759998000, seconds: 300, max_bytes: 8388608, bytes: 1024, state: 'done', stop_reason: 'size'},
 ...extra || []
]});
const devices = [{mac: 'aa:bb:cc:dd:ee:01', host: 'Laptop', ip4: '192.168.1.10'}];

(async () => {
 assert.deepEqual(declared.map(s => s.object + '.' + s.method), [
  'zen.capture.status', 'zen.traffic.getDevices', 'zen.capture.start', 'zen.capture.stop',
  'zen.capture.delete', 'zen.capture.getDomains', 'zen.capture.getEvents',
  'zen.capture.getCA', 'zen.capture.getHar'
 ], 'Capture view covers sessions, domains, events, CA and HAR');
 assert.deepEqual(declared.find(s => s.method === 'start').params,
  ['mac', 'mode', 'seconds', 'max_bytes', 'decrypt']);

 // Backend missing → warning page, no poll.
 let view = Object.create(component);
 view.render([null, []]);
 assert.match(text(view.body), /not reachable/);
 assert.equal(polls.length, 0, 'No polling without a reachable backend');

 // Full render: URL mac preselect, mode select, capped options, sessions table, 3s poll.
 view = Object.create(component);
 view.render([statusData(), devices]);
 const select = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-device')[0];
 assert.deepEqual(select.children.map(o => o.value), ['', 'aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:09'],
  'URL mac is preselected and appended when unknown');
 const modeSel = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-mode')[0];
 assert.deepEqual(modeSel.children.map(o => o.value), ['tap', 'http']);
 const duration = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-duration')[0];
 assert.deepEqual(duration.children.map(o => Number(o.value)), [60, 300, 600], '1800 is clamped by caps');
 const size = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-size')[0];
 assert.deepEqual(size.children.map(o => Number(o.value)), [4, 8], '16 MB is clamped by caps');
 assert.equal(polls.map(p => p.interval).join(','), '3', 'Poll is registered once per render');
 const rows = findAll(view.body, n => n.tag === 'tr');
 assert.equal(rows.length, 4, 'Header plus three sessions');
 assert.ok(text(rows[1]).includes('Laptop'), 'Known devices show their hostname');
 assert.ok(text(rows[2]).includes('HTTP requests'), 'Mode column shows the session mode');
 assert.equal(clickables(rows[1], 'Stop').length, 1, 'Running session offers Stop');
 assert.equal(clickables(rows[1], 'Download').length, 0, 'Running session has no download yet');
 assert.equal(clickables(rows[2], 'Download HAR').length, 1, 'Finished http session offers HAR');
 assert.equal(clickables(rows[2], 'Download ·').length, 0, 'http sessions have no pcap');
 assert.equal(clickables(rows[3], 'Download ·').length, 1, 'Finished tap session offers its pcap');
 assert.equal(clickables(rows[3], 'Download HAR').length, 0, 'tap sessions have no HAR');
 assert.equal(clickables(rows[3], 'Details').length, 1, 'Sessions offer a details toggle');
 assert.ok(text(rows[1]).includes('4.0 KB') && text(rows[2]).includes('2.0 KB'), 'Byte formatting');
 assert.ok(text(view.table).includes('Capturing'), 'Running state is labeled');

 // Detail toggle: http session → events table.
 const eventsWait = view.toggleDetail({}, 'a-0000', 'http');
 const eventsCall = drain().at(-1);
 assert.deepEqual(eventsCall.args, ['a-0000']);
 eventsCall.resolve(reply({ok: true, events: [
  {ts: 1760000000, kind: 'https', method: 'GET', host: 'example.com', path: '/a', status: 200, req_bytes: 120, resp_bytes: 2048},
  {ts: 1760000001, kind: 'passthrough', method: '', host: 'bank.com', path: '', status: 0, req_bytes: 10, resp_bytes: 20}
 ]}));
 await eventsWait;
 assert.ok(text(view.detail).includes('example.com'), 'Event rows render host');
 assert.ok(text(view.detail).includes('Passthrough'), 'Event kinds are translated');
 assert.ok(text(view.detail).includes('2.0 KB'), 'Response sizes render');

 // Detail toggle: tap session → domains table.
 const domainsWait = view.toggleDetail({}, 'a-0001', 'tap');
 const domainsCall = drain().at(-1);
 assert.deepEqual(domainsCall.args, ['a-0001']);
 assert.equal(domainsCall.spec.method, 'getDomains');
 domainsCall.resolve(reply({ok: true, domains: [{domain: 'www.example.com', count: 12, last_ts: 1760000000}]}));
 await domainsWait;
 assert.ok(text(view.detail).includes('www.example.com'));
 assert.ok(text(view.detail).includes('12'), 'Domain counts render');

 // Toggling the open detail hides it without RPC.
 const before = queued.length;
 view.toggleDetail({}, 'a-0001', 'tap');
 assert.equal(queued.length, before, 'Toggling the open detail just hides it');
 assert.equal(text(view.detail), '', 'Hidden detail clears its content');

 // Start: mode/decrypt passed through, size dropped for decrypt, error codes translated.
 notifications.length = 0;
 view.mac = '';
 await view.handleStart({});
 assert.equal(queued.length, 0, 'No start without a device');
 assert.match(notifications[0].msg, /Select a device/);
 view.mac = 'aa:bb:cc:dd:ee:01';
 view.mode = 'tap'; view.decrypt = false;
 const failed = view.handleStart({});
 const startCall = drain().at(-1);
 assert.deepEqual(startCall.args, ['aa:bb:cc:dd:ee:01', 'tap', 300, 8388608, false]);
 startCall.resolve(reply({ok: false, error: 'tap_unavailable'}));
 await failed;
 assert.match(notifications.at(-1).msg, /eBPF capture engine/);
 assert.equal(queued.length, 0, 'Backend errors do not trigger a refresh');

 notifications.length = 0;
 const httpStart = view.handleStart({});
 drain().at(-1).resolve(reply({ok: false, error: 'nft_failed'}));
 await httpStart;
 assert.match(notifications.at(-1).msg, /nftables/);

 // Decrypt start: max_bytes is sent as 0 (http mode has no pcap cap).
 view.mode = 'http'; view.decrypt = true;
 const decryptStart = view.handleStart({});
 const decryptCall = drain().at(-1);
 assert.deepEqual(decryptCall.args, ['aa:bb:cc:dd:ee:01', 'http', 300, 0, true]);
 decryptCall.resolve(reply({ok: true, session: {id: 'a-0002'}}));
 await settle();
 drain().at(-1).resolve(reply(statusData()));
 await decryptStart;

 // HAR download via getHar blob.
 document.body.children = [];
 const har = view.handleDownloadHar({}, 'a-0000');
 drain().at(-1).resolve(reply({ok: true, har: '{"log":{"entries":[]}}'}));
 await har;
 assert.equal(queued.length, 0, 'HAR fetch consumed');
 const harLink = document.body.children.filter(n => n.tag === 'a').at(-1);
 assert.equal(harLink.download, 'zen-capture-a-0000.har');

 // CA download path.
 document.body.children = [];
 const caOk = view.handleDownloadCA();
 const caCall = drain().at(-1);
 assert.equal(caCall.spec.method, 'getCA');
 caCall.resolve(reply({ok: true, pem: '-----BEGIN CERTIFICATE-----\nZEN\n-----END CERTIFICATE-----'}));
 await caOk;
 const caLink = document.body.children.filter(n => n.tag === 'a').at(-1);
 assert.equal(caLink.download, 'zen-capture-ca.crt');
 // CA error path surfaces the friendly hint.
 notifications.length = 0;
 const caFail = view.handleDownloadCA();
 drain().at(-1).resolve(reply({ok: false, error: 'ca_unavailable'}));
 await caFail;
 assert.match(notifications.at(-1).msg, /created when you start an encrypted capture/);

 // Stop / delete / pcap download flows.
 notifications.length = 0;
 const stopWait = view.handleStop({}, 'a-0001');
 const stopCall = drain().at(-1);
 assert.deepEqual(stopCall.args, ['a-0001']);
 stopCall.resolve(reply({ok: true, session: {}}));
 await settle();
 drain().at(-1).resolve(reply(statusData()));
 await stopWait;

 const refuseWait = view.handleStop({}, 'zz');
 const refuseCall = drain().at(-1);
 refuseCall.resolve(reply({ok: false, error: 'not_found'}));
 await refuseWait;
 assert.match(notifications.at(-1).msg, /not found/i);

 let confirmed = 0;
 ui.confirm = () => {confirmed++; return false;};
 await view.handleDelete({}, 'a-0000', 'aa:bb:cc:dd:ee:02');
 assert.equal(confirmed, 1, 'Delete asks for confirmation');
 assert.equal(queued.length, 0, 'Declined delete sends nothing');
 ui.confirm = () => {confirmed++; return true;};
 const deleteWait = view.handleDelete({}, 'a-0000', 'aa:bb:cc:dd:ee:02');
 const deleteCall = drain().at(-1);
 assert.deepEqual(deleteCall.args, ['a-0000']);
 deleteCall.resolve(reply({ok: true}));
 await settle();
 drain().at(-1).resolve(reply(statusData()));
 await deleteWait;

 await view.handleDownload({}, '/tmp/zen-capture/a-0001.pcap', 'a-0001.pcap');
 assert.deepEqual(readCalls, [{path: '/tmp/zen-capture/a-0001.pcap', format: 'blob'}],
  'pcap downloads via rpcd file read');

 fsMock.read = () => Promise.reject(Error('gone'));
 notifications.length = 0;
 await view.handleDownload({}, '/tmp/zen-capture/old.pcap', 'old.pcap');
 assert.match(notifications.at(-1).msg, /Download failed/);

 // Clamped default when the daemon caps shrink.
 view = Object.create(component);
 view.render([{ok: true, ca_ready: true, caps: {...caps, max_duration: 120, max_file_mb: 4}, sessions: []}, devices]);
 const shortDuration = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-duration')[0];
 assert.deepEqual(shortDuration.children.map(o => Number(o.value)), [60, 120]);
 assert.equal(shortDuration.value, 120, 'Default duration falls back to the largest allowed');
 const smallSize = findAll(view.body, n => n.tag === 'select' && n.attrs.id === 'zen-capture-size')[0];
 assert.deepEqual(smallSize.children.map(o => Number(o.value)), [4]);
 assert.equal(smallSize.value, 4);

 console.log('PASS: capture view (modes, decrypt, domains/events details, HAR/CA, caps, polling)');

 // ---------------- Static recipe checks ----------------
 const menu = JSON.parse(fs.readFileSync('luci-app-zen-traffic/root/usr/share/luci/menu.d/luci-app-zen-traffic.json', 'utf8'));
 assert.deepEqual(menu['admin/zen/capture'], {
  title: 'Capture', order: 4,
  action: {type: 'view', path: 'zen-traffic/capture'},
  depends: {acl: ['luci-app-zen-traffic']}
 }, 'Capture is a fourth Zen entry after settings');

 const acl = JSON.parse(fs.readFileSync('luci-app-zen-traffic/root/usr/share/rpcd/acl.d/luci-app-zen-traffic.json', 'utf8'));
 assert.deepEqual(acl['zen-capture'].read.ubus, {'zen.capture': ['status', 'getDomains', 'getEvents', 'getCA', 'getHar']});
 assert.deepEqual(acl['zen-capture'].read.file, {'/tmp/zen-capture': ['list', 'read']},
  'pcap download is limited to the capture directory');
 assert.deepEqual(acl['zen-capture'].write.ubus, {'zen.capture': ['start', 'stop', 'delete']});

 const appMakefile = fs.readFileSync('luci-app-zen-traffic/Makefile', 'utf8');
 assert.match(appMakefile, /view\/zen-traffic\/capture\.js/, 'capture.js is packaged');
 const themeMenu = JSON.parse(fs.readFileSync('luci-theme-zen/root/usr/share/luci/menu.d/luci-theme-zen.json', 'utf8'));
 assert.ok(!themeMenu['admin/zen/capture'], 'Route stays in the traffic app package');

 const daemonMakefile = fs.readFileSync('zen-traffic/Makefile', 'utf8');
 assert.match(daemonMakefile, /\+tcpdump/, 'tcpdump is a package dependency');
 assert.match(daemonMakefile, /Build\/Compile\/Cargo,crates\/zen-capture/, 'Second binary is compiled');
 assert.match(daemonMakefile, /bin\/zen-capture/, 'zen-capture binary is installed');
 assert.match(daemonMakefile, /CompileBPF,\$\(CAP_BPF_SRC\)/, 'Capture BPF object is compiled');
 assert.match(daemonMakefile, /zen_capture\.bpf\.o/, 'Capture BPF object is installed');

 const workspace = fs.readFileSync('zen-traffic/Cargo.toml', 'utf8');
 assert.match(workspace, /"crates\/zen-capture"/, 'zen-capture is a workspace member');
 const cargo = fs.readFileSync('zen-traffic/crates/zen-capture/Cargo.toml', 'utf8');
 for (const dep of ['aya', 'tokio', 'rustls', 'rcgen', 'tokio-rustls', 'rustls-pemfile'])
  assert.match(cargo, new RegExp(dep + ' ='), `zen-capture depends on ${dep}`);

 const init = fs.readFileSync('zen-traffic/files/etc/init.d/zen-capture', 'utf8');
 assert.match(init, /PROG=\/usr\/bin\/zen-capture/);
 assert.match(init, /config_get_bool enabled capture enabled 1/);
 assert.match(init, /procd_set_param respawn/, 'procd respawn keeps crash isolation');
 assert.match(init, /-B "\$bpf"/, 'init.d passes the BPF object path');
 assert.match(init, /-C "\$ca_dir"/, 'init.d passes the CA directory');
 assert.match(init, /-N "\$n"/, 'init.d passes decrypt_skip entries');

 const uci = fs.readFileSync('zen-traffic/files/etc/config/zen-traffic', 'utf8');
 assert.match(uci, /config capture 'capture'/);
 for (const [key, value] of [['max_sessions', '2'], ['max_duration', '600'], ['max_file_mb', '8'], ['snaplen', '256'], ['keep', '10'], ['ca_dir', '/etc/zen-capture']])
  assert.match(uci, new RegExp(`option ${key} '${value}'`), `uci default ${key} matches the daemon default`);

 const bpf = fs.readFileSync('zen-traffic/bpf/zen_capture.bpf.c', 'utf8');
 assert.match(bpf, /BPF_MAP_TYPE_RINGBUF/, 'Capture frames flow through a ringbuf');
 assert.match(bpf, /capture_enable/, 'Per-MAC enable switch exists');
 assert.match(bpf, /TC_ACT_UNSPEC/, 'Capture verdict must continue the filter chain');
 assert.match(bpf, /zen_cap_ingress[\s\S]*zen_cap_egress/, 'Both directions are covered');

 const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
 assert.match(ci, /node tools\/test-zen-capture\.cjs/, 'CI runs the capture regression');
 assert.match(ci, /zen_capture\.bpf\.c/, 'CI compiles the capture BPF object');

 const ubusSource = fs.readFileSync('zen-traffic/crates/zen-capture/src/ubus.rs', 'utf8');
 for (const method of ['start', 'stop', 'status', 'delete', 'getDomains', 'getEvents', 'getCA', 'getHar'])
  assert.match(ubusSource, new RegExp(`b"${method}\\\\0"`), `ubus method ${method}`);
 assert.match(ubusSource, /b"zen\.capture\\0"/, 'ubus object name');

 const captureSource = fs.readFileSync('zen-traffic/crates/zen-capture/src/capture.rs', 'utf8');
 assert.match(captureSource, /trait Proc: Send/, 'Manager must stay Send inside the ubus static');
 assert.match(captureSource, /pub pids: Vec<u32>/, 'pids must persist for orphan reaping');
 assert.match(captureSource, /chain_del/, 'http sessions release their nft chain');

 const tapSource = fs.readFileSync('zen-traffic/crates/zen-capture/src/tap.rs', 'utf8');
 assert.match(tapSource, /LinkOrder::first\(\)/, 'tap programs must precede the accounting filter');
 assert.match(tapSource, /qdisc_detach_program/, 'stale capture filters are cleaned by name');
 const proxySource = fs.readFileSync('zen-traffic/crates/zen-capture/src/proxy.rs', 'utf8');
 
 assert.match(proxySource, /copy_bidirectional/, 'passthrough splices both directions concurrently');
 assert.match(proxySource, /static ISSUER: OnceLock/, 'CA issuer is cached and reused across leaves');
 assert.match(proxySource, /Issuer::from_ca_cert_pem/, 'issuer is rebuilt from the stored CA (rcgen 0.14)');
 assert.match(proxySource, /meta l4proto udp udp dport 443 drop/, 'QUIC is forced back to TCP for decrypt sessions');
 assert.match(proxySource, /domain_skipped/, 'decrypt_skip passthrough exists');

 const parseSource = fs.readFileSync('zen-traffic/crates/zen-capture/src/parse.rs', 'utf8');
 for (const fn of ['dns_query_name', 'tls_sni', 'sni_from_record', 'parse_request_head', 'rfc3339'])
  assert.match(parseSource, new RegExp('fn ' + fn), `parser ${fn}`);

 const mainSource = fs.readFileSync('zen-traffic/crates/zen-capture/src/main.rs', 'utf8');
 assert.match(mainSource, /"-N" \| "--skip"/, 'CLI carries decrypt_skip entries');
 assert.match(mainSource, /snaplen: 256/, 'CLI default snaplen matches uci');

 const controls = fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-device-controls.js', 'utf8');
 assert.match(controls, /\['capture','zen\.capture','start'\]/, 'Device drawer probes the capture capability');
 assert.match(controls, /admin\/zen\/capture/, 'Device drawer links to the capture page');
 const themePo = fs.readFileSync('luci-theme-zen/po/zh_Hans/theme.po', 'utf8');
 assert.match(themePo, /msgid "Capture"/, 'Theme po translates the drawer action');

 const menuTest = fs.readFileSync('tools/test-menu-routing.cjs', 'utf8');
 assert.match(menuTest, /'admin\/zen\/capture'/, 'Menu routing test covers the capture route');

 console.log('PASS: capture recipes (menu, ACL, packaging, BPF, init.d, uci, workspace, CI, drawer)');
})().catch(e => {console.error(e); process.exit(1);});
