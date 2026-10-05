const fs = require('node:fs'), assert = require('node:assert/strict');
String.prototype.format = function (...args) { return this.replace(/%d/g, () => String(args.shift())); };
const source = fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-devices.js', 'utf8');
const icons = {inferType: () => 'unknown'};
const view = new Function('baseclass', 'rpc', 'fmt', 'icons', '_', 'identity', source)(
  {extend: x => x}, {declare: () => () => {}}, {fmtRate: String, MISSING: '—'}, icons, x => x,
  {identify:()=>({type:'unknown',brand:''})});
const field = () => ({textContent: ''});
const row = mac => ({mac, style: {}, classList: {contains: () => false, toggle() {}}, remove() {}});
view.list = {children: [], insertBefore(node, before) {
  this.children = this.children.filter(n => n !== node);
  this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
}};
view.cache = new Map(); view.count = field(); view.showAll = false;
for (const mac of ['a', 'b', 'c']) {
  const li = row(mac); view.list.children.push(li);
  view.cache.set(mac, {li, iconType: 'unknown:', connIconType: 'zen-i-eth',iconBox:{dataset:{}},
    name: field(), model:field(), ip: field(), mac: field(), conn: field(), dl: field(), ul: field(), last: field(), ov: {classList: {toggle() {}}}});
}
const data = [{mac:'a',conn:'wired',tx_r:10,rx_r:300}, {mac:'b',conn:'wired',tx_r:30,rx_r:100}, {mac:'c',conn:'wired',tx_r:20,rx_r:200}];
const order = () => view.list.children.map(n => n.mac);
view.sortKey = 'tx_r'; view.sortDescending = true; view.render(data);
assert.deepEqual(order(), ['b','c','a'], 'Upload sorting must reorder existing DOM rows');
view.sortDescending = false; view.render(data);
assert.deepEqual(order(), ['a','c','b'], 'Repeated click reverses the displayed order');
view.sortKey = 'rx_r'; view.sortDescending = true; view.render(data);
assert.deepEqual(order(), ['a','c','b'], 'Download sorting uses download rates');
view.render(data.map(d => d.mac === 'b' ? {...d,rx_r:500} : d));
assert.deepEqual(order(), ['b','a','c'], 'Polling preserves the selected sort and updates visible order');
const types = new Function('baseclass', fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-icons.js','utf8'))({extend:x=>x});
for (const [host,type] of [['realme-GT-8','phone'],['DXP4800','nas'],['Tmall-Genie','iot'],['yeelink-light-ceiling14','iot'],['000','unknown']]) assert.equal(types.inferType(host,'wired'),type);
console.log('PASS: cached row sorting, direction changes, polling updates and device recognition');
