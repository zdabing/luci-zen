const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/realtime.js'),'utf8');
let pending,fail=false;const requests=[];
const rpc={declare:s=>(...args)=>{requests.push(s);
 if(s.method==='getDevices'){if(fail)return Promise.reject(new Error('offline'));return new Promise(resolve=>{pending=resolve;});}
 return Promise.resolve(s.method==='getTotal'?{rx_r:100,tx_r:20}:{samples:[],step:5});
}};
const document={hidden:false};const monitor=new Function('view','rpc','_','document',source)({extend:x=>x},rpc,s=>s,document);
let updates=[];monitor.statusText={};monitor.lastLive=0;monitor.live={drawChart(){updates.push('chart');}};
monitor.renderRows=rows=>{monitor.onlineCount=rows.filter(d=>d.online).length;updates.push('devices');};
monitor.renderSummary=total=>{assert.equal(monitor.onlineCount,2);updates.push('summary');};
(async()=>{
 const active=monitor.tick();await monitor.tick();assert.equal(requests.length,3,'A pending refresh must not start more RPC calls');
 pending({dev:[{online:true},{online:true},{online:false}]});await active;
 assert.deepEqual(updates,['devices','summary','chart'],'Online count must be ready before rendering summary');
 assert.equal(monitor.statusText.textContent,'');assert.equal(monitor.refreshing,false);
 fail=true;await monitor.tick();assert.match(monitor.statusText.textContent,/last result/);
 assert.equal(monitor.onlineCount,2,'Failure must preserve the last successful device snapshot');
 const before=requests.length;document.hidden=true;await monitor.tick();assert.equal(requests.length,before);
 assert.ok(requests.every(s=>s.reject),'All polling methods must reject ubus error codes');
 console.log('PASS: monitoring snapshot order, no overlapping requests, hidden tab and stale-result error state');
})().catch(e=>{console.error(e);process.exit(1);});
