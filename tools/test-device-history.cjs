// Exercise production queries against the deployed daemon's optional-filter contract.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname,
  '../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/history.js'), 'utf8');
const requests = [], rendered = [];
let answer;
const rpc = {declare: spec => (...args) => {
  if (spec.method !== 'getHistory') return Promise.resolve({});
  const payload = Object.fromEntries((spec.params || []).map((key, i) => [key, args[i]]));
  requests.push(payload);
  if (answer) return answer(payload);
  // Older daemons treat a present null/empty MAC as a filter matching no devices.
  const all = !Object.hasOwn(payload, 'mac');
  const rows = all || payload.mac === '02:00:00:00:00:01'
    ? [{date: '2026-10-03', month: '2026-10', download: all ? 300 : 100, upload: all ? 30 : 10}]
    : [];
  return Promise.resolve({agg: payload.agg, [payload.agg === 'month' ? 'months' : 'days']: rows});
}};
const view = new Function('view', 'rpc', 'trafficStyle', '_', 'L', 'document', 'console', source)(
  {extend: x => x}, rpc, {}, x => x, {bind: (fn, ctx) => fn.bind(ctx)}, {hidden: false}, {warn() {}});
view.chart = {textContent: ''}; view.statusText = {textContent: ''};
view.draw = data => {rendered.push(data);view.lastResult = data;};
(async () => {
  for (const agg of ['day', 'month']) {
    view.agg = agg; view.mac = ''; await view.refresh();
    assert.deepEqual(requests.at(-1), {agg}, 'All devices must omit MAC entirely');
    assert.equal(rendered.at(-1)[agg === 'month' ? 'months' : 'days'][0].download, 300);
    view.mac = '02:00:00:00:00:01'; await view.refresh();
    assert.deepEqual(requests.at(-1), {agg, mac: view.mac});
    assert.equal(rendered.at(-1)[agg === 'month' ? 'months' : 'days'][0].download, 100);
    view.mac = ''; await view.refresh();
    assert.deepEqual(requests.at(-1), {agg}, 'Returning from a device must remove the filter');
  }
  let rejectOld;
  answer = () => new Promise((_, reject) => {rejectOld = reject;});
  const old = view.refresh();
  answer = () => Promise.resolve({agg: 'month', months: [{month: '2026-10', download: 900, upload: 90}]});
  await view.refresh(); rejectOld(new Error('stale failure')); await old;
  assert.equal(view.lastResult.months[0].download, 900);
  assert.equal(view.statusText.textContent, '', 'A stale error must not overwrite fresh results');
  answer = () => Promise.reject(new Error('RPC offline')); await view.refresh();
  assert.equal(view.statusText.textContent, 'Unable to load history. Please try again.');
  assert.equal(view.lastResult, null, 'Do not show an old device graph under a failed new selection');
  console.log('PASS: all-device day/month queries, selected MAC, filter removal and history errors');
})().catch(error => {console.error(error);process.exit(1);});
