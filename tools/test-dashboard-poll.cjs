const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../luci-theme-zen/htdocs/luci-static/resources/view/zen/dashboard.js'), 'utf8');
const polls = [];
const dashboard = new Function('baseclass', 'rpc', 'fs', 'network', 'poll', 'fmt', 'devices', 'wanShare', 'document', source)(
	{ extend: value => value }, { declare: () => () => Promise.resolve({}) }, {}, {},
	{ add: fn => polls.push(fn), remove() {} }, {},
	{ mount: () => Promise.resolve() }, { mount: () => Promise.resolve() }, { hidden: false }
);
let calls = 0, resolveRefresh, rejectRefresh;
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
dashboard.refresh = () => {
	calls++;
	return new Promise((resolve, reject) => { resolveRefresh = resolve; rejectRefresh = reject; });
};
(async () => {
	dashboard.start({ isConnected: true });
	const initial = dashboard.ready;
	assert.equal(polls[0](), initial, 'Immediate LuCI polling must share the first refresh');
	assert.equal(calls, 1, 'Startup must not issue a second RPC batch');
	resolveRefresh(); await initial;
	await polls[0]();
	assert.equal(calls, 1, 'Completed startup must not be sampled again in the same instant');
	now += 5000;
	const next = polls[0]();
	assert.equal(calls, 2, 'Subsequent polling must still refresh');
	assert.equal(polls[0](), next, 'Slow refreshes must not overlap');
	const originalError = console.error;
	console.error = () => {};
	try { rejectRefresh(new Error('RPC unavailable')); await next; }
	finally { console.error = originalError; }
	now += 5000;
	const retry = polls[0]();
	assert.equal(calls, 3, 'A failed refresh must release the guard for retry');
	resolveRefresh(); await retry;
	console.log('PASS: startup refresh sharing and spacing, no overlapping RPC batches and recovery after failure');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = realNow; });
