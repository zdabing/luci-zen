const fs = require('node:fs'), assert = require('node:assert/strict');
String.prototype.format = function (...args) { return this.replace(/%d/g, () => String(args.shift())); };
const source = fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-devices.js', 'utf8');
const icons = {inferType: () => 'unknown'};
const connectionInfo=new Function('baseclass','_',fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-connection-info.js','utf8'))({extend:x=>x},x=>x);
const view = new Function('baseclass', 'rpc', 'fmt', 'icons', '_', 'identity', 'connectionInfo', source)(
  {extend: x => x}, {declare: () => () => {}}, {fmtRate: String, MISSING: '—'}, icons, x => x,
  {identify:()=>({type:'unknown',brand:''})},connectionInfo);
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
const data = [{mac:'a',conn:'wired',wan_tx_r:10,wan_rx_r:300,rx_r:1}, {mac:'b',conn:'wired',wan_tx_r:30,wan_rx_r:100,rx_r:999999}, {mac:'c',conn:'wired',wan_tx_r:20,wan_rx_r:200,rx_r:2}];
const order = () => view.list.children.map(n => n.mac);
view.sortDescending = true;
view.render(data);
assert.deepEqual(order(), ['a','c','b'], 'Default order uses Internet download, never mixed rates');
assert.equal(view.cache.get('a').dl.textContent,'300');
view.sortKey = 'wan_tx_r'; view.render(data);
assert.deepEqual(order(), ['b','c','a'], 'Upload sorting must reorder existing DOM rows');
view.sortDescending = false; view.render(data);
assert.deepEqual(order(), ['a','c','b'], 'Repeated click reverses the displayed order');
view.sortKey = 'wan_rx_r'; view.sortDescending = true; view.render(data);
assert.deepEqual(order(), ['a','c','b'], 'Download sorting uses download rates');
view.render(data.map(d => d.mac === 'b' ? {...d,wan_rx_r:500} : d));
assert.deepEqual(order(), ['b','a','c'], 'Polling preserves the selected sort and updates visible order');
const missing = data.map(d=>({...d,wan_rx_r:d.mac==='a'?undefined:d.mac==='b'?0:20}));
view.render(missing);
assert.deepEqual(order(),['c','b','a'],'Unavailable Internet rate sorts after real zero');
assert.equal(view.cache.get('a').dl.textContent,'—','Missing scope never falls back to mixed rate');
assert.equal(view.cache.get('b').dl.textContent,'0','Real zero is preserved');
view.sortDescending=false;view.render(missing);
assert.deepEqual(order(),['b','c','a'],'Missing rates remain last when ascending');
view.render(data.map(d=>({...d,wan_rx_r:0})));
assert.deepEqual(order(),['a','b','c'],'Tied Internet rates have stable MAC order');
assert.equal(view.exportSelected,undefined,'Export implementation is removed');
const types = new Function('baseclass', fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-icons.js','utf8'))({extend:x=>x});
for (const [host,type] of [['realme-GT-8','phone'],['DXP4800','nas'],['Tmall-Genie','iot'],['yeelink-light-ceiling14','iot'],['000','unknown']]) assert.equal(types.inferType(host,'wired'),type);
console.log('PASS: cached row sorting, direction changes, polling updates and device recognition');
