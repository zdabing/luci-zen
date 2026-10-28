'use strict';
'require baseclass';
'require view.zen.zen-devices as devicesModule';
'require view.zen.zen-format as fmt';
'require view.zen.zen-wan-share as shares';
'require view.zen.zen-usage-ui as usageUI';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
return baseclass.extend({async mount(dash,model){
 if(!dash.isConnected||dash.dataset.consoleReady)return;
 dash.dataset.consoleReady='true';model.compactChart=true;model.lastW=0;
   const live=dash.querySelector('.zen-dash-traffic'),trend=dash.querySelector('.zen-dash-trend'),devices=dash.querySelector('.zen-dash-devices');
   live.classList.add('rf-live');live.querySelector('h3').textContent='实时网速';
   const details=el('details','rf-system');details.append(el('summary','','系统与接口详情'));
   for(const selector of ['.zen-dash-iface-control','.zen-dash-strip','.zen-dash-gauges','.zen-dash-overview','.zen-dash-interface-totals']){const n=dash.querySelector(selector);if(n)details.append(n);}
   for(const direction of ['tx','rx']){const peak=Math.max(0,...model.history.map(p=>Number(p[direction])||0));const node=el('span','rf-peak','峰值 '+fmt.fmtRate(peak));node.dataset.peak=direction;live.querySelector('.zen-dash-stat.'+direction).append(node);}
   const readings=el('div','rf-live-readings');readings.append(live.querySelector('.zen-dash-traffic-stats'));live.append(readings);
   live.append(trend);trend.querySelector('.zen-dash-svg').setAttribute('preserveAspectRatio','none');
   for(const [selector,label] of [['.ul','上传'],['.dl','下载']]){const item=trend.querySelector('.zen-dash-chart-legend '+selector);item.replaceChildren(item.querySelector('.swatch'),document.createTextNode(label));}
   const chartCaption=el('span','rf-chart-caption','每 5 秒更新 · 最近 5 分钟');trend.querySelector('.zen-dash-chart-legend').append(chartCaption);
   const chartFoot=el('div','rf-chart-foot');chartFoot.append(el('span','','5 分钟前'),el('span','','现在'));live.append(chartFoot);
   const systemTools=el('div','rf-system-tools');const systemButton=el('button','rf-system-button','系统与接口详情 ›');systemButton.type='button';details.id='rf-system-details';systemButton.setAttribute('aria-controls',details.id);systemButton.addEventListener('click',()=>{details.open=!details.open;if(details.open)details.scrollIntoView({block:'nearest',behavior:'smooth'});});details.addEventListener('toggle',()=>systemButton.setAttribute('aria-expanded',String(details.open)));systemButton.setAttribute('aria-expanded','false');systemTools.append(systemButton);
   devices.querySelector('h3').textContent='连接设备';
   const deviceModel=devicesModule;
   if(devices.querySelector('.zen-device-toolbar')&&Array.isArray(deviceModel.sortButtons)){
   const sorter=el('select','rf-device-sort');sorter.setAttribute('aria-label','设备排序');
   for(const [key,label] of [['wan_rx_r','按下载速度'],['wan_tx_r','按上传速度']]){const option=el('option','',label);option.value=key;sorter.append(option);}
   sorter.value=deviceModel.sortKey;sorter.addEventListener('change',()=>{const target=deviceModel.sortButtons.find(entry=>entry.key===sorter.value);if(target&&(deviceModel.sortKey!==sorter.value||!deviceModel.sortDescending))target.button.click();});
   devices.querySelector('.zen-device-toolbar').append(sorter);
   deviceModel.enhanceSelect(sorter);
   }
   const decorateRows=()=>{   for(const row of devices.querySelectorAll('.zen-dash-dev-row')){if(row.querySelector('.rf-device-sub'))continue;const speeds=el('div','rf-device-speeds');for(const rate of row.querySelectorAll('.zen-dash-dev-rate')){rate.prepend(el('span','rf-rate-arrow',rate.classList.contains('zen-dash-dev-download')?'↓':'↑'));speeds.append(rate);}row.append(speeds);const sub=el('span','rf-device-sub');sub.append(row.querySelector('.zen-dash-dev-ip'),el('span','','·'),row.querySelector('.zen-dash-dev-mac'));row.querySelector('.zen-dash-dev-id').append(sub);}};decorateRows();new MutationObserver(decorateRows).observe(devices,{subtree:true,childList:true});
   const router=el('section','rf-router');router.setAttribute('aria-label','网络概览');const routerHead=el('div','rf-router-head'),health=el('div','rf-health');
   const pageHead=document.querySelector('.rf-page-head'),title=pageHead?.querySelector('h1')||el('h1','','网络概览');title.classList.add('rf-router-title');routerHead.append(title);pageHead?.remove();
   const connection=dash.querySelector('.zen-dash-connections'),wanPill=el('div','rf-wan-pill');
   const wanState=el('span','rf-wan-status');wanState.append(el('span','','WAN'),connection.querySelector('[data-connection="state"]'));
   wanPill.append(wanState,connection.querySelector('[data-health-metric="latency"]'));routerHead.append(wanPill);router.append(routerHead,health,connection);
   const gaugeSource=details.querySelector('.zen-dash-gauges'),metrics=[];
   for(const [key,label] of [['cpu','CPU'],['ram','内存']]){const item=el('span','rf-health-metric'),value=el('b','','—'),bar=el('i','rf-health-fill'),track=el('span','rf-health-track');track.append(bar);item.append(el('span','',label),value,track);health.append(item);metrics.push({key,value,bar});}
   function syncHealth(){for(const {key,value,bar} of metrics){const source=gaugeSource.querySelector('[data-gauge="'+key+'"] text.pct');value.textContent=source?.textContent||'—';bar.style.width=Math.min(100,Math.max(0,parseFloat(value.textContent)||0))+'%';}}
   new MutationObserver(syncHealth).observe(gaugeSource,{subtree:true,childList:true,characterData:true});syncHealth();
   for(const key of ['temperature','connections'])health.append(connection.querySelector('[data-health-metric="'+key+'"]'));
   connection.querySelector('.zen-dash-health').remove();
   for(const key of ['wan','wan6','lan','uptime'])connection.querySelector('[data-connection="'+key+'"]').closest('.zen-dash-connection').dataset.connectionCard=key;
   const ipv6=connection.querySelector('[data-connection="wan6"]'),ipv6Card=ipv6.closest('.zen-dash-connection');
   const syncIPv6=()=>{const available=ipv6.textContent.trim()!==fmt.MISSING&&ipv6.textContent.trim()!=='';ipv6Card.hidden=!available;connection.classList.toggle('rf-has-ipv6',available);};
   new MutationObserver(syncIPv6).observe(ipv6,{subtree:true,childList:true,characterData:true});syncIPv6();
   for(const field of connection.querySelectorAll('[data-connection="wan"],[data-connection="wan6"],[data-connection="lan"]')){const button=el('button','rf-copy','复制');button.type='button';button.setAttribute('aria-label','复制 '+field.previousElementSibling.textContent);const line=el('div','rf-address-line');field.before(line);line.append(field,button);button.addEventListener('click',async()=>{if(field.textContent==='—')return;try{await navigator.clipboard.writeText(field.textContent);button.textContent='已复制';}catch{button.textContent='复制失败';}setTimeout(()=>button.textContent='复制',1200);});}
   dash.replaceChildren(router,live,devices,systemTools,details);
 const section=el('section','zen-dash-panel zen-wan-share rf-share-bounded');devices.before(section);
 let periodButtons=[];
 const usage=usageUI.mount(section,{analysisHref:L.url('admin','zen','analysis'),onPeriodChange:key=>periodButtons.find(b=>b.dataset.period===key)?.click()});
 const source=el('div'),notice=el('p','zu-empty','正在读取互联网用量…');let received=false;section.append(notice);source.style.display='none';source.setAttribute('aria-hidden','true');section.append(source);
 await shares.mount(source,{onUpdate:data=>{received=true;notice.hidden=true;const entries=new Map();for(const direction of ['upload','download'])for(const slice of data[direction+'Breakdown'].slices){const entry=entries.get(slice.key)||{key:slice.key,label:slice.label,upload:0,download:0};entry[direction]=slice.bytes;entries.set(slice.key,entry);}usage.update({period:data.period,upload:data.upload,download:data.download,devices:[...entries.values()]});}});
 const syncNotice=()=>{notice.textContent=source.querySelector('.zen-share-status')?.textContent||(!received?source.querySelector('.zen-share-description')?.textContent:'')||'';notice.hidden=!notice.textContent;};new MutationObserver(syncNotice).observe(source,{subtree:true,childList:true,characterData:true});syncNotice();
 periodButtons=[...source.querySelectorAll('.zen-share-periods button')];periodButtons.forEach((button,i)=>button.dataset.period=['day','week','month','all'][i]);
 const redraw=()=>{model.lastW=0;model.renderTraffic(model.lastTraffic||{rxRate:0,txRate:0,rxTotal:0,txTotal:0,names:model.lastNames||[]});};
 new ResizeObserver(redraw).observe(live);redraw();
}});
