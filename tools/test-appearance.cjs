// Preference migration and synchronization use the production browser module.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/zen/appearance.js'), 'utf8');
function browser(initial = {}, dark = false, blocked = false) {
 const values = new Map(Object.entries(initial)), styles = new Map(), events = {}, systemEvents = {}, emitted = [];
 const root = { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } };
 const storage = {
  getItem(key) { if (blocked) throw Error('blocked'); return values.get(key) ?? null; },
  setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); },
  removeItem(key) { if (blocked) throw Error('blocked'); values.delete(key); }
 };
 const system = { matches: dark, addEventListener: (name, handler) => { systemEvents[name] = handler; } };
 const window = { matchMedia: () => system, addEventListener: (name, handler) => { events[name] = handler; } };
 const document = { documentElement: root, querySelectorAll: () => [], addEventListener() {}, dispatchEvent: event => emitted.push(event) };
 const context = vm.createContext({ window, document, localStorage: storage, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
 vm.runInContext(source, context);
 return { api: window.ZenAppearance, root, styles, values, events, system, systemEvents, emitted };
}
let b = browser();
assert.equal(b.root.dataset.accent, 'macaron'); assert.equal(b.root.dataset.material, 'glass');
assert.equal(b.root.dataset.themeMode, 'auto'); assert.equal(b.root.dataset.theme, 'light');
assert.equal(b.root.dataset.layout, 'sidebar');
assert.equal(b.styles.get('--accent-light'), '#329383');
assert.equal(b.styles.get('--accent-light-ink'), '#17202e', 'bright main buttons need dark ink');
assert.equal(b.values.size, 0, 'Initialization must not replace saved preferences');
b.api.set({ accent: 'blue', material: 'outline', mode: 'dark' });
assert.equal(b.values.get('luci-theme-zen'), 'dark');
assert.equal(b.root.dataset.theme, 'dark'); assert.equal(b.root.dataset.darkmode, 'true');
assert.equal(b.styles.get('--accent-light-ink'), '#ffffff');
b.api.set({ material: 'paper' });
 b.api.set({ layout: 'top' }); assert.equal(b.root.dataset.layout, 'top');
 assert.equal(b.values.get('luci-theme-zen-layout'), 'top');
assert.equal(b.api.get().accent, 'blue'); assert.equal(b.api.get().mode, 'dark');
b.system.matches = false; b.systemEvents.change();
assert.equal(b.root.dataset.theme, 'dark', 'Explicit mode ignores system appearance');
b.api.set({ mode: 'auto' }); b.system.matches = true; b.systemEvents.change();
assert.equal(b.root.dataset.theme, 'dark'); assert.equal(b.values.has('luci-theme-zen'), false);
b.api.set({ accent: 'nord' });
b.events.storage({ key: 'luci-theme-zen-material', newValue: 'duotone' });
assert.equal(b.api.get().material, 'duotone'); assert.equal(b.api.get().accent, 'nord');
b.events.storage({ key: 'unrelated', newValue: 'light' }); assert.equal(b.root.dataset.theme, 'dark');
b.events.storage({ key: 'luci-theme-zen', newValue: 'light' }); assert.equal(b.root.dataset.theme, 'light');
b.values.clear(); b.events.storage({ key: null }); assert.equal(b.api.get().accent, 'macaron');
assert.equal(b.api.get().layout, 'sidebar');
b.events.storage({ key: 'luci-theme-zen-layout', newValue: 'top' }); assert.equal(b.api.get().layout, 'top');
b.api.set({ layout: 'invalid' }); assert.equal(b.api.get().layout, 'sidebar');
b = browser({ 'luci-theme-zen-layout': 'top' }); assert.equal(b.api.get().layout, 'top');
b = browser({ 'luci-theme-zen': 'dark', 'luci-theme-zen-accent': 'obsolete', 'luci-theme-zen-material': 'bad' });
assert.equal(b.root.dataset.theme, 'dark', 'Keep legacy Zen light/dark preference');
assert.equal(b.root.dataset.accent, 'macaron'); assert.equal(b.root.dataset.material, 'glass');
b = browser({}, true, true);
assert.equal(b.root.dataset.theme, 'dark', 'Blocked storage still honors system appearance');
b.api.set({ mode: 'light', accent: 'honey', material: 'paper' }); b.systemEvents.change();
assert.equal(b.root.dataset.theme, 'light'); assert.equal(b.api.get().accent, 'honey');
b.events.storage({ key: 'luci-theme-zen-material', newValue: 'outline' });
assert.equal(b.api.get().accent, 'honey', 'A storage event does not erase unrelated session preferences');
for (const [accent, material] of [['macaron','glass'],['nord','aurora'],['honey','paper'],['blue','outline'],['coast','duotone']]) {
 b.api.set({ accent, material }); assert.equal(b.root.dataset.accent, accent); assert.equal(b.root.dataset.material, material);
 assert.match(b.styles.get('--accent-light'), /^#[0-9a-f]{6}$/);
}
console.log('PASS: five presets; independent preferences; legacy mode; system, blocked storage and cross-tab sync; readable button ink');
