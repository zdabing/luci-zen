// Exercise the production component: device/date/hour routing, stale requests,
// expiry, old daemons and errors. No browser or router mutation.
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/device-timeline.js','utf8');
const E=(tag,attrs={},children=[])=>({tag,attrs,value:attrs.value||'',hidden:!!attrs.hidden,textContent:'',
 children:Array.isArray(children)?children:[children],replaceChildren(...nodes){this.children=nodes;}});
const queued=[],rpc={declare:spec=>{assert.equal(spec.method,'getDeviceTimeline');assert.deepEqual(spec.params,['mac','date','hour']);return (...args)=>new Promise((resolve,reject)=>queued.push({args,resolve,reject}));}};
let mounts=0;
const component=new Function('baseclass','view','rpc','E','_',source)({extend:p=>p},{extend:()=>{mounts++;}},rpc,E,s=>s);
const find=(n,p)=>n&&typeof n==='object'?(p(n)?n:n.children?.map(c=>find(c,p)).find(Boolean)):null;
const response=(label,step=3600,available_from=0)=>({json:JSON.stringify({start:1000,end:10000,available_from,step,samples:[{time:3600,label,download:3*1024**3,upload:1024,utc_offset:'+0800'}]})});
(async()=>{
 assert.equal(mounts,0,'Shared helper must not mount a LuCI page');
 const view=Object.create(component);view.render({device_timeline:true,timeline_today:'2026-10-07'});
 assert.equal(queued.length,0,'No all-device RPC');assert.equal(view.back.hidden,true);
 const first=view.select('aa:bb:cc:dd:ee:01');
 const second=view.select('aa:bb:cc:dd:ee:02');
 assert.deepEqual(queued[1].args,['aa:bb:cc:dd:ee:02','2026-10-07','']);
 queued[1].resolve(response('13:00–14:00'));await second;
 queued[0].resolve(response('wrong stale device'));await first;
 assert.ok(find(view.body,n=>n.children?.includes('13:00–14:00')));
 assert.ok(!find(view.body,n=>n.children?.includes('wrong stale device')));
 assert.ok(find(view.summary,n=>n.children?.includes('3.00 GB')));
 const hour=find(view.body,n=>n.tag==='button');const detail=hour.attrs.click();
 assert.deepEqual(queued[2].args,['aa:bb:cc:dd:ee:02','2026-10-07','3600']);
 queued[2].resolve(response('13:00–13:05',300,1200));await detail;
 assert.equal(view.back.hidden,false);assert.match(view.notice.textContent,/partially/);
 assert.equal(find(view.body,n=>n.tag==='button'),undefined);
 const back=view.back.attrs.click();queued[3].resolve(response('13:00–14:00'));await back;
 assert.equal(view.back.hidden,true);
 view.date.value='2026-09-01';const expired=view.query('');
 assert.equal(queued[4].args[1],'2026-09-01');
 queued[4].resolve({json:JSON.stringify({step:3600,samples:[],expired:true})});await expired;
 assert.match(view.notice.textContent,/no longer available/);assert.equal(view.body.children.length,0);
 const failed=view.query();queued[5].reject(Error('offline'));await failed;
 assert.match(view.notice.textContent,/Unable to load/);
 const malformed=view.query();queued[6].resolve({json:'{}'});await malformed;
 assert.match(view.notice.textContent,/Unable to load/);
 const obsolete=Object.create(component);obsolete.render({});await obsolete.select('aa:bb:cc:dd:ee:02');
 assert.equal(queued.length,7);assert.equal(obsolete.date.disabled,true);assert.match(obsolete.notice.textContent,/Update/);
 await view.select('');assert.equal(queued.length,7);assert.equal(view.body.children.length,0);
 console.log('PASS: device timeline routing, stale response isolation, detail/back, expiry, errors and old backend');
})().catch(error=>{console.error(error);process.exitCode=1;});
