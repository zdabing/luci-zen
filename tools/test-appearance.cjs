// Preference migration and synchronization use the production browser module.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/zen/appearance.js'), 'utf8');
function browser(initial = {}, dark = false, blocked = false, saved = null, authenticated = true) {
 const values = new Map(Object.entries(initial)), styles = new Map(), events = {}, systemEvents = {}, emitted = [];
 const root = { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } };
	if (saved) {
	 Object.assign(root.dataset, { zenAppearance: 'router', zenAuthenticated: String(authenticated), zenSaved: String(saved.saved !== false) });
	 for (const key of ['mode', 'accent', 'material', 'layout']) root.dataset['zen' + key[0].toUpperCase() + key.slice(1)] = saved[key];
	}
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

(async () => {
 let config = { saved: false, mode: 'auto', accent: 'macaron', material: 'glass', layout: 'sidebar' }, writes = [];
 const save = async values => { writes.push({ ...values }); config = { ...config, ...values, saved: true }; };
 let first = browser({}, false, false, config);
 await first.api.connect(save);
 assert.equal(writes.length, 0, 'A new browser must not overwrite router preferences on page load');
 first.api.set({ mode: 'dark', accent: 'honey', material: 'paper', layout: 'top' }); await first.api.flush();
 assert.equal(config.layout, 'top'); assert.equal(first.api.status(), 'Saved on router; applies across browsers');
 const second = browser({ 'luci-theme-zen-layout': 'sidebar', 'luci-theme-zen-accent': 'blue' }, false, true, config);
 assert.equal(second.api.get().layout, 'top', 'Another browser with blocked or stale storage must use router settings');
 assert.equal(second.api.get().accent, 'honey'); assert.equal(second.api.get().mode, 'dark');
 await second.api.connect(save); assert.equal(writes.length, 1, 'Reading saved router preferences must not write them back');
 second.api.set({ layout: 'sidebar' }); await second.api.flush();
 assert.deepEqual(writes[1], { layout: 'sidebar' }, 'Only changed fields are saved once router defaults exist');
 const reopened = browser({}, false, false, config); assert.equal(reopened.api.get().layout, 'sidebar');
 let fail = true;
 await first.api.connect(async values => { if (fail) throw Error('commit rejected'); return save(values); });
 first.api.set({ material: 'outline' }); await first.api.flush();
 assert.equal(first.api.status(), 'Could not save to router. Try again.'); assert.equal(config.material, 'paper');
 fail = false; await first.api.retry(); assert.equal(config.material, 'outline');
 assert.equal(first.api.status(), 'Saved on router; applies across browsers');
 let release, secondStarted; const queued = [];
 const secondRequest = new Promise(resolve => { secondStarted = resolve; });
 await first.api.connect(values => { queued.push({ ...values }); if (queued.length === 2) secondStarted(); return new Promise(resolve => { release = resolve; }); });
 first.api.set({ accent: 'blue' }); const draining = first.api.flush(); await Promise.resolve();
 first.api.set({ accent: 'coast' }); first.api.set({ layout: 'top' });
 assert.equal(queued.length, 1, 'Router commits must not overlap');
 release(); await secondRequest;
 assert.equal(queued.length, 2); assert.deepEqual(queued[1], { accent: 'coast', layout: 'top' }); release(); await draining;
 const migrated = browser({ 'luci-theme-zen-layout': 'top', 'luci-theme-zen': 'dark' }, false, false, { saved: false });
 let migration; await migrated.api.connect(async values => { migration = { ...values }; });
 assert.equal(migration.layout, 'top'); assert.equal(migration.mode, 'dark');
 const guest = browser({}, false, false, config, false); let guestWrites = 0;
 await guest.api.connect(async () => { guestWrites++; }); guest.api.set({ layout: 'top' }); await guest.api.flush();
 assert.equal(guestWrites, 0, 'The login page must not write router configuration');
 console.log('PASS: router persistence; independent browsers; stale/blocked storage; migration; field patches; serialized writes; retry; guest isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
