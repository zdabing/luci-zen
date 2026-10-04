// LuCI view modules mount themselves on construction. Shared dependencies
// must not initialize another page, regardless of which page imports them.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../luci-app-zen-traffic');
let mounts=[];
const view={extend:props=>{mounts.push(props);return props;}},baseclass={extend:props=>props};
const rpc={declare:()=>()=>Promise.resolve({})};
const helperSource=fs.readFileSync(path.join(root,'htdocs/luci-static/resources/view/zen-traffic/rate-history.js'),'utf8');
const helper=new Function('view','baseclass','rpc','trafficStyle','_',helperSource)(view,baseclass,rpc,{},s=>s);
assert.equal(mounts.length,0,'Importing a shared rate component must not mount a LuCI page');
assert.equal(typeof helper.render,'function');assert.equal(typeof helper.query,'function');
for(const page of ['realtime','history']) {
 mounts=[];
 const source=fs.readFileSync(path.join(root,'htdocs/luci-static/resources/view/zen-traffic/'+page+'.js'),'utf8');
 new Function('view','rpc','_',source)(view,rpc,s=>s);
 assert.equal(mounts.length,1,page+' must initialize exactly one page');
}
const menu=JSON.parse(fs.readFileSync(path.join(root,'root/usr/share/luci/menu.d/luci-app-zen-traffic.json'),'utf8'));
const visible=Object.entries(menu).filter(([key,value])=>key.startsWith('admin/status/zen-traffic/')&&value.title).sort((a,b)=>a[1].order-b[1].order);
assert.deepEqual(visible.map(([key])=>key.split('/').at(-1)),['realtime','history','notifications']);
assert.deepEqual(menu['admin/status/zen-traffic/devices'].action,{type:'alias',path:'admin/status/zen-traffic/realtime'});
// Emulate HTML boolean-attribute presence, including disabled="false".
const E=(tag,attrs={},children=[])=>({tag,attrs,disabled:Object.hasOwn(attrs,'disabled')&&attrs.disabled!=null,
 children:Array.isArray(children)?children:[children],value:attrs.value||'',textContent:'',
 appendChild(child){this.children.push(child);return child;}});
const document={getElementById:()=>null,createElement:tag=>E(tag),head:E('head')};
const historySource=fs.readFileSync(path.join(root,'htdocs/luci-static/resources/view/zen-traffic/history.js'),'utf8');
const find=(node,predicate)=>predicate(node)?node:(node.children||[]).map(child=>child&&typeof child==='object'?find(child,predicate):null).find(Boolean);
for(const available of [true,false]) {
 const history=new Function('view','rpc','trafficStyle','rateHistory','_','E','document','L','window',historySource)(
  view,rpc,{inject(){}},{render:()=>E('div'),query(){}},s=>s,E,document,{bind:(f,c)=>f.bind(c)},{location:{search:''}});
 let refreshes=0;history.refresh=()=>{refreshes++;};
 const page=history.render([{wan_daily:available},{dev:[]}]);
 const scope=find(page,node=>node.attrs?.['aria-label']==='Traffic scope');
 assert.equal(scope.children[0].disabled,!available,'Internet scope must be selectable exactly when supported by the daemon');
 assert.equal(scope.value,available?'internet':'all');
 if(available) {
  scope.attrs.change({target:{value:'all'}});assert.equal(history.scope,'all');
  assert.equal(history.monthTab.textContent,'Monthly (12 months)');
  scope.attrs.change({target:{value:'internet'}});assert.equal(history.scope,'internet');
  assert.equal(history.monthTab.textContent,'Monthly (retained days)');
  assert.equal(refreshes,3,'Both scope changes must refresh the selected history');
 }
}
console.log('PASS: shared chart imports do not mount pages; three entries; legacy alias; supported and unsupported internet scope');
