// Display preference compatibility, persistence and failed-write recovery.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('luci-theme-zen/htdocs/luci-static/zen/preferences.js','utf8');
function browser(initial={},dark=false,blocked=false,router=null,authenticated=true){
 const values=new Map(Object.entries(initial)),events={},systemEvents={};
 const root={dataset:{}};
 if(router)Object.assign(root.dataset,{zenAppearance:'router',zenAuthenticated:String(authenticated),zenSaved:String(router.saved!==false),zenMode:router.mode,zenLayout:router.layout});
 const media={matches:dark,addEventListener:(name,fn)=>systemEvents[name]=fn};
 const window={matchMedia:()=>media,addEventListener:(name,fn)=>events[name]=fn};
 const storage={getItem:key=>{if(blocked)throw Error('blocked');return values.get(key)??null;},setItem:(key,v)=>{if(blocked)throw Error('blocked');values.set(key,v);}};
 const document={documentElement:root,querySelectorAll:()=>[],addEventListener(){},dispatchEvent(){}};
 vm.runInNewContext(source,{window,document,localStorage:storage,CustomEvent:class{}});
 return {api:window.ZenAppearance,values,events,media,systemEvents,root};
}
const plain=value=>JSON.parse(JSON.stringify(value));
let b=browser();assert.deepEqual(plain(b.api.get()),{mode:'auto',layout:'sidebar',theme:'light'});assert.equal(b.values.size,0);
b=browser({'luci-theme-zen':'dark','luci-theme-zen-layout':'top','luci-theme-zen-accent':'macaron','luci-theme-zen-material':'glass'});
assert.deepEqual(plain(b.api.get()),{mode:'dark',layout:'top',theme:'dark'},'Retain useful legacy settings without the old palette');
b.api.set({accent:'blue',material:'outline'});assert.equal(b.api.get().accent,undefined);assert.equal(b.root.dataset.material,undefined);
b.api.set({mode:'auto'});b.media.matches=true;b.systemEvents.change();assert.equal(b.api.get().theme,'dark');
b.events.storage({key:'luci-theme-zen',newValue:'light'});assert.equal(b.api.get().theme,'light');
b.events.storage({key:'luci-theme-zen-layout',newValue:'sidebar'});assert.equal(b.api.get().layout,'sidebar');
b.api.set({mode:'invalid',layout:'invalid'});assert.equal(b.api.get().mode,'auto');assert.equal(b.api.get().layout,'sidebar');
b=browser({},true,true);assert.equal(b.api.get().theme,'dark');b.api.set({mode:'light',layout:'top'});b.systemEvents.change();assert.equal(b.api.get().theme,'light');
(async()=>{
 let config={saved:false,mode:'auto',layout:'sidebar'},writes=[];
 const save=async patch=>{writes.push(plain(patch));Object.assign(config,patch,{saved:true});};
 const first=browser({},false,false,config);await first.api.connect(save);assert.equal(writes.length,0);
 first.api.set({mode:'dark',layout:'top'});await first.api.flush();assert.deepEqual(writes[0],{mode:'dark',layout:'top'});
 const second=browser({'luci-theme-zen':'light'},false,true,config);assert.equal(second.api.get().theme,'dark');
 await second.api.connect(save);assert.equal(writes.length,1);second.api.set({layout:'sidebar'});await second.api.flush();assert.deepEqual(writes[1],{layout:'sidebar'});
 let failing=true;await first.api.connect(async patch=>{if(failing)throw Error('failed commit');await save(patch);});
 first.api.set({mode:'light'});await first.api.flush();assert.equal(first.api.status(),'Could not save to router. Try again.');
 failing=false;await first.api.retry();assert.equal(config.mode,'light');assert.equal(first.api.status(),'Saved on router; applies across browsers');
 let release;const queued=[];await first.api.connect(patch=>{queued.push(plain(patch));return new Promise(resolve=>release=resolve);});
 first.api.set({mode:'dark'});const flushing=first.api.flush();await new Promise(setImmediate);
 first.api.set({mode:'light'});first.api.set({layout:'top'});assert.equal(queued.length,1,'Serial commits');release();await new Promise(setImmediate);
 assert.deepEqual(queued[1],{mode:'light',layout:'top'});release();await flushing;
 const migrated=browser({'luci-theme-zen':'dark','luci-theme-zen-layout':'top'},false,false,{saved:false});let migration;
 await migrated.api.connect(async patch=>migration=plain(patch));assert.deepEqual(migration,{mode:'dark',layout:'top'});
 const guest=browser({},false,false,config,false);let changed=false;await guest.api.connect(async()=>changed=true);guest.api.set({mode:'dark'});await guest.api.flush();assert.equal(changed,false);
 console.log('PASS: native Mist preferences; legacy mode/layout, old palette ignored, auto/system, blocked storage, cross-tab events, router authority, field patches, serialized commits, retry, migration and guest isolation');
})().catch(e=>{console.error(e);process.exitCode=1;});
