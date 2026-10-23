const fs = require('node:fs'), assert = require('node:assert/strict');
const source = fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-health.js','utf8');
const load = backend => new Function('baseclass','fs',source)({extend:x=>x},backend);
const health = load({});
assert.deepEqual(health.prefixes({getIP6Prefixes:()=>['2001:db8::/56','2001:db8:100::/56']}),['2001:db8::/56','2001:db8:100::/56']);
assert.deepEqual(health.prefixes({getIP6Prefix:()=> '2001:db8::/56'}),['2001:db8::/56']);
assert.deepEqual(health.prefixes({getIP6Addrs:()=>['2001:db8::1/64']}),[],'Never invent a delegated prefix from an interface address');
const lan = {getName:()=> 'lan',getIPAddrs:()=>['192.168.8.1/24']};
const config = {values:{lan:{'.type':'dhcp',interface:'lan',start:'100',limit:'100'}}};
const leases = {dhcp_leases:[{ipaddr:'192.168.8.108',expires:10},{ipaddr:'192.168.8.108',expires:10},
 {ipaddr:'192.168.8.109',expires:false},{ipaddr:'192.168.8.110',expires:-1},{ipaddr:'192.168.8.111',expires:0},{ipaddr:'192.168.10.108',expires:10},{ipaddr:'192.168.8.20',expires:10}]};
assert.deepEqual(health.dhcpUsage(config,leases,lan),{state:'ok',used:2,total:100},'Exclude expired, guest-network and out-of-pool leases, and deduplicate IPs');
assert.deepEqual(health.dhcpUsage(config,{dhcp_leases:[]},lan),{state:'ok',used:0,total:100});
assert.deepEqual(health.dhcpUsage(null,leases,lan),{state:'unavailable'});
assert.deepEqual(health.dhcpUsage({values:{lan:{...config.values.lan,ignore:'1'}}},leases,lan),{state:'disabled'});
assert.deepEqual(health.dhcpUsage({values:{lan:{...config.values.lan,dynamicdhcp:'0'}}},leases,lan),{state:'static'});
assert.deepEqual(health.dhcpUsage({values:{lan:{...config.values.lan,start:'250'}}},leases,lan),{state:'ok',used:0,total:5},'Capacity cannot extend beyond the subnet broadcast address');
assert.deepEqual(health.dhcpUsage({values:{...config.values,second:{...config.values.lan,start:'150'}}},leases,lan),{state:'ok',used:2,total:150},'Overlapping pools share a union denominator');
assert.deepEqual(health.pingResult({code:0,stdout:'64 bytes from 1.1.1.1: seq=0 ttl=57 time=14.8 ms'}),{state:'ok',ms:14.8,lessThan:false,target:'1.1.1.1'});
assert.equal(health.pingResult({code:0,stdout:'time<1 ms'}).lessThan,true);
assert.equal(health.pingResult({code:1,stdout:'100% packet loss'}).state,'timeout');
assert.equal(health.pingResult({code:127}).state,'unavailable');
assert.equal(health.pingResult(null).state,'unavailable');
(async()=>{
 let probes=0, unavailable=false;
 const backend={
  read:async path=>{if(unavailable)throw Error('unavailable');return {'/proc/sys/net/netfilter/nf_conntrack_count':'0','/proc/sys/net/netfilter/nf_conntrack_max':'16384','/sys/class/thermal/thermal_zone0/temp':'51000','/sys/class/thermal/thermal_zone0/type':'soc-thermal'}[path]??null;},
  list:async()=>unavailable?[]:[{name:'thermal_zone0'},{name:'../../etc'}],
  exec:async(cmd,args)=>{probes++;assert.equal(cmd,'/bin/ping');assert.deepEqual(args,['-n','-c','1','-W','1','1.1.1.1']);return{code:0,stdout:'time=15 ms'};}
 };
 const reader=load(backend);const first=await reader.read(true);
 assert.equal(first.connections,0);assert.equal(first.temperature.celsius,51);assert.equal(first.latency.ms,15);
 await reader.read(true);assert.equal(probes,1,'Do not ping every 5-second dashboard refresh');
 unavailable=true;reader.lastSlow=Date.now()-31000;const missing=await reader.read(false);
 assert.equal(missing.connections,null);assert.equal(missing.temperature,null);assert.equal(missing.latency.state,'offline');
 await reader.read(true);assert.equal(probes,2,'Probe promptly after reconnecting');
 const hwmon=load({
  list:async path=>path==='/sys/class/thermal'?[]:path==='/sys/class/hwmon'?[{name:'hwmon0'}]:[{name:'temp1_input'},{name:'device'}],
  read:async path=>path.endsWith('/name')?'coretemp':path.endsWith('_label')?'Package id 0':path.endsWith('_input')?'48000':null
 });
 assert.equal((await hwmon.temperature()).celsius,48,'Support x86 hwmon sensors when thermal zones are absent');
 const unsupported=load({});assert.equal((await unsupported.read(true)).temperature,null);
 const acl=JSON.parse(fs.readFileSync('luci-theme-zen/root/usr/share/rpcd/acl.d/luci-theme-zen.json','utf8'))['luci-theme-zen'].read;
 assert.ok(acl.uci.includes('dhcp'));assert.deepEqual(acl.file['/bin/ping -n -c 1 -W 1 1.1.1.1'],['exec']);
 assert.equal(acl.file['/bin/ping *'],undefined,'The UI must not grant arbitrary ping targets or commands');
 console.log('PASS: real telemetry parsing, thermal/hwmon fallback, missing vs zero, prefix semantics, LAN DHCP pool accounting and cached fixed-target ICMP');
})().catch(error=>{console.error(error);process.exitCode=1;});
