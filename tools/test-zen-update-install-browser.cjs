// One-click interaction against production components and explicit fake update RPCs.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770',shots=process.env.ZEN_SCREENSHOT_DIR;
const metadata={schema:1,repo:'zdabing/luci-zen',tag:'v0.3.0',target:'rockchip/armv8',sdk_version:'25.12.5',packages:
 ['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.3.0-r1',filename:name+'-0.3.0-r1.apk',size:100,sha256:'a'.repeat(64)}))};
const release={tag_name:metadata.tag,body:'<!-- zen-update-metadata '+JSON.stringify(metadata)+' -->',published_at:'2026-10-12',assets:metadata.packages.map(f=>({name:f.filename,size:f.size,state:'uploaded'}))};
(async()=>{
 const browser=await chromium.launch({headless:true,channel:process.env.ZEN_BROWSER_CHANNEL||'msedge'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://api.github.com/repos/**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify([release])}));
 try {
  await page.goto(base+'/dev-preview/runtime.html?page=settings&tab=updates',{waitUntil:'networkidle'});
  const panel=page.locator('#zen-updates');await page.waitForFunction(()=>!document.querySelector('#zen-updates .cbi-button-action')?.disabled);
  await panel.getByRole('button',{name:'检查更新',exact:true}).click();await page.locator('.zen-update-install').first().waitFor();
  assert.equal(await page.locator('.zen-update-install').count(),3);
  await page.evaluate(()=>window.previewAllowUpdates=true);
  const original=page.url();await page.locator('.zen-update-install').nth(1).click();
  await page.waitForFunction(()=>document.querySelector('.zen-update-progress').textContent.includes('路由器正在下载'));
  assert.equal(page.url(),original,'Update does not navigate to GitHub');
  assert.equal(await page.locator('.zen-update-install:disabled').count(),3,'All components are serialized');
  assert.deepEqual(await page.evaluate(()=>previewRequests.filter(r=>r.method==='start').at(-1).args),['luci-app-zen-traffic','v0.3.0']);
  await page.evaluate(()=>{previewUpdateState.busy=false;previewUpdateState.job.stage='failed';previewUpdateState.job.error='checksum';});
  await page.waitForFunction(()=>document.querySelector('.zen-update-progress').textContent.includes('校验失败'));
  await page.waitForFunction(()=>!document.querySelector('.zen-update-install').disabled);
  await page.locator('.zen-update-install').nth(1).click();
  await page.evaluate(()=>{
   previewUpdateState.busy=false;previewUpdateState.job.stage='success';delete previewUpdateState.job.error;
   previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:name==='luci-app-zen-traffic'?'0.3.0-r1':'0.2.0-r10'})));
  });
  await page.waitForFunction(()=>document.querySelector('.zen-update-progress').textContent.includes('更新完成'));
  await page.waitForFunction(()=>document.querySelectorAll('.zen-update-install').length===2);
  assert.equal(await panel.getByText('0.3.0-r1',{exact:true}).count(),1,'Installed versions refresh after completion');
  await page.evaluate(async()=>{window.previewUpdateAccess=false;await previewModules['view.zen.zen-updates'].reload();});
  await panel.getByRole('button',{name:'检查更新',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.zen-update-install:disabled').length===2);
  assert.equal(await panel.getByRole('button',{name:'只读',exact:true}).count(),2);
  const calls=await page.evaluate(()=>previewRequests.filter(r=>r.method==='start').length);
  await page.evaluate(()=>previewModules['view.zen.zen-updates'].updater.install('zen-traffic','v0.3.0'));
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='start').length),calls);
  // A new view reconnects to an existing job, without issuing a second start.
  await page.evaluate(async()=>{
   window.previewUpdateAccess=true;window.previewUpdateState={available:true,busy:true,job:{id:'resumed',package:'zen-traffic',tag:'v0.3.0',stage:'installing'}};
   await previewModules['view.zen.zen-updates'].reload();
  });
  await page.waitForFunction(()=>document.querySelector('.zen-update-progress').textContent.includes('正在安装'));
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='start').length),calls);
  for(const width of [1440,390,320])for(const mode of ['light','dark']) {
   await page.setViewportSize({width,height:1000});await page.evaluate(mode=>ZenAppearance.set({mode,layout:'sidebar'}),mode);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(shots&&width!==320){fs.mkdirSync(shots,{recursive:true});await panel.screenshot({path:path.join(shots,`one-click-updater-${width}-${mode}.png`)});}
  }
  assert.deepEqual(errors,[]);console.log('PASS: one-click start, progress, no navigation, serialization, checksum failure/retry, installed version refresh, read-only and resume');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
