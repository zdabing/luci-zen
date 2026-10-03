// Verify the LuCI RPC contract and explicit confirmation before counter reset.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname,
  '../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/devices.js'), 'utf8');
String.prototype.format = function (...args) { return this.replace(/%[ds]/g, () => String(args.shift())); };
let modal = null, requests = [], ticks = 0;
const E = (tag, attrs = {}, children = []) => ({tag, attrs,
  children: Array.isArray(children) ? children : [children]});
const ui = {
  showModal: (title, children) => { modal = {title, children}; },
  hideModal: () => { modal = null; },
  addNotification: () => { throw new Error('Unexpected action error'); }
};
const rpc = {declare: spec => (...args) => {
  requests.push({method: spec.method,
    payload: Object.fromEntries((spec.params || []).map((key, i) => [key, args[i]]))});
  return Promise.resolve({ok: true});
}};
const view = new Function('view', 'rpc', 'poll', 'ui', 'trafficStyle', '_', 'L', 'E', 'document', source)(
  {extend: x => x}, rpc, {}, ui, {}, x => x, {bind: (fn, ctx) => fn.bind(ctx)}, E,
  {getElementById: () => ({value: ' NAS Updated '})});
view.tick = () => { ticks++; };
const row = {d: {mac: '02:00:00:00:00:01', host: 'NAS'}};
function button(label) {
  function find(nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.tag === 'button' && node.children.includes(label)) return node;
      const match = find(node.children || []); if (match) return match;
    }
  }
  const result = find(modal.children);
  assert.ok(result, 'Missing action button ' + label); return result;
}
const settled = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  view.editHostname(row);
  button('Save').attrs.click(); await settled();
  assert.deepEqual(requests.at(-1), {method: 'setHostname',
    payload: {mac: row.d.mac, host: 'NAS Updated'}});
  assert.equal(ticks, 1);
  view.resetDevice(row);
  assert.equal(requests.length, 1, 'Opening the reset dialog must not clear counters');
  button('Cancel').attrs.click(); await settled();
  assert.equal(requests.length, 1, 'Cancel must not issue a reset');
  view.resetDevice(row);
  button('Reset counters').attrs.click(); await settled();
  assert.deepEqual(requests.at(-1), {method: 'resetDevice', payload: {mac: row.d.mac}});
  assert.equal(ticks, 2);
  console.log('PASS: hostname/reset RPC fields and explicit reset confirmation');
})().catch(error => {console.error(error); process.exit(1);});
