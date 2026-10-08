const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..'), base = path.join(root, 'luci-theme-zen/htdocs/luci-static/resources/view/zen');
const model = new Function('baseclass', fs.readFileSync(path.join(base, 'zen-update-model.js'), 'utf8'))({extend: v => v});
const board = {board_name: 'friendlyarm,nanopi-r5c', release: {target: 'rockchip/armv8', version: '25.12.5'}};
assert.deepEqual({...model.installed('[{"name":"zen-traffic","version":"0.2.0-r10"}]')}, {'zen-traffic':'0.2.0-r10'});
assert.deepEqual({...model.installed('P:luci-theme-zen\nV:0.2.0-r10\n\nP:zen-traffic\nV:0.2.0-r9\n')}, {'luci-theme-zen':'0.2.0-r10','zen-traffic':'0.2.0-r9'});
assert.deepEqual({...model.installed('Package: zen-traffic\nVersion: 0.2.0-10\nStatus: install ok installed\n\nPackage: luci-theme-zen\nVersion: 0.2.0-10\nStatus: deinstall ok config-files')}, {'zen-traffic':'0.2.0-10'});
assert.throws(()=>model.installed('cpu 1 2 3')); assert.throws(()=>model.installed('{}'));
assert.equal(model.compare('0.2.0-r9','0.2.0-r10'),-1); assert.equal(model.compare('0.2.0-10','0.2.0-r10'),0);
assert.equal(model.compare('0.3.0-r1','0.2.0-r10'),1); assert.equal(model.compare('snapshot','0.2.0-r10'),null);
function release(meta, date='2026-10-04T00:00:00Z') {
 return {tag_name:meta.tag,body:'<!-- zen-update-metadata\n'+JSON.stringify(meta)+'\n-->',published_at:date,assets:[meta,...(meta.builds||[])].flatMap(build=>(build.packages||[]).map(f=>({name:f.filename,size:f.size,state:'uploaded'})))};
}
const zen = {schema:1,repo:model.REPO,tag:'v0.2.0',target:'rockchip/armv8',sdk_version:'25.12.5',packages:model.PACKAGES.map(name=>({name,version:'0.2.0-r10',filename:name+'-0.2.0-r10.apk',size:123,sha256:'a'.repeat(64)}))};
assert.equal(model.select([release(zen)],board,'zen-traffic').state,'matched');
assert.equal(model.select([release(zen)],{release:{target:'x86/64',version:'25.12.5'}},'zen-traffic').state,'incompatible');
assert.equal(model.select([release(zen)],{...board,release:{...board.release,version:'25.12-SNAPSHOT'}},'zen-traffic').state,'matched');
assert.equal(model.select([{...release(zen),prerelease:true}],board,'zen-traffic').state,'empty');
assert.equal(model.select([{tag_name:'v0.3.0',published_at:'2026-10-05'},release(zen)],board,'zen-traffic').state,'metadata','Newer metadata-less release cannot report older release as latest');
for (const name of ['luci-theme-zen','luci-app-zen-traffic']) {
 assert.equal(model.select([release(zen)],{release:{target:'x86/64',version:'custom-firmware'}},name).state,'matched','All-architecture frontend is not gated by firmware target/version');
 assert.equal(model.select([release(zen)],{},name).state,'matched');
}
const newer = {...zen,tag:'v0.3.0',target:'x86/64'};
const available = [release(newer,'2026-10-05'),release(zen)];
assert.equal(model.select(available,board,'luci-theme-zen').meta.tag,'v0.3.0');
assert.equal(model.select(available,board,'zen-traffic').meta.tag,'v0.2.0','Each component chooses its compatible release independently');
assert.throws(()=>model.select(available,board,'unrelated-package'));
assert.equal(model.metadata({...release(zen),assets:[]}),null);
assert.equal(model.metadata(release({...zen,packages:[{...zen.packages[0],filename:'../../unsafe.apk'},...zen.packages.slice(1)]})),null);
assert.equal(model.metadata(release({...zen,repo:'zdabing/10Wrt'})),null,'Other repositories cannot supply Zen package updates');
assert.equal(model.metadata({...release(zen),body:release(zen).body.replace('zen-update-metadata','10wrt-update-metadata')}),null,'Firmware metadata is not supported');
const themeOnly = {...zen,tag:'theme-v0.2.0-r11',packages:[{...zen.packages[0],version:'0.2.0-r11'}]};
assert.ok(model.metadata(release(themeOnly)),'A package can be published independently');
assert.equal(model.select([release(themeOnly),release(zen,'2026-10-03')],board,'luci-theme-zen').meta.tag,themeOnly.tag);
assert.equal(model.select([release(themeOnly),release(zen,'2026-10-03')],board,'zen-traffic').meta.tag,zen.tag,'A theme release must not hide the backend release');
assert.equal(model.select([release(themeOnly)],board,'luci-app-zen-traffic').state,'incompatible');
assert.equal(model.metadata(release({...zen,packages:[zen.packages[0],{...zen.packages[0],filename:'duplicate.apk'}]})),null,'Duplicate package names are invalid');
assert.equal(model.metadata(release({...zen,packages:[]})),null);
const acl=JSON.parse(fs.readFileSync(path.join(root,'luci-theme-zen/root/usr/share/rpcd/acl.d/luci-theme-zen.json'),'utf8'))['luci-theme-zen'];
assert.deepEqual(acl.write,{ubus:{uci:['set','commit']},uci:['zen']}, 'Only appearance configuration may be written; package upgrades remain outside this ACL'); assert.deepEqual(Object.keys(acl.read.file).filter(k=>acl.read.file[k].includes('exec')),['/usr/libexec/package-manager-call list-installed']);
assert.equal(acl.read.file['/usr/share/10wrt/release.json'],undefined);
assert.ok(!acl.read.ubus.luci.includes('getVersion'));
const snapshot = {release:{distribution:'ImmortalWrt',target:'rockchip/armv8',version:'25.12-SNAPSHOT'}};
const legacy = {tag_name:'v0.1.0',published_at:'2026-10-01'};
assert.equal(model.select([release(zen),legacy],snapshot,'zen-traffic').state,'matched','A numbered snapshot matches the same major without republishing metadata');
assert.equal(model.select([release(zen),legacy],{release:{...snapshot.release,version:'24.10.5'}},'zen-traffic').state,'incompatible','An old legacy release cannot hide a newer build\'s major mismatch');
assert.equal(model.select([release(zen),legacy],snapshot,'luci-app-zen-traffic').state,'matched');

