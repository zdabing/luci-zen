// Production UI in the local fixture. Writes are opt-in and in-memory only.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const base = process.env.ZEN_PREVIEW_URL || 'http://127.0.0.1:8770';
const out = process.env.ZEN_SCREENSHOT_DIR || path.join(__dirname, '../acceptance-out/console');
const settle = page => page.waitForTimeout(300); // Finish drawer/navigation transitions before measuring.
(async () => {
 const browser = await chromium.launch({headless:true, channel:process.env.ZEN_BROWSER_CHANNEL || 'msedge'});
 const context = await browser.newContext({viewport:{width:1440,height:1000}, acceptDownloads:true});
 const page = await context.newPage(), errors = [];
 page.on('pageerror', e => errors.push(e.message)); fs.mkdirSync(out,{recursive:true});
 const bounded = async selector => {
  const box = await page.locator(selector).boundingBox(), size = page.viewportSize();
  assert.ok(box && box.x>=-1 && box.x+box.width<=size.width+1,selector+' width');
  assert.ok(box.y>=-1 && box.y+box.height<=size.height+1,selector+' height');
 };
 const shot = name => page.screenshot({path:path.join(out,name+'.png')});
 try {
  await page.goto(base+'/dev-preview/runtime.html?page=dashboard',{waitUntil:'networkidle'});
  await page.waitForSelector('[data-preview-ready]');
  await page.evaluate(()=>ZenAppearance.set({mode:'light',layout:'sidebar'})); await settle(page);
  assert.equal(await page.locator('.zen-dash-dev-row').count(),4);
  await page.locator('.showSide').click(); await settle(page);
  assert.equal(Math.round((await page.locator('#mainmenu').boundingBox()).width),76);
  const category = page.locator('#mainmenu .nav > .slide > .menu').first();
  await category.focus(); await page.keyboard.press('Enter');
  await bounded('#mainmenu .zen-menu-open > .slide-menu');
  assert.equal(await category.getAttribute('aria-expanded'),'true'); await shot('desktop-navigation');
  await page.keyboard.press('Escape'); assert.equal(await category.getAttribute('aria-expanded'),'false');
  assert.ok(await category.evaluate(el=>el===document.activeElement));
  await page.locator('.showSide').click(); await settle(page);
  assert.equal(Math.round((await page.locator('#mainmenu').boundingBox()).width),224);
  const search=page.locator('.zen-device-search'), filter=page.getByRole('combobox',{name:'连接类型筛选'});
  await filter.selectOption('wired'); assert.equal(await page.locator('.zen-dash-dev-row:visible').count(),2);
  await page.getByRole('checkbox',{name:'全选筛选结果',exact:true}).check();
  assert.match(await page.locator('.zen-device-bulkbar').innerText(),/已选 2 台/);
  await search.fill('not-a-device'); assert.ok(await page.locator('.zen-device-empty').isVisible());
  assert.ok(await page.getByRole('checkbox',{name:'全选筛选结果',exact:true}).isDisabled());
  await search.fill(''); await filter.selectOption('all');
  await page.evaluate(()=>previewModules['view.zen.zen-devices'].tick());
  assert.equal(await page.locator('.zen-dash-dev-row.selected').count(),2);
  const downloading=page.waitForEvent('download'); await page.getByRole('button',{name:'导出 CSV',exact:true}).click();
  const csv=fs.readFileSync(await (await downloading).path(),'utf8');
  assert.equal(csv.trim().split('\r\n').length,3); assert.ok(csv.includes('工作电脑')&&csv.includes('家庭 NAS')&&!csv.includes('小米手机'));
  await page.evaluate(()=>{previewDevices[0].host=' =1+1';});
  await page.evaluate(()=>previewModules['view.zen.zen-devices'].tick());
  const escapedDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出 CSV',exact:true}).click();
  assert.ok(fs.readFileSync(await (await escapedDownload).path(),'utf8').includes('"\' =1+1"'),'CSV neutralizes formula-like hostnames');
  await page.evaluate(()=>{previewDevices[0].host='工作电脑';});await page.evaluate(()=>previewModules['view.zen.zen-devices'].tick());
  await page.getByRole('button',{name:'取消选择',exact:true}).click();
  assert.ok(await page.getByRole('button',{name:'导出 CSV',exact:true}).isDisabled());
  for(const width of [1440,1024,768,390,320]) {
   await page.setViewportSize({width,height:width>768?1000:844}); await settle(page);
   for(const mode of ['light','dark']) {
    await page.evaluate(mode=>ZenAppearance.set({mode}),mode);
    await page.locator('.zen-dash-devices').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),width+'/'+mode+' overflow');
    const first=page.locator('.zen-dash-dev-row').first(); await first.focus(); await page.keyboard.press('Enter'); await settle(page);
    await bounded('.zen-device-drawer'); await bounded('.zen-drawer-footer');
    assert.equal(await page.locator('.zen-device-drawer .zen-dash-dev-detail').count(),1);
    assert.equal(await page.locator('.zen-device-drawer .zen-dash-device-history svg').count(),1);
    assert.ok(await page.locator('.zen-device-drawer').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    if(width===1440&&mode==='light') {
     await page.evaluate(()=>{previewDevices[0].ip4='192.0.2.88';});await page.evaluate(()=>previewModules['view.zen.zen-devices'].tick());
     assert.ok((await page.locator('.zen-device-facts').innerText()).includes('192.0.2.88'),'Open drawer refreshes address changes');
     await page.evaluate(()=>{previewDevices[0].ip4='192.168.1.108';});await page.evaluate(()=>previewModules['view.zen.zen-devices'].tick());
    }
    await page.keyboard.press('Tab'); assert.ok(await page.locator('.zen-device-drawer').evaluate(el=>el.contains(document.activeElement)));
    await shot('drawer-'+width+'-'+mode); await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.locator('.zen-device-drawer').count(),0);
    assert.ok(await first.evaluate(el=>el===document.activeElement));
    assert.equal(await first.locator('.zen-dash-dev-detail').count(),1);
    await first.evaluate(el=>el.blur()); await shot('devices-'+width+'-'+mode);
   }
   if(width<=768) {
    assert.ok(await page.locator('#mainmenu').evaluate(el=>el.inert));
    await page.locator('.showSide').click(); await settle(page); await bounded('#mainmenu');
    assert.ok(await page.locator('#mainmenu').evaluate(el=>!el.inert));
    await page.keyboard.press('Escape'); assert.ok(await page.locator('#mainmenu').evaluate(el=>el.inert));
   }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>ZenAppearance.set({mode:'light'})); await settle(page);
  const head=page.locator('.zen-dash-dev-columns');
  const hostHeader=await head.getByText('主机名',{exact:true}).boundingBox(), ipHeader=await head.getByText('IPv4',{exact:true}).boundingBox();
  assert.ok(Math.abs(hostHeader.y-ipHeader.y)<=1,'Desktop column headers share one row');
  const ipCell=await page.locator('.zen-dash-dev-row').first().locator('.zen-dash-dev-ip').boundingBox();
  assert.ok(Math.abs(ipHeader.x-ipCell.x)<=1,'Header aligns with its address column');
  await page.screenshot({path:path.join(out,'desktop-full.png'),fullPage:true});
  await page.locator('.zen-dash-dev-row input[type=checkbox]').nth(0).check();
  await page.locator('.zen-dash-dev-row input[type=checkbox]').nth(1).check();
  await page.getByRole('button',{name:'重置统计',exact:true}).click();
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='resetDevice').length),0);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.evaluate(()=>previewRequests.filter(r=>r.method==='resetDevice').length),0);
  await page.evaluate(()=>{window.previewAllowDeviceReset=true;window.previewResetFailures=[previewDevices[1].mac];});
  await page.getByRole('button',{name:'重置统计',exact:true}).click(); await shot('batch-confirm-desktop');
  await page.locator('#modal_overlay').getByRole('button',{name:'重置统计',exact:true}).click();
  await page.locator('#modal_overlay [role=alert]').waitFor({state:'visible'});
  assert.equal(await page.locator('.zen-batch-device-list li').count(),1,'Retry list contains only failed devices');
  assert.equal(await page.locator('.zen-dash-dev-row.selected').count(),1);
  await page.setViewportSize({width:320,height:640}); await settle(page); await bounded('#modal_overlay > .modal');
  assert.ok(await page.locator('#modal_overlay > .modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await shot('batch-confirm-mobile'); await page.evaluate(()=>{window.previewResetFailures=[];});
  await page.locator('#modal_overlay').getByRole('button',{name:'重试失败设备',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('modal_overlay'));
  assert.deepEqual(await page.evaluate(()=>previewRequests.filter(r=>r.method==='resetDevice').map(r=>r.args[0])),['02:00:00:00:00:00','02:00:00:00:00:01','02:00:00:00:00:01']);
  assert.equal(await page.locator('.zen-dash-dev-row.selected').count(),0);
  await page.locator('.zen-dash-dev-row').first().click(); await settle(page);
  await page.locator('.zen-drawer-footer').getByRole('button',{name:'设备识别'}).click();
  assert.equal(await page.locator('.zen-device-drawer').count(),0); await bounded('#modal_overlay > .modal');
  assert.equal(await page.locator('.zen-identity-form label').count(),3);
  await page.locator('#modal_overlay').getByRole('button',{name:'保存',exact:true}).click();
  assert.ok(await page.locator('.zen-identity-error').isVisible()); await shot('identity-mobile'); await page.keyboard.press('Escape');
  const readonly=await context.newPage(); await readonly.addInitScript(()=>{window.previewDeviceWriteAccess=false;});
  await readonly.goto(base+'/dev-preview/runtime.html?page=dashboard',{waitUntil:'networkidle'}); await readonly.waitForSelector('[data-preview-ready]');
  assert.ok(await readonly.locator('.zen-bulk-actions .cbi-button-negative').isHidden());
  assert.ok(await readonly.getByRole('button',{name:'导出 CSV',exact:true}).isVisible()); await readonly.close();
  await page.setViewportSize({width:1440,height:1000});await settle(page);
  await page.locator('.showSide').click();await page.evaluate(()=>ZenAppearance.set({layout:'top'}));await settle(page);
  assert.ok(await page.locator('#mainmenu .nav > li > a > .zen-menu-label').first().isVisible(),'Collapsed preference preserves top-navigation labels');
  for(const width of [1440,1024,769,768,390]) {
   await page.setViewportSize({width,height:900});await settle(page);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Top layout at '+width);
   if(width>768) {
    const menu=page.locator('#mainmenu .nav > .slide > .menu').first();await menu.click();await bounded('#mainmenu .zen-menu-open > .slide-menu');await page.keyboard.press('Escape');
   } else {await page.locator('.showSide').click();await page.keyboard.press('Escape');}
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: rail/mobile navigation, 5 widths × 2 modes, detail/history/focus, search/filter, selection, CSV, permissions, cancel, partial reset/retry and identity modal. Screenshots: '+out);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
