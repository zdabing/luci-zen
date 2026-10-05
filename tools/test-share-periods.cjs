const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-share-periods.js','utf8');
let calls=0;
const rows=[{date:'2026-09-30',download:100,upload:50},{date:'2026-10-04',download:200,upload:80},{date:'2026-10-05',download:300,upload:90}];
const rpc={declare:spec=>async()=>{
 calls++;
 return spec.method==='getNotifications'?{json:JSON.stringify({today:'2026-10-05'})}:
  {json:JSON.stringify({days:rows,since:1791126802,ranking:[{mac:'a'}]})};
}};
const mod=new Function('baseclass','rpc',source)({extend:x=>x},rpc);
assert.equal(mod.startDate('2026-10-05','week'),'2026-10-05');
assert.equal(mod.startDate('2026-10-04','week'),'2026-09-28','Sunday belongs to the preceding Monday');
assert.equal(mod.startDate('2026-01-01','week'),'2025-12-29','Week can cross a year');
const network={days:rows,since:1},devices=[['a',{days:rows}]],names=new Map([['a','Phone']]);
assert.equal(mod.aggregate(network,devices,'2026-10-05','day',names).interface_download,300);
assert.equal(mod.aggregate(network,devices,'2026-10-05','month',names).dev[0].upload,170);
assert.equal(mod.aggregate(network,devices,'2026-10-04','week',names).interface_download,300);
(async()=>{
 const usage={dev:[{mac:'a',host:'Phone'}]};
 const [first,second]=await Promise.all([mod.load(usage),mod.load(usage)]);
 assert.equal(first,second,'Upload and download share one request batch');
 await mod.load(usage);assert.equal(calls,3,'Cache calendar histories instead of requesting all devices each poll');
 assert.equal(first.day.dev[0].host,'Phone');
 console.log('PASS: calendar day/week/month boundaries, internet-only sums and shared cached requests');
})().catch(e=>{console.error(e);process.exitCode=1});
