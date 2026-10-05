const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/zen-appearance.js'), 'utf8');
let save, fail = null; const calls = [], specs = [];
new Function('baseclass', 'rpc', 'window', source)(
	{ extend: props => { props.__init__(); return props; } },
	{ declare: spec => { specs.push(spec); return async (...args) => { calls.push([spec.method, ...args]); if (spec.method === fail) throw Error('ubus rejected'); }; } },
	{ ZenAppearance: { connect: adapter => { save = adapter; } } }
);
(async () => {
	await save({ layout: 'top' });
	assert.deepEqual(calls, [['set', 'zen', 'appearance', { layout: 'top', saved: '1' }], ['commit', 'zen']]);
	assert.ok(specs.every(spec => spec.reject), 'Failed UCI writes must not be reported as saved');
	calls.length = 0; fail = 'set'; await assert.rejects(save({ mode: 'dark' }));
	assert.equal(calls.length, 1, 'Do not commit when setting preferences failed');
	fail = 'commit'; await assert.rejects(save({ mode: 'dark' }));
	const acl = JSON.parse(fs.readFileSync(path.join(__dirname, '../luci-theme-zen/root/usr/share/rpcd/acl.d/luci-theme-zen.json'), 'utf8'))['luci-theme-zen'];
	assert.deepEqual(acl.read.uci, ['zen']); assert.deepEqual(acl.write.uci, ['zen']);
	assert.deepEqual(acl.write.ubus.uci, ['set', 'commit']);
	console.log('PASS: native UCI save/commit order, error propagation and theme-scoped permissions');
})().catch(error => { console.error(error); process.exitCode = 1; });
