// Real chart: nearest time selection, gaps, edges, mobile taps and keyboard focus.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
class Element {
  constructor(tag) { this.tag=tag;this.attrs={};this.children=[];this.events={};this.style={};this.clientWidth=320;this.clientHeight=300;this.offsetWidth=160;this.offsetHeight=40; }
  setAttribute(k,v) { this.attrs[k]=String(v); }
  appendChild(c) { this.children.push(c);return c; }
  replaceChildren(...children) { this.children=children; }
  addEventListener(k,fn) { this.events[k]=fn; }
  getBoundingClientRect() { return {left:10,top:0,width:320}; }
}
const E=(tag,attrs={},text)=>{const el=new Element(tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));el.textContent=text;return el;};
const source=fs.readFileSync(path.join(__dirname,'../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/rate-history.js'),'utf8');
const view=new Function('baseclass','rpc','_','document','E',source)({extend:x=>x},{declare:()=>()=>{}},x=>x,{createElementNS:(_,tag)=>new Element(tag)},E);
for(const samples of [[],[{time:100,upload:0,download:2048}],[{time:100,upload:1024,download:0},{time:110,upload:2048,download:3072},{time:180,upload:4096,download:8192}]]) {
  view.chart=new Element('div');view.data={samples,start:100,end:180,step:5};view.drawChart();
  if(!samples.length) {assert.equal(view.chart.children.length,1);continue;}
  const [tip,chart,readout]=view.chart.children;
  assert.equal(tip.hidden,true);
  chart.events.pointermove({clientX:10+64,clientY:100});assert.equal(tip.hidden,false);assert.match(tip.textContent,/↑/);assert.match(tip.textContent,/↓/);
  const firstLeft=tip.style.left,firstTop=tip.style.top;
  chart.events.pointermove({clientX:10+140,clientY:160});
  assert.notEqual(tip.style.left,firstLeft);assert.notEqual(tip.style.top,firstTop);
  assert.ok(parseFloat(tip.style.left)+tip.offsetWidth<=view.chart.clientWidth-8);
  chart.events.pointermove({clientX:10+64,clientY:100});
  assert.ok(tip.textContent.includes(samples[0].upload===0?'0 B/s':'1.0 KB/s'));
  chart.events.pointermove({clientX:10+64+192*.5});
  if(samples.length>1) assert.ok(readout.textContent.includes('2.0 KB/s'),'Missing intervals select the nearest existing time, without inventing a zero sample');
  chart.events.pointerleave();assert.equal(tip.hidden,true);
  chart.events.pointerdown({clientX:10+256});assert.equal(tip.hidden,false);assert.ok(readout.textContent.includes(samples.at(-1).download===2048?'2.0 KB/s':'8.0 KB/s'));
  const dots=chart.children.filter(el=>el.tag==='circle');dots[0].events.focus();assert.equal(tip.hidden,false);
  chart.events.pointermove({clientX:10});assert.equal(tip.hidden,true);
}
console.log('PASS: realtime hover/tap/focus, upload/download rates, nearest timestamps with gaps, chart edges and empty state');
