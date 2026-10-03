// Check the production chart's amount, date and interaction contract without a browser.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.offsetWidth=160; this.offsetHeight=40; this.clientHeight=320; this.clientWidth = 320; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(k, fn) { this.events[k] = fn; }
  getBoundingClientRect() { return {left:0, top:0, width:this.attrs.viewBox ? Number(this.attrs.viewBox.split(' ')[2]) : this.clientWidth}; }
  set textContent(v) { this.text = v; this.children = []; }
  get textContent() { return this.text || this.children.map(c => c.textContent).join(''); }
}
const E = (tag, attrs = {}, children = []) => {
  const el = new Element(tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (Array.isArray(children)) children.forEach(c => el.appendChild(c)); else el.textContent = children;
  return el;
};
const document = {createElementNS: (_, tag) => new Element(tag), createTextNode: text => ({textContent: text})};
const source = fs.readFileSync(path.join(__dirname,
  '../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/history.js'), 'utf8');
const view = new Function('view', 'rpc', '_', 'document', 'E', source)(
  {extend: x => x}, {declare: () => () => {}}, x => x, document, E);
String.prototype.format = function (...args) { let i = 0; return this.replace(/%d/g, () => args[i++]); };
const find = (el, tag) => (el.tag === tag ? [el] : []).concat((el.children || []).flatMap(c => find(c, tag)));
for (const [agg, count] of [['day', 90], ['month', 12], ['day', 1]]) {
  view.chart = new Element('div');
  const rows = Array.from({length: count}, (_, i) => ({[agg === 'day' ? 'date' : 'month']: (agg === 'day' ? 'day-' : 'month-') + i, upload: i * 1024, download: (i + 1) * 2048}));
  view.draw({agg, [agg === 'day' ? 'days' : 'months']: rows});
  const bars = find(view.chart, 'rect');
  assert.equal(bars.length, count * 2, 'Every date has separate upload/download bars');
  assert.equal(find(view.chart, 'path').length + find(view.chart, 'circle').length, 0);
  assert.equal(Number(bars[0].attrs.height), 0, 'Zero upload must not appear as positive usage');
  const baseline = Number(bars[1].attrs.y) + Number(bars[1].attrs.height);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 2; k++) {
      const bar = bars[i * 2 + k];
      assert.ok(Math.abs(Number(bar.attrs.y) + Number(bar.attrs.height) - baseline) < 1e-9);
      assert.equal(bar.attrs.tabindex, '0');
      assert.ok(bar.attrs['aria-label'].startsWith((agg === 'day' ? 'day-' : 'month-') + i));
    }
    assert.ok(Number(bars[i * 2].attrs.x) < Number(bars[i * 2 + 1].attrs.x));
  }
  if (count > 1) {
    assert.ok(Math.abs(Number(bars[3].attrs.height) / Number(bars[1].attrs.height) - 2) < 1e-9,
      'Bar heights share one byte scale');
    assert.ok(Number(bars[2].attrs.x) > Number(bars[1].attrs.x) + Number(bars[1].attrs.width));
  }
  bars[1].events.click();
  assert.ok(view.chart.children.at(-1).textContent.startsWith((agg === 'day' ? 'day-' : 'month-') + '0 ·'));
  bars.at(-1).events.focus();
  assert.ok(view.chart.children.at(-1).textContent.startsWith((agg === 'day' ? 'day-' : 'month-') + (count - 1) + ' ·'));
  const chart = find(view.chart, 'svg')[0], tip = view.chart.children[0];
  chart.events.pointermove({clientX: 87, clientY: 140});
  assert.ok(tip.textContent.startsWith((agg === 'day' ? 'day-' : 'month-') + '0 ·'), 'Hovering the plot selects zero-height bars too');
  assert.equal(tip.hidden, false);
  const firstLeft=tip.style.left;
  chart.events.pointermove({clientX:150,clientY:220});
  assert.notEqual(tip.style.left,firstLeft,'The tooltip follows the pointer rather than staying in a fixed corner');
  assert.ok(parseFloat(tip.style.left)+tip.offsetWidth<=view.chart.clientWidth-8,'Tooltip stays inside the card');
  chart.events.pointerleave(); assert.equal(tip.hidden, true);
  chart.events.pointerdown({clientX: Number(chart.attrs.viewBox.split(' ')[2]) - 21});
  assert.ok(tip.textContent.startsWith((agg === 'day' ? 'day-' : 'month-') + (count - 1) + ' ·'), 'Touch selects the last group');
  if (count === 90) assert.ok(Number(find(view.chart, 'svg')[0].attrs.viewBox.split(' ')[2]) > 320);
}
view.chart = new Element('div'); view.draw({agg: 'day', days: []});
assert.equal(find(view.chart, 'rect').length, 0);
assert.match(view.chart.textContent, /No history data yet/);
console.log('PASS: daily/monthly grouped bars, amount scale, zero usage, long history, tap/focus and empty state');
