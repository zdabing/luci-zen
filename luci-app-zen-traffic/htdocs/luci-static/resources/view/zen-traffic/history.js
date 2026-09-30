'use strict';
'require view';
'require rpc';

/*
 * view.zen-traffic.history — luci-app-zen-traffic 历史曲线页。
 *
 * 数据源：ubus zen.traffic getHistory（SQLite daily_usage/monthly_usage 聚合，
 * daemon 端落盘）。方向约定 download=rx（下载）、upload=tx（上传）。
 *
 * 交互：日/月聚合切换（90 天 / 12 个月）、设备选择（可选，默认全设备 SUM）。
 * 渲染：SVG 折线（一次构建），切换/刷新只重写 path 与坐标文本。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const H = 260, PAD_L = 86, PAD_R = 20, PAD_T = 28, PAD_B = 40;

const callStatus = rpc.declare({
	object: 'zen.traffic',
	method: 'getStatus'
});

const callDevices = rpc.declare({
	object: 'zen.traffic',
	method: 'getDevices'
});

const callHistory = rpc.declare({
	object: 'zen.traffic',
	method: 'getHistory',
	params: ['agg', 'mac']
});

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

/* 峰值向上取整到 1/2/2.5/5/10 × 10^k（与 zen-format niceMax 同口径） */
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

function svg(name, attrs, children) {
	const el = document.createElementNS(SVG_NS, name);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	(children || []).forEach((c) => el.appendChild(c));
	return el;
}

