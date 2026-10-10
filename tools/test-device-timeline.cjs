// Production hourly chart: routing/races, byte scale, zero hours and input methods.
const fs=require('node:fs'),assert=require('node:assert/strict');
class Element {
 constructor(tag,attrs={},children=[]) {this.tag=tag;this.attrs=attrs;this.value=attrs.value||'';this.hidden=!!attrs.hidden;
  this.children=Array.isArray(children)?children:[children];this.events={};this.style={};this.clientWidth=320;this.clientHeight=280;this.offsetWidth=240;this.offsetHeight=60;}
 replaceChildren(...nodes){this.children=nodes;}
 appendChild(node){this.children.push(node);return node;}
 setAttribute(key,value){this.attrs[key]=String(value);}
 addEventListener(key,fn){this.events[key]=fn;}
 getBoundingClientRect(){return {left:0,top:0,width:320,height:280};}
 focus(){this.events.focus?.({currentTarget:this});}
 contains(node){return node===this||this.children.some(c=>c?.contains?.(node));}
}
const E=(...args)=>new Element(...args),document={createElementNS:(_,tag)=>E(tag)};
const source=fs.readFileSync('luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/device-timeline.js','utf8');
const queued=[],rpc={declare:spec=>{assert.equal(spec.method,'getDeviceTimeline');assert.deepEqual(spec.params,['mac','date']);return (...args)=>new Promise((resolve,reject)=>queued.push({args,resolve,reject}));}};
let mounts=0;
const component=new Function('baseclass','view','rpc','E','_','document',source)({extend:p=>p},{extend:()=>{mounts++;}},rpc,E,s=>s,document);
const findAll=(n,p)=>n&&typeof n==='object'? [...(p(n)?[n]:[]),...n.children.flatMap(c=>findAll(c,p))]:[];
const slots=v=>findAll(v.body,n=>n.tag==='g');
const start=1791302400;
const response=(label='01:00–02:00',extra={})=>({json:JSON.stringify({start,end:start+86400,now:start+13*3600+20,available_from:start,step:3600,
 samples:[{time:start+3600,label,download:9.8*1024**3,upload:.2*1024**3,utc_offset:'+0800'}],...extra})});
