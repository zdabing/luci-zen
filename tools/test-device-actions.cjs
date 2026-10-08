// Verify the LuCI RPC contract and explicit confirmation before counter reset.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
const historySource=fs.readFileSync(path.join(__dirname,'../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/history.js'),'utf8');
const history=new Function('view','rpc','ui','_','E',historySource)({extend:x=>x},rpc,ui,x=>x,E);
history.mac='02:00:00:00:00:01';history.sel={selectedOptions:[{textContent:'NAS'}]};history.refresh=()=>{ticks++;};
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
  history.resetSelected();
  assert.equal(requests.length, 0, 'Opening the reset dialog must not clear counters');
  button('Cancel').attrs.click(); await settled();
  assert.equal(requests.length, 0, 'Cancel must not issue a reset');
  history.resetSelected();
  button('Reset counters').attrs.click(); await settled();
  assert.deepEqual(requests.at(-1), {method: 'resetDevice', payload: {mac: row.d.mac}});
  assert.equal(ticks, 1);
  console.log('PASS: reset RPC fields and explicit reset confirmation');
})().catch(error => {console.error(error); process.exit(1);});
