// Exercise the production homepage chart with single and multiple day records.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.clientWidth = 320; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(event, callback) { this.events[event] = callback; }
  getBoundingClientRect() { return {left: 0, width: Number(this.attrs.viewBox.split(' ')[2])}; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text || this.children.map(c => c.textContent).join(''); }
}
const document = {createElementNS: (_, tag) => new Element(tag)};
const E = (tag, attrs) => { const el = new Element(tag); Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v)); return el; };
const formatSource = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-format.js'), 'utf8');
const fmt = new Function('baseclass', formatSource)({extend: value => value});
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-devices.js'), 'utf8');
const draw = new Function('rpc','fmt','document','_','E',source.slice(0,source.indexOf('\nfunction refreshHistory('))+'\nreturn drawHistory;')(
  {declare:()=>()=>{}},fmt,document,x=>x,E);
const find = (el,tag) => (el.tag===tag?[el]:[]).concat(el.children.flatMap(child=>find(child,tag)));
for (const count of [1,4,14,20]) {
  const ent={historyChart:new Element('div')};
  const days=Array.from({length:count},(_,i)=>({date:'day-'+i,upload:i*1024,download:(i+1)*2048}));
  draw(ent,{days});
  const kept=days.slice(-14),bars=find(ent.historyChart,'rect');
  assert.equal(bars.length,kept.length*2,'Every retained day has upload and download bars');
  assert.equal(find(ent.historyChart,'polyline').length+find(ent.historyChart,'circle').length,0,'Single and multiple days use the same chart type');
  const baseline=Number(bars[0].attrs.y)+Number(bars[0].attrs.height);
  for(let i=0;i<kept.length;i++) {
    for(const bar of bars.slice(i*2,i*2+2)) {
      assert.ok(Math.abs(Number(bar.attrs.y)+Number(bar.attrs.height)-baseline)<1e-9);
      assert.equal(bar.attrs.tabindex,'0');
      assert.ok(bar.attrs['aria-label'].startsWith(kept[i].date));
    }
    assert.ok(Number(bars[i*2].attrs.x)+Number(bars[i*2].attrs.width)<Number(bars[i*2+1].attrs.x));
  }
  if(count<=14) assert.equal(Number(bars[0].attrs.height),0,'Zero usage has zero bar height');
  if(count===4) assert.ok(Math.abs(Number(bars[3].attrs.height)/Number(bars[1].attrs.height)-2)<1e-9,'Both dates share one byte scale');
  const readout=ent.historyChart.children.at(-1);
  bars[0].events.click();assert.ok(readout.textContent.startsWith(kept[0].date+' · ↑'));
  bars.at(-1).events.focus();assert.ok(readout.textContent.startsWith(kept.at(-1).date+' · ↑'));
  const chart=find(ent.historyChart,'svg')[0],tip=ent.historyChart.children[0];
  chart.events.pointermove({clientX:63}); assert.ok(tip.textContent.startsWith(kept[0].date+' · ↑'));
  assert.equal(tip.hidden,false);chart.events.pointerleave();assert.equal(tip.hidden,true);
  chart.events.pointerdown({clientX:Number(chart.attrs.viewBox.split(' ')[2])-19});
  assert.ok(tip.textContent.startsWith(kept.at(-1).date+' · ↑'),'Tap selects the last date');
  if(count>=14) assert.ok(parseFloat(find(ent.historyChart,'svg')[0].style.width)>320,'Long history scrolls instead of squeezing bars');
}
const empty={historyChart:new Element('div')};draw(empty,{days:[]});
assert.equal(find(empty.historyChart,'rect').length,0);assert.match(empty.historyChart.textContent,/No history/);
console.log('PASS: homepage single/multiple-day grouped bars, zero usage, byte scale, date selection and 14-day window');
