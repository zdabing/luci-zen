'use strict';
'require view';
'require rpc';
'require view.zen-traffic.style as trafficStyle';

const callHistory = rpc.declare({ object: 'zen.traffic', method: 'getRealtimeHistory', params: ['iface', 'start', 'end', 'limit'], reject: true });
const callDefaultHistory = rpc.declare({ object: 'zen.traffic', method: 'getRealtimeHistory', reject: true });
const callStatus = rpc.declare({ object: 'zen.traffic', method: 'getStatus', reject: true });
const DAY = 86400;
function localInput(time) {
 const date = new Date(time * 1000);
 return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function rate(value) {
 let n = Math.max(0, Number(value) || 0), i = 0;
 const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
 while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
 return n.toFixed(i ? (n >= 100 ? 0 : 1) : 0) + ' ' + units[i];
}
function svg(tag, attrs, text) {
 const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
 for (const key in attrs) el.setAttribute(key, attrs[key]);
 if (text != null) el.textContent = text;
 return el;
}
function styles() {
 if (document.getElementById('zen-realtime-css')) return;
 const style = E('style', { id: 'zen-realtime-css' });
 style.textContent = '.zen-rt-controls{display:flex;gap:16px;align-items:end;flex-wrap:wrap}.zen-rt-field{display:flex;flex-direction:column;gap:6px;font-size:13px}.zen-rt-controls input,.zen-rt-controls select{max-width:100%;min-height:36px}.zen-rt-summary{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:16px}.zen-rt-summary strong{display:block;font-size:24px;margin-top:4px}.zen-rt-dl{color:var(--dl,#15803d)}.zen-rt-ul{color:var(--ul,#ea580c)}.zen-rt-chart svg{display:block;width:100%;height:240px}.zen-rt-chart text{fill:currentColor;opacity:.65;font-size:11px}.zen-rt-chart text.zen-rt-ul{fill:var(--ul,#ea580c);opacity:1}.zen-rt-chart text.zen-rt-dl{fill:var(--dl,#15803d);opacity:1}.zen-rt-grid{stroke:currentColor;opacity:.12;stroke-dasharray:3 5}.zen-rt-chart .dl{stroke:var(--dl,#15803d);fill:none}.zen-rt-chart .ul{stroke:var(--ul,#ea580c);fill:none;stroke-dasharray:5 5}.zen-rt-legend{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:flex-end;font-size:13px;margin-bottom:8px}.zen-rt-pagination{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:12px}.zen-rt-table td,.zen-rt-table th{text-align:right}.zen-rt-table td:first-child,.zen-rt-table th:first-child{text-align:left}.zen-rt-note{font-size:13px;opacity:.7}.zen-rt-error{color:var(--danger,#dc2626)}@media(max-width:600px){.zen-rt-field{flex:1 1 180px;min-width:0}.zen-rt-summary strong{font-size:20px}.zen-rt-table{font-size:12px}}';
 document.head.appendChild(style);
}

return view.extend({
 injectStyles: styles,
 load() {
  // Let the router choose its current window; the browser clock may be ahead.
  return callDefaultHistory().then(data => ({data})).catch(() => ({error:true}));
 },
 render(initial) {
  styles(); trafficStyle.inject(); this.requestId = 0; this.page = 0;
  this.iface = E('select', { 'aria-label': _('Interface') });
  this.range = E('select', {}, [
   ['300', _('Last 5 minutes')], ['3600', _('Last hour')], ['86400', _('Last 24 hours')],
   ['604800', _('Last 7 days')], ['custom', _('Custom range')]
  ].map(([value,label]) => E('option',{value},label)));
  this.start = E('input', {type:'datetime-local',step:'1'});
  this.end = E('input', {type:'datetime-local',step:'1'});
  const field = (label, input) => E('label', {'class':'zen-rt-field'},[E('span',{},label),input]);
  this.startField = field(_('Start time'),this.start);
  this.endField = field(_('End time'),this.end);
  this.button = E('button', {type:'button','class':'cbi-button cbi-button-action'},_('Query'));
  this.error = E('p', {'class':'zen-rt-error',role:'alert'});
  this.summary = E('div', {'class':'zen-rt-summary'});
  this.chart = E('div', {'class':'zen-rt-chart'});
  this.note = E('p', {'class':'zen-rt-note','aria-live':'polite'});
  this.rows = E('tbody');
  this.previous = E('button', {type:'button','class':'cbi-button'},_('Previous'));
  this.next = E('button', {type:'button','class':'cbi-button'},_('Next'));
  this.pageText = E('span');
  this.previous.addEventListener('click', () => { if(this.page > 0) { this.page--; this.drawTable(); } });
  this.next.addEventListener('click', () => { if(this.page + 1 < Math.ceil(this.data.samples.length / 20)) { this.page++; this.drawTable(); } });
  this.button.addEventListener('click', () => this.query());
  this.iface.addEventListener('change', () => this.query());
  this.range.addEventListener('change', () => this.setRange());
  this.setRange();
  const root = E('div', {'class':'cbi-map zen-traffic-page',id:'zen-rate-history'},[
   E('h3',{},_('Past internet rates')),
   E('p',{'class':'cbi-map-descr'},_('WAN rates sampled every 5 seconds and retained for 7 days. Longer ranges show average rates.')),
   E('section',{'class':'cbi-section zen-rt-controls'},[
    field(_('Interface'),this.iface),field(_('Time range'),this.range),
    this.startField,this.endField,this.button
   ]),this.error,
   E('section',{'class':'cbi-section'},[this.summary,
    E('div',{'class':'zen-rt-legend'},[E('span',{'class':'zen-rt-ul'},'┄ '+_('Upload')),E('span',{'class':'zen-rt-dl'},'— '+_('Download')),E('span',{},_('Independent scales'))]),
    this.chart,this.note
   ]),
   E('section',{'class':'cbi-section'},[
    E('table',{'class':'table zen-rt-table'},[
     E('thead',{},E('tr',{},[_('Time'),_('Download rate'),_('Upload rate')].map(label=>E('th',{scope:'col'},label)))),this.rows
    ]),E('div',{'class':'zen-rt-pagination'},[this.previous,this.pageText,this.next])
   ])
  ]);
  if(initial.data) this.showData(initial.data);
  else {this.error.textContent=_('Realtime history is unavailable. Update and enable the zen-traffic service.');this.showData({samples:[],interfaces:[],step:5});}
  requestAnimationFrame(() => this.drawChart());
  if(typeof ResizeObserver === 'function') {
   let width=0;
   this.observer=new ResizeObserver(entries=>{const next=entries[0].contentRect.width;if(next!==width){width=next;this.drawChart();}});
   this.observer.observe(this.chart);
   window.addEventListener('pagehide',()=>this.observer.disconnect(),{once:true});
  }
  return root;
 },
 setRange() {
  const now = Math.floor(Date.now()/1000), custom=this.range.value==='custom';
  this.start.disabled = !custom; this.end.disabled = !custom;
  this.startField.hidden = !custom; this.endField.hidden = !custom;
  for(const input of [this.start,this.end]) {input.min=localInput(now-7*DAY);input.max=localInput(now);}
  if(!custom) {this.start.value=localInput(now-Number(this.range.value));this.end.value=localInput(now);}
 },
 async query() {
  this.setRange();
  const now=Math.floor(Date.now()/1000);
  let start=Math.floor(new Date(this.start.value).getTime()/1000), end=Math.floor(new Date(this.end.value).getTime()/1000);
  if(this.range.value==='custom'&&(!Number.isFinite(start)||!Number.isFinite(end)||start>end||start<now-7*DAY||end>now)) {
   this.error.textContent=_('Choose a valid time range within the last 7 days.'); return;
  }
  const id=++this.requestId;
  this.button.disabled=true; this.button.textContent=_('Loading…');this.error.textContent='';
  try {
   if(this.range.value!=='custom') {
    const status=await callStatus();
    if(id!==this.requestId) return;
    const serverNow=Number(status.since);
    if(!Number.isFinite(serverNow)||serverNow<1700000000) throw new Error('Invalid router time');
    end=Math.floor(serverNow);start=end-Number(this.range.value);
    this.start.value=localInput(start);this.end.value=localInput(end);
   }
   const data=await callHistory(this.iface.value||'',start,end,600);
   if(id===this.requestId) this.showData(data);
  } catch(e) {
   if(id===this.requestId) this.error.textContent=_('Unable to query realtime history.');
  } finally {
   if(id===this.requestId){this.button.disabled=false;this.button.textContent=_('Query');}
  }
 },
 showData(data) {
  this.data=Object.assign({samples:[],interfaces:[],step:5},data);this.page=0;
  const selected=data.interface || this.iface.value;
  this.iface.replaceChildren(...this.data.interfaces.map(name=>E('option',{value:name},name)));
  this.iface.value=selected;
  this.summary.replaceChildren(...[
   [_('Maximum displayed download'), Math.max(0,...this.data.samples.map(s=>s.download)), 'zen-rt-dl'],
   [_('Maximum displayed upload'), Math.max(0,...this.data.samples.map(s=>s.upload)), 'zen-rt-ul']
  ].map(([label,value,cls])=>E('div',{},[E('span',{},label),E('strong',{'class':cls},rate(value))])));
  this.note.textContent=_('%d points · %d-second intervals').format(this.data.samples.length,this.data.step);
  this.drawChart();this.drawTable();
 },
 drawChart() {
  if(!this.data) return;
  this.chart.replaceChildren();const samples=this.data.samples;
  if(!samples.length) {this.chart.appendChild(E('p',{},_('No realtime history yet. Leave the service running to collect samples.')));return;}
  const width=Math.max(280,this.chart.clientWidth||960), margin=width<600?64:86,left=margin,right=width-margin,top=28,bottom=205;
  const start=this.data.start??samples[0].time,end=this.data.end??samples[samples.length-1].time;
  const peaks={};
  for(const key of ['upload','download']) peaks[key]=Math.max(64,...samples.map(s=>s[key]||0))*1.05;
  const x=t=>left+(t-start)/Math.max(1,end-start)*(right-left),y=(v,key)=>bottom-v/peaks[key]*(bottom-top);
  const chart=svg('svg',{viewBox:'0 0 '+width+' 240',role:'img','aria-label':_('Realtime History')});
  const tip=E('div',{'class':'zen-history-tip',role:'tooltip',hidden:true});
  const readout=E('p',{'class':'zen-rt-readout',role:'status'});
  const cross=svg('line',{y1:top,y2:bottom,'class':'zen-rt-cross',visibility:'hidden'});
  const positionTip=ev=>{
   if(!ev)return;
   const box=this.chart.getBoundingClientRect(),anchor=(ev.currentTarget||chart).getBoundingClientRect();
   const px=(Number.isFinite(ev.clientX)?ev.clientX:anchor.left+anchor.width/2)-box.left;
   const py=(Number.isFinite(ev.clientY)?ev.clientY:anchor.top)-box.top;
   const tw=tip.offsetWidth,th=tip.offsetHeight,cw=this.chart.clientWidth,ch=this.chart.clientHeight;
   const tx=px+12+tw>cw-8?px-tw-12:px+12,ty=py-th-12<8?py+12:py-th-12;
   tip.style.left=Math.max(8,Math.min(tx,cw-tw-8))+'px';
   tip.style.top=Math.max(8,Math.min(ty,ch-th-8))+'px';
  };
  const select=(s,ev)=>{
   readout.textContent=new Date(s.time*1000).toLocaleString()+' · ↑ '+rate(s.upload)+' · ↓ '+rate(s.download);
   tip.textContent=readout.textContent;tip.hidden=false;
   positionTip(ev);
   cross.setAttribute('x1',x(s.time));cross.setAttribute('x2',x(s.time));cross.setAttribute('visibility','visible');
  };
  for(let i=0;i<=4;i++) {
   const gy=bottom-i/4*(bottom-top);
   chart.appendChild(svg('line',{x1:left,x2:right,y1:gy,y2:gy,'class':'zen-rt-grid'}));
   for(const [key,cls] of [['upload','zen-rt-ul'],['download','zen-rt-dl']]) {
    chart.appendChild(svg('text',{x:key==='upload'?left-8:right+8,y:gy+4,'text-anchor':key==='upload'?'end':'start','class':cls},rate(peaks[key]*i/4)));
   }
  }
  for(const [key,cls] of [['upload','ul'],['download','dl']]) {
   chart.appendChild(svg('text',{x:key==='upload'?left-8:right+8,y:16,'text-anchor':key==='upload'?'end':'start','class':key==='upload'?'zen-rt-ul':'zen-rt-dl'},key==='upload'?_('Upload'):_('Download')));
   let segment=[];
   const flush=()=>{if(segment.length>1)chart.appendChild(svg('polyline',{points:segment.map(s=>x(s.time)+','+y(s[key],key)).join(' '),'class':cls,'stroke-width':2}));segment=[];};
   samples.forEach((s,i)=>{
    if(i&&s.time-samples[i-1].time>this.data.step*1.5) flush();
    segment.push(s);
    const dot=svg('circle',{cx:x(s.time),cy:y(s[key],key),r:samples.length===1?4:2,tabindex:0,'aria-label':new Date(s.time*1000).toLocaleString()+' · '+rate(s[key]),fill:cls==='dl'?'var(--dl,#15803d)':'var(--ul,#ea580c)'});
    for(const event of ['focus','click'])dot.addEventListener(event,ev=>select(s,ev));
    dot.appendChild(svg('title',{},new Date(s.time*1000).toLocaleString()+' · '+(key==='upload'?_('Upload'):_('Download'))+': '+rate(s[key])));chart.appendChild(dot);
   });flush();
  }
  const timeLabel=t=>width<600?new Date(t*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}):new Date(t*1000).toLocaleString();
  chart.appendChild(svg('text',{x:left,y:232},timeLabel(start)));
  chart.appendChild(svg('text',{x:right,y:232,'text-anchor':'end'},timeLabel(end)));
  chart.appendChild(cross);
  const inspect=ev=>{
   const bounds=chart.getBoundingClientRect(),px=(ev.clientX-bounds.left)*width/Math.max(1,bounds.width);
   if(px<left||px>right){tip.hidden=true;cross.setAttribute('visibility','hidden');return;}
   const time=start+(px-left)/(right-left)*(end-start);
   const nearest=samples.reduce((best,s)=>Math.abs(s.time-time)<Math.abs(best.time-time)?s:best,samples[0]);
   select(nearest,ev);
  };
  for(const event of ['pointermove','pointerdown','click'])chart.addEventListener(event,inspect);
  chart.addEventListener('pointerleave',()=>{tip.hidden=true;cross.setAttribute('visibility','hidden');});
  select(samples[samples.length-1]);tip.hidden=true;cross.setAttribute('visibility','hidden');
  this.chart.appendChild(tip);this.chart.appendChild(chart);this.chart.appendChild(readout);
 },
 drawTable() {
  const samples=this.data.samples, pages=Math.max(1,Math.ceil(samples.length/20));
  this.rows.replaceChildren(...samples.slice(this.page*20,this.page*20+20).map(s=>E('tr',{},[
   E('td',{},new Date(s.time*1000).toLocaleString()),E('td',{'class':'zen-rt-dl'},rate(s.download)),E('td',{'class':'zen-rt-ul'},rate(s.upload))
  ])));
  this.previous.disabled=this.page===0;this.next.disabled=this.page>=pages-1;
  this.pageText.textContent='%d / %d'.format(this.page+1,pages);
 },
 handleSaveApply:null,handleSave:null,handleReset:null
});