const text=(v,cls)=>findAll(v.body,n=>n.attrs.class===cls)[0];
(async()=>{
 assert.equal(mounts,0);
 const view=Object.create(component);view.render({device_timeline:true,timeline_today:'2026-10-07',since:start+13*3600});
 assert.equal(queued.length,0,'No all-device RPC');assert.equal(view.back,undefined);
 const first=view.select('aa:bb:cc:dd:ee:01'),second=view.select('aa:bb:cc:dd:ee:02');
 assert.deepEqual(queued[1].args,['aa:bb:cc:dd:ee:02','2026-10-07']);
 queued[1].resolve(response());await second;
 queued[0].resolve(response('wrong stale device'));await first;
 assert.equal(slots(view).length,24,'Zero and future hours keep their positions');
 assert.ok(slots(view)[1].attrs['aria-label'].includes('01:00–02:00'));
 assert.ok(!slots(view).some(n=>n.attrs['aria-label'].includes('wrong stale')));
 assert.ok(findAll(view.summary,n=>n.children.includes('10.0 GB')).length);
 const before=queued.length;slots(view)[1].events.click({currentTarget:slots(view)[1]});
 assert.match(text(view,'zen-timeline-readout').textContent,/Total 10.0 GB.*Download 9.80 GB.*Upload 205 MB/);
 assert.equal(queued.length,before,'Selecting a bar does not drill down or call RPC');
 const bars=slots(view)[1].children;
 assert.equal(Number(bars[2].attrs.y)+Number(bars[2].attrs.height),Number(bars[1].attrs.y),'Upload stacks above download');
 assert.ok(Math.abs(Number(bars[1].attrs.height)/Number(bars[2].attrs.height)-49)<1e-9,'Shared byte scale');
 assert.equal(Number(slots(view)[0].children[1].attrs.height),0,'No fabricated traffic for empty hours');
 slots(view)[0].events.focus({currentTarget:slots(view)[0]});assert.match(text(view,'zen-timeline-readout').textContent,/No time records/);
 slots(view)[13].events.focus({currentTarget:slots(view)[13]});assert.match(text(view,'zen-timeline-readout').textContent,/Collecting/);
 slots(view)[14].events.click({currentTarget:slots(view)[14]});assert.match(text(view,'zen-timeline-readout').textContent,/Not started/);
 assert.ok(!text(view,'zen-timeline-readout').textContent.includes('Total 0'),'Future is not displayed as measured zero');
 slots(view)[1].events.keydown({key:'End',preventDefault(){}});assert.equal(slots(view)[23].attrs['aria-pressed'],'true');
 slots(view)[23].events.keydown({key:'Escape'});assert.equal(text(view,'zen-history-tip zen-timeline-tip').hidden,true);
 for(const count of [23,25]) {
  view.draw(JSON.parse(response('01:00–02:00',{end:start+count*3600}).json));assert.equal(slots(view).length,count);
 }
 view.draw(JSON.parse(response('',{samples:Array.from({length:24},(_,i)=>({time:start+i*3600,download:0,upload:0,recorded:false}))}).json));
 assert.equal(slots(view).length,24);
 assert.ok(slots(view).every(n=>Number(n.children[1].attrs.height)===0&&Number(n.children[2].attrs.height)===0));
 assert.equal(findAll(view.summary,n=>n.children.includes('0 B')).length,3,'All-zero day has a stable zero summary');
 view.draw(JSON.parse(response('01:00–02:00',{available_from:start+3600+20}).json));
 slots(view)[0].events.click({currentTarget:slots(view)[0]});assert.match(text(view,'zen-timeline-readout').textContent,/Not recorded/);
 slots(view)[1].events.click({currentTarget:slots(view)[1]});assert.match(text(view,'zen-timeline-readout').textContent,/Partially recorded/);
 const dst=JSON.parse(response().json);dst.end=start+25*3600;dst.samples=[
  {time:start+3600,label:'01:00–01:00',utc_offset:'-0400',download:100,upload:0},
  {time:start+7200,label:'01:00–02:00',utc_offset:'-0500',download:200,upload:0}];
 view.draw(dst);assert.match(slots(view)[1].attrs['aria-label'],/UTC-0400/);assert.match(slots(view)[2].attrs['aria-label'],/UTC-0500/);
 view.date.value='2026-09-01';let pending=view.query();queued.at(-1).resolve(response('',{samples:[],expired:true}));await pending;
 assert.match(view.notice.textContent,/no longer available/);assert.equal(view.body.children.length,0);
 pending=view.query();queued.at(-1).reject(Error('offline'));await pending;assert.match(view.notice.textContent,/Unable to load/);
 for(const data of [{json:'{}'},response('',{step:300}),response('',{samples:[{time:start,download:-1,upload:0}]})]) {
  pending=view.query();queued.at(-1).resolve(data);await pending;assert.match(view.notice.textContent,/Unable to load/);
 }
 const dated=view.query();view.date.value='2026-09-02';const newer=view.date.attrs.change();
 queued.at(-1).resolve(response('new date'));await newer;queued.at(-2).resolve(response('stale date'));await dated;
 assert.ok(slots(view).some(n=>n.attrs['aria-label'].includes('new date')));
 const obsolete=Object.create(component),calls=queued.length;obsolete.render({});await obsolete.select('aa:bb:cc:dd:ee:02');
 assert.equal(queued.length,calls);assert.equal(obsolete.date.disabled,true);assert.match(obsolete.notice.textContent,/Update/);
 await view.select('');assert.equal(queued.length,calls);assert.equal(view.body.children.length,0);
 console.log('PASS: hourly device routing, races, stacked byte scale, full-day slots, keyboard/touch, expiry and errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
