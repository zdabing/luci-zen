// The same policy source runs in ucode in CI and in Node with equivalent core functions.
const fs=require('node:fs'),assert=require('node:assert/strict');
const policySource=fs.readFileSync('luci-theme-zen/root/usr/share/zen/update-model.uc','utf8');
const load=()=>new Function('type','length','index','match','int','split','replace','push','json','substr','trim','die',
 policySource.replace(/for \((?:const|let) (\w+) in /g,'for (const $1 of '))(
 v=>Number.isInteger(v)?'int':Array.isArray(v)?'array':v===null?'null':typeof v,v=>v?.length,
 (a,b)=>a.indexOf(b),(s,re)=>String(s).match(re),v=>parseInt(v,10),(s,sep)=>s.split(sep),
 (s,a,b)=>s.replace(a,b),(a,v)=>a.push(v),JSON.parse,(s,i,n)=>s.substr(i,n),s=>s.trim(),msg=>{throw Error(msg);});
const policy=load(),board={release:{target:'rockchip/armv8',version:'25.12-SNAPSHOT'}};
const file={name:'zen-traffic',version:'0.2.3-r1',filename:'zen-traffic-0.2.3-r1-rockchip-armv8.apk',size:100,sha256:'a'.repeat(64)};
const root={schema:1,repo:'zdabing/luci-zen',tag:'v0.2.3',target:'rockchip/armv8',sdk_version:'25.12.5',packages:[file]};
const release=meta=>({tag_name:'v0.2.3',draft:false,prerelease:false,body:'<!-- zen-update-metadata\n'+JSON.stringify(meta)+'\n-->',assets:[meta,...(meta.builds||[])].flatMap(m=>m.packages.map(f=>({name:f.filename,size:f.size,state:'uploaded',digest:'sha256:'+f.sha256})))});
const good={release:release(root),request:{package:'zen-traffic',tag:'v0.2.3'},board,current:'0.2.2-r1',expected:file.filename};
const cases=[good];
const bad=(changes,error)=>cases.push({...structuredClone(good),...changes,error});
bad({request:{package:'unrelated',tag:'v0.2.3'}},'invalid_release');
bad({request:{package:'zen-traffic',tag:'x;reboot'}},'invalid_release');
bad({release:{...release(root),prerelease:true}},'invalid_release');
bad({current:'0.2.3-r1'},'not_newer');bad({current:'0.3.0-r1'},'not_newer');bad({current:null},'invalid_release');
bad({board:{release:{target:'x86/64',version:'25.12.5'}}},'incompatible');
bad({board:{release:{target:'rockchip/armv8',version:'24.10.5'}}},'incompatible');
bad({release:release({...root,repo:'other/repo'})},'invalid_metadata');
bad({release:release({...root,packages:[{...file,filename:'../../upload.apk'}]})},'invalid_filename');
bad({release:release({...root,packages:[{...file,size:33554433}]})},'invalid_metadata');
bad({release:{...release(root),assets:[]}},'invalid_asset');
bad({release:{...release(root),assets:[{name:file.filename,size:file.size,state:'uploaded',digest:'sha256:'+'b'.repeat(64)}]}},'invalid_asset');
const multi={...root,target:'x86/64',packages:[{...file,filename:file.filename.replace('rockchip-armv8','x86-64')}],builds:[root]};
cases.push({...good,release:release(multi)});
const theme={...root,packages:[{...file,name:'luci-theme-zen',filename:'luci-theme-zen-0.2.3-r1-rockchip-armv8.apk'}]};
cases.push({...good,release:release(theme),request:{package:'luci-theme-zen',tag:'v0.2.3'},board:{},expected:theme.packages[0].filename});
for(const test of cases) {
 if(test.error)assert.throws(()=>policy.candidate(test.release,test.request,test.board,test.current),new RegExp(test.error));
 else assert.equal(policy.candidate(test.release,test.request,test.board,test.current).filename,test.expected);
}
assert.deepEqual(policy.installed('P:luci-theme-zen\nV:0.2.2-r1\n\nP:unrelated\nV:1.0.0'),{'luci-theme-zen':'0.2.2-r1'});
assert.equal(policy.compare('0.2.2-r1','0.2.2-r2'),-1);
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(cases));
console.log('PASS: updater policy validates repository, release, installed version, platform, path, asset hash/size and package allowlist');
