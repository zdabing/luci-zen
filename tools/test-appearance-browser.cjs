// Production-renderer acceptance for the standalone Mist theme.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770';
const out=process.env.ZEN_SCREENSHOT_DIR||path.join(__dirname,'../acceptance-out/mist');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.ZEN_BROWSER_CHANNEL||'msedge'});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const errors=[],oldAssets=[];let checked=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(/\/zen\/appearance(?:-zen)?\.(?:css|js)/.test(req.url()))oldAssets.push(req.url());});
 const ready=async()=>{await page.waitForFunction(()=>document.body.dataset.previewReady||document.body.dataset.previewError);assert.equal(await page.locator('body').getAttribute('data-preview-error'),null);};
 const settle=()=>page.waitForTimeout(300);
 fs.mkdirSync(out,{recursive:true});
 try{
  for(const view of ['dashboard','history','notifications','settings','login']){
   await page.goto(base+'/dev-preview/runtime.html?page='+view,{waitUntil:'networkidle'});await ready();
   assert.equal(await page.locator('.appearance-materials,.appearance-swatches,.zen-appearance-presets').count(),0);
   for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:width<769?844:1000});await settle();
    for(const layout of ['sidebar','top'])for(const mode of ['light','dark']){
     await page.evaluate(v=>ZenAppearance.set(v),{mode,layout});await page.waitForTimeout(25);
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),view+'/'+width+'/'+layout+'/'+mode+' overflow');
     assert.deepEqual(await page.evaluate(()=>ZenAppearance.get()),{mode,layout,theme:mode});checked++;
     if([1440,390].includes(width)&&layout==='sidebar'){
      await settle();await page.screenshot({path:path.join(out,view+'-'+width+'-'+mode+'.png'),fullPage:width<769});
     }
    }
   }
   const trigger=page.locator('.zen-appearance-trigger').first();
   await page.evaluate(()=>ZenAppearance.open(document.querySelector('.zen-appearance-trigger')));
   const dialog=page.locator('#zen-appearance-dialog');await dialog.waitFor({state:'visible'});
   for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:780});await settle();
    const r=await dialog.boundingBox();assert.ok(r.x>=0&&r.x+r.width<=width+1&&r.y>=0&&r.y+r.height<=781,view+' settings dialog bounds');
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
   }
   await dialog.locator('[data-pref-group=layout][data-pref-value=sidebar]').click();assert.equal(await page.evaluate(()=>ZenAppearance.get().layout),'sidebar');
   await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);await page.waitForFunction(()=>document.activeElement===document.querySelector('.zen-appearance-trigger'));
   console.log('PASS: '+view+'; modes/layouts at five widths, dialog sizing and focus');
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/dev-preview/runtime.html?page=notifications',{waitUntil:'networkidle'});await ready();
  await page.locator('input[type=password]').first().fill('unsaved-placeholder');
  await page.evaluate(()=>ZenAppearance.set({mode:'light',layout:'sidebar'}));await page.locator('.zen-mode-toggle').click();
  assert.equal(await page.evaluate(()=>ZenAppearance.get().theme),'dark');
  assert.equal(await page.locator('input[type=password]').first().inputValue(),'unsaved-placeholder');
  await page.evaluate(()=>ZenAppearance.set({mode:'dark',layout:'top'}));await page.reload({waitUntil:'networkidle'});await ready();
  assert.deepEqual(await page.evaluate(()=>ZenAppearance.get()),{mode:'dark',layout:'top',theme:'dark'});
  const sibling=await context.newPage();await sibling.goto(base+'/dev-preview/runtime.html?page=settings',{waitUntil:'networkidle'});await sibling.waitForSelector('[data-preview-ready]');
  await page.evaluate(()=>ZenAppearance.set({mode:'light',layout:'sidebar'}));await sibling.waitForFunction(()=>ZenAppearance.get().mode==='light'&&ZenAppearance.get().layout==='sidebar');await sibling.close();
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>ZenAppearance.set({mode:'auto'}));assert.equal(await page.evaluate(()=>ZenAppearance.get().theme),'dark');
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>ZenAppearance.get().theme==='light');
  await page.evaluate(()=>{localStorage.setItem('luci-theme-zen-accent','honey');localStorage.setItem('luci-theme-zen-material','paper');});
  await page.reload({waitUntil:'networkidle'});await ready();assert.equal(await page.evaluate(()=>document.documentElement.dataset.material),undefined);
  for(const mode of ['light','dark']){
   await page.evaluate(mode=>ZenAppearance.set({mode}),mode);
   const ratios=await page.evaluate(()=>{
    const css=getComputedStyle(document.documentElement),rgb=value=>{
     const e=document.createElement('span');e.style.color=value;document.body.append(e);const c=getComputedStyle(e).color.match(/[\d.]+/g).slice(0,3).map(Number);e.remove();
     const l=c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return l[0]*.2126+l[1]*.7152+l[2]*.0722;
    };const contrast=(a,b)=>{const x=rgb(css.getPropertyValue(a)),y=rgb(css.getPropertyValue(b));return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    return [contrast('--text','--bg-panel'),contrast('--text-secondary','--bg-panel'),contrast('--on-accent','--accent')];
   });assert.ok(ratios.every(v=>v>=4.5),mode+' text/primary contrast '+ratios);
  }
  await page.goto(base+'/dev-preview/runtime.html?page=overview',{waitUntil:'networkidle'});await ready();
  assert.equal(await page.locator('#zen-dashboard').count(),0);assert.equal(await page.locator('#native-overview-preview').count(),1);
  assert.deepEqual(errors,[]);assert.deepEqual(oldAssets,[]);
  console.log('PASS: '+checked+' responsive states; no old runtime assets, persistence, cross-tab/system modes, legacy migration, unsaved form preservation and AA text/button contrast. Screenshots: '+out);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
