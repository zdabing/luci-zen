'use strict';
'require baseclass';
'require rpc';

const history = rpc.declare({object:'zen.traffic',method:'getInternetHistory',params:['agg','mac'],reject:true});
const clock = rpc.declare({object:'zen.traffic',method:'getNotifications',reject:true});
const decode = response => {
 const value = JSON.parse(response.json);
 if (!Array.isArray(value.days) || !Number(value.since)) throw new Error('Internet history unavailable');
 return value;
};
function startDate(today, period) {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('Router date unavailable');
 if (period === 'month') return today.slice(0,7)+'-01';
 if (period === 'week') {
  const date = new Date(today+'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay()+6)%7);
  return date.toISOString().slice(0,10);
 }
 return today;
}
function sum(days, start, end) {
 return days.filter(row=>row.date >= start && row.date <= end).reduce((total,row)=>{
  total.download += Math.max(0,Number(row.download)||0); total.upload += Math.max(0,Number(row.upload)||0);return total;
 },{download:0,upload:0});
}
function aggregate(network, devices, today, period, names) {
 const start = startDate(today,period), total = sum(network.days,start,today);
 return {since:network.since,interface_download:total.download,interface_upload:total.upload,
  dev:devices.map(([mac,data])=>({mac,host:names.get(mac),...sum(data.days,start,today)}))};
}
let cached, pending, refreshed = 0;
return baseclass.extend({
 startDate, aggregate,
 async load(usage) {
  if (pending) return pending;
  if (cached && Date.now()-refreshed < 60000) return cached;
  pending = (async()=>{
   const [raw, time] = await Promise.all([history('day',''),clock()]);
   const network = decode(raw), today = JSON.parse(time.json).today;
   startDate(today,'day');
   const names = new Map(usage.dev.map(d=>[d.mac,d.host]));
   const macs = [...new Set([...(network.ranking||[]).map(d=>d.mac),...names.keys()])];
   const devices = []; let index = 0;
   // Bound concurrency; both charts share one snapshot, refreshed once a minute.
   await Promise.all(Array.from({length:Math.min(4,macs.length)},async()=>{
    while(index < macs.length) {const mac=macs[index++]; devices.push([mac,decode(await history('day',mac))]);}
   }));
   const result = Object.fromEntries(['day','week','month'].map(period=>[period,aggregate(network,devices,today,period,names)]));
   cached=result;refreshed=Date.now();return result;
  })();
  try { return await pending; } finally { pending=null; }
 }
});
