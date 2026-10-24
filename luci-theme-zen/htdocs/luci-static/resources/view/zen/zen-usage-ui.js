'use strict';
'require baseclass';
/* Measured usage presentation. Its caller supplies the traffic snapshot. */
 'use strict';
 const PERIODS={day:'本日',week:'本周',month:'本月',all:'全部'};
 const COLORS=['#1f7a5a','#b08d57','#5f7f94','#8a9a5b','#9c7972'];
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
 return baseclass.extend({mount});
