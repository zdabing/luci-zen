'use strict';
'require view';
'require rpc';
'require ui';
'require view.zen-traffic.rate-history as rateHistory';
'require view.zen-traffic.device-timeline as deviceTimeline';
'require view.zen-traffic.style as trafficStyle';

/*
 * view.zen-traffic.history — luci-app-zen-traffic 历史曲线页。
 *
 * 数据源：ubus zen.traffic getHistory（SQLite daily_usage/monthly_usage 聚合，
 * daemon 端落盘）。方向约定 download=rx（下载）、upload=tx（上传）。
 *
 * 交互：日/月聚合切换（90 天 / 12 个月）、设备选择（可选，默认全设备 SUM）。
 * 渲染：每个日期一组上传/下载柱，长历史只滚动图表。
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
	params: ['agg', 'mac'],
	reject: true
});

/* Omit the optional filter for all devices, including on older daemons. */
const callAllHistory = rpc.declare({
	object: 'zen.traffic',
	method: 'getHistory',
	params: ['agg'],
	reject: true
});
const callInternetHistory = rpc.declare({object:'zen.traffic',method:'getInternetHistory',params:['agg','mac'],reject:true});
const callReset = rpc.declare({object:'zen.traffic',method:'resetDevice',params:['mac'],reject:true});

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
		'#zen-traffic-history .zen-history-controls { display: grid; gap: 16px; }',
		'#zen-traffic-history .zen-history-field { display: grid; gap: 8px; min-width: 0; margin: 0; font-size: 13px; line-height: 20px; }',
		'#zen-traffic-history .zen-history-field select { width: 100%; height: 44px; min-height: 44px; margin: 0; }',
		'#zen-traffic-history .zen-history-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }',
		'#zen-traffic-history .zen-history-actions > label { flex: 0 1 280px; }',
		'#zen-traffic-history .zen-history-actions > .zen-tf-tabs { box-sizing: border-box; height: 44px; max-width: 100%; }',
		'#zen-traffic-history .zen-history-actions > .zen-tf-tabs button { height: 36px; min-height: 36px; padding: 0 14px; }',
		'#zen-traffic-history .zen-history-actions > button { height: 44px; min-height: 44px; margin: 0; }',
		'@media(max-width:600px) { #zen-traffic-history .zen-history-actions { display: grid; grid-template-columns: minmax(0,1fr); } #zen-traffic-history .zen-history-actions > label, #zen-traffic-history .zen-history-actions > button { width: 100%; } #zen-traffic-history .zen-history-actions > .zen-tf-tabs { height: 52px; } #zen-traffic-history .zen-history-actions > .zen-tf-tabs button { height: 44px; min-height: 44px; padding: 0 8px; } }',
		'.zen-analysis-table { width: 100%; table-layout: fixed; } .zen-analysis-table th:first-child { width: 40%; } .zen-analysis-table td, .zen-analysis-table th { overflow-wrap: anywhere; }',
		'@media(max-width:600px) { .zen-analysis-table td, .zen-analysis-table th { padding: 10px 6px; font-size: 12px; } }',
		'.zen-tf-bar-ul { fill: var(--ul, #ea580c); }',
		'.zen-tf-bar-dl { fill: var(--dl, #15803d); }',
		'.zen-tf-chart-scroll { max-width: 100%; overflow-x: auto; }',
		'.zen-tf-bar-ul:focus, .zen-tf-bar-dl:focus { outline: none; stroke: currentColor; stroke-width: 2; }',
		'.zen-tf-readout { padding-top: 8px; font-size: 13px; font-variant-numeric: tabular-nums; }',
		'.zen-tf-grid { stroke: currentColor; opacity: .12; }',
		'.zen-tf-ax { font-size: 11px; fill: currentColor; opacity: .65; }',
		'.zen-tf-legend { display: flex; gap: 16px; padding-top: 6px; font-size: 13px; }',
		'.zen-tf-legend .zen-tf-dl { color: var(--dl, currentColor); }',
		'.zen-tf-legend .zen-tf-ul { color: var(--ul, currentColor); }',
		'.zen-device-timeline [hidden] { display:none!important; }',
		'#device-hourly { scroll-margin-top:96px; } #device-hourly:focus { outline:none; }',
		'.zen-timeline-controls { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; } .zen-timeline-controls input { min-height:44px; max-width:100%; }',
		'.zen-timeline-frame { position:relative; min-width:0; margin-top:16px; } .zen-timeline-scroll { width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; }',
		'.zen-timeline-scroll-hint { display:none; } @media(max-width:600px) { .zen-timeline-scroll-hint { display:block; font-size:12px; margin:8px 0; } }',
		'.zen-timeline-chart { display:block; width:100%; min-width:960px; height:280px; color:var(--zt-text,var(--text,#536175)); }',
		'.zen-traffic-page .zen-device-timeline .zen-rt-summary { grid-template-columns:repeat(3,minmax(0,1fr)); } @media(max-width:600px) { .zen-traffic-page .zen-device-timeline .zen-rt-summary { grid-template-columns:repeat(2,minmax(0,1fr)); } .zen-device-timeline .zen-rt-summary > div:last-child { grid-column:1 / -1; } }',
		'.zen-timeline-hit { fill:currentColor; fill-opacity:0; } .zen-timeline-slot { cursor:pointer; outline:none; } .zen-timeline-slot[aria-pressed="true"] .zen-timeline-hit { fill-opacity:.06; } .zen-timeline-slot:focus-visible .zen-timeline-hit { stroke:currentColor; stroke-width:1.5; }',
		'.zen-timeline-slot.is-current .zen-timeline-hit { stroke:var(--primary,#168b7f); stroke-width:1; stroke-dasharray:4 3; } .zen-timeline-slot.is-unavailable .zen-timeline-hit { fill-opacity:.025; }',
		'.zen-traffic-page .zen-timeline-tip { box-sizing:border-box; max-width:min(360px,calc(100% - 16px)); white-space:normal!important; overflow-wrap:anywhere; } .zen-timeline-readout { min-height:24px; margin-top:10px; font-size:13px; line-height:1.7; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }'
	].join('\n');
	document.head.appendChild(style);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
	agg: 'day',
	scope: 'internet',
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
		this.scope = status && status.wan_daily ? 'internet' : 'all';
		const requestedMac = new URLSearchParams(window.location.search).get('mac') || '';
		this.mac = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(requestedMac) ? requestedMac.toLowerCase() : '';
		this.jumpToHourly = !!this.mac && window.location.hash === '#device-hourly';

		injectStyles();
		trafficStyle.inject();

		if (!status)
			return E('div', { 'class': 'cbi-map zen-traffic-page' }, [
				E('h2', {}, _('Traffic History')),
				E('div', { 'class': 'cbi-section' }, [
					E('p', { 'class': 'alert-message warning' },
						_('The zen-traffic daemon is not reachable. History is stored in the daemon-side SQLite database.'))
				])
			]);

		/* 设备选择（单选 + 全设备） */
		const sel = E('select', { id: 'zen-tf-history-device', 'class': 'cbi-input-select', 'change': L.bind(function (ev) {
			this.mac = ev.target.value;
			this.refresh();
		}, this) }, [
			E('option', { 'value': '' }, _('All devices'))
		].concat(devs.map((d) => E('option', { 'value': d.mac }, d.host || d.ip4 || d.mac))));
		if (this.mac && !devs.some(d => d.mac.toLowerCase() === this.mac))
			sel.appendChild(E('option', { value: this.mac }, this.mac));

		const tabs = E('div', { 'class': 'zen-tf-tabs' }, [
			this.tabBtn('day', _('Daily (90 days)')),
			this.monthTab = this.tabBtn('month', this.scope === 'internet' ? _('Monthly (retained days)') : _('Monthly (12 months)'))
		]);
		const internetOption = E('option', {value:'internet'}, _('Internet only'));
		internetOption.disabled = !(status && status.wan_daily);
		const scope = E('select', {'aria-label': _('Traffic scope'), change: ev => {
			this.scope = ev.target.value;
			this.monthTab.textContent = this.scope === 'internet' ? _('Monthly (retained days)') : _('Monthly (12 months)');
			this.refresh();
		}}, [internetOption,E('option',{value:'all'},_('Internet + local (existing history)'))]);
		scope.value = this.scope;
		const reset = E('button', {type:'button','class':'cbi-button cbi-button-negative',click:()=>this.resetSelected()}, _('Reset selected device counters'));
		this.resetButton = reset;
		this.rateView = Object.create(rateHistory);
		this.timelineView = Object.create(deviceTimeline);

		const root = E('div', { 'class': 'cbi-map zen-traffic-page', 'id': 'zen-traffic-history' }, [
			E('h2', {}, _('History analysis')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Compare recorded usage by date and device, then inspect past internet rates. Current speeds are on Zen home.')),
			E('div', { 'class': 'cbi-section zen-history-controls' }, [
				E('label', { 'class': 'zen-history-field', 'for': 'zen-tf-history-device' }, [_('Device'), sel]),
				E('div', { 'class': 'zen-history-actions' }, [
					tabs, E('label', { 'class': 'zen-history-field' }, [_('Traffic scope'), scope]), reset
				])
			]),
			E('div', { 'class': 'cbi-section' },
				[this.statusText = E('p', { 'class': 'zen-tf-status', role: 'status' }),
				this.scopeNote = E('p', {'class':'zen-app-muted'}),
				this.usageSummary = E('div', {'class':'zen-rt-summary'}),
				(this.chart = E('div', { 'class': 'zen-tf-chart' }, []))]),
			this.timelineView.render(status),
			E('section',{'class':'cbi-section'},[E('h3',{},_('Device usage ranking')),this.ranking = E('div')]),
			this.rateView.render({data:{samples:[],interfaces:[],step:5}})
		]);

		this.sel = sel;
		this.sel.value = this.mac;
		this.rateView.query();
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
			type: 'button', 'aria-pressed': String(this.agg === agg),
			'class': 'cbi-button' + (this.agg === agg ? ' cbi-button-action important' : ''),
			'click': L.bind(function (ev) {
				ev.preventDefault();
				this.agg = agg;
				/* 同级 tab 互斥高亮 */
				for (const b of ev.target.parentElement.querySelectorAll('.cbi-button')) {
					b.classList.remove('cbi-button-action', 'important');
					b.setAttribute('aria-pressed', 'false');
				}
				ev.target.classList.add('cbi-button-action', 'important');
				ev.target.setAttribute('aria-pressed', 'true');
				this.refresh();
			}, this)
		}, label);
		return btn;
	},

	refresh() {
		if (document.hidden || !this.chart)
			return;

		const request = this.request = (this.request || 0) + 1;
		const timelineReady = this.timelineView?.select(this.mac);
		if (this.jumpToHourly) {
			this.jumpToHourly = false;
			Promise.resolve(timelineReady).then(() => requestAnimationFrame(() => {
				const section = this.timelineView?.container;
				if (!section?.isConnected) return;
				section.scrollIntoView({ block: 'start' });
				section.focus({ preventScroll: true });
			}));
		}
		this.statusText.textContent = _('Loading history…');
		this.resetButton.disabled = !this.mac;
		this.scopeNote.textContent = this.scope === 'internet' ?
			_('Internet-only daily records start when this version is installed and retain 90 days. Monthly bars sum these retained days. Older mixed records cannot be converted.') :
			_('Existing history includes internet and local transfers: 90 days of daily records and 12 months of monthly records.');
		const query = this.scope === 'internet' ? callInternetHistory(this.agg, this.mac).then(r=>JSON.parse(r.json)) :
			(this.mac ? callHistory(this.agg, this.mac) : callAllHistory(this.agg));
		return query.then(L.bind((res) => {
			if (request === this.request) {
				this.statusText.textContent = '';
				this.draw(res);
				this.drawAnalysis(res);
			}
		}, this)).catch((e) => {
			if (request === this.request) {
				this.statusText.textContent = _('Unable to load history. Please try again.');
				this.chart.textContent = '';
				this.usageSummary.replaceChildren(); this.ranking.replaceChildren();
				this.lastResult = null;
			}
			console.warn('zen-traffic history', e);
		});
	},

	resetSelected() {
		if (!this.mac) return;
		const mac = this.mac, name = this.sel.selectedOptions[0].textContent;
		ui.showModal(_('Reset counters'), [E('p',{},_('Reset all counters for %s?').format(name)),
			E('div',{'class':'zen-tf-modal-actions'},[
				E('button',{type:'button','class':'btn',click:ui.hideModal},_('Cancel')),
				E('button',{type:'button','class':'btn cbi-button-negative',click:()=>{
					ui.hideModal(); callReset(mac).then(()=>this.refresh()).catch(()=>ui.addNotification(null,E('p',{},_('Unable to reset device counters.'))));
				}},_('Reset counters'))])]);
	},

	drawAnalysis(res) {
		const rows = res.days || res.months || [];
		const totals = rows.reduce((s,r)=>({upload:s.upload+(r.upload||0),download:s.download+(r.download||0)}),{upload:0,download:0});
		this.usageSummary.replaceChildren(...[[ _('Recorded upload'), totals.upload, 'zen-tf-ul'],[_('Recorded download'),totals.download,'zen-tf-dl']]
			.map(([label,value,cls])=>E('div',{},[E('span',{},label),E('strong',{'class':cls},fmtBytes(value))])));
		this.ranking.replaceChildren();
		if (this.scope !== 'internet') {
			this.ranking.appendChild(E('p',{'class':'zen-app-muted'},_('Choose Internet only to compare devices with the upstream total.'))); return;
		}
		this.ranking.appendChild(E('p',{'class':'zen-app-muted'},_('Ranking covers the same retained 90-day internet window. Percentages use the upstream total; unassigned traffic is shown separately.')));
		const names = new Map(Array.from(this.sel.options).map(o=>[o.value,o.textContent]));
		const total = (res.network_upload || 0) + (res.network_download || 0);
		const table = E('table',{'class':'table zen-analysis-table'},[
			E('thead',{},E('tr',{},[_('Device'),_('Upload'),_('Download'),_('Share')].map(t=>E('th',{scope:'col'},t)))),
			E('tbody',{},(res.ranking || []).map(r=>E('tr',{},[
				E('td',{},names.get(r.mac)||r.mac),E('td',{'class':'zen-tf-ul'},fmtBytes(r.upload)),
				E('td',{'class':'zen-tf-dl'},fmtBytes(r.download)),E('td',{},total ? ((r.upload+r.download)*100/total).toFixed(1)+'%' : '—')
			]))) ]);
		this.ranking.appendChild(table);
		if (res.unassigned_upload || res.unassigned_download)
			this.ranking.appendChild(E('p',{},_('Unassigned') + ': ↑ '+fmtBytes(res.unassigned_upload)+' · ↓ '+fmtBytes(res.unassigned_download)));
		if (res.excess_upload || res.excess_download)
			this.ranking.appendChild(E('p',{'class':'alert-message warning'},_('Attributed device usage exceeds the upstream total; percentages may exceed 100%.')));
	},

	draw(res) {
		const el = this.chart;
		if (!el)
			return;
		this.lastResult = res;
		this.chartWidth = el.clientWidth;
		const viewportW = Math.max(280, el.clientWidth || 860);

		const isMonth = (res && res.agg === 'month');
		const rows = (isMonth ? (res.months || []) : ((res && res.days) || []))
			.map((r) => ({ k: r.date || r.month, dl: r.download || 0, ul: r.upload || 0 }));

		el.textContent = '';

		if (!rows.length) {
			el.appendChild(E('p', { 'class': 'alert-message info' },
				_('No history data yet. Usage accumulates as traffic flows and is persisted on checkpoint/day rollover.')));
			return;
		}

		const n = rows.length;
		const W = Math.max(viewportW, PAD_L + PAD_R + n * 24);
		const max = niceMax(Math.max(...rows.map((r) => Math.max(r.dl, r.ul))));
		const iw = W - PAD_L - PAD_R, ih = H - PAD_T - PAD_B;
		const slot = iw / n, barWidth = Math.min(40, slot * .3), gap = Math.min(8, slot * .1);
		const x = (i) => PAD_L + (i + .5) * slot;
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

		const tip = E('div', { 'class': 'zen-history-tip', role: 'tooltip', hidden: true });
		const positionTip = ev => {
			if (!ev) return;
			const box = el.getBoundingClientRect(), anchor = (ev.currentTarget || chartSvg).getBoundingClientRect();
			const px = (Number.isFinite(ev.clientX) ? ev.clientX : anchor.left + anchor.width / 2) - box.left;
			const py = (Number.isFinite(ev.clientY) ? ev.clientY : anchor.top) - box.top;
			const tw = tip.offsetWidth, th = tip.offsetHeight, cw = el.clientWidth, ch = el.clientHeight;
			const tx = px + 12 + tw > cw - 8 ? px - tw - 12 : px + 12;
			const ty = py - th - 12 < 8 ? py + 12 : py - th - 12;
			tip.style.left = Math.max(8, Math.min(tx, cw - tw - 8)) + 'px';
			tip.style.top = Math.max(8, Math.min(ty, ch - th - 8)) + 'px';
		};
		const readout = E('div', { 'class': 'zen-tf-readout', role: 'status' });
		const showRow = (r, active, ev) => {
			readout.textContent = r.k + ' · ↑ ' + fmtBytes(r.ul) + ' · ↓ ' + fmtBytes(r.dl);
			tip.textContent = readout.textContent; tip.hidden = !active;
			if (active) positionTip(ev);
		};
		showRow(rows[n - 1]);
		const points = [];
		rows.forEach((r, i) => {
			for (const key of ['ul', 'dl']) {
				const center = x(i) + (key === 'ul' ? -1 : 1) * (barWidth + gap) / 2;
				const top = y(r[key]), height = H - PAD_B - top;
				const label = r.k + ' · ' + (key === 'ul' ? _('Upload') : _('Download')) + ': ' + fmtBytes(r[key]);
				const bar = svg('rect', { x: center - barWidth / 2, y: top, width: barWidth, height,
					rx: Math.min(4, barWidth / 4), tabindex: 0, 'aria-label': label, 'class': 'zen-tf-bar-' + key },
					[svg('title', {}, [document.createTextNode(label)])]);
				for (const event of ['mouseenter', 'focus', 'click'])
					bar.addEventListener(event, ev => showRow(r, true, ev));
				points.push(bar);
				if (n === 1)
					points.push(svg('text', { x: center, y: top - 8, 'text-anchor': 'middle', 'class': 'zen-tf-ax' }, [document.createTextNode(fmtBytes(r[key]))]));
			}
		});

		const legend = E('div', { 'class': 'zen-tf-legend' }, [
			E('span', { 'class': 'zen-tf-ul' }, '■ ' + _('Upload')),
			E('span', { 'class': 'zen-tf-dl' }, '■ ' + _('Download'))
		]);

		const chartSvg = svg('svg', {
			viewBox: '0 0 %d %d'.format(W, H),
			'preserveAspectRatio': 'xMidYMid meet',
			role: 'img', 'aria-label': _('Traffic History'),
			'class': 'zen-tf-chart-svg', style: 'width: ' + W + 'px; max-width: none;'
		}, [].concat(grid, ytexts, xticks, points));

		const inspect = ev => {
			const bounds = chartSvg.getBoundingClientRect();
			const px = (ev.clientX - bounds.left) * W / Math.max(1, bounds.width);
			if (px < PAD_L || px > W - PAD_R) { tip.hidden = true; return; }
			showRow(rows[Math.min(n - 1, Math.max(0, Math.floor((px - PAD_L) / slot)))], true, ev);
		};
		for (const event of ['pointermove', 'pointerdown', 'click']) chartSvg.addEventListener(event, inspect);
		chartSvg.addEventListener('pointerleave', () => { tip.hidden = true; });
		el.appendChild(tip);
		el.appendChild(E('div', { 'class': 'zen-tf-chart-scroll', tabindex: 0 }, [chartSvg]));
		el.appendChild(legend);
		if (W > viewportW)
			el.appendChild(E('p', { 'class': 'zen-app-muted' }, _('Swipe or scroll to see more dates.')));
		el.appendChild(readout);
	}
});