/* 独立样式 id，避免先打开设备页后跳过历史图表样式。 */
const CSS_ID = 'zen-traffic-history-css';
function injectStyles() {
	if (document.getElementById(CSS_ID))
		return;
	const style = document.createElement('style');
	style.id = CSS_ID;
	style.textContent = [
		'.zen-tf-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }',
		'.zen-tf-tabs { display: flex; gap: 8px; }',
		'.zen-tf-chart-svg { display: block; width: 100%; height: 260px; background: rgba(127,127,127,.04); border-radius: 12px; }',
		'.zen-tf-controls > select { min-width: 0; max-width: 100%; }',
		'.zen-tf-bar-ul { fill: var(--ul, #ea580c); }',
		'.zen-tf-bar-dl { fill: var(--dl, #15803d); }',
		'.zen-tf-grid { stroke: currentColor; opacity: .12; }',
		'.zen-tf-ax { font-size: 11px; fill: currentColor; opacity: .65; }',
		'.zen-tf-line-dl { stroke: var(--dl, currentColor); stroke-width: 2; }',
		'.zen-tf-line-ul { stroke: var(--ul, currentColor); stroke-width: 2; stroke-dasharray: 5 5; }',
		'.zen-tf-point-dl { fill: var(--dl, currentColor); }',
		'.zen-tf-point-ul { fill: var(--bg-panel, white); stroke: var(--ul, currentColor); stroke-width: 2; }',
		'.zen-tf-legend { display: flex; gap: 16px; padding-top: 6px; font-size: 13px; }',
		'.zen-tf-legend .zen-tf-dl { color: var(--dl, currentColor); }',
		'.zen-tf-legend .zen-tf-ul { color: var(--ul, currentColor); }'
	].join('\n');
	document.head.appendChild(style);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
	agg: 'day',
	mac: '',
	chart: null,
	labels: {},

	load() {
		return Promise.all([
			callStatus().catch(() => null),
			callDevices().catch(() => ({ dev: [] }))
		]);
	},

	render(data) {
		const status = data[0];
		const devs = (data[1] && data[1].dev) || [];

		injectStyles();

		if (!status)
			return E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('Traffic History')),
				E('div', { 'class': 'cbi-section' }, [
					E('p', { 'class': 'alert-message warning' },
						_('The zen-traffic daemon is not reachable. History is stored in the daemon-side SQLite database.'))
				])
			]);

		/* 设备选择（单选 + 全设备） */
		const sel = E('select', { 'class': 'cbi-input-select', 'change': L.bind(function (ev) {
			this.mac = ev.target.value;
			this.refresh();
		}, this) }, [
			E('option', { 'value': '' }, _('All devices'))
		].concat(devs.map((d) => E('option', { 'value': d.mac }, d.host || d.ip4 || d.mac))));

		const tabs = E('div', { 'class': 'zen-tf-tabs' }, [
			this.tabBtn('day', _('Daily (90 days)')),
			this.tabBtn('month', _('Monthly (12 months)'))
		]);

		const root = E('div', { 'class': 'cbi-map', 'id': 'zen-traffic-history' }, [
			E('h2', {}, _('Traffic History')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Daily and monthly usage aggregated from the zen-traffic SQLite database. download = rx, upload = tx.')),
			E('div', { 'class': 'cbi-section zen-tf-controls' }, [
				E('label', {}, _('Device')), sel,
				tabs
			]),
			E('div', { 'class': 'cbi-section' },
				(this.chart = E('div', { 'class': 'zen-tf-chart' }, [])))
		]);

		this.sel = sel;
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (typeof ResizeObserver !== 'undefined') {
			this.resizeObserver = new ResizeObserver(() => {
				if (this.chart.clientWidth !== this.chartWidth && this.lastResult)
					this.draw(this.lastResult);
			});
			this.resizeObserver.observe(this.chart);
		}
		this.refresh();
		return root;
	},

	tabBtn(agg, label) {
		const btn = E('button', {
			'class': 'cbi-button' + (this.agg === agg ? ' cbi-button-action important' : ''),
			'click': L.bind(function (ev) {
				ev.preventDefault();
				this.agg = agg;
				/* 同级 tab 互斥高亮 */
				for (const b of ev.target.parentElement.querySelectorAll('.cbi-button'))
					b.classList.remove('cbi-button-action', 'important');
				ev.target.classList.add('cbi-button-action', 'important');
				this.refresh();
			}, this)
		}, label);
		return btn;
	},

	refresh() {
		if (document.hidden || !this.chart)
			return;

		const request = this.request = (this.request || 0) + 1;
		return callHistory(this.agg, this.mac || null).then(L.bind((res) => {
			if (request === this.request)
				this.draw(res);
		}, this)).catch((e) => {
			console.warn('zen-traffic history', e);
		});
	},

	draw(res) {
		const el = this.chart;
		if (!el)
			return;
		this.lastResult = res;
		this.chartWidth = el.clientWidth;
		const W = Math.max(280, el.clientWidth || 860);

		const isMonth = (res && res.agg === 'month');
		const rows = (isMonth ? (res.months || []) : ((res && res.days) || []))
			.map((r) => ({ k: r.date || r.month, dl: r.download || 0, ul: r.upload || 0 }));

		el.textContent = '';

		if (!rows.length) {
			el.appendChild(E('p', { 'class': 'alert-message info' },
				_('No history data yet. Usage accumulates as traffic flows and is persisted on checkpoint/day rollover.')));
			return;
		}

		const max = niceMax(Math.max(...rows.map((r) => Math.max(r.dl, r.ul))));
		const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
		const n = rows.length;
		const x = (i) => PAD_L + (n === 1 ? iw / 2 : (i * iw / (n - 1)));
		const y = (v) => PAD_T + ih - (Math.min(v, max) * ih / max);

		const grid = [];
		const ytexts = [];
		for (let g = 0; g <= 4; g++) {
			const gy = PAD_T + ih * g / 4;
			const gv = max * (4 - g) / 4;
			grid.push(svg('line', { x1: PAD_L, y1: gy, x2: W - PAD_R, y2: gy, 'class': 'zen-tf-grid' }));
			ytexts.push(svg('text', { x: PAD_L - 8, y: gy + 4, 'text-anchor': 'end', 'class': 'zen-tf-ax' },
				[document.createTextNode(fmtBytes(gv))]));
		}

		const xticks = [];
		const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 110))));
		for (let i = 0; i < n; i += step) {
			xticks.push(svg('text', {
				x: x(i), y: H - PAD_B + 18, 'text-anchor': n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', 'class': 'zen-tf-ax'
			}, [document.createTextNode(rows[i].k)]));
		}

		const path = (key) => svg('path', {
			d: rows.map((r, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(r[key]).toFixed(1)).join(' '),
			'fill': 'none', 'class': key === 'dl' ? 'zen-tf-line-dl' : 'zen-tf-line-ul'
		});
		/* 单日/月使用两根柱；多日/月保留曲线和圆点。 */
		const points = [];
		rows.forEach((r, i) => {
			for (const key of ['ul', 'dl']) {
				if (n === 1) {
					const center = x(0) + (key === 'ul' ? -32 : 32);
					const height = Math.max(2, H - PAD_B - y(r[key]));
					const top = H - PAD_B - height;
					points.push(svg('rect', { x: center - 20, y: top, width: 40, height, rx: 4, 'class': 'zen-tf-bar-' + key }, [
						svg('title', {}, [document.createTextNode(r.k + ' · ' + (key === 'ul' ? _('Upload') : _('Download')) + ': ' + fmtBytes(r[key]))])
					]));
					points.push(svg('text', { x: center, y: top - 8, 'text-anchor': 'middle', 'class': 'zen-tf-ax' }, [document.createTextNode(fmtBytes(r[key]))]));
					continue;
				}
				points.push(svg('circle', {
					cx: x(i), cy: y(r[key]), r: key === 'dl' ? 4 : 3,
					'class': 'zen-tf-point-' + key
				}, [svg('title', {}, [document.createTextNode(
					r.k + ' · ' + (key === 'dl' ? _('Download') : _('Upload')) + ': ' + fmtBytes(r[key])
				)])]));
			}
		});

		const legend = E('div', { 'class': 'zen-tf-legend' }, [
			E('span', { 'class': 'zen-tf-ul' }, '— ' + _('Upload')),
			E('span', { 'class': 'zen-tf-dl' }, '— ' + _('Download'))
		]);

		const chartSvg = svg('svg', {
			viewBox: '0 0 %d %d'.format(W, H),
			'preserveAspectRatio': 'xMidYMid meet',
			role: 'img', 'aria-label': _('Traffic History'),
			'class': 'zen-tf-chart-svg'
		}, [].concat(grid, ytexts, xticks, n === 1 ? [] : [path('ul'), path('dl')], points));

		el.appendChild(chartSvg);
		el.appendChild(legend);
	}
});
