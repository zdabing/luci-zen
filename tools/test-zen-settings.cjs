const fs=require('node:fs'),assert=require('node:assert/strict'),{Element,E,find}=require('./test-ui-dom.cjs');
const source=fs.readFileSync('luci-theme-zen/htdocs/luci-static/resources/view/zen/settings.js','utf8');
const tick=()=>new Promise(setImmediate);
function setup(search='',missing=false){
 const reads=[],frames=[],updates={build:()=>E('div',{id:'versions'}),start:()=>reads.push('versions-start')};
 const form=E('input',{value:'unsaved'}),component={load:async()=>{reads.push('notification-load');return[];},render:()=>form};
 const win={location:{href:'http://router/cgi-bin/luci/admin/zen/settings'+search,search},history:{replaceState:(_a,_b,url)=>{win.location.href=String(url);}},ZenAppearance:{render:()=>E('div')}};
 const module=new Function('view','_','E','L','window','requestAnimationFrame',source)({extend:x=>x},x=>x,E,{require:async name=>{
  reads.push(name);if(name==='view.zen.zen-updates')return updates;
  if(missing)throw Error('not installed');return component;
 }},win,fn=>frames.push(fn));
 const root=module.render();const attach=node=>{node.isConnected=true;node.children.forEach(child=>{if(child&&typeof child==='object')attach(child);});};attach(root);frames.forEach(fn=>fn());
 const tab=name=>find(root,node=>node.attrs.id==='zen-settings-tab-'+name);
 return {reads,root,tab,form,win};
}
(async()=>{
 const app=setup();assert.deepEqual(app.reads,[],'Appearance must not import notifications or update RPC code');
 app.tab('notifications').attrs.click();await tick();
 assert.equal(app.reads.filter(v=>v==='notification-load').length,1);
 app.form.value='new unsaved value';app.tab('appearance').attrs.click();app.tab('notifications').attrs.click();await tick();
 assert.equal(app.form.value,'new unsaved value','Switching settings tabs retains unsaved notification inputs');
 assert.equal(app.reads.filter(v=>v==='notification-load').length,1);
 app.tab('notifications').attrs.keydown({key:'ArrowRight',preventDefault(){}});await tick();
 assert.equal(app.tab('versions').attrs['aria-selected'],'true');assert.equal(Element.focused,app.tab('versions'));
 assert.ok(app.win.location.href.includes('tab=updates'));assert.equal(app.reads.filter(v=>v==='versions-start').length,1);
 app.tab('versions').attrs.keydown({key:'ArrowRight',preventDefault(){}});assert.equal(app.tab('appearance').attrs['aria-selected'],'true','Arrow keys cycle through all three tabs');
 const legacy=setup('?tab=updates');await tick();assert.equal(legacy.tab('versions').attrs['aria-selected'],'true');
 const unavailable=setup('?tab=notifications',true);await tick();assert.ok(unavailable.root.textContent.includes('Install and enable'));
 unavailable.tab('versions').attrs.click();await tick();assert.ok(unavailable.reads.includes('versions-start'),'Optional plugin failure does not break versions');
 console.log('PASS: three settings tabs, lazy imports, retained inputs, keyboard cycling, deep links and optional-plugin failure');
})().catch(error=>{console.error(error);process.exitCode=1;});