const supported = {...zen, compatible_systems:[
 {distribution:'OpenWrt',version:'25.12.5',target:zen.target},
 {distribution:'ImmortalWrt',version:'25.12-SNAPSHOT',target:zen.target}
]};
assert.equal(model.select([release(supported)],snapshot,'zen-traffic').state,'matched');
assert.equal(model.select([release(supported)],{release:{...snapshot.release,distribution:'Custom OpenWrt'}},'zen-traffic').state,'matched','Distribution labels do not divide the OpenWrt major');
assert.equal(model.select([release(supported)],{release:{...snapshot.release,target:'x86/64'}},'zen-traffic').state,'incompatible');
const exactList = {...zen,compatible_systems:[supported.compatible_systems[0]]};
for (const meta of [zen,exactList,supported]) {
 for (const distribution of ['OpenWrt','ImmortalWrt',undefined]) {
  for (const version of ['25','25.12','25.12.0','25.12.6','25.12-SNAPSHOT','25.01.2','25.12.0-rc1','25.12.5-custom']) {
   assert.equal(model.select([release(meta)],{release:{distribution,target:zen.target,version}},'zen-traffic').state,'matched',`${distribution} ${version} shares major 25 even with old exact metadata`);
  }
 }
 for (const version of ['24.10.5','24.10-SNAPSHOT','26.01.0','SNAPSHOT','custom-firmware','25custom','25.12garbage','125.12.5',null,undefined,25]) {
  assert.equal(model.select([release(meta)],{release:{target:zen.target,version}},'zen-traffic').state,'incompatible',`${version} must not match major 25`);
 }
 for (const target of ['x86/64','rockchip/armv7',undefined,'']) {
  assert.equal(model.select([release(meta)],{release:{target,version:'25.12.6'}},'zen-traffic').state,'incompatible','Target matching is still required');
 }
}
const oldMajor = {...zen,tag:'v0.1.1',sdk_version:'24.10.5'};
const oldBoard = {release:{distribution:'ImmortalWrt',target:zen.target,version:'24.10-SNAPSHOT'}};
assert.equal(model.select([release(zen),release(oldMajor,'2026-10-03')],oldBoard,'zen-traffic').meta.tag,oldMajor.tag,'Choose the latest backend in the router\'s own major');
assert.equal(model.select([release(oldMajor)],snapshot,'zen-traffic').state,'incompatible','Major 24 builds cannot update major 25');
assert.equal(model.select([release({...zen,compatible_systems:[{...supported.compatible_systems[0],version:'24.10.5'}]})],oldBoard,'zen-traffic').state,'incompatible','Test records cannot override the SDK major');
for (const sdk_version of ['SNAPSHOT','custom-firmware','25broken']) {
 const unknownSdk = release({...zen,sdk_version});
 assert.ok(model.metadata(unknownSdk),'An unknown SDK major does not invalidate otherwise valid metadata');
 assert.equal(model.select([unknownSdk],board,'zen-traffic').state,'incompatible','Do not guess an unknown SDK major');
 assert.equal(model.select([unknownSdk],board,'luci-theme-zen').state,'matched','An unknown native SDK must not block portable frontend packages');
}
for (const sdk_version of [undefined,25,{},'']) {
 assert.equal(model.metadata(release({...zen,sdk_version})),null,'Native SDK metadata must be a nonempty version string');
}
for (const systems of [[],[{}],[supported.compatible_systems[0],supported.compatible_systems[0]],[{...supported.compatible_systems[0],target:'x86/64'}]]) {
 assert.equal(model.metadata(release({...zen,compatible_systems:systems})),null);
}
const targetBuild = target => ({...zen,target,packages:zen.packages.map(file=>({...file,filename:file.filename.replace('.apk','-'+target.replace('/','-')+'.apk')}))});
const multi = {...targetBuild('x86/64'),builds:[targetBuild('rockchip/armv8')]};
assert.ok(model.metadata(release(multi)),'Multi-target metadata retains the schema-1 top-level build');
for (const target of ['x86/64','rockchip/armv8']) {
 for (const distribution of ['OpenWrt','ImmortalWrt']) {
  const found = model.select([release(multi)],{release:{target,distribution,version:'25.12-SNAPSHOT'}},'zen-traffic');
  assert.equal(found.state,'matched');
  assert.equal(found.meta.target,target);
  assert.ok(found.meta.packages.find(file=>file.name==='zen-traffic').filename.endsWith('-'+target.replace('/','-')+'.apk'),'Download the native APK for this target');
 }
}
assert.equal(model.select([release(multi)],{release:{target:'mediatek/filogic',version:'25.12.5'}},'zen-traffic').state,'incompatible');
assert.equal(model.select([release(multi)],oldBoard,'zen-traffic').state,'incompatible');
assert.equal(model.select([release(multi)],{},'luci-theme-zen').state,'matched');
for (const builds of [[],[{}],[multi],[targetBuild('x86/64')],[targetBuild('rockchip/armv8'),targetBuild('rockchip/armv8')],[{...targetBuild('rockchip/armv8'),repo:'other/repo'}]]) {
 assert.equal(model.metadata(release({...multi,builds})),null,'Reject empty, malformed, nested, repeated or foreign builds');
}
assert.equal(model.metadata({...release(multi),assets:release(multi).assets.slice(0,3)}),null,'All declared target packages must exist');
assert.equal(model.metadata(release({...multi,builds:[{...targetBuild('x86/64'),target:'other/target'}]})),null,'Asset filenames must be unique across targets');
console.log('PASS: independent Zen package versions; portable frontends; native target/OpenWrt major matching across distributions, patches and snapshots; legacy metadata; no firmware identity or upgrade ACL');
