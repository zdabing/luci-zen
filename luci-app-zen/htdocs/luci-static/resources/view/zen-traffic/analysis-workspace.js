'use strict';
'require baseclass';
'require rpc';
'require view.zen-traffic.rate-history as rateHistory';
'require view.zen-traffic.device-timeline as deviceTimeline';
'require view.zen-traffic.device-reset as deviceReset';
'require view.zen-traffic.style as trafficStyle';
const callUsage=rpc.declare({object:'zen.traffic',method:'getWanUsage',reject:true});
const E=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const NS='http://www.w3.org/2000/svg';
const S=(tag,attrs,text)=>{const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
const format=n=>{let i=0;while(n>=1024&&i<4){n/=1024;i++;}return n.toFixed(i===0?0:i>2?2:1)+' '+['B','KB','MB','GB','TB'][i];};
const colors=['#1f7a5a','#b08d57','#5f7f94','#8a9a5b','#9c7972'];
const deviceColor=key=>{let hash=0;for(const char of key)hash=(hash*31+char.charCodeAt(0))>>>0;return key==='unassigned'?'#a7aaa0':colors[hash%colors.length];};
return baseclass.extend({async render(data){
  trafficStyle.inject();
  const status=data[0],facts=new Map(((data[1]&&data[1].dev)||[]).map(d=>[d.mac,d]));
  if(!status?.wan_daily)throw Error('当前流量服务不支持互联网历史，请更新服务。');
  const model={rateView:Object.create(rateHistory)},timeline=Object.create(deviceTimeline);
  const periodsModule=await L.require('view.zen.zen-share-periods');
  const measured=await callUsage();
  const records=await periodsModule.records(measured);
  const picker=await L.require('view.zen-traffic.date-picker');
  const selectUI=await L.require('view.zen.zen-select');
  const root=E('div');root.id='za-workspace';root.classList.add('zen-traffic-page');
  const modes=E('div','zen-segmented za-modes');modes.setAttribute('role','tablist');modes.setAttribute('aria-label','流量分析');
  const usage=E('section','za-usage-view'),rates=E('section','za-rate-panel');usage.id='za-usage';rates.id='za-rates';
  const modeButtons=[];
  for(const [index,label]of ['用量统计','速率回看'].entries()){
   const b=E('button','',label);b.type='button';b.id='za-mode-'+index;b.setAttribute('role','tab');b.setAttribute('aria-controls',index?rates.id:usage.id);
   b.addEventListener('click',()=>chooseMode(index));
   b.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:1-modeButtons.indexOf(b);chooseMode(next);modeButtons[next].focus();});
   modeButtons.push(b);modes.append(b);
  }
  for(const [index,panel]of [usage,rates].entries()){panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','za-mode-'+index);}
  const top=E('section','za-panel'),filters=E('div','za-filterbar'),periodLabel=E('span','za-period-label'),periods=E('div','zen-segmented zu-periods');periods.setAttribute('role','group');periods.setAttribute('aria-label','统计时间范围');
  filters.append(periodLabel,periods);
  const statLine=E('div','za-stat-line'),stat=E('div'),total=E('strong','za-total'),directions=E('div','za-totals-directions');
  stat.append(E('span','za-total-label','互联网总用量'),total);statLine.append(stat,directions);
  const trendHead=E('div','za-chart-head'),trendTitle=E('h3'),trendLegend=E('div','za-chart-legend');trendLegend.append(E('span','za-upload','↑ 上传'),E('span','za-download','↓ 下载'));trendHead.append(trendTitle,trendLegend);
  const trend=E('div'),readout=E('div','za-chart-readout');readout.setAttribute('role','status');top.append(filters,statLine,trendHead,trend,readout);
  const devicePanel=E('section','za-panel'),devicesHead=E('div','za-section-head za-devices-head');devicesHead.append(E('h2','','设备用量'),E('span','za-meta',records.devices.length+' 台设备'));
  const deviceLayout=E('div','za-device-layout'),tableArea=E('div','za-table-area'),tableTools=E('div','za-table-tools'),search=E('input','za-search');
  search.type='search';search.placeholder='搜索设备、IP 或 MAC';search.setAttribute('aria-label','搜索统计设备');
  const sort=E('select');sort.setAttribute('aria-label','设备用量排序');for(const [value,label]of [['total','按总用量'],['upload','按上传用量'],['download','按下载用量']]){const o=E('option','',label);o.value=value;sort.append(o);}
  tableTools.append(search,sort);const tableHead=E('div','za-device-table-head');for(const text of ['设备','总量','↑ 上传','↓ 下载',''])tableHead.append(E('span','',text));
  const rows=E('div'),listFooter=E('div','za-list-footer'),listCount=E('span'),more=E('button','za-text-button');more.type='button';more.setAttribute('aria-expanded','false');rows.id='za-device-list';more.setAttribute('aria-controls',rows.id);listFooter.append(listCount,more);
  tableArea.append(tableTools,tableHead,rows,listFooter);deviceLayout.append(tableArea);devicePanel.append(devicesHead,deviceLayout);const lower=E('div','zc-analysis-lower');usage.append(top,lower);
  const todayKey=records.today;
  const ledger=records.network.days.map(day=>({...day})).sort((a,b)=>a.date.localeCompare(b.date));
  if(!ledger.length)ledger.push({date:todayKey,upload:0,download:0});
  const byDay=new Map(ledger.map(day=>{
   const devices=records.devices.map(([mac,history])=>{const row=history.days.find(r=>r.date===day.date)||{};return {key:mac,label:records.names.get(mac)||facts.get(mac)?.host||mac,ip:facts.get(mac)?.ip4||'',upload:Math.max(0,Number(row.upload)||0),download:Math.max(0,Number(row.download)||0)};});
   const sum=devices.reduce((s,d)=>({upload:s.upload+d.upload,download:s.download+d.download}),{upload:0,download:0});
   const missing={key:'unassigned',label:'未归属',ip:'',upload:Math.max(0,(Number(day.upload)||0)-sum.upload),download:Math.max(0,(Number(day.download)||0)-sum.download)};
   if(missing.upload||missing.download)devices.push(missing);
   return [day.date,devices];
  }));
  const deviceOptions=records.devices.map(([key])=>({key,label:records.names.get(key)||facts.get(key)?.host||key}));
  for(const day of ledger){const rows=byDay.get(day.date);day.upload=rows.reduce((sum,row)=>sum+row.upload,0);day.download=rows.reduce((sum,row)=>sum+row.download,0);}
  const timelineRoot=timeline.render(status);
  const requestedDevice=(new URLSearchParams(location.search).get('mac')||'').toLowerCase();
  let period='week',expanded=false,selected=deviceOptions.some(d=>d.key===requestedDevice)?requestedDevice:deviceOptions[0]?.key||'',day=todayKey,snapshot=[];
  const detail=E('section','za-detail');detail.id='device-hourly';detail.tabIndex=-1;detail.setAttribute('aria-labelledby','za-hourly-title');
  const detailHead=E('div','za-detail-head'),detailIdentity=E('div'),detailName=E('h3','','每小时用量'),detailMeta=E('div','za-detail-meta'),close=E('button','za-close','×');detailName.id='za-hourly-title';close.type='button';close.setAttribute('aria-label','清除分时设备选择');
  detailIdentity.append(detailName,detailMeta);detailHead.append(detailIdentity,close);
  const detailTools=E('div','za-detail-tools'),date=timeline.date;date.max=todayKey;date.min=picker.shift(todayKey,-29);
  const deviceSelect=E('select');deviceSelect.setAttribute('aria-label','分时设备');const blankDevice=E('option','','选择设备');blankDevice.value='';deviceSelect.append(blankDevice);for(const d of deviceOptions){const option=E('option','',d.label);option.value=d.key;deviceSelect.append(option);}
  const deviceField=E('label','za-hourly-device'),dateField=E('label','za-hourly-date');deviceField.append(E('span','za-meta','设备'),deviceSelect);const dateControl=timelineRoot.querySelector('.zen-date-picker');dateField.append(E('span','za-meta','日期'),dateControl);
  const dayTotals=timeline.summary,hourly=timeline.body,hourReadout=timeline.notice,hourEmpty=E('p','za-meta','选择设备查看每小时用量');dayTotals.classList.add('za-detail-day');detailTools.append(deviceField,dateField,dayTotals);
  const hourlyHeading=E('div','za-chart-head');hourlyHeading.append(E('h3','','每小时用量'),trendLegend.cloneNode(true));
  detail.append(detailHead,detailTools,hourEmpty,hourlyHeading,hourly,hourReadout,timeline.appUsage);detail.classList.add('za-panel');lower.append(devicePanel,detail);
  function range(){if(period==='day')return ledger.filter(d=>d.date===todayKey).concat(ledger.some(d=>d.date===todayKey)?[]:[{date:todayKey,upload:0,download:0}]);if(period==='week'){return ledger.filter(d=>d.date>=periodsModule.startDate(todayKey,'week'));}if(period==='month')return ledger.filter(d=>d.date.slice(0,7)===todayKey.slice(0,7));return ledger;}
  function addMetric(host,label,amount,cls){const cell=E('div',cls);cell.append(E('span','',label),E('strong','',format(amount)));host.append(cell);}
  function drawBars(host,data,label,hours,onSelect,targetReadout){
   const W=Math.max(260,host.clientWidth||900),H=180,left=0,right=3,top=16,bottom=150,slot=(W-left-right)/Math.max(1,data.length),max=Math.max(1,...data.map(r=>r.upload+r.download))*1.12;
   const svg=S('svg',{viewBox:`0 0 ${W} ${H}`,class:'za-chart',role:'group','aria-label':label,preserveAspectRatio:'none'});
   for(const fraction of [0,.5,1]){const y=bottom-fraction*(bottom-top);svg.append(S('line',{x1:left,x2:W,y1:y,y2:y,class:'za-grid'}));}
   data.forEach((r,i)=>{const w=Math.min(36,slot*.64),x=left+slot*(i+.5)-w/2,dl=r.download/max*(bottom-top),ul=r.upload/max*(bottom-top),text=r.label||r.date.slice(5).replace('-','/');
    const value=text+' · ↑ '+format(r.upload)+' · ↓ '+format(r.download),g=S('g',{tabindex:0,role:'button','aria-label':value});g.append(S('rect',{x:left+slot*i,y:top,width:slot,height:bottom-top,fill:'transparent'}),S('rect',{x,y:bottom-dl,width:w,height:dl,rx:2,class:'za-bar-download'}),S('rect',{x,y:bottom-dl-ul,width:w,height:ul,rx:2,class:'za-bar-upload'}),S('title',{},value));
    for(const name of ['pointerenter','focus'])g.addEventListener(name,()=>targetReadout.textContent=value);
    g.addEventListener('click',()=>{targetReadout.textContent=value;onSelect?.(r);});g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();targetReadout.textContent=value;onSelect?.(r);}});svg.append(g);
    const stride=hours?4:Math.max(1,Math.ceil(data.length/7));if((i%stride===0&&(i===0||data.length-1-i>=stride/2))||i===data.length-1)svg.append(S('text',{x:left+slot*(i+.5),y:174,'text-anchor':'middle'},hours?text.slice(0,5):text));
   });host.replaceChildren(svg);
  }
  let timelineKey='';
  function showDetail(scroll=false){
   const device=deviceOptions.find(d=>d.key===selected);deviceSelect.value=selected;deviceSelect.zenPicker?.sync();hourEmpty.hidden=!!device;close.hidden=!device;detailMeta.hidden=!device;for(const part of [dayTotals,hourlyHeading,hourly,hourReadout,timeline.appUsage])part.hidden=!device;if(!device){timelineKey='';timeline.select('');return;}
   detailMeta.textContent=facts.get(device.key)?.ip4||'';
   if(!picker.selectable(day,date.min,date.max))return;
   const key=selected+'|'+date.value;
   if(key!==timelineKey){timelineKey=key;timeline.select(selected);}
   if(scroll){detail.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});detail.focus({preventScroll:true});}
  }
  function selectDevice(key,scroll=true){if(key==='unassigned')return;selected=selected===key?'':key;renderRows();showDetail(scroll);}
  function renderRows(){
   const query=search.value.trim().toLowerCase(),key=sort.value||'total',all=snapshot.filter(d=>(d.label+' '+d.ip+' '+d.key).toLowerCase().includes(query)).sort((a,b)=>(key==='total'?b.upload+b.download-a.upload-a.download:b[key]-a[key]));
   const shown=expanded?all:all.slice(0,5),totals=snapshot.reduce((t,d)=>({upload:t.upload+d.upload,download:t.download+d.download}),{upload:0,download:0});rows.replaceChildren();
   for(const d of shown){const row=E('button','za-device-row');row.type='button';row.dataset.mac=d.key;row.setAttribute('aria-expanded',String(selected===d.key));row.setAttribute('aria-controls',detail.id);const name=E('span','za-device-name'),swatch=E('i','za-swatch'),identity=E('span');swatch.style.background=deviceColor(d.key);identity.append(E('strong','',d.label),E('small','',d.ip));name.append(swatch,identity);row.append(name,E('span','za-device-amount zc-total',format(d.upload+d.download)));
    for(const direction of ['upload','download']){const amount=E('span','za-device-amount za-'+direction,format(d[direction]));row.append(amount);}row.append(E('span','za-row-arrow',d.key==='unassigned'?'—':selected===d.key?'●':'›'));row.disabled=d.key==='unassigned';row.setAttribute('aria-label',d.key==='unassigned'?d.label:d.label+' · 查看分时用量');row.addEventListener('click',()=>selectDevice(d.key));rows.append(row);
   }
   if(!all.length)rows.append(E('p','za-meta','没有匹配的设备'));listCount.textContent=all.filter(d=>d.key!=='unassigned').length+' 台设备';more.hidden=all.length<=5;more.textContent=expanded?'收起':'更多';more.setAttribute('aria-expanded',String(expanded));
  }
  function refresh(){const dates=range();if(!dates.length)dates.push({date:todayKey,upload:0,download:0});const sums=new Map();for(const d of dates)for(const row of byDay.get(d.date)||deviceOptions.map(d=>({...d,ip:facts.get(d.key)?.ip4||'',upload:0,download:0}))){const sum=sums.get(row.key)||{...row,upload:0,download:0};sum.upload+=row.upload;sum.download+=row.download;sums.set(row.key,sum);}snapshot=[...sums.values()];const t=snapshot.reduce((t,d)=>({upload:t.upload+d.upload,download:t.download+d.download}),{upload:0,download:0});
   periodLabel.textContent=dates[0].date.replaceAll('-',' / ')+(dates.length>1?' — '+dates.at(-1).date.slice(5).replace('-',' / '):'');const parts=format(t.upload+t.download).split(' ');total.replaceChildren(document.createTextNode(parts[0]),E('small','',parts[1]));directions.replaceChildren();addMetric(directions,'↓ 下载',t.download,'za-download');addMetric(directions,'↑ 上传',t.upload,'za-upload');
   trendTitle.textContent='每日用量';readout.textContent='';for(const part of [trendHead,trend,readout])part.hidden=dates.length===1;drawBars(trend,dates,'互联网每日用量',false,r=>{if(selected&&r.date){day=r.date;date.value=day;date.dispatchEvent(new Event('change'));showDetail(true);}},readout);
   renderRows();showDetail();
  }
  for(const [value,label]of [['day','本日'],['week','本周'],['month','本月'],['all','全部']]){const b=E('button','',label);b.type='button';b.dataset.period=value;b.setAttribute('aria-pressed',String(value===period));b.addEventListener('click',()=>{period=value;expanded=false;for(const button of periods.children)button.setAttribute('aria-pressed',String(button===b));refresh();});periods.append(b);}
  search.addEventListener('input',()=>{expanded=false;renderRows();});sort.addEventListener('change',renderRows);more.addEventListener('click',()=>{expanded=!expanded;renderRows();});close.addEventListener('click',()=>{const key=selected;selected='';showDetail();renderRows();rows.querySelector('[data-mac="'+key+'"]')?.focus();});date.addEventListener('change',()=>{day=date.value;timelineKey=selected+'|'+date.value;});
  deviceSelect.addEventListener('change',()=>{selected=deviceSelect.value;renderRows();showDetail();});
  const rateRoot=model.rateView.render({data:{samples:[],interfaces:[],step:5}});rates.append(rateRoot);
  const rateSummary=rateRoot.querySelector('.zen-rt-summary');const alignRateSummary=()=>{const items=rateSummary?.children;if(items?.length===2&&items[0].querySelector('.zen-rt-dl'))rateSummary.prepend(items[1]);};alignRateSummary();new MutationObserver(alignRateSummary).observe(rateSummary,{childList:true});
  const sections=rateRoot.querySelectorAll(':scope > .cbi-section'),raw=E('details','za-rate-raw');raw.append(E('summary','','原始采样'));if(sections.length>2){raw.append(sections[2]);rateRoot.append(raw);}
  const rateSelects=rateRoot.querySelectorAll('select');for(const select of rateSelects)if(select.options.length)selectUI.enhance(select);
  const management=E('details','za-rate-raw'),reset=Object.create(deviceReset).build([...facts.values()],()=>selected,()=>window.location.reload());management.append(E('summary','','统计管理'),reset);usage.append(management);
  root.append(modes,usage,rates);requestAnimationFrame(()=>{const head=document.querySelector('.rf-page-head');if(head)head.append(modes);});selectUI.enhance(sort);selectUI.enhance(deviceSelect);
  let ratesStarted=false;
  function chooseMode(index){usage.hidden=!!index;rates.hidden=!index;modeButtons.forEach((b,i)=>{b.setAttribute('aria-selected',String(i===index));b.tabIndex=i===index?0:-1;});if(index&&!ratesStarted){ratesStarted=true;model.rateView.query().then(()=>{for(const select of rateSelects){if(!select.value&&select.options.length)select.value=select.options[0].value;selectUI.enhance(select);select.zenPicker.sync();}});}const url=new URL(location.href);if(index)url.searchParams.set('tab','rates');else url.searchParams.delete('tab');history.replaceState(null,'',url);}
  refresh();chooseMode(selected||location.hash==='#device-hourly'?0:new URLSearchParams(location.search).get('tab')==='rates'?1:0);if(location.hash==='#device-hourly')requestAnimationFrame(()=>{detail.scrollIntoView({block:'start'});detail.focus({preventScroll:true});});let lastWidth=top.clientWidth;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(root.isConnected&&width>0&&width!==lastWidth){lastWidth=width;refresh();if(selected)timeline.query();}}).observe(top);return root;
}});
