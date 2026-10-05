// Optional browser acceptance: requires Playwright and a browser.
// Serve the repository: python -m http.server 8770 --bind 127.0.0.1
// Run: node tools/test-appearance-browser.cjs
// ZEN_PREVIEW_URL, ZEN_BROWSER_CHANNEL and ZEN_SCREENSHOT_DIR are optional.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const presets=[['macaron','glass'],['nord','aurora'],['honey','paper'],['blue','outline'],['coast','duotone']];
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770';
const shot=process.env.ZEN_SCREENSHOT_DIR;
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.ZEN_BROWSER_CHANNEL?{channel:process.env.ZEN_BROWSER_CHANNEL}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const openAppearance=async()=>{const trigger=page.locator('.zen-appearance-trigger');if(await trigger.getAttribute('href'))await page.evaluate(()=>ZenAppearance.open(document.querySelector('.zen-appearance-trigger')));else await trigger.click();};
 let checked=0;
 try {
  for(const view of ['dashboard','realtime','history','notifications','login']){
   await page.goto(base+'/dev-preview/runtime.html?page='+view,{waitUntil:'networkidle'});
   await page.waitForFunction(()=>document.body.dataset.previewReady||document.body.dataset.previewError);
   assert.equal(await page.locator('body').getAttribute('data-preview-error'),null,view+' must render the production module');
   if(view==='dashboard') {
    assert.equal(await page.locator('#view > #zen-dashboard').count(),1,'Standalone home belongs inside its own LuCI view');
    assert.equal(await page.locator('#maincontent > .container > #zen-dashboard').count(),0,'No dashboard prepended outside the view');
    assert.equal(await page.locator('#mainmenu').getByRole('link',{name:'Zen 首页',exact:true}).getAttribute('href'),'?page=dashboard');
    assert.equal(await page.locator('#mainmenu').getByRole('link',{name:'OpenWrt 概览',exact:true,includeHidden:true}).getAttribute('href'),'?page=overview');
   }
   for(const width of [1440,700,390,320]){
    await page.setViewportSize({width,height:1000});
    await page.waitForTimeout(350); // Finish the existing sidebar resize transition.
    for(const layout of ['sidebar','top'])for(const [accent,material] of presets)for(const mode of ['light','dark']){
     await page.evaluate(value=>ZenAppearance.set(value),{accent,material,mode,layout});
     await page.waitForTimeout(25);
     const measured=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,accent:document.documentElement.dataset.accent,material:document.documentElement.dataset.material}));
     assert.ok(measured.scroll<=width+1,view+': overflow '+JSON.stringify(measured));
     assert.equal(measured.theme,mode);assert.equal(measured.accent,accent);assert.equal(measured.material,material);checked++;
     if(shot&&view==='dashboard'&&width===1440&&mode==='light'){
      fs.mkdirSync(shot,{recursive:true});await page.screenshot({path:path.join(shot,layout+'-'+accent+'-'+material+'.png'),fullPage:true});
     }
    }
   }
   await openAppearance();
   const dialog=page.locator('#zen-appearance-dialog');await dialog.waitFor({state:'visible'});
   await dialog.locator('.zen-appearance-layouts button').first().click();
   assert.equal(await page.evaluate(()=>ZenAppearance.get().layout),'sidebar');
   await dialog.locator('.zen-appearance-layouts button').nth(1).click();
   assert.equal(await page.evaluate(()=>ZenAppearance.get().layout),'top');
   assert.equal(await dialog.getByRole('button',{name:'海盐日落双色渐层',exact:true}).getAttribute('aria-pressed'),'true');
   await dialog.getByRole('button',{name:'蜂蜜麦田暖色纸页',exact:true}).click();
   assert.equal(await page.evaluate(()=>ZenAppearance.get().mode),'dark','Preset must keep selected mode');
   for(const width of [1440,700,390,320]){
    await page.setViewportSize({width,height:780});
    const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,view+': dialog width');
    assert.ok(bounds.y>=0&&bounds.height<=780,view+': dialog height');
    assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),view+': dialog content overflow');
   }
   if(shot&&view==='dashboard')await page.screenshot({path:path.join(shot,'settings-mobile-dark.png')});
   await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
   assert.equal(await page.locator('.zen-appearance-trigger').evaluate(node=>node===document.activeElement),true,'Restore focus');
   const quick=page.locator('.zen-mode-toggle');
   const quickBounds=await quick.boundingBox();assert.ok(quickBounds.x>160&&quickBounds.y<70,view+': quick mode at top right');
   await quick.click();assert.equal(await page.evaluate(()=>ZenAppearance.get().theme),'light');
   assert.equal(await quick.getAttribute('aria-label'),'切换到深色模式');
   await quick.click();assert.equal(await page.evaluate(()=>ZenAppearance.get().theme),'dark');
   console.log('PASS: '+view+' production renderer; 5 presets × 2 modes × 2 layouts × 4 widths; modal, focus and top-right quick mode');
  }
  await page.setViewportSize({width:1440,height:900});
  await page.goto(base+'/dev-preview/runtime.html?page=notifications',{waitUntil:'networkidle'});
  await page.waitForSelector('[data-preview-ready]');
  await page.locator('input[type="password"]').first().fill('unsaved-placeholder');
  await openAppearance();
  await page.locator('.zen-appearance-presets button').first().click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('input[type="password"]').first().inputValue(),'unsaved-placeholder','Appearance must preserve unsaved notification fields');
  assert.equal(await page.evaluate(()=>previewRequests.some(r=>/^(set|test|reset)/.test(r.method))),false,'Theme actions never invoke business mutations');
  await page.evaluate(()=>ZenAppearance.set({accent:'nord',material:'aurora',mode:'dark',layout:'top'}));
  await page.reload({waitUntil:'networkidle'});await page.waitForSelector('[data-preview-ready]');
  assert.deepEqual(await page.evaluate(()=>ZenAppearance.get()),{accent:'nord',material:'aurora',mode:'dark',theme:'dark',layout:'top'});
  const sibling=await context.newPage();await sibling.goto(base+'/dev-preview/runtime.html?page=history',{waitUntil:'networkidle'});await sibling.waitForSelector('[data-preview-ready]');
  await page.evaluate(()=>ZenAppearance.set({accent:'blue',material:'outline',mode:'light',layout:'sidebar'}));
  await sibling.waitForFunction(()=>ZenAppearance.get().accent==='blue'&&ZenAppearance.get().mode==='light'&&ZenAppearance.get().layout==='sidebar');
  await page.evaluate(()=>ZenAppearance.set({layout:'top'}));
  // Top navigation retains the real LuCI links and works with pointer and keyboard.
  for(const width of [1440,1024,769]){
   await page.setViewportSize({width,height:900});await page.waitForTimeout(350);
   assert.equal(await page.locator('.showSide').isVisible(),false);
   const menu=page.locator('#mainmenu');const bounds=await menu.boundingBox();
   const header=await page.locator('body > header').boundingBox();
   assert.ok(bounds.y>=header.y&&bounds.y+bounds.height<=header.y+header.height+1,'Top navigation shares the header row');
   assert.ok((await page.locator('#maincontent').boundingBox()).y>=header.y+header.height,'Content below the single header');
   const parent=menu.locator('.menu').first();await parent.focus();await page.keyboard.press('Enter');
   assert.equal(await parent.getAttribute('aria-expanded'),'true');
   const submenu=menu.locator('.slide-menu').first(),subBounds=await submenu.boundingBox();
   assert.ok(subBounds.x>=0&&subBounds.x+subBounds.width<=width,'Dropdown stays inside viewport');
   assert.equal(await submenu.getByRole('link',{name:'历史分析',exact:true}).getAttribute('href'),'?page=history');
   await page.keyboard.press('Tab');assert.equal(await submenu.evaluate(node=>node.contains(document.activeElement)),true);
   await page.keyboard.press('Escape');assert.equal(await parent.getAttribute('aria-expanded'),'false');
   assert.equal(await parent.evaluate(node=>node===document.activeElement),true);
   await parent.click();await page.locator('#view h2').first().click();
   assert.equal(await parent.getAttribute('aria-expanded'),'false','Outside click closes dropdown');
  }
  if(shot){await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(shot,'top-navigation-light.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
  await page.locator('.showSide').click();assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('sidebar-open')),true);
  assert.equal(await page.locator('#mainmenu').getByRole('link',{name:'历史分析',exact:true}).isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('sidebar-open')),false);
  if(shot)await page.screenshot({path:path.join(shot,'top-navigation-mobile.png'),fullPage:true});
  // A collapsed left sidebar must not hide the top layout or overwrite its preference.
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>ZenAppearance.set({layout:'sidebar'}));await page.waitForTimeout(350);
  await page.locator('.showSide').click();assert.equal(await page.evaluate(()=>localStorage.getItem('luci-theme-zen-sidebar')),'collapsed');
  await page.evaluate(()=>ZenAppearance.set({layout:'top'}));assert.equal(await page.locator('body > header #mainmenu').count(),1);
  await page.evaluate(()=>ZenAppearance.set({layout:'sidebar'}));await page.waitForTimeout(350);
  assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('sidebar-collapsed')),true);
  await page.locator('.showSide').click();
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>ZenAppearance.set({mode:'auto'}));
  assert.equal(await page.evaluate(()=>ZenAppearance.get().theme),'dark');
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>ZenAppearance.get().theme==='light');
  await page.evaluate(()=>{localStorage.setItem('luci-theme-zen-accent','unknown');localStorage.setItem('luci-theme-zen-material','unknown');});
  await page.reload({waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>ZenAppearance.get().accent),'macaron');
  assert.equal(await page.evaluate(()=>ZenAppearance.get().material),'glass');
  // Keyboard: enter the modal, tab through choices, choose without a pointer.
  await page.locator('.zen-appearance-trigger').focus();await openAppearance();
  await page.locator('.appearance-swatches button').nth(3).focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>ZenAppearance.get().accent),'blue');
  await page.keyboard.press('Escape');
  // Native-route preview is explicitly a placeholder, not an upstream renderer.
  await page.goto(base+'/dev-preview/runtime.html?page=overview',{waitUntil:'networkidle'});
  await page.waitForSelector('[data-preview-ready]');
  assert.equal(await page.locator('#zen-dashboard').count(),0,'Stock overview route never injects Zen content');
  assert.equal(await page.locator('#native-overview-preview').count(),1);
  assert.deepEqual(await page.evaluate(()=>previewRequests),[],'Native-route preview has no Zen collectors');
  await page.locator('#mainmenu').getByRole('link',{name:'Zen 首页',exact:true}).click();
  await page.waitForSelector('#view > #zen-dashboard');await page.waitForSelector('[data-preview-ready]');
  assert.equal(await page.locator('#native-overview-preview').count(),0,'Returning home replaces the entire view');
  assert.deepEqual(errors,[]);
  console.log('PASS: '+checked+' responsive combinations; top-menu links, keyboard/outside dismissal, mobile drawer, collapse memory, persistence, cross-tab/system sync and unsaved form preservation; no browser errors');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
