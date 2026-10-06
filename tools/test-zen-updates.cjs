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
 return {tag_name:meta.tag,body:'<!-- zen-update-metadata\n'+JSON.stringify(meta)+'\n-->',published_at:date,assets:meta.packages.map(f=>({name:f.filename,size:f.size,state:'uploaded'}))};
}
const zen = {schema:1,repo:model.REPO,tag:'v0.2.0',target:'rockchip/armv8',sdk_version:'25.12.5',packages:model.PACKAGES.map(name=>({name,version:'0.2.0-r10',filename:name+'-0.2.0-r10.apk',size:123,sha256:'a'.repeat(64)}))};
assert.equal(model.select([release(zen)],board,'zen-traffic').state,'matched');
assert.equal(model.select([release(zen)],{release:{target:'x86/64',version:'25.12.5'}},'zen-traffic').state,'incompatible');
assert.equal(model.select([release(zen)],{...board,release:{...board.release,version:'25.12-SNAPSHOT'}},'zen-traffic').state,'incompatible');
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
console.log('PASS: independent Zen package versions; portable all-architecture frontends; target/SDK matching for native backend; validated metadata; no firmware identity or upgrade ACL');

const snapshot = {release:{distribution:'ImmortalWrt',target:'rockchip/armv8',version:'25.12-SNAPSHOT'}};
const legacy = {tag_name:'v0.1.0',published_at:'2026-10-01'};
assert.equal(model.select([release(zen),legacy],snapshot,'zen-traffic').state,'incompatible','An old legacy release cannot hide the SDK mismatch in a newer validated build');
assert.equal(model.select([release(zen),legacy],snapshot,'luci-app-zen-traffic').state,'matched');
