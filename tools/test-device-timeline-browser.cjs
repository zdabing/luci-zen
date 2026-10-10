// Optional local production-renderer acceptance; same server/runtime as appearance checks.
// python -m http.server 8770 --bind 127.0.0.1
// ZEN_BROWSER_CHANNEL=msedge node tools/test-device-timeline-browser.cjs
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770';
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.ZEN_BROWSER_CHANNEL||'msedge'});
 const context=await browser.newContext({viewport:{width:1440,height:1000},hasTouch:true,timezoneId:'Asia/Taipei'});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   await page.goto(base+'/dev-preview/runtime.html?page=dashboard',{waitUntil:'networkidle'});
   const link=page.locator('.zen-share-card.download .zen-share-legend a').first();
   await link.waitFor();
   const href=await link.getAttribute('href'),expected=new URL(href,base).searchParams.get('mac');
   assert.ok(expected);assert.ok(href.endsWith('#device-hourly'));
   if(width===1440&&process.env.ZEN_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.ZEN_SCREENSHOT_DIR,{recursive:true});
    await link.hover();
    await page.locator('.zen-share-card.download').screenshot({path:path.join(process.env.ZEN_SCREENSHOT_DIR,'share-device-entry.png')});
   }
   if(width===390)await link.tap();else {await link.focus();await page.keyboard.press('Enter');}
   await page.waitForSelector('[data-preview-ready]');
   await page.waitForFunction(()=>document.activeElement.id==='device-hourly');
   assert.equal(await page.locator('#zen-tf-history-device').inputValue(),expected,'Share link preselects the matching device');
   assert.equal(await page.locator('.zen-timeline-slot').count(),24);
   const target=await page.locator('#device-hourly').boundingBox();
   assert.ok(target.y>=70&&target.y<400,'Hourly section is visible below the fixed header');
   assert.match(await page.locator('#device-hourly').innerText(),/30 天/);
   assert.equal(await page.evaluate(()=>previewRequests.find(r=>r.method==='getDeviceTimeline').args[0]),expected);
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/dev-preview/runtime.html?page=history',{waitUntil:'networkidle'});
  await page.waitForSelector('[data-preview-ready]');
  await page.locator('#zen-tf-history-device').selectOption('02:00:00:00:00:00');
  const section=page.locator('.zen-device-timeline'),slots=section.locator('.zen-timeline-slot');
  await slots.first().waitFor();
  await section.locator('input[type=date]').fill('2026-10-09');
  await section.locator('input[type=date]').dispatchEvent('change');
  await page.waitForFunction(()=>document.querySelector('.zen-timeline-slot')?.getAttribute('aria-label').includes('00:00–01:00'));
  assert.equal(await slots.count(),24);
  assert.equal(await section.locator('table').count(),0);
  assert.equal(await section.getByRole('button',{name:'返回每小时用量'}).count(),0);
  const calls=()=>page.evaluate(()=>previewRequests.filter(r=>r.method==='getDeviceTimeline').length);
  const before=await calls();
  await slots.nth(1).hover();
  await page.waitForFunction(()=>document.querySelector('.zen-timeline-readout').textContent.includes('10.0 GB'));
  assert.match(await section.locator('.zen-timeline-readout').innerText(),/01:00–02:00.*10.0 GB.*9.80 GB/);
  assert.equal(await section.locator('[role=tooltip]').isVisible(),true);
  await slots.nth(1).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await slots.nth(2).getAttribute('aria-pressed'),'true');
  await page.keyboard.press('End');assert.equal(await slots.nth(23).getAttribute('aria-pressed'),'true');
  await page.keyboard.press('Escape');assert.equal(await section.locator('[role=tooltip]').isVisible(),false);
  assert.equal(await calls(),before,'Hover, tap and keyboard only select hourly usage');
  const shots=process.env.ZEN_SCREENSHOT_DIR;
  if(shots)fs.mkdirSync(shots,{recursive:true});
  for(const width of [1440,390,320])for(const mode of ['light','dark']) {
   await page.setViewportSize({width,height:1000});
   await page.evaluate(mode=>ZenAppearance.set({accent:'blue',material:'outline',mode,layout:'sidebar'}),mode);
   await section.scrollIntoViewIfNeeded();
   await slots.nth(1).tap();
   const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
   assert.ok(bounds.scroll<=width+1,'No page overflow: '+JSON.stringify(bounds));
   const tooltip=await section.locator('[role=tooltip]').boundingBox();
   assert.ok(tooltip.x>=0&&tooltip.x+tooltip.width<=width+1,'Tooltip stays in the viewport');
   await slots.nth(23).tap();assert.equal(await slots.nth(23).getAttribute('aria-pressed'),'true');
   assert.equal(await calls(),before);
   await slots.nth(1).tap();
   if(shots&&width!==320)await section.screenshot({path:path.join(shots,`device-hourly-${width}-${mode}.png`)});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: share links preselect and focus device hours; 30-day chart desktop/mobile, light/dark, scrolling, tooltip, touch and keyboard');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
