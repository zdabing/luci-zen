const fs=require('node:fs'),assert=require('node:assert/strict');
const read=name=>fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/'+name+'.js','utf8');
const baseclass={extend:x=>x};
const icons=new Function('baseclass',read('zen-icons'))(baseclass);
const vendors=new Function('baseclass',read('zen-vendors'))(baseclass);
assert.equal(vendors.lookup('9a:0d:ab:ff:1e:99'),null,'Private MAC must not be matched to a vendor');
assert.equal(vendors.lookup('ff:ff:ff:ff:ff:ff'),null);
assert.equal(vendors.lookup('00:03:93:00:00:01'),'apple');
let storage={},requests=[],modal,fail=false;
const rpc={declare:spec=>async(...args)=>{
 requests.push({method:spec.method,args});
 if(spec.method==='get')return {...storage};
 if(fail)throw new Error('save failed');
 if(spec.method==='set')Object.assign(storage,args[2]);
}};
const E=(tag,attrs={},children=[])=>({tag,attrs,children:Array.isArray(children)?children:[children],value:attrs.value||''});
const ui={showModal:(title,nodes)=>{modal=nodes;},hideModal:()=>{modal=null;}};
const create=()=>new Function('baseclass','rpc','ui','icons','vendors','_','E',read('zen-identity'))(baseclass,rpc,ui,icons,vendors,x=>x,E);
function find(nodes,tag){return nodes.flatMap(n=>typeof n==='object'?[...(n.tag===tag?[n]:[]),...find(n.children||[],tag)]:[]);}
(async()=>{
 const one=create();await one.load();
 assert.deepEqual(one.identify({host:'realme-GT-8',mac:'9a:0d:ab:ff:1e:99'}),{type:'phone',brand:'realme',name:'realme',model:'GT 8',source:'name'});
 const generic=one.identify({host:'000',mac:'00:03:93:00:00:01'});
 assert.equal(generic.brand,'apple');assert.equal(generic.model,'','MAC cannot establish model');assert.equal(generic.type,'unknown','Apple MAC is not necessarily a phone');
 const d={host:'000',mac:'9a:0d:ab:ff:1e:99'};let changed=0;
 one.edit(d,()=>changed++);
 const selects=find(modal,'select');selects[0].value='realme';selects[1].value='phone';find(modal,'input')[0].value='GT 8';
 const save=find(modal,'button').find(b=>b.children.includes('Save'));await save.attrs.click();
 assert.equal(changed,1);assert.equal(modal,null);
 assert.deepEqual(requests.slice(-2).map(x=>x.method),['set','commit']);
 const two=create();await two.load();assert.equal(two.identify(d).model,'GT 8');assert.equal(two.identify(d).source,'manual','Another browser reads the router override');
 one.edit(d,()=>changed++);fail=true;await find(modal,'button').find(b=>b.children.includes('Save')).attrs.click();
 assert.equal(changed,1,'Failed save must not apply a local override');assert.ok(modal,'Keep dialog open for retry');
 console.log('PASS: name/model recognition, private MAC exclusion, vendor fallback, router persistence and save failure');
})().catch(e=>{console.error(e);process.exit(1);});
