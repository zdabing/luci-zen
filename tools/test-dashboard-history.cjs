// Exercise homepage restoration with the production module; no build required.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/dashboard.js'), 'utf8');
let requests = [], deferred = null;
const rpc = { declare: spec => (...args) => {
  if (spec.method !== 'getRealtimeHistory') return Promise.resolve({});
  requests.push(args);
  if (deferred) return new Promise(resolve => { deferred.resolve = resolve; });
  return Promise.resolve({samples: [{time: Math.floor(Date.now()/1000)-5, download: 100, upload: 200}]});
} };
const dashboard = new Function('baseclass', 'rpc', 'fs', 'network', 'poll', 'fmt', 'devices', source)(
  {extend: value => value}, rpc, {}, {}, {}, {}, {}
);
(async () => {
  dashboard.wanDevice = dashboard.iface = 'pppoe-wan';
  dashboard.history = [];
  await dashboard.loadRealtimeHistory();
  assert.equal(dashboard.history[0].rx, 100);
  assert.equal(dashboard.history[0].tx, 200);
  assert.ok(dashboard.history[0].t > 1e12, 'Unix seconds must become milliseconds');
  assert.equal(requests[0][0], 'pppoe-wan');
  assert.deepEqual(requests[0], ['pppoe-wan', 60], 'Use router-time default window, unaffected by browser clock skew');
  const wan = {getDevice: () => ({getName: () => 'eth1'}), getL3Device: () => ({getName: () => 'pppoe-wan'})};
  const counters = {eth1: {statistics: {rx_bytes: 20000000, tx_bytes: 500000}}, 'pppoe-wan': {statistics: {rx_bytes: 2000, tx_bytes: 1000}}};
  assert.equal(dashboard.selectWanDevice(wan, counters), 'eth1', 'Accelerated WAN traffic must use physical counters');
  assert.equal(dashboard.pickStats(counters, 'eth1').rx, 20000000, 'Do not add physical and PPPoE counters together');
  assert.equal(dashboard.selectWanDevice(wan, {'pppoe-wan': counters['pppoe-wan']}), 'pppoe-wan', 'Fall back when physical device is unavailable');
  await dashboard.loadRealtimeHistory();
  assert.equal(requests.length, 1, 'Do not re-query historical data every poll');
  dashboard.iface = 'all'; dashboard.historyLoadedFor = null;
  await dashboard.loadRealtimeHistory();
  assert.equal(requests.length, 1, 'Do not restore WAN history into all-interface chart');
  dashboard.iface = 'pppoe-wan'; dashboard.history = [];
  deferred = {};
  const pending = dashboard.loadRealtimeHistory();
  dashboard.iface = 'br-lan'; dashboard.historyRequest++;
  deferred.resolve({samples:[{time:123,download:999,upload:999}]});
  await pending;
  assert.equal(dashboard.history.length, 0, 'Stale history cannot overwrite a newly selected interface');
  console.log('PASS: WAN restoration, timestamp conversion, one-time fetch, interface isolation and stale response protection');
})().catch(error => { console.error(error); process.exit(1); });
