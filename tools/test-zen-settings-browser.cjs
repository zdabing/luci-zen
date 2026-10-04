// Test actual settings navigation, shared controls and lazy version loading.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770',shot=process.env.ZEN_SCREENSHOT_DIR;
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.ZEN_BROWSER_CHANNEL?{channel:process.env.ZEN_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];let external=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://api.github.com/**',route=>{external++;return route.abort();});
 const ready=async()=>{await page.waitForFunction(()=>document.body.dataset.previewReady||document.body.dataset.previewError);assert.equal(await page.locator('body').getAttribute('data-preview-error'),null);};
 try{
  await page.goto(base+'/dev-preview/runtime.html?page=dashboard',{waitUntil:'networkidle'});await ready();
  assert.equal(await page.locator('#zen-updates').count(),0);
  assert.equal(await page.evaluate(()=>!!previewModules['view.zen.zen-updates']),false,'Home does not even import update RPC code');
  await page.locator('body > header .zen-settings-link').click();await ready();
  assert.equal(await page.locator('#zen-settings').count(),1);
  assert.equal(await page.locator('#zen-dashboard').count(),0);
  assert.deepEqual(await page.evaluate(()=>previewRequests),[],'Appearance tab does not read router versions');
  const appearance=page.locator('#zen-settings-appearance');
  assert.equal(await page.getByRole('tab',{name:'外观与布局',exact:true}).getAttribute('aria-selected'),'true');
  await appearance.getByRole('button',{name:'晴蓝清晰描边',exact:true}).click();
  await appearance.getByRole('button',{name:'深色模式',exact:true}).click();
  await appearance.locator('.zen-appearance-layouts button').nth(1).click();
  assert.deepEqual(await page.evaluate(()=>ZenAppearance.get()),{accent:'blue',material:'outline',mode:'dark',theme:'dark',layout:'top'});
  await page.reload({waitUntil:'networkidle'});await ready();
  assert.equal(await appearance.locator('.zen-appearance-layouts button').nth(1).getAttribute('aria-pressed'),'true');
  const presets=[['macaron','glass'],['nord','aurora'],['honey','paper'],['blue','outline'],['coast','duotone']];
  let checked=0;
  for(const width of [1440,1024,769,390,320])for(const layout of ['sidebar','top'])for(const [accent,material] of presets)for(const mode of ['light','dark']){
   await page.setViewportSize({width,height:1000});await page.evaluate(v=>ZenAppearance.set(v),{accent,material,mode,layout});await page.waitForTimeout(35);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Settings must fit '+width);
   checked++;
   if(shot&&[1440,390].includes(width)&&layout==='sidebar'&&accent==='macaron'){
    await page.waitForTimeout(350); // Finish the native sidebar layout transition before visual QA.
    // Edge full-page capture can distort fixed glass layers. Desktop QA uses
    // the actual viewport; mobile still captures the vertically stacked form.
    fs.mkdirSync(shot,{recursive:true});await page.screenshot({path:path.join(shot,'appearance-'+width+'-'+mode+'.png'),fullPage:width<769});
   }
  }
  assert.equal(await page.locator('#zen-updates').count(),0);
  const versionTab=page.getByRole('tab',{name:'版本与更新',exact:true});
  await page.getByRole('tab',{name:'外观与布局',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('#zen-updates .zen-version-item strong')?.textContent==='0.2.0-r10');
  assert.equal(await versionTab.getAttribute('aria-selected'),'true');
  assert.equal(await versionTab.evaluate(node=>node===document.activeElement),true);
  assert.equal(await appearance.isVisible(),false);
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='list-installed').length),1);
  await page.keyboard.press('Home');assert.equal(await appearance.isVisible(),true);
  await page.keyboard.press('End');assert.equal(await page.locator('#zen-updates').isVisible(),true);
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='list-installed').length),1,'Tab switching does not duplicate version reads');
  await page.reload({waitUntil:'networkidle'});await ready();
  assert.equal(await versionTab.getAttribute('aria-selected'),'true','URL remembers the selected tab on reload');
  assert.equal(await page.locator('#zen-updates').count(),1);
  assert.equal(external,0,'No external update check on navigation, tab changes or reload');
  await page.goto(base+'/dev-preview/runtime.html?page=login',{waitUntil:'networkidle'});await ready();
  await page.getByRole('button',{name:'主题设置',exact:true}).click();
  assert.equal(await page.locator('#zen-appearance-dialog').isVisible(),true);
  assert.equal(await page.locator('#zen-updates').count(),0,'Login is appearance-only');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
  console.log('PASS: home/settings separation; real header navigation; shared saved appearance/layout controls; '+checked+' responsive combinations; keyboard tabs, lazy version reads, reload; login fallback; no external calls');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
