// Production LuCI modules against read-only router and GitHub fixtures.
const {chromium}=require('playwright'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const base=process.env.ZEN_PREVIEW_URL||'http://127.0.0.1:8770', shot=process.env.ZEN_SCREENSHOT_DIR;
const hash='a'.repeat(64);
const zen={schema:1,repo:'zdabing/luci-zen',tag:'v0.3.0',target:'rockchip/armv8',sdk_version:'25.12.5',packages:['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.3.0-r1',filename:name+'-0.3.0-r1.apk',size:123,sha256:hash}))};
const release=m=>({tag_name:m.tag,body:'<!-- zen-update-metadata\n'+JSON.stringify(m)+'\n-->',published_at:'2026-10-04T00:00:00Z',assets:[m,...(m.builds||[])].flatMap(build=>build.packages.map(f=>({name:f.filename,size:f.size,state:'uploaded'})))});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.ZEN_BROWSER_CHANNEL?{channel:process.env.ZEN_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 let mode='matched', calls=0;const updateUrls=[];
 await page.route('https://api.github.com/repos/**',async route=>{
  calls++;updateUrls.push(route.request().url());
  if(mode==='offline') return route.abort();
  if(mode==='timeout') return;
  if(mode==='rate') return route.fulfill({status:403,contentType:'application/json',body:'{}'});
  const partial={...zen,tag:'theme-v0.3.0-r2',packages:[{...zen.packages[0],version:'0.3.0-r2',filename:'luci-theme-zen-0.3.0-r2.apk'}]};
  const deployed={...zen,tag:'build-r10',packages:zen.packages.map(f=>({...f,version:'0.2.0-r10',filename:f.name+'-0.2.0-r10.apk'}))};
  const publishedTheme={...zen,tag:'theme-v0.2.0-r22',packages:[{...zen.packages[0],version:'0.2.0-r22',filename:'luci-theme-zen-0.2.0-r22.apk'}]};
  const exactList={...zen,compatible_systems:[{distribution:'OpenWrt',version:'25.12.5',target:zen.target}]};
  const targetBuild=target=>({...zen,target,packages:zen.packages.map(file=>({...file,filename:file.filename.replace('.apk','-'+target.replace('/','-')+'.apk')}))});
  const multi={...targetBuild('x86/64'),builds:[targetBuild('rockchip/armv8')]};
  const rows=mode==='snapshot'?[release(publishedTheme),release(deployed),{tag_name:'legacy',published_at:'2026-10-01'}]:mode==='legacy'?[{tag_name:'legacy',body:'Old release',published_at:'2026-10-05'}]:mode==='mismatch'?[release({...zen,target:'wrong/target'})]:mode==='partial'?[release(partial)]:mode==='independent'?[release(partial),release(zen)]:mode==='exact-list'?[release(exactList)]:mode==='multi'?[release(multi)]:[release(zen)];
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
  await page.waitForFunction(()=>document.querySelector('#zen-updates .zen-version-item strong')?.textContent==='0.2.0-r10');
  const panel=page.locator('#zen-updates');
  assert.equal(await panel.locator('.zen-version-item').count(),3);
  assert.equal(await panel.getByText('0.2.0-r10',{exact:true}).count(),3);
  assert.equal(await panel.getByRole('link',{name:'管理 Zen 软件包',exact:true}).getAttribute('href'),'?page=package-manager&query=zen');
  assert.equal(await panel.locator('a[href*="flash"]').count(),0);
  assert.ok(!(await panel.innerText()).includes('10Wrt'));
  await clickCheck();assert.equal(calls,1);
  assert.equal(await panel.locator('.zen-update-file').count(),3);
  assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),3);
  assert.ok((await panel.innerText()).includes('有可用更新'));
  mode='partial';await clickCheck();
  assert.equal(await panel.locator('.zen-update-file').count(),1,'Standalone theme release is accepted');
  assert.equal(await panel.locator('a[href*="/releases/download/"][href*="/luci-theme-zen-"]').count(),1);
  mode='independent';await clickCheck();
  assert.equal(await panel.locator('.zen-update-file').count(),3,'Theme release does not hide previous traffic package releases');
  mode='matched';await clickCheck();
  assert.equal(await panel.locator('.zen-version-item').count(),3,'Exactly one row per component after checking');
  assert.equal(await panel.locator('h3').count(),0,'Component names are not repeated in separate cards');
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
   assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),scenario==='mismatch'?2:0,scenario+' must only offer compatible packages');
   if(scenario==='mismatch')assert.equal(await panel.locator('a[href*="/releases/download/"][href*="/zen-traffic-"]').count(),0,'Mismatched native backend cannot be downloaded');
   assert.ok(!(await panel.innerText()).includes('已是最新'),scenario+' cannot report up to date');
  }
  mode='matched';
  await page.evaluate(async()=>{
   previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.3.0-r1'})));
   await previewModules['view.zen.zen-updates'].reload();
  });
  await clickCheck();assert.equal(await panel.getByText(/已是最新/).count(),3,'Installed package versions match release');
  assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),0,'Equal versions never offer reinstall downloads');
  await page.evaluate(async()=>{
   const updates=previewModules['view.zen.zen-updates'];
   previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.4.0-r1'})));
   await updates.reload();
  });
  await clickCheck();assert.equal(await panel.getByText(/当前安装版本较新/).count(),3);
  assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),0,'Newer installed versions never offer downgrades');
  assert.ok(!(await panel.innerText()).includes('→'),'No downgrade arrow');
  for(const metadataMode of ['matched','exact-list'])for(const distribution of ['OpenWrt','ImmortalWrt'])for(const version of ['25.12-SNAPSHOT','25.12.6','25.01.2']){
   mode=metadataMode;
   await page.evaluate(async release=>{
    const updates=previewModules['view.zen.zen-updates'];
    previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.2.0-r10'})));
    await updates.reload();updates.board={release};
   },{distribution,target:'rockchip/armv8',version});
   await clickCheck();
   assert.equal(await panel.locator('a[href*="/releases/download/"][href*="/zen-traffic-"]').count(),1,`${metadataMode}: ${distribution} ${version} gets a same-major backend update`);
   assert.equal(await panel.getByText('尚未发布适配此固件的版本。',{exact:true}).count(),0);
  }
  for(const version of ['24.10.5','26.01.0','SNAPSHOT']){
   await page.evaluate(version=>{previewModules['view.zen.zen-updates'].board.release.version=version;},version);
   await clickCheck();
   assert.equal(await panel.locator('a[href*="/releases/download/"][href*="/zen-traffic-"]').count(),0,'Different or unknown majors cannot offer native downloads');
   assert.equal(await panel.getByText('尚未发布适配此固件的版本。',{exact:true}).count(),1);
  }
  mode='multi';
  for(const target of ['x86/64','rockchip/armv8']){
   await page.evaluate(target=>{previewModules['view.zen.zen-updates'].board.release={distribution:'ImmortalWrt',target,version:'25.12-SNAPSHOT'};},target);
   await clickCheck();
   assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),3);
   const native=panel.locator('a[href*="/releases/download/"][href*="/zen-traffic-"]');
   assert.ok((await native.getAttribute('href')).endsWith('-'+target.replace('/','-')+'.apk'),'Multi-target releases choose this router\'s native APK');
  }
  mode='snapshot';
  await page.evaluate(async()=>{
   const updates=previewModules['view.zen.zen-updates'];
   previewModules.fs.exec_direct=async()=>JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:name==='luci-theme-zen'?'0.2.0-r25':'0.2.0-r10'})));
   await updates.reload();updates.board={release:{distribution:'ImmortalWrt',target:'rockchip/armv8',version:'25.12-SNAPSHOT'}};
  });
  await clickCheck();
  assert.equal(await panel.getByText('当前安装版本较新',{exact:true}).count(),1);
  assert.equal(await panel.getByText('已是最新',{exact:true}).count(),2,'Both traffic packages are current on the same-major snapshot');
  assert.equal(await panel.getByText('尚未发布适配此固件的版本。',{exact:true}).count(),0);
  assert.equal(await panel.locator('a[href*="/releases/download/"]').count(),0);
  assert.equal(await panel.locator('.zen-update-file').count(),0,'No package details when no update exists');
  if(shot)for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});
   await page.evaluate(()=>{ZenAppearance.set({accent:'macaron',material:'glass',mode:'light',layout:'sidebar'});previewModules['menu-zen'].setSidebarOpen(false);});
   await page.waitForTimeout(350);
   await page.screenshot({path:path.join(shot,'updates-current-'+width+'.png'),fullPage:true});
  }
  mode='matched';

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
  assert.ok(!(await panel.innerText()).includes('三个包版本不一致'),'Components may have independent versions');
  await clickCheck();assert.equal(await panel.locator('.zen-update-file').count(),3);
  await page.evaluate(async()=>{
   previewModules.fs.exec_direct=async()=>JSON.stringify([{name:'luci-theme-zen',version:'0.2.0-r10'}]);
   await previewModules['view.zen.zen-updates'].reload();
  });
  await clickCheck();assert.equal(await panel.locator('.zen-update-file').count(),1,'Theme-only installs are not asked to install the traffic backend');
  assert.equal(await panel.locator('a[href*="/releases/download/"][href*="/luci-theme-zen-"]').count(),1);
  await page.evaluate(async()=>{previewModules.fs.exec_direct=async()=>{throw Error('Helper unavailable');};await previewModules['view.zen.zen-updates'].reload();});
  await page.evaluate(async()=>{previewModules.fs.read_direct=async()=>{throw Error('Denied');};await previewModules['view.zen.zen-updates'].reload();});
  assert.equal(await panel.getByText('无法读取',{exact:true}).count(),3);await clickCheck();
  assert.equal(await panel.getByText(/无法比较/).count(),3);
  await page.evaluate(async()=>{previewModules.ui.menu.load=async()=>({children:{admin:{children:{system:{children:{'package-manager':{readonly:true},flash:{readonly:true}}}}}}});await previewModules['view.zen.zen-updates'].reload();});
  assert.ok((await panel.getByRole('link',{name:/管理 Zen 软件包/}).innerText()).includes('只读'));
  assert.equal(await panel.locator('a[href*="flash"]').count(),0);
  await page.evaluate(async()=>{previewModules.ui.menu.load=async()=>({children:{admin:{children:{system:{children:{flash:{readonly:true}}}}}}});await previewModules['view.zen.zen-updates'].reload();});
  assert.equal(await panel.getByRole('link',{name:'管理 Zen 软件包',exact:true}).count(),0);
  assert.equal(await panel.locator('a[href*="flash"]').count(),0);
  assert.ok((await panel.innerText()).includes('当前账号没有可用的软件包管理页面'));
  assert.ok(updateUrls.every(url=>url==='https://api.github.com/repos/zdabing/luci-zen/releases?per_page=100'),'Only Zen releases are requested');
  assert.ok(!(await page.evaluate(()=>previewRequests)).some(r=>r.method==='getVersion'),'No LuCI version query');
  assert.deepEqual(errors,[]);
  const mutating=await page.evaluate(()=>previewRequests.filter(r=>/^(install|update|upgrade|remove|exec|write|set|flash|reboot)/i.test(r.method)));
  assert.deepEqual(mutating,[]);
  console.log('PASS: three Zen packages only; OpenWrt/ImmortalWrt major matching with legacy exact lists; cross-major/target rejection; one Zen release request per check; 200 theme/layout/width cases; legacy/mismatch/rate/offline; package fallback/failure; ACL links; no firmware actions; zero mutation');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
