// Production LuCI modules against read-only router and GitHub fixtures.
const {chromium}=require('playwright'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770', shot=process.env.ZEN_SCREENSHOT_DIR;
const hash='a'.repeat(64), file={filename:'openwrt-r5c-squashfs-sysupgrade.img.gz',size:123,sha256:hash};
const zen={schema:1,repo:'zdabing/luci-zen',tag:'v0.3.0',target:'rockchip/armv8',sdk_version:'25.12.5',packages:['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.3.0-r1',filename:name+'-0.3.0-r1.apk',size:123,sha256:hash}))};
const firmware={schema:1,repo:'zdabing/10Wrt',tag:'r5c-2026.10.04-88',target:'rockchip/armv8',profile:'friendlyarm_nanopi-r5c',build_number:88,files:[file]};
const release=(m,kind)=>({tag_name:m.tag,body:'<!-- '+kind+'-update-metadata\n'+JSON.stringify(m)+'\n-->',published_at:'2026-10-04T00:00:00Z',assets:(m.packages||m.files).map(f=>({name:f.filename,size:f.size,state:'uploaded'}))});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.ZEN_BROWSER_CHANNEL?{channel:process.env.ZEN_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let mode='matched', calls=0;
 await page.route('https://api.github.com/repos/**',async route=>{
  calls++;const isZen=route.request().url().includes('/luci-zen/');
  if(mode==='offline') return route.abort();
  if(mode==='timeout') return;
  if(mode==='rate') return route.fulfill({status:403,contentType:'application/json',body:'{}'});
  const m=isZen?zen:firmware;
  const rows=mode==='legacy'?[{tag_name:'legacy',body:'Old release',published_at:'2026-10-05'}]:mode==='mismatch'?[release({...m,target:'wrong/target'},isZen?'zen':'10wrt')]:[release(m,isZen?'zen':'10wrt')];
  return route.fulfill({contentType:'application/json',body:JSON.stringify(rows)});
 });
 const clickCheck=async()=>{await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#zen-updates .cbi-button-action').disabled);};
 try {
  await page.goto(base+'/dev-preview/runtime.html?page=dashboard',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.body.dataset.previewReady||document.body.dataset.previewError);
  assert.equal(await page.locator('body').getAttribute('data-preview-error'),null);
  assert.equal(calls,0,'No external request before explicit check');
  assert.equal(await page.locator('#zen-updates').count(),0,'No update panel on the monitoring home');
  assert.ok(!(await page.evaluate(()=>previewRequests)).some(r=>r.method==='list-installed'),'Home never reads package inventory');
  await page.getByRole('link',{name:'Zen 设置',exact:true}).first().click();
  await page.waitForSelector('[data-preview-ready]');
  assert.equal(await page.locator('#zen-settings').count(),1);
  assert.equal(await page.locator('#zen-dashboard').count(),0,'Settings is an independent view');
  assert.equal(await page.locator('#zen-updates').count(),0,'Version reads are lazy');
  await page.getByRole('tab',{name:'版本与更新',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#zen-updates .zen-version-item strong')?.textContent.includes('OpenWrt'));
  const panel=page.locator('#zen-updates');
  assert.equal(await panel.locator('.zen-version-item').count(),6);
  assert.equal(await panel.getByText('0.2.0-r10',{exact:true}).count(),3);
  assert.equal(await panel.getByRole('link',{name:'管理 Zen 软件包',exact:true}).getAttribute('href'),'?page=package-manager&query=zen');
  assert.equal(await panel.getByRole('link',{name:'备份 / 升级固件',exact:true}).getAttribute('href'),'?page=flash');
  await clickCheck();assert.equal(calls,2);
  assert.ok((await panel.innerText()).includes('当前构建版本未知'));
  assert.equal(await panel.locator('.zen-update-file').count(),4);
  assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),4);
  assert.ok((await panel.innerText()).includes('有可用更新'));
  for(const width of [1440,1024,769,390,320])for(const layout of ['sidebar','top'])for(const appearance of [{accent:'macaron',material:'glass'},{accent:'nord',material:'aurora'},{accent:'honey',material:'paper'},{accent:'blue',material:'outline'},{accent:'coast',material:'duotone'}])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});await page.evaluate(v=>ZenAppearance.set(v),{...appearance,mode:theme,layout});
   await page.waitForTimeout(30);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No overflow with long versions/downloads: '+width);
   if(shot&&['1440','390'].includes(String(width))&&layout==='sidebar'&&appearance.accent==='macaron'){
    fs.mkdirSync(shot,{recursive:true});await page.screenshot({path:path.join(shot,'updates-'+width+'-'+theme+'.png'),fullPage:width<769});
   }
  }
  for(const scenario of ['legacy','mismatch','rate','offline','timeout']){
   mode=scenario;await clickCheck();
   assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),0,scenario+' must not offer unverified files');
   assert.ok(!(await panel.innerText()).includes('已是最新'),scenario+' cannot report up to date');
  }
  mode='matched';
  await page.evaluate(async identity=>{
   const modules=previewModules;
   modules.fs.read=async()=>JSON.stringify(identity);
   await modules['view.zen.zen-updates'].reload();
  },firmware);
  await clickCheck();assert.ok((await panel.innerText()).includes('已是最新'),'Installed firmware tag matches release');
  await page.evaluate(async()=>{
   const updates=previewModules['view.zen.zen-updates'];let releaseOld;
   previewModules.fs.exec_direct=()=>new Promise(resolve=>{releaseOld=resolve;});
   const old=updates.reload();await new Promise(resolve=>setTimeout(resolve,0));
   const previous=updates.panel;previous.replaceWith(updates.build());
   previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.2.0-r20'})));
   await updates.start();releaseOld(JSON.stringify([{name:'zen-traffic',version:'0.2.0-r1'}]));await old;
  });
  assert.equal(await panel.getByText('0.2.0-r20',{exact:true}).count(),3,'Detached older requests cannot overwrite a new home view');
  await page.evaluate(async()=>{
   previewModules.fs.exec_direct=async()=>{throw Error('Helper unavailable');};
   previewModules.fs.read_direct=async path=>{if(path==='/lib/apk/db/installed')return 'P:luci-theme-zen\nV:0.2.0-r10\n\nP:luci-app-zen-traffic\nV:0.2.0-r9\n\nP:zen-traffic\nV:0.2.0-r10';throw Error('Missing');};
   await previewModules['view.zen.zen-updates'].reload();
  });
  assert.ok((await panel.innerText()).includes('三个包版本不一致'));
  await page.evaluate(async()=>{previewModules.fs.read_direct=async()=>{throw Error('Denied');};await previewModules['view.zen.zen-updates'].reload();});
  assert.equal(await panel.getByText('无法读取',{exact:true}).count(),3);await clickCheck();
  assert.equal(await panel.getByText(/无法比较/).count(),3);
  await page.evaluate(async()=>{previewModules.ui.menu.load=async()=>({children:{admin:{children:{system:{children:{flash:{readonly:true}}}}}}});await previewModules['view.zen.zen-updates'].reload();});
  assert.equal(await panel.getByRole('link',{name:'管理 Zen 软件包',exact:true}).count(),0);
  assert.ok((await panel.getByRole('link',{name:/备份 \/ 升级固件/}).innerText()).includes('只读'));
  assert.deepEqual(errors,[]);
  const mutating=await page.evaluate(()=>previewRequests.filter(r=>/^(install|update|upgrade|remove|exec|write|set|flash|reboot)/i.test(r.method)));
  assert.deepEqual(mutating,[]);
  console.log('PASS: production versions + manual update checks; 200 theme/layout/width cases; legacy/mismatch/rate/offline; package fallback/failure; firmware identity; ACL links; zero mutation');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
