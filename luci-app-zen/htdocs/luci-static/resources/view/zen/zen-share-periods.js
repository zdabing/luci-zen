'use strict';
'require baseclass';
'require rpc';

const history = rpc.declare({object:'zen.traffic',method:'getInternetHistory',params:['agg','mac','devices'],reject:true});
const clock = rpc.declare({object:'zen.traffic',method:'getNotifications',reject:true});
const decode = response => {
 const value = JSON.parse(response.json);
 if (!Array.isArray(value.days) || !Number(value.since)) throw new Error('Internet history unavailable');
 return value;
};
function parseDeviceDays(rows, since) {
 const days = Array.isArray(rows) ? rows.map(row => Array.isArray(row)
  ? { date: String(row[0] || ''), download: Number(row[1]) || 0, upload: Number(row[2]) || 0 }
  : { date: String(row?.date || ''), download: Number(row?.download) || 0, upload: Number(row?.upload) || 0 }) : [];
 return { days, since };
}
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
let cached, ledger, pending, refreshed = 0;
return baseclass.extend({
 startDate, aggregate,
 async records(usage) { await this.load(usage); return ledger; },
 async load(usage) {
  if (pending) return pending;
  if (cached && Date.now()-refreshed < 60000) return cached;
  pending = (async()=>{
   const raw = await history('day','',true);
   const network = decode(raw);
   const today = typeof network.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(network.today)
    ? network.today : JSON.parse((await clock()).json).today;
   startDate(today,'day');
   const names = new Map(usage.dev.map(d=>[d.mac,d.host]));
   const macs = [...new Set([...(network.ranking||[]).map(d=>d.mac),...names.keys()])];
   const embedded = network.device_days && typeof network.device_days === 'object' && !Array.isArray(network.device_days)
    ? new Map(Object.entries(network.device_days).map(([mac, rows]) => [mac, parseDeviceDays(rows, network.since)]))
    : null;
   const deviceMap = embedded || new Map();
   const fetchMacs = embedded
    ? (network.devices_complete === true ? [] : macs.filter(mac => !deviceMap.has(mac)))
    : macs;
   if (fetchMacs.length) {
    let index = 0;
    // Bound concurrency; both charts share one snapshot, refreshed once a minute.
    await Promise.all(Array.from({length:Math.min(4,fetchMacs.length)},async()=>{
     while(index < fetchMacs.length) {const mac=fetchMacs[index++]; deviceMap.set(mac,decode(await history('day',mac)));}
    }));
   }
   const devices = macs.map(mac => [mac, deviceMap.get(mac) || { days: [], since: network.since }]);
   const result = Object.fromEntries(['day','week','month'].map(period=>[period,aggregate(network,devices,today,period,names)]));
   ledger={network,devices,today,names};
   cached=result;refreshed=Date.now();return result;
  })();
  try { return await pending; } finally { pending=null; }
 }
});
