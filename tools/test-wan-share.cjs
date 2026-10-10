const fs = require('fs');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('path').join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-wan-share.js'), 'utf8');
const moduleView = new Function('baseclass', 'rpc', 'poll', 'fmt', '_', 'L', 'window', source)(
 { extend: x => x }, { declare: () => () => {} }, {}, {}, x => x,
 {url:(...parts)=>'/cgi-bin/luci/'+parts.join('/')},{location:{href:'http://router.local/cgi-bin/luci/admin/zen'}});
assert.equal(moduleView.deviceHistoryUrl('AA:BB:CC:DD:EE:01'),'/cgi-bin/luci/admin/status/zen-traffic/history?mac=aa%3Abb%3Acc%3Add%3Aee%3A01#device-hourly');
for(const key of ['other','unassigned','not-a-device','']) assert.equal(moduleView.deviceHistoryUrl(key),null,'Aggregate rows are not device links');
const model = (dev, observed, all = false, direction = 'download') => moduleView.breakdown({dev, ['interface_' + direction]: observed}, direction, all);
const device = (mac, download, upload = 0) => ({mac, download, upload});
assert.deepEqual(model([], 0).slices, []);
let result = model([device('a', 60, 9), device('b', 30, 1)], 100);
assert.equal(result.total, 100);
assert.equal(result.slices.at(-1).key, 'unassigned');
assert.equal(result.slices.at(-1).bytes, 10);
result = model([device('a', 110)], 100);
assert.equal(result.excess, 10);
assert.equal(result.total, 110);
assert.equal(result.slices.length, 1, 'device excess must not become negative unassigned traffic');
const devices = Array.from({length: 20}, (_, i) => device(String(i), i + 1, i + 2));
result = model(devices, 230);
assert.equal(result.slices.reduce((sum, d) => sum + d.bytes, 0), 230, 'collapsed devices preserve the denominator');
assert.equal(result.slices.find(d => d.key === 'other').bytes, 105);
assert.equal(model(devices, 230, true).slices.length, 21);
assert.equal(model(devices, 250, true, 'upload').slices.reduce((sum, d) => sum + d.bytes, 0), 250);
assert.equal(model([device('a', -20), device('b', NaN)], 5).total, 5);
console.log('WAN share accounting cases passed');
