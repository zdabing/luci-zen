// Shared dashboard imports must never prepend content to another LuCI page.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '../luci-theme-zen');
const source = name => fs.readFileSync(path.join(root, 'htdocs/luci-static/resources/' + name), 'utf8');
const callbacks = [], polls = []; let ticks = 0, deviceMounts = 0, shareMounts = 0;
// LuCI invokes a baseclass constructor's __init__ at import time.
const baseclass = { extend(props) { if (props.__init__) props.__init__(); return props; } };
const rpc = { declare: () => () => Promise.resolve({}) };
const poll = { add: (fn, interval) => polls.push({ fn, interval }), remove: fn => { const i = polls.findIndex(p => p.fn === fn); if (i >= 0) polls.splice(i, 1); } };
const document = { hidden: false, getElementById() { throw Error('Dashboard imports must not access the native view'); } };
const dashboard = new Function('baseclass', 'rpc', 'fs', 'network', 'poll', 'fmt', 'devices', 'wanShare', 'document', source('view/zen/dashboard.js'))(
 baseclass, rpc, {}, {}, poll, {}, { mount: () => { deviceMounts++; return Promise.resolve(); } },
 { mount: () => { shareMounts++; return Promise.resolve(); } }, document
);
assert.equal(polls.length, 0); assert.equal(dashboard.dash, undefined);
const nativeView = { content: 'Original OpenWrt status sections' };
dashboard.tick = () => { ticks++; return Promise.resolve(); };
let mounted = 0;
const view = { extend: props => { mounted++; return props; } };
const home = new Function('view', 'dashboard', 'requestAnimationFrame', source('view/zen/home.js'))(view, dashboard, fn => callbacks.push(fn));
assert.equal(mounted, 1); assert.equal(polls.length, 0, 'Importing the home view must wait for its render');
const dash = { isConnected: false, appendChild() {} }; dashboard.build = () => dash;
assert.equal(home.render(), dash); assert.equal(polls.length, 0, 'Render must return content for LuCI to insert');
dash.isConnected = true; callbacks.shift()();
assert.equal(polls.length, 1); assert.equal(polls[0].interval, 5); assert.equal(ticks, 1);
assert.equal(deviceMounts, 1); assert.equal(shareMounts, 1);
dashboard.start(dash); assert.equal(polls.length, 1); assert.equal(deviceMounts, 1, 'Repeated start must not duplicate device collectors');
document.hidden = true; polls[0].fn(); assert.equal(ticks, 1);
document.hidden = false; dash.isConnected = false; polls[0].fn(); assert.equal(ticks, 1);
dash.isConnected = true; polls[0].fn(); assert.equal(ticks, 2);
assert.equal(nativeView.content, 'Original OpenWrt status sections');
assert.equal(home.handleSave, null); assert.equal(home.handleSaveApply, null); assert.equal(home.handleReset, null);
const routes = JSON.parse(fs.readFileSync(path.join(root, 'root/usr/share/luci/menu.d/luci-theme-zen.json'), 'utf8'));
assert.deepEqual(Object.keys(routes), ['admin/zen','admin/system/zen'], 'Theme owns home and settings; it must not overwrite stock routes');
assert.deepEqual(routes['admin/system/zen'].action, {type:'view',path:'zen/settings'});
assert.ok(!source('view/zen/home.js').includes('zen-updates'), 'Home does not load the update component');
assert.deepEqual(routes['admin/zen'].action, { type: 'view', path: 'zen/home' });
assert.ok(routes['admin/zen'].order < 10, 'Zen home precedes the stock status menu for the default landing');
assert.deepEqual(routes['admin/zen'].depends.acl, ['luci-theme-zen']);
// Run the real menu initializer on the native overview, where the old injection happened.
let imports = 0;
const menuDocument = { body: { getAttribute: () => 'admin-status-overview' } };
const menu = new Function('baseclass', 'ui', 'icons', 'document', 'L', source('menu-zen.js'))(
 { extend: props => props }, { menu: { load: () => Promise.resolve({}) } }, {}, menuDocument, { require: () => { imports++; } }
);
menu.render = () => {}; menu.__init__(); assert.equal(imports, 0, 'Native overview must not load any Zen dashboard');
console.log('PASS: standalone home route; no stock-overview injection or import side effects; single collector startup; hidden/detached polling guard');
