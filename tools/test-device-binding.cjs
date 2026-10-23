// Execute the actual ucode planner, adapting only core helpers and value iteration.
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('luci-theme-zen/root/usr/share/zen/device-binding-model.uc','utf8').replace(/for \(let (\w+) in ([^)]+)\)/g,'for (let $1 of $2)');
const helpers={type:value=>typeof value==='boolean'?'bool':Number.isInteger(value)?'int':typeof value,
 match:(value,regex)=>value.match(regex),lc:value=>value.toLowerCase(),substr:(...args)=>args[0].substr(...args.slice(1)),
 split:(value,separator)=>value.split(separator),int:value=>Math.trunc(Number(value)),length:value=>value.length,
 filter:(values,fn)=>values.filter(fn),index:(values,value)=>values.indexOf(value)};
const model=new Function(...Object.keys(helpers),source)(...Object.values(helpers));
const mac='02:00:00:00:00:01',other='02:00:00:00:00:02';
const lans=[{address:'192.168.1.1',mask:24}],request={mac,ip:'192.168.1.108',enabled:true};
assert.deepEqual(model.plan(request,[],lans,[]),{mac,ip:request.ip,section:undefined,remove:false});
for(const ip of ['192.168.1.0','192.168.1.255','192.168.2.3','0.0.0.0'])assert.equal(model.plan({...request,ip},[],lans,[]).error,'outside_lan');
assert.equal(model.plan({...request,ip:'192.168.1.1'},[],lans,[]).error,'router_ip');
for(const ip of ['1.2.3.999','01.2.3.4','192.168.1.2;reboot','1.2.3'])assert.equal(model.plan({...request,ip},[],lans,[]).error,'invalid_ip');
for(const value of ['ff:ff:ff:ff:ff:ff','00:00:00:00:00:00','01:00:00:00:00:01','02:00:00:00:00:01;reboot'])assert.equal(model.plan({...request,mac:value},[],lans,[]).error,'invalid_request');
const own={section:'own',macs:[mac],ip:request.ip},conflict={section:'other',macs:[other],ip:request.ip};
assert.equal(model.plan(request,[conflict],lans,[]).error,'ip_conflict');
assert.equal(model.plan(request,[],lans,[{mac:other,ip:request.ip}]).error,'ip_conflict');
assert.equal(model.plan(request,[own],lans,[{mac,ip:request.ip}]).section,'own');
assert.equal(model.plan(request,[own,{...own,section:'duplicate'}],lans,[]).error,'ambiguous_binding');
const shared={...own,macs:[mac,other]};
assert.equal(model.plan(request,[shared],lans,[]).error,'shared_binding');
assert.deepEqual(model.plan({mac,enabled:false},[shared],lans,[]),{mac,remove:true,section:'own',remaining:[other]});
assert.deepEqual(model.plan({mac,enabled:false},[own],[],[]),{mac,remove:true,section:'own',remaining:[]});
assert.deepEqual(model.plan({mac,enabled:false},[],[],[]),{mac,remove:true,section:undefined,remaining:[]});
assert.equal(model.plan({...request,mac:mac.toUpperCase()},[],lans,[]).mac,mac);
const cases={request,lans,mac,other};
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(cases));
console.log('PASS: actual DHCP planner: LAN boundaries, router/broadcast IPs, malformed input, occupied IPs, duplicate/shared reservations, reversible unbinding');
