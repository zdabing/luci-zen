'use strict';
'require view';
'require rpc';

const callHistory = rpc.declare({ object: 'zen.traffic', method: 'getRealtimeHistory', params: ['iface', 'start', 'end', 'limit'] });
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
 style.textContent = '.zen-rt-controls{display:flex;gap:16px;align-items:end;flex-wrap:wrap}.zen-rt-field{display:flex;flex-direction:column;gap:6px;font-size:13px}.zen-rt-controls input,.zen-rt-controls select{max-width:100%;min-height:36px}.zen-rt-summary{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:16px}.zen-rt-summary strong{display:block;font-size:24px;margin-top:4px}.zen-rt-dl{color:var(--dl,#15803d)}.zen-rt-ul{color:var(--ul,#ea580c)}.zen-rt-chart svg{display:block;width:100%;height:240px}.zen-rt-chart text{fill:currentColor;opacity:.65;font-size:11px}.zen-rt-grid{stroke:currentColor;opacity:.12;stroke-dasharray:3 5}.zen-rt-chart .dl{stroke:var(--dl,#15803d);fill:none}.zen-rt-chart .ul{stroke:var(--ul,#ea580c);fill:none;stroke-dasharray:5 5}.zen-rt-legend{display:flex;gap:20px;justify-content:flex-end;font-size:13px;margin-bottom:8px}.zen-rt-pagination{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:12px}.zen-rt-table td,.zen-rt-table th{text-align:right}.zen-rt-table td:first-child,.zen-rt-table th:first-child{text-align:left}.zen-rt-note{font-size:13px;opacity:.7}.zen-rt-error{color:var(--danger,#dc2626)}@media(max-width:600px){.zen-rt-field{flex:1 1 180px;min-width:0}.zen-rt-summary strong{font-size:20px}.zen-rt-table{font-size:12px}}';
 document.head.appendChild(style);
}

return view.extend({
 load() {
  const now = Math.floor(Date.now() / 1000);
  return callHistory('', now - 300, now, 600).then(data => ({data})).catch(() => ({error:true}));
 },
 render(initial) {
  styles(); this.requestId = 0; this.page = 0;
  this.iface = E('select', { 'aria-label': _('Interface') });
  this.range = E('select', {}, [
   ['300', _('Last 5 minutes')], ['3600', _('Last hour')], ['86400', _('Last 24 hours')],
   ['604800', _('Last 7 days')], ['custom', _('Custom range')]
  ].map(([value,label]) => E('option',{value},label)));
  this.start = E('input', {type:'datetime-local',step:'1'});
  this.end = E('input', {type:'datetime-local',step:'1'});
  const field = (label, input) => E('label', {'class':'zen-rt-field'},[E('span',{},label),input]);
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
  const root = E('div', {'class':'cbi-map',id:'zen-realtime-history'},[
   E('h2',{},_('Realtime History')),
   E('p',{'class':'cbi-map-descr'},_('WAN rates sampled every 5 seconds and retained for 7 days. Longer ranges show average rates.')),
   E('section',{'class':'cbi-section zen-rt-controls'},[
    field(_('Interface'),this.iface),field(_('Time range'),this.range),
    field(_('Start time'),this.start),field(_('End time'),this.end),this.button
   ]),this.error,
   E('section',{'class':'cbi-section'},[this.summary,
    E('div',{'class':'zen-rt-legend'},[E('span',{'class':'zen-rt-dl'},'— '+_('Download')),E('span',{'class':'zen-rt-ul'},'┄ '+_('Upload'))]),
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
  for(const input of [this.start,this.end]) {input.min=localInput(now-7*DAY);input.max=localInput(now);}
  if(!custom) {this.start.value=localInput(now-Number(this.range.value));this.end.value=localInput(now);}
 },
 async query() {
  this.setRange();
  const now=Math.floor(Date.now()/1000), start=Math.floor(new Date(this.start.value).getTime()/1000), end=Math.floor(new Date(this.end.value).getTime()/1000);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||start<now-7*DAY||end>now) {
   this.error.textContent=_('Choose a valid time range within the last 7 days.'); return;
  }
  const id=++this.requestId;
  this.button.disabled=true; this.button.textContent=_('Loading…');this.error.textContent='';
  try {
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
  const width=Math.max(320,this.chart.clientWidth||960), left=70,right=width-16,top=20,bottom=205;
  const start=this.data.start??samples[0].time,end=this.data.end??samples[samples.length-1].time;
  const peak=Math.max(64,...samples.flatMap(s=>[s.download,s.upload]))*1.05;
  const x=t=>left+(t-start)/Math.max(1,end-start)*(right-left),y=v=>bottom-v/peak*(bottom-top);
  const chart=svg('svg',{viewBox:'0 0 '+width+' 240',role:'img','aria-label':_('Realtime History')});
  for(let i=0;i<=4;i++) {
   const v=peak*i/4;
   chart.appendChild(svg('line',{x1:left,x2:right,y1:y(v),y2:y(v),'class':'zen-rt-grid'}));
   chart.appendChild(svg('text',{x:left-8,y:y(v)+4,'text-anchor':'end'},rate(v)));
  }
  for(const [key,cls] of [['download','dl'],['upload','ul']]) {
   let segment=[];
   const flush=()=>{if(segment.length>1)chart.appendChild(svg('polyline',{points:segment.map(s=>x(s.time)+','+y(s[key])).join(' '),'class':cls,'stroke-width':2}));segment=[];};
   samples.forEach((s,i)=>{
    if(i&&s.time-samples[i-1].time>this.data.step*1.5) flush();
    segment.push(s);
    const dot=svg('circle',{cx:x(s.time),cy:y(s[key]),r:samples.length===1?4:2,fill:cls==='dl'?'var(--dl,#15803d)':'var(--ul,#ea580c)'});
    dot.appendChild(svg('title',{},new Date(s.time*1000).toLocaleString()+' · '+rate(s[key])));chart.appendChild(dot);
   });flush();
  }
  chart.appendChild(svg('text',{x:left,y:232},new Date(start*1000).toLocaleString()));
  chart.appendChild(svg('text',{x:right,y:232,'text-anchor':'end'},new Date(end*1000).toLocaleString()));
  this.chart.appendChild(chart);
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
