const fs = require('node:fs'), assert = require('node:assert/strict');
const document = {querySelector:()=>null, addEventListener(){}, documentElement:{dataset:{}}};
const window = {innerWidth:1024, addEventListener(){}};
const L = {env:{dispatchpath:['admin','zen','realtime']}};
const menu = new Function('baseclass','ui','icons','document','window','L',
 fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/menu-zen.js','utf8'))(
 {extend:value=>value},{},{},document,window,L);
let mainRendered = 0, tabsRendered = 0;
menu.renderModeMenu = () => mainRendered++;
menu.renderTabMenu = () => tabsRendered++;
for (const name of ['setDesktopCollapsed','setSidebarOpen','syncNavigationPlacement','syncMenuExpansion']) menu[name]=()=>{};
menu.readDesktopCollapsed=()=>false;
// Alias nodes returned by LuCI may be leaves even when the request has a child path.
assert.doesNotThrow(()=>menu.render({children:{admin:{children:{zen:{title:'Zen'}}}}}));
assert.equal(mainRendered,1); assert.equal(tabsRendered,0);
assert.doesNotThrow(()=>menu.render({children:{admin:{children:{zen:{children:{realtime:{title:'Overview'}}}}}}}));
assert.equal(mainRendered,2); assert.equal(tabsRendered,1);
console.log('PASS: LuCI alias leaves do not abort navigation; existing child routes retain tabs');

// The dispatcher resolves firstchild and legacy aliases without redirecting
// the address bar. The header must pass ctx.path (not ctx.request_path).
const vm = require('node:vm');
const header = fs.readFileSync('luci-theme-zen/ucode/template/themes/zen/header.ut','utf8');
assert.match(header, /data-dispatch-path="\{\{ entityencode\(join\('\/', ctx\.path\), true\) \}\}"/);
const consoleSource = fs.readFileSync('luci-theme-zen/htdocs/luci-static/zen/console-layout.js','utf8');
function consoleEntry(url, resolved, envPath) {
 const dataset = {resourceVersion:'123'};
 if (resolved !== undefined) dataset.dispatchPath = resolved;
 const window = {L:{env:{dispatchpath:envPath}}};
 let observers = 0;
 vm.runInNewContext(consoleSource, {
  window, L:window.L,
  location:new URL(url,'http://localhost'),
  document:{currentScript:{dataset},querySelector:()=>null,documentElement:{},readyState:'complete'},
  MutationObserver:class {observe(){observers++;}},
 });
 assert.equal(window.L.env.resource_version,'123');
 return {enabled:!!window.ZenConsole?.enabled,observers};
}
for (const url of ['/cgi-bin/luci/','/cgi-bin/luci','/cgi-bin/luci/admin','/cgi-bin/luci/admin/','/cgi-bin/luci/admin/zen','/cgi-bin/luci/admin/zen/','/cgi-bin/luci/admin/zen/realtime'])
 assert.deepEqual(consoleEntry(url,'admin/zen/realtime'),{enabled:true,observers:1},'Default home: '+url);
const routes = {...JSON.parse(fs.readFileSync('luci-theme-zen/root/usr/share/luci/menu.d/luci-theme-zen.json')),
 ...JSON.parse(fs.readFileSync('luci-app-zen-traffic/root/usr/share/luci/menu.d/luci-app-zen-traffic.json'))};
for (const [route,node] of Object.entries(routes)) {
 const resolved = node.action.type==='alias'?node.action.path:route;
 if (resolved.startsWith('admin/zen/'))
  assert.equal(consoleEntry('/cgi-bin/luci/'+route,resolved).enabled,true,route);
}
for (const route of ['admin/status/overview','admin/network/network','admin/system/flash','admin/services/test','admin/status/zen-traffic/notifications'])
 assert.deepEqual(consoleEntry('/cgi-bin/luci/'+route,route),{enabled:false,observers:0},'Native page: '+route);
assert.equal(consoleEntry('/cgi-bin/luci/admin',undefined,['admin','zen','realtime']).enabled,true,'LuCI environment fallback');
assert.equal(consoleEntry('/cgi-bin/luci/admin/zen/realtime',undefined).enabled,true,'Standalone preview fallback');
assert.equal(consoleEntry('/cgi-bin/luci/admin/zen/realtime','admin/status/overview').enabled,false,'Resolved route is authoritative');
console.log('PASS: default home, Zen links and legacy aliases share the console; native OpenWrt pages retain their navigation');

// Exercise the mounted content initializer with a protected native shell.
// Any attempt to insert a replacement menu or edit the shell fails the test.
for (const route of ['admin/zen/realtime','admin/zen/analysis','admin/zen/capture','admin/zen/settings']) {
 const headings=[],classes=[];
 let disconnected=0,mutate;
 const view={firstElementChild:{},before:node=>headings.push(node)};
 const doc={
  currentScript:{dataset:{dispatchPath:route}},readyState:'complete',
  documentElement:{classList:{add:name=>classes.push(name)}},
  querySelector:selector=>{assert.equal(selector,'#view');return view;},
  createElement:tag=>{assert.ok(['div','h1'].includes(tag),'Content headings only');return {tag,append(child){this.child=child;}};}
 };
 Object.defineProperty(doc,'body',{get(){throw Error('The native shell must not be changed');}});
 vm.runInNewContext(consoleSource, {document:doc,window:{},location:{pathname:'/cgi-bin/luci/admin'},
  MutationObserver:class {constructor(fn){mutate=fn;}observe(){}disconnect(){disconnected++;}}
 });
 mutate();
 assert.equal(headings.length,1,'One content heading even if the observer runs again');
 assert.deepEqual(classes,['zen-console']);
 assert.equal(disconnected,1);
 assert.ok(headings[0].child.textContent);
}
const consoleCSS=fs.readFileSync('luci-theme-zen/htdocs/luci-static/zen/console.css','utf8');
assert.doesNotMatch(consoleCSS,/--header-h\s*:\s*0/,'Keep the native header height');
assert.doesNotMatch(consoleCSS,/[^{}]*(?:\.main-left|\.main-right|body\s*>\s*header)[^{}]*\{/,'Content CSS must not override the native shell');
assert.doesNotMatch(consoleCSS,/\.rf-(?:sidebar|admin-dialog|mobile-menu)[^{}]*\{/,'No replacement navigation');
console.log('PASS: content initialization preserves the native shell; no hidden header, replacement menu or zero-height header CSS');
