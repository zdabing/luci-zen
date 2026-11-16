'use strict';
'require baseclass';
'require rpc';
'require view.zen-traffic.device-timeline as deviceTimeline';
'require view.zen-traffic.style as trafficStyle';
const callStatus=rpc.declare({object:'zen.traffic',method:'getStatus'});
const callUsage=rpc.declare({object:'zen.traffic',method:'getWanUsage',reject:true});
const callP2pUsage=rpc.declare({object:'zen.traffic',method:'getP2pUsage'});
const callRateHistory=rpc.declare({object:'zen.traffic',method:'getRealtimeHistory',params:['iface','start','end','limit'],reject:true});
const E=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const NS='http://www.w3.org/2000/svg';
const S=(tag,attrs,text)=>{const n=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text!=null)n.textContent=text;return n;};
const format=n=>{let i=0;while(n>=1024&&i<4){n/=1024;i++;}return n.toFixed(i===0?0:i>2?2:1)+' '+['B','KB','MB','GB','TB'][i];};
const fmtRate=n=>{let v=Math.max(0,Number(n)||0),i=0;while(v>=1024&&i<3){v/=1024;i++;}return v.toFixed(i?(v>=100?0:1):0)+' '+['B/s','KB/s','MB/s','GB/s'][i];};
const fmtPkts=n=>{const v=Math.max(0,Math.round(Number(n)||0));return v>=1e4?(v/1e4).toFixed(v>=1e6?1:2)+' 万包':v.toLocaleString()+' 包';};
const colors=Array.from({length:8},(_,i)=>'var(--chart-series-'+(i+1)+')');
const deviceColor=key=>{let hash=0;for(const char of key)hash=(hash*31+char.charCodeAt(0))>>>0;return key==='unassigned'?'var(--chart-unassigned)':colors[hash%colors.length];};
return baseclass.extend({async render(data){
  trafficStyle.inject();
  const status=data[0],facts=new Map(((data[1]&&data[1].dev)||[]).map(d=>[d.mac,d]));
  if(!status?.wan_daily)throw Error('当前流量服务不支持互联网历史，请更新服务。');
  const timeline=Object.create(deviceTimeline);
  const periodsModule=await L.require('view.zen.zen-share-periods');
  const [measured,rawP2p]=await Promise.all([callUsage(),callP2pUsage().catch(()=>null)]);
  const p2pData=rawP2p&&typeof rawP2p.json==='string'?JSON.parse(rawP2p.json):(rawP2p||{});
  const p2pDayMap=new Map(((p2pData&&p2pData.days)||[]).map(r=>[r.date,Math.max(0,Number(r.dropped)||0)]));
  const p2pDevDayMap=new Map(((p2pData&&p2pData.devices)||[]).map(d=>[d.mac,new Map((d.days||[]).map(r=>[r.date,Math.max(0,Number(r.dropped)||0)]))]));
  const records=await periodsModule.records(measured);
  const picker=await L.require('view.zen-traffic.date-picker');
  const selectUI=await L.require('view.zen.zen-select');
  const root=E('div');root.id='za-workspace';root.classList.add('zen-traffic-page');
  const usage=E('section','za-usage-view');usage.id='za-usage';
  const top=E('section','za-panel'),filters=E('div','za-filterbar'),topRange=E('div','za-date-range'),periods=E('div','zen-segmented zu-periods');periods.setAttribute('role','group');periods.setAttribute('aria-label','统计时间范围');
  filters.append(topRange,periods);
  const statLine=E('div','za-stat-line'),stat=E('div'),total=E('strong','za-total'),directions=E('div','za-totals-directions');
  stat.append(E('span','za-total-label','互联网总用量'),total);statLine.append(stat,directions);
  const trendHead=E('div','za-chart-head'),trendTitle=E('h3'),trendLegend=E('div','za-chart-legend');trendLegend.append(E('span','za-upload','↑ 上传'),E('span','za-download','↓ 下载'));trendHead.append(trendTitle,trendLegend);
  const trend=E('div'),readout=E('div','za-chart-readout');readout.setAttribute('role','status');top.append(filters,statLine,trendHead,trend,readout);
  const devicePanel=E('section','za-panel'),devicesHead=E('div','za-section-head za-devices-head');devicesHead.append(E('h2','','设备用量'),E('span','za-meta',records.devices.length+' 台设备'));
  const deviceLayout=E('div','za-device-layout'),tableArea=E('div','za-table-area'),tableTools=E('div','za-table-tools'),search=E('input','za-search');
  search.type='search';search.placeholder='搜索设备、IP 或 MAC';search.setAttribute('aria-label','搜索统计设备');
  const sort=E('select');sort.setAttribute('aria-label','设备用量排序');for(const [value,label]of [['total','按总用量'],['upload','按上传用量'],['download','按下载用量'],['p2p','按 P2P 拦截']]){const o=E('option','',label);o.value=value;sort.append(o);}
  tableTools.append(search,sort);const tableHead=E('div','za-device-table-head');for(const text of ['设备','总量','↑ 上传','↓ 下载','P2P 拦截',''])tableHead.append(E('span','',text));
  const rows=E('div'),listFooter=E('div','za-list-footer'),listCount=E('span'),more=E('button','za-text-button');more.type='button';more.setAttribute('aria-expanded','false');rows.id='za-device-list';more.setAttribute('aria-controls',rows.id);
  listFooter.append(listCount,more);
  tableArea.append(tableTools,tableHead,rows,listFooter);deviceLayout.append(tableArea);devicePanel.append(devicesHead,deviceLayout);
  const ratePanel=E('section','za-panel za-rate-card'),rateHead=E('div','za-section-head za-rate-head'),rateTitleBox=E('div'),rateMeta=E('div','za-detail-meta','WAN 速率趋势 · 保留最近 7 天'),ratePeriods=E('div','zen-segmented zu-periods');
  ratePeriods.setAttribute('role','group');ratePeriods.setAttribute('aria-label','速率回看时间范围');rateTitleBox.append(E('h2','','速率回看'),rateMeta);rateHead.append(rateTitleBox,ratePeriods);
  const rateSummary=E('div','zen-rt-summary has-p2p'),rateLegend=E('div','za-rate-legend'),rateLegendItems=E('div','za-rate-legend-items'),rateSourceToggle=E('div','za-rate-source-toggle');
  rateLegendItems.append(E('span','za-download','↓ 下载'),E('span','za-upload','↑ 上传'));
  rateSourceToggle.setAttribute('role','group');rateSourceToggle.setAttribute('aria-label','速率口径切换');rateSourceToggle.hidden=true;
  rateLegend.append(rateLegendItems,rateSourceToggle);
  const rateChartWrap=E('div','za-rate-chart-wrap'),rateReadout=E('div','zen-timeline-readout','正在加载速率历史…');rateReadout.setAttribute('role','status');
  ratePanel.append(rateHead,rateSummary,rateLegend,rateChartWrap,rateReadout);
  const leftCol=E('div','zc-analysis-left');leftCol.append(devicePanel,ratePanel);
  const lower=E('div','zc-analysis-lower');usage.append(top,lower);
  const todayKey=records.today;
  const ledgerMap=new Map(records.network.days.map(day=>[day.date,{...day,p2p:p2pDayMap.get(day.date)||0}]));
  for(const [date,dropped] of p2pDayMap){if(!ledgerMap.has(date))ledgerMap.set(date,{date,upload:0,download:0,p2p:dropped});}
  const ledger=[...ledgerMap.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(!ledger.length)ledger.push({date:todayKey,upload:0,download:0,p2p:0});
  const allDeviceMacs=[...new Set([...records.devices.map(([mac])=>mac),...p2pDevDayMap.keys()])];
  const historyByMac=new Map(records.devices);
  const byDay=new Map(ledger.map(day=>{
   const devices=allDeviceMacs.map(mac=>{const history=historyByMac.get(mac)||{days:[]};const row=(history.days||[]).find(r=>r.date===day.date)||{};const p2p=p2pDevDayMap.get(mac)?.get(day.date)||0;return {key:mac,label:records.names.get(mac)||facts.get(mac)?.host||mac,ip:facts.get(mac)?.ip4||'',upload:Math.max(0,Number(row.upload)||0),download:Math.max(0,Number(row.download)||0),p2p};});
   const sum=devices.reduce((s,d)=>({upload:s.upload+d.upload,download:s.download+d.download}),{upload:0,download:0});
   const missing={key:'unassigned',label:'未归属',ip:'',upload:Math.max(0,(Number(day.upload)||0)-sum.upload),download:Math.max(0,(Number(day.download)||0)-sum.download),p2p:0};
   if(missing.upload||missing.download)devices.push(missing);
   return [day.date,devices];
  }));
  const deviceOptions=allDeviceMacs.map(key=>({key,label:records.names.get(key)||facts.get(key)?.host||key}));
  for(const day of ledger){const rows=byDay.get(day.date);day.upload=rows.reduce((sum,row)=>sum+row.upload,0);day.download=rows.reduce((sum,row)=>sum+row.download,0);day.p2p=p2pDayMap.get(day.date)||rows.reduce((sum,row)=>sum+(row.p2p||0),0);}
  const timelineRoot=timeline.render(status);
  const earliestLedger=ledger.length?ledger[0].date:todayKey;
  let suppressTopDate=false;
  function presetBounds(p){
   if(p==='day')return [todayKey,todayKey];
   if(p==='week')return [periodsModule.startDate(todayKey,'week'),todayKey];
   if(p==='month')return [todayKey.slice(0,7)+'-01',todayKey];
   if(p==='all')return [earliestLedger,todayKey];
   return [customStart,customEnd];
  }
  const topStartInput=E('input',{type:'date',value:todayKey,min:earliestLedger,max:todayKey});
  const topEndInput=E('input',{type:'date',value:todayKey,min:earliestLedger,max:todayKey});
  const topStartCtrl=picker.create(topStartInput,{today:todayKey}),topEndCtrl=picker.create(topEndInput,{today:todayKey});
  topRange.append(topStartCtrl,E('span','za-date-sep','至'),topEndCtrl);
  function syncTopDates(s,e){
   suppressTopDate=true;
   try{
    if(topStartInput.value!==s){topStartInput.value=s;topStartInput.dispatchEvent(new Event('change'));}
    if(topEndInput.value!==e){topEndInput.value=e;topEndInput.dispatchEvent(new Event('change'));}
   }finally{suppressTopDate=false;}
  }
  const requestedDevice=(new URLSearchParams(location.search).get('mac')||'').toLowerCase();
  let period='week',expanded=false,selected=deviceOptions.some(d=>d.key===requestedDevice)?requestedDevice:'',day=todayKey,snapshot=[];
  let [customStart,customEnd]=presetBounds(period);
  syncTopDates(customStart,customEnd);
  const detail=E('section','za-detail');detail.id='device-hourly';detail.tabIndex=-1;detail.setAttribute('aria-labelledby','za-hourly-title');
  const detailHead=E('div','za-detail-head'),detailIdentity=E('div'),detailName=E('h3','','每小时用量与 P2P 拦截'),detailMeta=E('div','za-detail-meta'),close=E('button','za-close','×');detailName.id='za-hourly-title';close.type='button';close.setAttribute('aria-label','切换回整机汇总');
  const detailTools=E('div','za-detail-tools'),date=timeline.date,endDate=timeline.endDate;date.max=todayKey;date.min=picker.shift(todayKey,-29);endDate.max=todayKey;endDate.min=date.min;
  const deviceSelect=E('select');deviceSelect.setAttribute('aria-label','分时设备');const blankDevice=E('option','','全部设备（整机汇总）');blankDevice.value='';deviceSelect.append(blankDevice);for(const d of deviceOptions){const option=E('option','',d.label);option.value=d.key;deviceSelect.append(option);}
  const deviceField=E('label','za-hourly-device');deviceField.append(E('span','za-meta','设备'),deviceSelect);
  detailIdentity.append(detailName,detailMeta);detailHead.append(detailIdentity,deviceField,close);
  const dayTotals=timeline.summary,hourly=timeline.body,hourReadout=timeline.notice,hourEmpty=E('p','za-meta','当前展示整机全部设备每小时流量、P2P 拦截与应用识别汇总；选择单台设备可单独查看该设备明细。');dayTotals.classList.add('za-detail-day');detailTools.append(dayTotals);
  const hourlyHeading=E('div','za-chart-head');hourlyHeading.append(E('h3','','每小时用量'),trendLegend.cloneNode(true));
  detail.append(detailHead,detailTools,hourEmpty,hourlyHeading,hourly,hourReadout,timeline.appUsage);detail.classList.add('za-panel');lower.append(leftCol,detail);
  function range(){const [s,e]=presetBounds(period);const list=ledger.filter(d=>d.date>=s&&d.date<=e);return list.length?list:[{date:s,upload:0,download:0,p2p:0}];}
  function addMetric(host,label,amount,cls,rawText){const cell=E('div',cls);cell.append(E('span','',label),E('strong','',rawText||format(amount)));host.append(cell);}
  function drawBars(host,data,label,hours,onSelect,targetReadout){
   const W=Math.max(260,host.clientWidth||900),H=180,left=0,right=3,top=16,bottom=150,slot=(W-left-right)/Math.max(1,data.length),max=Math.max(1,...data.map(r=>r.upload+r.download))*1.12;
   const svg=S('svg',{viewBox:`0 0 ${W} ${H}`,class:'za-chart',role:'group','aria-label':label,preserveAspectRatio:'none'});
   for(const fraction of [0,.5,1]){const y=bottom-fraction*(bottom-top);svg.append(S('line',{x1:left,x2:W,y1:y,y2:y,class:'za-grid'}));}
   data.forEach((r,i)=>{const w=Math.min(36,slot*.64),x=left+slot*(i+.5)-w/2,dl=r.download/max*(bottom-top),ul=r.upload/max*(bottom-top),text=r.label||r.date.slice(5).replace('-','/');
    const value=text+' · ↑ '+format(r.upload)+' · ↓ '+format(r.download)+(r.p2p?' · P2P 拦截 '+r.p2p.toLocaleString()+' 包':''),g=S('g',{tabindex:0,role:'button','aria-label':value});g.append(S('rect',{x:left+slot*i,y:top,width:slot,height:bottom-top,fill:'transparent'}),S('rect',{x,y:bottom-dl,width:w,height:dl,rx:2,class:'za-bar-download'}),S('rect',{x,y:bottom-dl-ul,width:w,height:ul,rx:2,class:'za-bar-upload'}),S('title',{},value));
    for(const name of ['pointerenter','focus'])g.addEventListener(name,()=>targetReadout.textContent=value);
    g.addEventListener('click',()=>{targetReadout.textContent=value;onSelect?.(r);});g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();targetReadout.textContent=value;onSelect?.(r);}});svg.append(g);
    const stride=hours?4:Math.max(1,Math.ceil(data.length/7));if((i%stride===0&&(i===0||data.length-1-i>=stride/2))||i===data.length-1)svg.append(S('text',{x:left+slot*(i+.5),y:174,'text-anchor':'middle'},hours?text.slice(0,5):text));
   });host.replaceChildren(svg);
  }
  let timelineKey='';
  function showDetail(scroll=false){
   const device=deviceOptions.find(d=>d.key===selected);deviceSelect.value=selected;deviceSelect.zenPicker?.sync();hourEmpty.hidden=!!device;close.hidden=!device;detailMeta.hidden=!device;
   for(const part of [dayTotals,hourlyHeading,hourly,hourReadout,timeline.appUsage])part.hidden=false;
   detailMeta.textContent=device?(facts.get(device.key)?.ip4||''):'整机汇总';
   const targetMac=device?selected:'';
   const key=targetMac+'|'+date.value+'|'+(endDate?.value||date.value);
   if(key!==timelineKey){timelineKey=key;timeline.select(targetMac);}
   if(scroll){detail.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});detail.focus({preventScroll:true});}
  }
  function selectDevice(key,scroll=true){if(key==='unassigned')return;selected=selected===key?'':key;renderRows();showDetail(scroll);}
  function renderRows(){
   const query=search.value.trim().toLowerCase(),key=sort.value||'total',all=snapshot.filter(d=>(d.label+' '+d.ip+' '+d.key).toLowerCase().includes(query)).sort((a,b)=>(key==='total'?b.upload+b.download-a.upload-a.download:key==='p2p'?(b.p2p||0)-(a.p2p||0)||(b.upload+b.download-a.upload-a.download):b[key]-a[key]));
   const shown=expanded?all:all.slice(0,8);rows.replaceChildren();
   for(const [index,d] of shown.entries()){const row=E('button','za-device-row');row.type='button';row.dataset.mac=d.key;row.setAttribute('aria-expanded',String(selected===d.key));row.setAttribute('aria-controls',detail.id);const name=E('span','za-device-name'),swatch=E('i','za-swatch'),identity=E('span');swatch.style.background=d.key==='unassigned'?'var(--chart-unassigned)':colors[index%colors.length];
    identity.append(E('strong','',d.label),E('small','',d.ip||d.key));name.append(swatch,identity);row.append(name,E('span','za-device-amount zc-total',format(d.upload+d.download)));
    for(const direction of ['upload','download']){const amount=E('span','za-device-amount za-'+direction,format(d[direction]));row.append(amount);}
    row.append(E('span','za-device-amount za-p2p',d.p2p>0?fmtPkts(d.p2p):'—'));
    row.append(E('span','za-row-arrow',d.key==='unassigned'?'—':selected===d.key?'●':'›'));row.disabled=d.key==='unassigned';row.setAttribute('aria-label',d.key==='unassigned'?d.label:d.label+' · 查看分时用量');row.addEventListener('click',()=>selectDevice(d.key));rows.append(row);
   }
   if(!all.length)rows.append(E('p','za-meta','没有匹配的设备'));listCount.textContent=all.filter(d=>d.key!=='unassigned').length+' 台设备';more.hidden=all.length<=8;more.textContent=expanded?'收起':'更多';more.setAttribute('aria-expanded',String(expanded));
  }
  function refresh(syncRight=false){const dates=range();if(!dates.length)dates.push({date:todayKey,upload:0,download:0,p2p:0});const sums=new Map();for(const d of dates)for(const row of byDay.get(d.date)||deviceOptions.map(d=>({...d,ip:facts.get(d.key)?.ip4||'',upload:0,download:0,p2p:0}))){const sum=sums.get(row.key)||{...row,upload:0,download:0,p2p:0};sum.upload+=row.upload;sum.download+=row.download;sum.p2p+=(row.p2p||0);sums.set(row.key,sum);}snapshot=[...sums.values()];const t=snapshot.reduce((t,d)=>({upload:t.upload+d.upload,download:t.download+d.download,p2p:t.p2p+(d.p2p||0)}),{upload:0,download:0,p2p:0});
   const p2pTotal=period==='all'?Math.max(t.p2p,Number(p2pData?.total?.dropped)||0):t.p2p;
   const [boundStart,boundEnd]=presetBounds(period);syncTopDates(boundStart,boundEnd);
   const parts=format(t.upload+t.download).split(' ');total.replaceChildren(document.createTextNode(parts[0]),E('small','',parts[1]));directions.replaceChildren();addMetric(directions,'↓ 下载',t.download,'za-download');addMetric(directions,'↑ 上传',t.upload,'za-upload');addMetric(directions,'🛡 P2P 拦截',p2pTotal,'za-p2p',fmtPkts(p2pTotal));
   trendTitle.textContent='每日用量与拦截趋势';readout.textContent='';for(const part of [trendHead,trend,readout])part.hidden=dates.length===1;drawBars(trend,dates,'互联网每日用量',false,r=>{if(r.date){day=r.date;timeline.setRange(r.date,r.date);timelineKey=(selected||'')+'|'+date.value+'|'+endDate.value;showDetail(true);}},readout);
   renderRows();
   if(syncRight){timeline.setRange(boundStart,boundEnd);timelineKey=(selected||'')+'|'+date.value+'|'+endDate.value;}
   showDetail();
  }
  for(const [value,label]of [['day','本日'],['week','本周'],['month','本月'],['all','全部']]){const b=E('button','',label);b.type='button';b.dataset.period=value;b.setAttribute('aria-pressed',String(value===period));b.addEventListener('click',()=>{period=value;expanded=false;for(const button of periods.children)button.setAttribute('aria-pressed',String(button===b));refresh(true);});periods.append(b);}
  const onTopDateChange=which=>{
   if(suppressTopDate)return;
   let s=topStartInput.value,e=topEndInput.value;
   if(!s||!e)return;
   if(s>e){if(which==='start')e=s;else s=e;}
   customStart=s;customEnd=e;period='custom';expanded=false;
   for(const button of periods.children)button.setAttribute('aria-pressed','false');
   refresh(true);
  };
  topStartInput.addEventListener('change',()=>onTopDateChange('start'));
  topEndInput.addEventListener('change',()=>onTopDateChange('end'));
  search.addEventListener('input',()=>{expanded=false;renderRows();});sort.addEventListener('change',renderRows);more.addEventListener('click',()=>{expanded=!expanded;renderRows();});close.addEventListener('click',()=>{const key=selected;selected='';showDetail();renderRows();rows.querySelector('[data-mac="'+key+'"]')?.focus();});
  timeline.onRangeChange=()=>{timelineKey=(selected||'')+'|'+date.value+'|'+endDate.value;};
  deviceSelect.addEventListener('change',()=>{selected=deviceSelect.value;renderRows();showDetail();});
  let ratePreset='sync',rateSource='device',rateReq=0,rateData=null,rateIface='',tlState=null,rateHoverSync=null;
  const localDayStart=str=>{const [y,m,d]=str.split('-').map(Number);return Math.floor(new Date(y,m-1,d,0,0,0,0).getTime()/1000);};
  const ratePeriodBtns=[];
  for(const [val,label]of [['sync','随筛选'],[3600,'1 小时'],[21600,'6 小时'],[86400,'24 小时'],[604800,'7 天']]){
   const b=E('button','',label);b.type='button';b.setAttribute('aria-pressed',String(val===ratePreset));
   if(val==='sync')b.title='跟随页面筛选、选中设备及右侧点击时段联动';
   b.addEventListener('click',()=>{ratePreset=val;syncRateButtons();syncRateHistory();});
   ratePeriodBtns.push([val,b]);ratePeriods.append(b);
  }
  const sourceBtns=[];
  for(const [val,label]of [['device','设备均速'],['wan','WAN 5s']]){
   const b=E('button','',label);b.type='button';b.setAttribute('aria-pressed',String(val===rateSource));
   b.addEventListener('click',()=>{rateSource=val;ratePreset='sync';syncRateButtons();syncRateHistory();});
   sourceBtns.push([val,b]);rateSourceToggle.append(b);
  }
  function syncRateButtons(){
   for(const [val,b]of ratePeriodBtns)b.setAttribute('aria-pressed',String(val===ratePreset));
   const hasDevice=!!deviceOptions.find(d=>d.key===selected);
   rateSourceToggle.hidden=!hasDevice||ratePreset!=='sync';
   for(const [val,b]of sourceBtns)b.setAttribute('aria-pressed',String(val===rateSource));
  }
  function buildHourlyRateData(tl,deviceObj,reasonNote){
   const daySpan=Math.max(1,tl.days?.length||1);
   const samples=(tl.rows||[]).map((row,idx)=>({
    time:row.time+1800,barStart:row.time,hourIdx:idx,label:row.label,available:!!row.available,
    download:row.available?Math.round(row.download/(3600*daySpan)):0,
    upload:row.available?Math.round(row.upload/(3600*daySpan)):0
   }));
   const start=samples.length?samples[0].barStart:0;
   const end=samples.length?samples[samples.length-1].barStart+3600:3600;
   const spanText=tl.isMultiDay?(tl.startStr.slice(5)+' 至 '+tl.endStr.slice(5)+' 日均分时速率'):(tl.startStr+' 分时均速');
   const prefix=deviceObj?deviceObj.label+' · ':'整机汇总 · ';
   return {
    kind:'hourly',start,end,step:3600,canPin:!tl.isMultiDay,
    pinnedIdx:tl.pinned?.index??null,
    subtitle:prefix+spanText+(reasonNote?' · '+reasonNote:' · 由每小时流量折算'),
    samples
   };
  }
  function renderRateCard(){
   if(!rateData)return;
   syncRateButtons();
   const isHourly=rateData.kind==='hourly';
   const samples=(rateData.samples||[]).filter(s=>Number.isFinite(Number(s.time)));
   const valid=samples.filter(s=>s.available!==false);
   rateMeta.textContent=rateData.subtitle||'WAN 速率趋势';
   const maxDl=valid.length?Math.max(...valid.map(s=>Number(s.download)||0)):0;
   const maxUl=valid.length?Math.max(...valid.map(s=>Number(s.upload)||0)):0;
   const avgDl=valid.length?valid.reduce((sum,s)=>sum+(Number(s.download)||0),0)/valid.length:0;
   const avgUl=valid.length?valid.reduce((sum,s)=>sum+(Number(s.upload)||0),0)/valid.length:0;
   const mkCell=(label,val,cls)=>{const cell=E('div');cell.append(E('span','',label),E('strong',cls,val));return cell;};
   rateSummary.replaceChildren(
    mkCell(isHourly?'峰值下载均速':'峰值下载',fmtRate(maxDl),'za-download'),
    mkCell(isHourly?'峰值上传均速':'峰值上传',fmtRate(maxUl),'za-upload'),
    mkCell(isHourly?'时段平均下载':'平均下载',fmtRate(avgDl),''),
    mkCell(isHourly?'时段平均上传':'平均上传',fmtRate(avgUl),'')
   );
   rateChartWrap.replaceChildren();
   rateHoverSync=null;
   if(!samples.length){
    rateChartWrap.append(E('p','za-meta','暂无该时段速率采样，服务运行后每 5 秒自动记录。'));
    rateReadout.textContent='暂无速率采样';
    return;
   }
   const W=Math.max(260,rateChartWrap.clientWidth||480),H=175,padL=4,padR=4,padT=14,padB=22,iw=W-padL-padR,ih=H-padT-padB;
   const t0=Number.isFinite(Number(rateData.start))?Number(rateData.start):Number(samples[0].time);
   const t1=Number.isFinite(Number(rateData.end))?Number(rateData.end):Number(samples[samples.length-1].time);
   const span=Math.max(1,t1-t0),yMax=Math.max(1024,maxDl,maxUl)*1.12;
   const xOf=t=>padL+((Number(t)-t0)/span)*iw,yOf=v=>padT+ih-(Math.min(yMax,Math.max(0,Number(v)||0))/yMax)*ih;
   const svgEl=S('svg',{viewBox:`0 0 ${W} ${H}`,class:'za-rate-svg',role:'img','aria-label':'历史速率曲线'});
   for(const frac of [0,.5,1]){const gy=padT+ih*(1-frac);svgEl.append(S('line',{x1:padL,x2:W-padR,y1:gy,y2:gy,class:'za-grid'}));}
   svgEl.append(S('text',{x:padL+2,y:padT+10,'text-anchor':'start'},fmtRate(yMax)));
   const hoverBand=S('rect',{y:padT,height:ih,rx:3,fill:'var(--accent)','fill-opacity':'.09',visibility:'hidden'});
   svgEl.append(hoverBand);
   const stepSec=Number(rateData.step)||5,gapThreshold=isHourly?7200:Math.max(60,stepSec*3);
   const plotList=isHourly?valid:samples;
   for(const [key,stroke,areaAlpha]of [['download','var(--dl,#168bff)',0.14],['upload','var(--ul,#ff6a00)',0.10]]){
    let seg=[];
    const flush=()=>{
     if(seg.length===1){svgEl.append(S('circle',{cx:xOf(seg[0].time).toFixed(1),cy:yOf(seg[0][key]).toFixed(1),r:3,fill:stroke}));seg=[];return;}
     if(seg.length<2){seg=[];return;}
     const linePts=seg.map(s=>xOf(s.time).toFixed(1)+','+yOf(s[key]).toFixed(1));
     const areaPath=`M${xOf(seg[0].time).toFixed(1)},${(padT+ih).toFixed(1)} L${linePts.join(' L')} L${xOf(seg[seg.length-1].time).toFixed(1)},${(padT+ih).toFixed(1)} Z`;
     svgEl.append(S('path',{d:areaPath,fill:stroke,'fill-opacity':areaAlpha}));
     svgEl.append(S('polyline',{points:linePts.join(' '),fill:'none',stroke,'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'}));
     seg=[];
    };
    plotList.forEach((s,i)=>{if(i&&Number(s.time)-Number(plotList[i-1].time)>gapThreshold)flush();seg.push(s);});
    flush();
   }
   if(isHourly&&rateData.pinnedIdx!=null&&samples[rateData.pinnedIdx]?.available){
    const ps=samples[rateData.pinnedIdx],px=xOf(ps.time);
    svgEl.append(S('line',{x1:px.toFixed(1),x2:px.toFixed(1),y1:padT,y2:padT+ih,stroke:'var(--accent)','stroke-opacity':'.55','stroke-dasharray':'3 3'}));
    svgEl.append(S('circle',{cx:px.toFixed(1),cy:yOf(ps.download).toFixed(1),r:4.5,fill:'var(--dl,#168bff)',stroke:'var(--bg-panel,#fff)','stroke-width':1.5}));
    svgEl.append(S('circle',{cx:px.toFixed(1),cy:yOf(ps.upload).toFixed(1),r:4.5,fill:'var(--ul,#ff6a00)',stroke:'var(--bg-panel,#fff)','stroke-width':1.5}));
   }
   const fmtTick=t=>{
    const d=new Date(t*1000);
    if(isHourly)return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return span>86400?`${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
   };
   svgEl.append(S('text',{x:padL,y:H-4,'text-anchor':'start'},fmtTick(t0)));
   svgEl.append(S('text',{x:padL+iw/2,y:H-4,'text-anchor':'middle'},fmtTick(t0+span/2)));
   svgEl.append(S('text',{x:W-padR,y:H-4,'text-anchor':'end'},fmtTick(t1)));
   const cross=S('line',{y1:padT,y2:padT+ih,stroke:'var(--text-secondary)','stroke-opacity':'.45','stroke-dasharray':'3 3',visibility:'hidden'});
   const dotDl=S('circle',{r:3.5,fill:'var(--dl,#168bff)',stroke:'var(--bg-panel,#fff)','stroke-width':1.5,visibility:'hidden'});
   const dotUl=S('circle',{r:3.5,fill:'var(--ul,#ff6a00)',stroke:'var(--bg-panel,#fff)','stroke-width':1.5,visibility:'hidden'});
   const hit=S('rect',{x:padL,y:padT,width:iw,height:ih,fill:'transparent',style:isHourly&&rateData.canPin?'cursor:pointer':''});
   svgEl.append(cross,dotDl,dotUl,hit);
   const defaultSample=isHourly&&rateData.pinnedIdx!=null&&samples[rateData.pinnedIdx]?samples[rateData.pinnedIdx]:(valid.at(-1)||samples.at(-1));
   const showSample=(s,showCross)=>{
    let prefixLabel;
    if(isHourly){
     prefixLabel=(s.label||'')+(s.available===false?'（暂无记录）':' · 均速');
    }else{
     const d=new Date(Number(s.time)*1000);
     prefixLabel=`${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    }
    rateReadout.textContent=`${prefixLabel} · ↓ 下载 ${fmtRate(s.download)} · ↑ 上传 ${fmtRate(s.upload)}`+(isHourly&&rateData.canPin?' · 点击可联动应用用量':'');
    const px=xOf(s.time);
    cross.setAttribute('x1',px.toFixed(1));cross.setAttribute('x2',px.toFixed(1));
    dotDl.setAttribute('cx',px.toFixed(1));dotDl.setAttribute('cy',yOf(s.download).toFixed(1));
    dotUl.setAttribute('cx',px.toFixed(1));dotUl.setAttribute('cy',yOf(s.upload).toFixed(1));
    const vis=showCross&&s.available!==false?'visible':'hidden';
    cross.setAttribute('visibility',vis);dotDl.setAttribute('visibility',vis);dotUl.setAttribute('visibility',vis);
   };
   const nearestAt=ev=>{
    const box=svgEl.getBoundingClientRect(),px=(ev.clientX-box.left)*W/Math.max(1,box.width);
    if(px<padL||px>W-padR)return null;
    const t=t0+((px-padL)/Math.max(1,iw))*span;
    return samples.reduce((best,s)=>Math.abs(Number(s.time)-t)<Math.abs(Number(best.time)-t)?s:best,samples[0]);
   };
   const inspect=ev=>{
    const nearest=nearestAt(ev);
    if(!nearest)return;
    showSample(nearest,true);
    if(isHourly)timeline.highlightHour(nearest.hourIdx);
    else if(tlState&&!tlState.isMultiDay&&tlState.rows?.length===24){
     const hIdx=Math.floor((Number(nearest.time)-tlState.rows[0].time)/3600);
     timeline.highlightHour(hIdx>=0&&hIdx<24?hIdx:null);
    }
   };
   for(const evt of ['pointermove','pointerdown'])hit.addEventListener(evt,inspect);
   hit.addEventListener('click',ev=>{
    const nearest=nearestAt(ev);
    if(!nearest)return;
    if(isHourly&&rateData.canPin)timeline.pinHour(nearest.hourIdx);
    else showSample(nearest,true);
   });
   hit.addEventListener('pointerleave',()=>{showSample(defaultSample,false);timeline.highlightHour(null);});
   rateHoverSync=hourIdx=>{
    if(hourIdx==null){hoverBand.setAttribute('visibility','hidden');showSample(defaultSample,false);return;}
    if(isHourly&&samples[hourIdx]){hoverBand.setAttribute('visibility','hidden');showSample(samples[hourIdx],true);return;}
    if(!isHourly&&tlState?.rows?.[hourIdx]){
     const hStart=tlState.rows[hourIdx].time,hEnd=hStart+3600;
     if(hEnd>=t0&&hStart<=t1){
      const x1=Math.max(padL,xOf(hStart)),x2=Math.min(W-padR,xOf(hEnd));
      hoverBand.setAttribute('x',x1.toFixed(1));hoverBand.setAttribute('width',Math.max(4,x2-x1).toFixed(1));
      hoverBand.setAttribute('visibility','visible');
     }
    }
   };
   showSample(defaultSample,false);
   rateChartWrap.append(svgEl);
  }
  async function syncRateHistory(){
   const req=++rateReq;
   syncRateButtons();
   const activeDevice=deviceOptions.find(d=>d.key===selected);
   if(ratePreset==='sync'&&tlState&&tlState.rows?.length&&activeDevice&&rateSource==='device'){
    rateData=buildHourlyRateData(tlState,activeDevice,'');
    renderRateCard();
    return;
   }
   rateReadout.textContent='正在加载速率历史…';
   try{
    const st=await callStatus().catch(()=>status);
    if(req!==rateReq)return;
    const nowSec=Math.floor(Number(st?.now||st?.since)||Date.now()/1000);
    const cutoff=nowSec-7*86400;
    let qStart,qEnd,subLabel;
    if(ratePreset!=='sync'){
     qEnd=nowSec;qStart=Math.max(cutoff,nowSec-Number(ratePreset));subLabel='WAN 5 秒实时速率 · 保留最近 7 天';
    }else if(tlState&&tlState.rows?.length){
     const pinnedRow=!tlState.isMultiDay?tlState.pinned?.row:null;
     const winStart=pinnedRow?pinnedRow.time:localDayStart(tlState.startStr);
     const winEnd=pinnedRow?pinnedRow.time+3600:localDayStart(tlState.endStr)+86400;
     qEnd=Math.min(winEnd,nowSec);qStart=Math.max(winStart,cutoff);
     if(qEnd<=cutoff||qEnd-qStart<60){
      rateData=buildHourlyRateData(tlState,activeDevice||null,'超出 7 天 5 秒保留期，已展示分时均速');
      renderRateCard();
      return;
     }
     const labelPart=pinnedRow?(tlState.startStr.slice(5)+' '+pinnedRow.label):(tlState.isMultiDay?(tlState.startStr.slice(5)+' 至 '+tlState.endStr.slice(5)):tlState.startStr);
     subLabel='联动 '+labelPart+' · WAN 5 秒速率'+(winStart<cutoff?'（近 7 天）':'');
    }else{
     qEnd=nowSec;qStart=Math.max(cutoff,nowSec-86400);subLabel='WAN 5 秒实时速率 · 保留最近 7 天';
    }
    let res=await callRateHistory(rateIface,qStart,qEnd,240);
    if(req!==rateReq)return;
    if(!rateIface&&res?.interface==='lo'){
     const preferred=(res.interfaces||[]).find(n=>n!=='lo');
     if(preferred){rateIface=preferred;res=await callRateHistory(preferred,qStart,qEnd,240);}
    }
    if(req!==rateReq)return;
    const ifaceName=res?.interface||rateIface;
    if(ratePreset==='sync'&&tlState&&tlState.rows?.length&&(!res?.samples||!res.samples.length)){
     rateData=buildHourlyRateData(tlState,activeDevice||null,'该时段暂无 5 秒采样，已展示分时均速');
     renderRateCard();
     return;
    }
    rateData=Object.assign({kind:'wan',samples:[],interfaces:[],step:5},res,{kind:'wan',subtitle:(ifaceName?ifaceName+' · ':'')+subLabel});
    renderRateCard();
   }catch(_e){
    if(req!==rateReq)return;
    if(ratePreset==='sync'&&tlState&&tlState.rows?.length){
     rateData=buildHourlyRateData(tlState,activeDevice||null,'已切换为分时均速');
     renderRateCard();
    }else{
     rateChartWrap.replaceChildren(E('p','za-meta','暂未获取到历史速率数据。'));rateReadout.textContent='无法读取速率历史';
    }
   }
  }
  timeline.onDataReady=state=>{tlState=state;if(ratePreset!=='sync')ratePreset='sync';syncRateHistory();};
  timeline.onPinChange=pinned=>{if(tlState)tlState.pinned=pinned;ratePreset='sync';syncRateHistory();};
  timeline.onHoverHour=idx=>rateHoverSync?.(idx);
  root.append(usage);selectUI.enhance(sort);selectUI.enhance(deviceSelect);
  syncRateButtons();refresh(true);
  if(!status?.device_timeline)syncRateHistory();
  if(location.hash==='#device-hourly')requestAnimationFrame(()=>{detail.scrollIntoView({block:'start'});detail.focus({preventScroll:true});});
  else if(new URLSearchParams(location.search).get('tab')==='rates')requestAnimationFrame(()=>ratePanel.scrollIntoView({block:'nearest'}));
  let lastWidth=top.clientWidth;new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(root.isConnected&&width>0&&width!==lastWidth){lastWidth=width;refresh();timeline.query();renderRateCard();}}).observe(top);return root;
}});
