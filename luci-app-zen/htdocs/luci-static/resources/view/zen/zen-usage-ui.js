'use strict';
'require baseclass';
/* Measured usage presentation. Its caller supplies the traffic snapshot. */
 'use strict';
 const PERIODS={day:'本日',week:'本周',month:'本月',all:'全部'};
 const COLORS=Array.from({length:8},(_,i)=>'var(--chart-series-'+(i+1)+')');
 const E=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
 const bytes=n=>{const units=['B','KB','MB','GB','TB'];let unit=0,value=Math.max(0,Number(n)||0);while(value>=1024&&unit<4){value/=1024;unit++;}return value.toFixed(unit>=3?2:unit===2?1:0)+' '+units[unit];};
 const total=d=>d.upload+d.download;
 let nextId=0;
 function mount(host,options={}){
  const root=E('section','zu-usage');root.setAttribute('aria-label','互联网用量');
  const header=E('div','zu-header'),title=E('h2','','互联网用量'),periods=E('div','zu-periods zen-segmented');periods.setAttribute('role','group');periods.setAttribute('aria-label','时间范围');
  const summary=E('div','zu-summary'),metric=E('div','zu-metric'),periodLabel=E('span','zu-muted'),totalValue=E('strong','zu-total');
  metric.append(periodLabel,totalValue);const side=E('div','zu-summary-side'),directions=E('div','zu-directions'),analysis=E('a','zu-analysis','查看历史分析');
  if(options.analysisHref){analysis.href=options.analysisHref;side.append(directions,analysis);}else side.append(directions);
  summary.append(metric,side);
  const charts=E('div','zu-charts'),legend=E('div','zu-legend'),moreLegend=E('div','zu-legend zu-more-legend'),footer=E('div','zu-footer'),countLabel=E('span','zu-muted'),more=E('button','zu-view-all','更多');
  more.type='button';moreLegend.id='zu-more-'+(++nextId);more.setAttribute('aria-controls',moreLegend.id);more.setAttribute('aria-expanded','false');moreLegend.hidden=true;
  footer.append(countLabel,more);header.append(title,periods);if(options.heading!==false)root.append(header);root.append(summary,charts,legend,footer,moreLegend);host.append(root);
  let snapshot={period:'day',devices:[],upload:0,download:0},ranked=[],expanded=false;
  for(const [key,label]of Object.entries(PERIODS)){const button=E('button','',label);button.type='button';button.dataset.period=key;button.addEventListener('click',()=>options.onPeriodChange?.(key));periods.append(button);}
  function syncExpansion(){
   moreLegend.hidden=!expanded;more.setAttribute('aria-expanded',String(expanded));more.textContent=expanded?'收起 ⌃':'更多（'+Math.max(0,ranked.length-5)+' 台）⌄';
  }
  more.addEventListener('click',()=>{expanded=!expanded;syncExpansion();});
  function update(data){
   snapshot={...data,upload:Math.max(0,data.upload||0),download:Math.max(0,data.download||0)};
   const rows=(data.devices||[]).map(d=>({...d,upload:Math.max(0,d.upload||0),download:Math.max(0,d.download||0)})).sort((a,b)=>total(b)-total(a)||a.key.localeCompare(b.key));
   if(rows.length!==ranked.length)expanded=false;
   // Keep every device in both charts. Only the text list is collapsed.
   ranked=rows.map((item,index)=>({...item,color:COLORS[index]||'hsl('+Math.round(index*137.508%360)+' 24% 52%)'}));
   periodLabel.textContent=PERIODS[data.period]+'总用量';const [number,unit]=bytes(snapshot.upload+snapshot.download).split(' ');totalValue.replaceChildren(E('span','',number),E('small','',unit));
   directions.replaceChildren(E('strong','zu-up','↑ '+bytes(snapshot.upload)),E('strong','zu-down','↓ '+bytes(snapshot.download)));
   for(const button of periods.children)button.setAttribute('aria-pressed',String(button.dataset.period===data.period));
   charts.replaceChildren();legend.replaceChildren();moreLegend.replaceChildren();
   for(const [key,label]of[['upload','↑ 上传占比'],['download','↓ 下载占比']]){
    const track=E('div','zu-track');track.setAttribute('role','group');track.setAttribute('aria-label',label);
    for(const item of ranked){const part=E('span','zu-segment');const percent=snapshot[key]?item[key]/snapshot[key]*100:0;part.style.flexBasis=percent+'%';part.style.backgroundColor=item.color;part.title=item.label+' · '+bytes(item[key])+' · '+percent.toFixed(1)+'%';part.setAttribute('role','img');part.setAttribute('aria-label',part.title);track.append(part);}
    charts.append(E('span',key==='upload'?'zu-up':'zu-down',label),track);
   }
   for(const [index,item]of ranked.entries()){
    const entry=E('div','zu-legend-entry'),dot=E('i','zu-dot');dot.style.backgroundColor=item.color;entry.append(dot,E('span','zu-legend-name',item.label));
    for(const [key,arrow]of[['upload','↑'],['download','↓']])entry.append(E('small',key==='upload'?'zu-up':'zu-muted',arrow+' '+bytes(item[key])+' · '+(snapshot[key]?item[key]/snapshot[key]*100:0).toFixed(1)+'%'));
    (index<5?legend:moreLegend).append(entry);
   }
   countLabel.textContent=ranked.length+' 台设备';footer.hidden=!ranked.length;more.hidden=ranked.length<=5;syncExpansion();
   if(!ranked.length)charts.append(E('p','zu-empty','暂无互联网用量'));
  }
  return {update,root};
 }

 function startDate(today,period){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(today||''))return '';
  if(period==='month')return today.slice(0,7)+'-01';
  if(period==='week'){
   const d=new Date(today+'T12:00:00Z');
   d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
   return d.toISOString().slice(0,10);
  }
  return today;
 }

 const fmtPackets=n=>{
  const v=Math.max(0,Math.round(Number(n)||0));
  if(v>=1e8)return [(v/1e8).toFixed(2),'亿包'];
  if(v>=1e4)return [(v/1e4).toFixed(v>=1e6?1:2),'万包'];
  return [v.toLocaleString(),'包'];
 };

 function mountP2p(host,options={}){
  const root=E('section','zu-usage zu-p2p-usage');root.setAttribute('aria-label','P2P / PCDN 拦截统计');
  const header=E('div','zu-header'),title=E('h2','','P2P / PCDN 拦截统计'),periods=E('div','zu-periods zen-segmented');
  periods.setAttribute('role','group');periods.setAttribute('aria-label','P2P 统计时间范围');
  const summary=E('div','zu-summary'),metric=E('div','zu-metric'),periodLabel=E('span','zu-muted'),totalValue=E('strong','zu-total');
  metric.append(periodLabel,totalValue);
  const side=E('div','zu-summary-side'),directions=E('div','zu-directions'),analysis=E('a','zu-analysis','查看分时明细');
  if(options.analysisHref){analysis.href=options.analysisHref;side.append(directions,analysis);}else side.append(directions);
  summary.append(metric,side);
  const charts=E('div','zu-charts'),legend=E('div','zu-legend'),moreLegend=E('div','zu-legend zu-more-legend'),footer=E('div','zu-footer'),countLabel=E('span','zu-muted'),more=E('button','zu-view-all','更多');
  more.type='button';moreLegend.id='zu-p2p-more-'+(++nextId);more.setAttribute('aria-controls',moreLegend.id);more.setAttribute('aria-expanded','false');moreLegend.hidden=true;
  footer.append(countLabel,more);header.append(title,periods);if(options.heading!==false)root.append(header);root.append(summary,charts,legend,footer,moreLegend);host.append(root);
  let currentPeriod=options.defaultPeriod||'day',userChosen=false,rawData=null,ranked=[],expanded=false;
  for(const [key,label]of Object.entries(PERIODS)){
   const button=E('button','',label);button.type='button';button.dataset.period=key;
   button.addEventListener('click',()=>{userChosen=true;currentPeriod=key;if(rawData)render();options.onPeriodChange?.(key);});
   periods.append(button);
  }
  function syncExpansion(){
   moreLegend.hidden=!expanded;more.setAttribute('aria-expanded',String(expanded));more.textContent=expanded?'收起 ⌃':'更多（'+Math.max(0,ranked.length-5)+' 台）⌄';
  }
  more.addEventListener('click',()=>{expanded=!expanded;syncExpansion();});
  function computePeriod(data,period){
   const today=data.today||'';
   if(period==='all'){
    const t=data.total||{};
    const devs=(data.devices||[]).map(d=>({
     key:d.mac,label:d.host||d.mac,ip:d.ip4||'',mode:d.mode||'off',
     dropped:Math.max(0,Number(d.total?.dropped)||0),
     conflicts:Math.max(0,Number(d.total?.conflicts)||0),
     bypassed:Math.max(0,Number(d.total?.bypassed)||0)
    }));
    return {
     dropped:Math.max(0,Number(t.dropped)||0),
     conflicts:Math.max(0,Number(t.conflicts)||0),
     bypassed:Math.max(0,Number(t.bypassed)||0),
     devices:devs
    };
   }
   const start=startDate(today,period);
   const sumRows=rows=>(rows||[]).filter(r=>r.date>=start&&r.date<=today).reduce((acc,r)=>{
    acc.dropped+=Math.max(0,Number(r.dropped)||0);
    acc.conflicts+=Math.max(0,Number(r.conflicts)||0);
    acc.bypassed+=Math.max(0,Number(r.bypassed)||0);
    return acc;
   },{dropped:0,conflicts:0,bypassed:0});
   const tot=sumRows(data.days);
   const devs=(data.devices||[]).map(d=>({
    key:d.mac,label:d.host||d.mac,ip:d.ip4||'',mode:d.mode||'off',
    ...sumRows(d.days)
   }));
   return {...tot,devices:devs};
  }
  function render(){
   if(!rawData)return;
   if(!userChosen){
    const dayView=computePeriod(rawData,'day');
    if(dayView.dropped===0&&dayView.conflicts===0&&(Number(rawData.total?.dropped)||0)>0){
     const weekView=computePeriod(rawData,'week');
     currentPeriod=weekView.dropped>0?'week':'all';
    }
   }
   const view=computePeriod(rawData,currentPeriod);
   const allTotal=Math.max(0,Number(rawData.total?.dropped)||0);
   const rows=view.devices.filter(d=>d.dropped>0||d.conflicts>0||d.bypassed>0||d.mode!=='off')
    .sort((a,b)=>b.dropped-a.dropped||b.conflicts-a.conflicts||a.key.localeCompare(b.key));
   if(rows.length!==ranked.length)expanded=false;
   ranked=rows.map((item,index)=>({...item,color:COLORS[index]||'hsl('+Math.round(index*137.508%360)+' 24% 52%)'}));
   periodLabel.textContent=PERIODS[currentPeriod]+'拦截包数';
   const [num,unit]=fmtPackets(view.dropped);
   totalValue.replaceChildren(E('span','',num),E('small','',unit));
   totalValue.title=view.dropped.toLocaleString()+' 包';
   directions.replaceChildren(
    E('strong','zu-up','⚡ 端口冲突 '+view.conflicts.toLocaleString()+' 次'),
    E('strong','zu-down','↷ 白名单放行 '+view.bypassed.toLocaleString()+' 包')
   );
   for(const button of periods.children)button.setAttribute('aria-pressed',String(button.dataset.period===currentPeriod));
   charts.replaceChildren();legend.replaceChildren();moreLegend.replaceChildren();
   const activeTracked=ranked.filter(d=>d.dropped>0);
   if(view.dropped>0&&activeTracked.length){
    const track=E('div','zu-track');track.setAttribute('role','group');track.setAttribute('aria-label','拦截包数设备占比');
    for(const item of activeTracked){
     const part=E('span','zu-segment');
     const percent=view.dropped?item.dropped/view.dropped*100:0;
     part.style.flexBasis=percent+'%';part.style.backgroundColor=item.color;
     part.title=item.label+' · 拦截 '+item.dropped.toLocaleString()+' 包 · '+percent.toFixed(1)+'%';
     part.setAttribute('role','img');part.setAttribute('aria-label',part.title);
     track.append(part);
    }
    charts.append(E('span','zu-up','🛡 拦截包数占比（共 '+view.dropped.toLocaleString()+' 包）'),track);
   }
   for(const [index,item]of ranked.entries()){
    const entry=E('div','zu-legend-entry'),dot=E('i','zu-dot');dot.style.backgroundColor=item.color;
    const modeTag=item.mode==='enforce'?' [拦截中]':item.mode==='observe'?' [观察中]':'';
    const nameNode=options.deviceHref?E('a','zu-legend-name',item.label+modeTag):E('span','zu-legend-name',item.label+modeTag);
    if(options.deviceHref){nameNode.href=options.deviceHref(item.key);nameNode.style.textDecoration='none';nameNode.style.color='inherit';}
    entry.append(dot,nameNode);
    const pct=view.dropped?item.dropped/view.dropped*100:0;
    entry.append(E('small','zu-up','拦截 '+item.dropped.toLocaleString()+' 包 · '+pct.toFixed(1)+'%'));
    entry.append(E('small','zu-muted','冲突 '+item.conflicts.toLocaleString()+' 次'+(item.bypassed?' · 放行 '+item.bypassed.toLocaleString()+' 包':'')));
    (index<5?legend:moreLegend).append(entry);
   }
   countLabel.textContent=ranked.length+' 台受控/命中设备';footer.hidden=!ranked.length;more.hidden=ranked.length<=5;syncExpansion();
   if(!view.dropped&&!view.conflicts){
    charts.append(E('p','zu-empty',allTotal>0
     ?'当前所选时间段暂无 P2P 拦截记录（历史累计已拦截 '+allTotal.toLocaleString()+' 包，可切换「本周 / 本月 / 全部」查看）'
     :'暂无 P2P / PCDN 拦截记录'));
   }
  }
  function update(data){rawData=data;render();}
  return {update,root,setPeriod(key){userChosen=true;currentPeriod=key;if(rawData)render();}};
 }
 return baseclass.extend({mount,mountP2p,startDate,fmtPackets});
