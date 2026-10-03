// Preset queries must follow router time and propagate nonzero ubus results.
const fs = require('node:fs'),path = require('node:path'),assert = require('node:assert/strict');
const source = fs.readFileSync(process.argv[2] || path.join(__dirname,
  '../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/rate-history.js'), 'utf8');
const requests = [], serverNow = 1790998101;
let fail = false, delayStatus;
const realNow = Date.now;
Date.now = () => (serverNow + 1) * 1000;
String.prototype.format = function(...args) {return this.replace(/%[ds]/g,()=>String(args.shift()));};
const rpc = {declare: spec => (...args) => {
  const payload = Object.fromEntries((spec.params || []).map((key,i)=>[key,args[i]]));
  requests.push({method:spec.method,payload,reject:spec.reject});
  if(spec.method==='getStatus') return delayStatus || Promise.resolve({since:serverNow});
  if(fail || payload.end>serverNow) return spec.reject ? Promise.reject(new Error('ubus code 2')) : Promise.resolve(2);
  return Promise.resolve({interface:'pppoe-wan',interfaces:['pppoe-wan'],start:serverNow-300,end:serverNow,step:5,samples:[{time:serverNow-5,download:1234,upload:456}]});
}};
const view = new Function('view','rpc','trafficStyle','_',source)({extend:x=>x},rpc,{},x=>x);
view.range={value:'300'};view.iface={value:'pppoe-wan'};
view.start={value:''};view.end={value:''};view.button={};view.error={};view.requestId=0;
view.startField={};view.endField={};
view.showData=data=>{view.data=data;};
(async()=>{
  const initial=await view.load();
  assert.ok(initial.data && Array.isArray(initial.data.samples),'Initial load must return history data, not a ubus error code');
  assert.equal(initial.data.samples.length,1,'Initial load must not ask for a future browser timestamp');
  assert.deepEqual(requests[0].payload,{});
  await view.query();
  assert.deepEqual(requests.at(-1).payload,{iface:'pppoe-wan',start:serverNow-300,end:serverNow,limit:600});
  assert.equal(view.data.samples.length,1);
  for(const seconds of [3600,86400,604800]) {
    view.range.value=String(seconds);await view.query();
    assert.equal(requests.at(-1).payload.start,serverNow-seconds);
    assert.equal(requests.at(-1).payload.end,serverNow);
  }
  view.range.value='custom';view.start.value=view.end.value;await view.query();
  assert.equal(requests.at(-1).payload.start,serverNow,'Custom timestamps must be preserved');
  const beforeInvalid=requests.length;view.end.value='';await view.query();
  assert.equal(requests.length,beforeInvalid,'Invalid custom input must not query');
  assert.equal(view.error.textContent,'Choose a valid time range within the last 7 days.');
  view.range.value='300';
  fail=true;
  assert.deepEqual(await view.load(),{error:true},'Backend errors must not become empty successful data');
  await view.query();
  assert.equal(view.error.textContent,'Unable to query realtime history.');
  assert.equal(view.button.disabled,false);
  let release;
  delayStatus=new Promise(resolve=>{release=resolve;});
  const old=view.query(),count=requests.length;view.requestId++;
  release({since:serverNow});await old;
  assert.equal(requests.length,count,'An obsolete status request must not issue a history query');
  console.log('PASS: realtime presets use router clock, initial defaults and RPC failure handling');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{Date.now=realNow;});
