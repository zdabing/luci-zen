const fs = require('node:fs'), assert = require('node:assert/strict');
String.prototype.format = function (...args) { return this.replace(/%s/g, () => String(args.shift())); };
const fields = new Map();
function field(selector) {
 if (!fields.has(selector)) fields.set(selector, {textContent:'', attrs:{}, style:{}, classList:{toggle(){}}, setAttribute(k,v){this.attrs[k]=v;}, querySelector:field});
 return fields.get(selector);
}
const source = fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/dashboard.js','utf8');
const health = new Function('baseclass','fs',fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-health.js','utf8'))({extend:x=>x},{});
function element(tag, attrs, children = []) {
 return {textContent:(Array.isArray(children)?children:[children]).map(child =>
  child && typeof child === 'object' ? child.textContent : String(child)).join('')};
}
const dash = new Function('baseclass','rpc','fs','network','poll','fmt','devices','_','health','E',source)(
 {extend:x=>x}, {declare:()=>()=>Promise.resolve({})}, {}, {}, {},
 {MISSING:'—',fmtUptime:sec=>`${sec}s`}, {}, x=>x,health,element);

const summary = dash.buildConnectionSummary();
assert.ok(summary.textContent.includes('WAN IPv6'));
assert.ok(!summary.textContent.includes('null'), 'LuCI renders null children as text; optional nodes must be omitted');
dash.dash = {querySelector:field};
const text = key => field(`[data-connection="${key}"]`).textContent;
const wan = {getIPAddrs:()=>['100.64.1.2'], isUp:()=>true, getProtocol:()=> 'dhcp', getUptime:()=>3600,
 getGatewayAddr:()=> '100.64.1.1', getDNSAddrs:()=>['192.0.2.53','192.0.2.54']};
dash.setNetworkRow('wan',wan,false);
assert.equal(text('wan'),'100.64.1.2','Show the actual WAN interface address, even when it is not public');
assert.equal(text('state'),'Connected');
assert.equal(field('[data-network-extra="gateway"]').textContent,'100.64.1.1');
assert.equal(field('[data-network-extra="dns"]').textContent,'192.0.2.53\n192.0.2.54');
dash.setNetworkRow('wan6',{getIP6Addrs:()=>[{address:'2001:db8::1'},'2001:db8::2'],isUp:()=>true},true);
assert.equal(text('wan6'),'2001:db8::1\n2001:db8::2','Preserve all IPv6 addresses');
dash.setNetworkRow('wan6',null,true);
assert.equal(text('wan6'),'—','Clear removed IPv6 data on the next poll');
assert.equal(text('wan6-detail'),'No delegated prefix');
dash.setNetworkRow('wan',null,false);
assert.equal(text('state'),'Down','Never retain a connected status when WAN disappears');
assert.equal(text('wan'),'—');
assert.equal(field('[data-connection="state"]').attrs['data-state'],'down');
assert.equal(field('[data-network-extra="dns"]').textContent,'—','Clear stale resolver data');
dash.setNetworkRow('lan',{getIPAddrs:()=>['192.168.8.1'],isUp:()=>true},false);
assert.equal(text('lan'),'192.168.8.1');
dash.setUptime(86400,1800000000); assert.equal(text('uptime'),'86400s');
assert.ok(text('uptime-detail').startsWith('Restarted '),'Restart time stays visible next to uptime');
dash.setUptime(0,1800000000); assert.equal(text('uptime'),'0s','Zero uptime is valid');
dash.setUptime(undefined); assert.equal(text('uptime'),'—','Unavailable uptime must not be fabricated');
dash.setHealth({connections:1284,connectionLimit:16384,temperature:{celsius:51,sensor:'soc',path:'/sys/class/thermal/thermal_zone0/temp'},latency:{state:'ok',ms:14.8,target:'1.1.1.1'}},{state:'ok',used:5,total:100});
assert.equal(field('[data-health="temperature"]').textContent,'51 °C');
assert.equal(field('[data-health="latency"]').textContent,'14.8 ms');
assert.equal(text('lan-detail'),'DHCP leases 5 / 100');
dash.setHealth({connections:0,connectionLimit:16384,temperature:null,latency:{state:'timeout'}},{state:'disabled'});
assert.equal(field('[data-health="connections"]').textContent,'0');
assert.equal(field('[data-health="temperature"]').textContent,'—');
assert.equal(field('[data-health="latency"]').textContent,'Timeout');
assert.equal(text('lan-detail'),'DHCP disabled');
console.log('PASS: visible WAN/LAN/IPv6 and system uptime, live connection state, gateway/DNS and stale data clearing');
