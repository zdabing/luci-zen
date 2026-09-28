'use strict';
'require baseclass';

/*
 * view.zen.zen-format — zen dashboard 共享格式化工具。
 * 纯函数，无 RPC；与 ARCHITECTURE.md §6 字段容错约定配套
 * （字段缺失 → null/0 → 显示 “—” 由调用方决定）。
 */

function fmtBytes(n) {
	n = Math.max(0, Number(n) || 0);
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	const digits = i === 0 ? 0 : (n >= 100 ? 0 : n >= 10 ? 1 : 2);
	return n.toFixed(digits) + ' ' + units[i];
}

function fmtRate(n) {
	return fmtBytes(n) + '/s';
}

function fmtUptime(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	const d = Math.floor(sec / 86400),
	      h = Math.floor((sec % 86400) / 3600),
	      m = Math.floor((sec % 3600) / 60);
	if (d > 0)
		return '%dd %dh'.format(d, h);
	if (h > 0)
		return '%dh %dm'.format(h, m);
	return '%dm'.format(m);
}

/* 峰值向上取整到 1/2/2.5/5/10 × 10^k，1 KB/s 下限，避免空闲抖动放大 */
function niceMax(v) {
	v = Number(v) || 0;
	if (v <= 1024)
		return 1024;
	const exp = Math.floor(Math.log(v) / Math.LN10);
	const base = Math.pow(10, exp);
	const frac = v / base;
	let nice;
	if (frac <= 1) nice = 1;
	else if (frac <= 2) nice = 2;
	else if (frac <= 2.5) nice = 2.5;
	else if (frac <= 5) nice = 5;
	else nice = 10;
	return nice * base;
}

function clampPct(n) {
	n = Number(n);
	if (!isFinite(n) || n < 0)
		return 0;
	return Math.min(100, n);
}

function levelFor(pct) {
	if (pct >= 90)
		return 'danger';
	if (pct >= 70)
		return 'warn';
	return 'ok';
}

/* 占位符：任何字段缺失都渲染为 — */
const MISSING = '—';

function orDash(v) {
	return (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) ? MISSING : String(v);
}

return baseclass.extend({
	fmtBytes: fmtBytes,
	fmtRate: fmtRate,
	fmtUptime: fmtUptime,
	niceMax: niceMax,
	clampPct: clampPct,
	levelFor: levelFor,
	orDash: orDash,
	MISSING: MISSING
});
