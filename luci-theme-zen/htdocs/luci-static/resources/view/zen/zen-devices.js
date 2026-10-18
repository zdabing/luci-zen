'use strict';
'require baseclass';
'require rpc';
'require poll';
'require ui';
'require view.zen.zen-format as fmt';
'require view.zen.zen-icons as icons';
'require view.zen.zen-identity as identity';
'require view.zen.zen-device-panel as panel';

/*
 * view.zen.zen-devices — 首页“设备流量”模块。
 *
 * 数据源：ubus 对象 zen.traffic（zen-traffic 守护进程发布，LuCI ACL 见
 * luci-theme-zen.json / zen-traffic.json）。**主题不硬依赖该组件**：
 * probe() 失败时模块降级为提示卡片，其余仪表盘功能不受影响。
 *
 * Phase 3：真实设备列表渲染 —— MAC 缓存行、textContent-only 更新、
 * Top-N 折叠/展开、今日/月累计；2s 轮询、document.hidden 节流。
 * 完整版设备页（历史曲线/hostname 编辑/单设备重置）在 luci-app-zen-traffic。
 */

const DEV_POLL_SECS = 2;
const TOP_N = 8;

const callStatus = rpc.declare({
	object: 'zen.traffic',
	method: 'getStatus'
});

const callDevices = rpc.declare({
	object: 'zen.traffic',
	method: 'getDevices'
});

const callHistory = rpc.declare({
	object: 'zen.traffic', method: 'getHistory', params: ['agg', 'mac'], reject: true
});

const callAccess = rpc.declare({ object: 'session', method: 'access', params: ['scope', 'object', 'function'], expect: { access: false } });
const callReset = rpc.declare({ object: 'zen.traffic', method: 'resetDevice', params: ['mac'], reject: true });

function historySvg(tag, attrs, text) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const key in attrs) el.setAttribute(key, attrs[key]);
	if (text != null) el.textContent = text;
	return el;
}

function drawHistory(ent, res) {
	ent.historyData = res;
	ent.historyWidth = ent.historyChart.clientWidth;
	const rows = ((res && res.days) || []).slice(-14);
	ent.historyChart.textContent = '';
	if (!rows.length) {
		ent.historyChart.textContent = _('No history data yet');
		return;
	}
	const max = fmt.niceMax(Math.max(...rows.map(r => Math.max(r.download || 0, r.upload || 0))));
	const width = Math.max(280, ent.historyChart.clientWidth - 16);
	const left = 62, right = width - 18, bottom = 136;
	const chart = historySvg('svg', { viewBox: '0 0 ' + width + ' 180', role: 'img', 'aria-label': _('Daily traffic') });
	chart.style.width = '100%';
	const slot = (right - left) / rows.length;
	const barWidth = Math.min(36, slot * .3), gap = Math.min(8, slot * .1);
	const x = i => left + (i + .5) * slot;
	const y = v => bottom - Math.max(0, Number(v) || 0) * 108 / max;
	for (let i = 0; i <= 2; i++) {
		const value = max * i / 2;
		chart.appendChild(historySvg('line', { x1: left, x2: right, y1: y(value), y2: y(value), 'class': 'history-grid' }));
		chart.appendChild(historySvg('text', { x: left - 8, y: y(value) + 4, 'text-anchor': 'end' }, fmt.fmtBytes(value)));
	}
	const tip = E('div', { 'class': 'zen-history-tip', role: 'tooltip', hidden: true });
	const positionTip = ev => {
		if (!ev) return;
		const box = ent.historyChart.getBoundingClientRect(), anchor = (ev.currentTarget || chart).getBoundingClientRect();
		const px = (Number.isFinite(ev.clientX) ? ev.clientX : anchor.left + anchor.width / 2) - box.left;
		const py = (Number.isFinite(ev.clientY) ? ev.clientY : anchor.top) - box.top;
		const tw = tip.offsetWidth, th = tip.offsetHeight, cw = ent.historyChart.clientWidth, ch = ent.historyChart.clientHeight;
		const tx = px + 12 + tw > cw - 8 ? px - tw - 12 : px + 12;
		const ty = py - th - 12 < 8 ? py + 12 : py - th - 12;
		tip.style.left = ((ent.historyChart.scrollLeft || 0) + Math.max(8, Math.min(tx, cw - tw - 8))) + 'px';
		tip.style.top = ((ent.historyChart.scrollTop || 0) + Math.max(8, Math.min(ty, ch - th - 8))) + 'px';
	};
	const select = (row, active, ev) => {
		ent.historyDate = row.date;
		tip.textContent = row.date + ' · ' + _('Upload') + ' ' + fmt.fmtBytes(row.upload) + ' · ' + _('Download') + ' ' + fmt.fmtBytes(row.download);
		tip.hidden = !active;
		if (active) positionTip(ev);
	};
	rows.forEach((row, i) => {
		for (const key of ['upload', 'download']) {
			const value = Math.max(0, Number(row[key]) || 0);
			const label = row.date + ' · ' + (key === 'upload' ? _('Upload') : _('Download')) + ': ' + fmt.fmtBytes(value);
			const bar = historySvg('rect', { x: x(i) + (key === 'upload' ? -gap / 2 - barWidth : gap / 2), y: y(value),
				width: barWidth, height: bottom - y(value), rx: 3, tabindex: 0, 'aria-label': label,
				'class': 'history-bar ' + (key === 'upload' ? 'ul' : 'dl') });
			bar.appendChild(historySvg('title', {}, label));
			for (const event of ['mouseenter', 'focus', 'click']) bar.addEventListener(event, ev => select(row, true, ev));
			chart.appendChild(bar);
		}
	});
	const tickStep = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((right - left) / 110))));
	for (let i = 0; i < rows.length; i++) {
		if (i % tickStep !== 0 && i !== rows.length - 1) continue;
		chart.appendChild(historySvg('text', { x: x(i), y: 168, 'text-anchor': rows.length === 1 ? 'middle' :
			i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' }, width < 480 ? rows[i].date.slice(5) : rows[i].date));
	}
	select(rows.find(row => row.date === ent.historyDate) || rows[rows.length - 1]);
	const inspect = ev => {
		const bounds = chart.getBoundingClientRect();
		const px = (ev.clientX - bounds.left) * width / Math.max(1, bounds.width);
		if (px < left || px > right) { tip.hidden = true; return; }
		select(rows[Math.min(rows.length - 1, Math.max(0, Math.floor((px - left) / slot)))], true, ev);
	};
	for (const event of ['pointermove', 'pointerdown', 'click']) chart.addEventListener(event, inspect);
	chart.addEventListener('pointerleave', () => { tip.hidden = true; });
	ent.historyChart.appendChild(tip);
	ent.historyChart.appendChild(chart);
}

function refreshHistory(ent, force) {
	if (!ent.d || ent.historyLoading || (!force && Date.now() - (ent.historyAt || 0) < 60000)) return;
	if (!ent.historyChart) {
		ent.historyChart = E('div', { 'class': 'zen-dash-device-history', 'aria-live': 'polite' }, _('Loading history…'));
		const refresh = E('button', { type: 'button', 'class': 'zen-dash-history-refresh' }, _('Refresh'));
		refresh.addEventListener('click', () => refreshHistory(ent, true));
		ent.detail.appendChild(E('div', { 'class': 'zen-dash-history-head' }, [E('strong', {}, _('Daily traffic')), refresh]));
		ent.detail.appendChild(E('div', { 'class': 'zen-dash-chart-legend zen-dash-history-legend' }, [
			E('span', { 'class': 'ul' }, [E('span', { 'class': 'swatch' }), _('Upload')]),
			E('span', { 'class': 'dl' }, [E('span', { 'class': 'swatch' }), _('Download')])
		]));
		ent.detail.appendChild(ent.historyChart);
		if (typeof ResizeObserver !== 'undefined') {
			ent.historyResize = new ResizeObserver(() => {
				if (ent.historyData && ent.historyChart.clientWidth > 0 &&
					ent.historyChart.clientWidth !== ent.historyWidth)
					drawHistory(ent, ent.historyData);
			});
			ent.historyResize.observe(ent.historyChart);
		}
	}
	ent.historyLoading = true;
	return callHistory('day', ent.d.mac).then(res => {
		drawHistory(ent, res);
		ent.historyAt = Date.now();
	}).catch(() => {
		if (!ent.historyAt) ent.historyChart.textContent = _('Unable to load history');
	}).finally(() => { ent.historyLoading = false; });
}

/* 'ok' | 'missing'（权限/异常也归并为 missing，降级语义一致） */
async function probeState() {
	try {
		await callStatus();
		return 'ok';
	} catch (e) {
		/* ubus 对象不存在（未安装）与权限/异常均降级，不阻塞首页 */
		return 'missing';
	}
}

function setText(el, s) {
	if (el && el.textContent !== s)
		el.textContent = s;
}

function devName(d) {
	return d.host || d.ip4 || d.ip6 || d.mac;
}

function connText(d) {
	if (d.conn === 'wifi')
		return _('Wi-Fi') + (d.band ? ' · ' + d.band : '');
	if (d.conn === 'router')
		return _('Router');
	if (d.conn === 'wired')
		return _('Wired');
	return d.conn || '';
}

function detailFacts(d) {
	return [[_('Connection'), connText(d)], ['IPv4', d.ip4 || '—'], ['IPv6', d.ip6 || '—'], [_('MAC'), d.mac],
		[_('Last activity'), d.last > 0 ? new Date(d.last * 1000).toLocaleString() : '—']];
}

function buildRow(owner) {
	const li = E('li', { 'class': 'zen-dash-dev-row', role: 'button', tabindex: '0', 'aria-expanded': 'false' });

	const iconBox = E('span', { 'class': 'zen-dash-dev-icon' }, []);
	const ov = E('span', { 'class': 'zen-dash-ov-dot dot' });
	iconBox.appendChild(ov);

	const id = E('span', { 'class': 'zen-dash-dev-id' }, [
		E('span', { 'class': 'zen-dash-dev-name-line' }, [E('span', { 'class': 'zen-dash-dev-name' }, '')]),
		E('span', { 'class': 'zen-dash-dev-model' }, '')
	]);
	const ip = E('span', { 'class': 'zen-dash-dev-ip' }, '');
	const mac = E('span', { 'class': 'zen-dash-dev-mac' }, '');

	const connLabel = E('span', {}, '');
	const conn = E('span', { 'class': 'zen-dash-dev-conn' }, [connLabel]);
	const rate = (direction, label) => E('span', { 'class': 'zen-dash-dev-rate ' + direction, 'aria-label': label }, [
		E('span', { 'class': 'zen-dash-dev-rate-value' }, '')
	]);
	const dl = rate('dl', _('Download'));
	const ul = rate('ul', _('Upload'));
	dl.classList.add('zen-dash-dev-download');
	ul.classList.add('zen-dash-dev-upload');
	const last = E('span', { 'class': 'zen-dash-dev-last', 'data-label': _('Last activity') }, '');
	const chev = E('span', { 'class': 'zen-dash-dev-chev' }, [icons.icon('zen-i-chev', 16)]);

	const detail = E('div', { 'class': 'zen-dash-dev-detail' },
		E('div', { 'class': 'zen-dash-dev-detail-grid' }, []));

	li.appendChild(iconBox);
	li.appendChild(id);
	li.appendChild(ip);
	li.appendChild(mac);
	li.appendChild(conn);
	li.appendChild(ul);
	li.appendChild(dl);
	li.appendChild(last);
	li.appendChild(chev);
	li.appendChild(detail);

	const ent = {
		li, iconBox, ov, ip, mac, last, conn: connLabel, connBox: conn,
		dl: dl.lastChild, ul: ul.lastChild, detail,
		grid: detail.firstChild,
		name: id.firstChild.firstChild,
		model: id.lastChild,
		d: null
	};
	id.firstChild.appendChild(E('button', {type:'button','class':'zen-dash-identity-edit',click:()=>identity.edit(ent.d,()=>ent.li.dispatchEvent(new Event('zen-identity-changed')))}, _('Device identity')));

	/* 展开时立即使用缓存数据，不等待下一轮轮询。 */
	const toggle = (ev) => {
		if (ev.target.closest('.zen-dash-dev-detail, .zen-dash-identity-edit, .zen-device-check'))
			return;
		if (ent.d) owner.openDetail(ent);
	};
	li.addEventListener('click', toggle);
	li.addEventListener('keydown', ev => {
		if (ev.target === li && (ev.key === 'Enter' || ev.key === ' ')) {
			ev.preventDefault();
			toggle(ev);
		}
	});
	const check = E('input', { type: 'checkbox', 'aria-label': _('Select device'), change: () => {
		if (check.checked) owner.selected.add(ent.d.mac); else owner.selected.delete(ent.d.mac);
		owner.syncSelection();
	} });
	ent.check = check;
	li.insertBefore(E('label', { 'class': 'zen-device-check' }, [check]), iconBox);

	return ent;
}

function updateDetail(ent, d) {
	const grid = ent.grid;
	const cells = [
		[_('Today'), '↑ ' + fmt.fmtBytes(d.tx_today) + '  ↓ ' + fmt.fmtBytes(d.rx_today)],
		[_('Month'), '↑ ' + fmt.fmtBytes(d.tx_month) + '  ↓ ' + fmt.fmtBytes(d.rx_month)],
		[_('Total'), '↑ ' + fmt.fmtBytes(d.tx_total) + '  ↓ ' + fmt.fmtBytes(d.rx_total)]
	];
	if (!grid.firstChild) {
		for (const [k] of cells)
			grid.appendChild(E('div', {}, [
				E('div', { 'class': 'k' }, k),
				E('div', { 'class': 'v' }, '')
			]));
	}
	const vs = grid.querySelectorAll('.v');
	cells.forEach((c, i) => setText(vs[i], c[1]));
	refreshHistory(ent, false);
}

return baseclass.extend({
	/* 'ok' | 'missing'（权限/异常也归并为 missing，降级语义一致） */
	async probe() {
		return probeState();
	},

	/* 探测一次并返回挂载用的 section（missing 时为提示卡片） */
	async mount(dash) {
		if (dash.querySelector('.zen-dash-devices'))
			return dash.querySelector('.zen-dash-devices');

		const state = await this.probe();
		await identity.load();
		const section = E('section', { 'class': 'zen-dash-panel zen-dash-devices' }, [
			E('div', { 'class': 'zen-dash-dev-head' }, [
				E('h3', {}, _('Device Traffic')),
			E('span', { 'class': 'zen-dash-dev-count', 'aria-live': 'polite' }, '')
			])
		]);

		if (state !== 'ok') {
			section.appendChild(E('div', { 'class': 'zen-dash-dev-note' },
				_('Device traffic requires the zen-traffic service (not detected). Everything else keeps working.')));
			section.setAttribute('data-state', 'missing');
			dash.appendChild(section);
			return section;
		}

		/* ---- 真实设备列表（zen.traffic 可用）---- */
		section.setAttribute('data-state', 'ok');
		this.section = section;
		this.count = section.querySelector('.zen-dash-dev-count');
		this.sortKey = 'rx_today';
		this.sortDescending = true;
		this.sortButtons = [];
		this.selected = new Set();
		this.query = '';
		this.connection = 'all';
		this.canReset = false;
		const search = E('input', { type: 'search', 'class': 'zen-device-search', placeholder: _('Search name, IP or MAC'), 'aria-label': _('Search devices'), input: ev => {
			this.query = ev.target.value.trim().toLocaleLowerCase(); this.applyVisibility();
		} });
		const filter = E('select', { 'aria-label': _('Connection filter'), change: ev => { this.connection = ev.target.value; this.applyVisibility(); } },
			[['all', _('All connections')], ['wifi', _('Wi-Fi')], ['wired', _('Wired')], ['offline', _('Offline')]].map(([value, label]) => E('option', { value }, [label])));
		this.selectAll = E('input', { type: 'checkbox', 'aria-label': _('Select matching devices'), change: ev => {
			for (const ent of this.cache.values()) if (this.matches(ent.d)) {
				if (ev.target.checked) this.selected.add(ent.d.mac); else this.selected.delete(ent.d.mac);
			}
			this.syncSelection();
		} });
		this.selectionLabel = E('span', { 'aria-live': 'polite' });
		this.exportButton = E('button', { type: 'button', 'class': 'cbi-button', click: () => this.exportSelected() }, [_('Export CSV')]);
		this.resetSelectedButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-negative', hidden: true, click: () => this.resetSelected() }, [_('Reset counters')]);
		this.clearButton = E('button', { type: 'button', 'class': 'zen-selection-clear', click: () => { this.selected.clear(); this.syncSelection(); } }, [_('Clear selection')]);
		this.bulkBar = E('div', { 'class': 'zen-device-bulkbar' }, [
			E('label', { 'class': 'zen-select-all' }, [this.selectAll, E('span', {}, [_('Select matching devices')])]),
			this.selectionLabel, E('div', { 'class': 'zen-bulk-actions' }, [this.exportButton, this.resetSelectedButton, this.clearButton])
		]);
		this.feedback = E('p', { 'class': 'zen-device-feedback', role: 'status', hidden: true });
		this.empty = E('p', { 'class': 'zen-device-empty', hidden: true }, [_('No matching devices. Try another search or connection filter.')]);
		section.appendChild(E('div', { 'class': 'zen-device-toolbar' }, [search, filter]));
		section.appendChild(this.bulkBar);
		section.appendChild(this.feedback);
		callAccess('ubus', 'zen.traffic', 'resetDevice').then(access => {
			this.canReset = access === true || access && access.access === true;
			this.resetSelectedButton.hidden = !this.canReset; this.syncSelection();
		}).catch(() => {});
		const sortColumn = (key, label) => {
			const arrow = E('span', { 'class': 'zen-sort-arrow', 'aria-hidden': 'true' }, '↕');
			const button = E('button', { type: 'button', 'class': 'zen-dash-dev-sort', 'aria-pressed': 'false', title: _('Sort descending') }, [label, arrow]);
			this.sortButtons.push({ key, button, arrow });
			button.addEventListener('click', () => {
				this.sortDescending = this.sortKey === key ? !this.sortDescending : true;
				this.sortKey = key;
				for (const entry of this.sortButtons) {
					const active = entry.key === key;
					entry.button.setAttribute('aria-pressed', String(active));
					entry.button.title = active && this.sortDescending ? _('Sort ascending') : _('Sort descending');
					entry.arrow.textContent = active ? (this.sortDescending ? '↓' : '↑') : '↕';
				}
				this.render(this.devs || []);
			});
			return button;
		};
		section.appendChild(E('div', { 'class': 'zen-dash-dev-columns' }, [
			E('span', {}, ''),
			E('span', {}, ''),
			E('span', {}, _('Hostname')),
			E('span', { 'class': 'zen-dash-dev-ip' }, 'IPv4'),
			E('span', { 'class': 'zen-dash-dev-mac' }, _('MAC')),
			E('span', { 'class': 'zen-dash-dev-conn' }, _('Connection')),
			sortColumn('tx_r', _('Realtime upload')),
			sortColumn('rx_r', _('Realtime download')),
			E('span', { 'class': 'zen-dash-dev-last' }, _('Last activity')),
			E('span', {}, '')
		]));
		this.list = E('ul', { 'class': 'zen-dash-dev-list' }, []);
		this.showAll = false;
		this.cache = new Map();

		this.more = E('button', {
			'class': 'zen-dash-dev-more',
			'type': 'button'
		}, _('Show all'));
		this.more.addEventListener('click', (ev) => {
			ev.preventDefault();
			this.showAll = !this.showAll;
			this.more.textContent = this.showAll ? _('Show less') : _('Show all');
			this.applyVisibility();
		});

		section.appendChild(this.list);
		section.appendChild(this.empty);
		section.appendChild(this.more);

		poll.add(L.bind(this.tick, this), DEV_POLL_SECS);
		dash.appendChild(section);
		this.tick();
		return section;
	},

	tick() {
		if (document.hidden || !this.section || !this.section.isConnected)
			return;

		return callDevices().then(L.bind((data) => {
			const devs = (data && Array.isArray(data.dev)) ? data.dev : [];
			this.render(devs);
		}, this)).catch(() => {
			/* daemon 退出等瞬态错误：保留上次渲染，下一轮重试 */
		});
	},

	render(devs) {
		const keep = new Set();
		this.devs = devs.slice();
		devs = this.devs.slice();

		/* Default to today's download volume; equal totals keep a stable MAC order. */
		const sortKey = this.sortKey || 'rx_today';
		devs.sort((a, b) =>
			((a[sortKey] || 0) - (b[sortKey] || 0)) * (this.sortDescending ? -1 : 1) ||
			String(a.mac || '').localeCompare(String(b.mac || '')));

		devs.forEach((d, idx) => {
			if (idx >= 50)
				return;
			keep.add(d.mac);

			let ent = this.cache.get(d.mac);
			if (!ent) {
				ent = buildRow(this);
				ent.li.addEventListener('zen-identity-changed',()=>this.render(this.devs||[]));
				this.cache.set(d.mac, ent);
				this.list.appendChild(ent.li);
			}
			// Cached rows must follow the sorted array, including after polling.
			const position = this.list.children[idx];
			if (position !== ent.li) this.list.insertBefore(ent.li, position || null);

			ent.d = d;
			if (ent.check) ent.check.setAttribute('aria-label', _('Select device') + ': ' + devName(d));
			const info = identity.identify(d);
			const type = info.type;
			const signature = type + ':' + info.brand;
			if (ent.iconType !== signature) {
				const icon = identity.glyph(info, 17);
				if (ent.glyph)
					ent.iconBox.replaceChild(icon, ent.glyph);
				else
					ent.iconBox.insertBefore(icon, ent.ov);
				ent.glyph = icon;
				ent.iconType = signature;
			}
			ent.iconBox.dataset.deviceType = type;
			ent.iconBox.title = info.name || type;
			setText(ent.model, [info.name,info.model].filter(Boolean).join(' · '));
			ent.model.hidden = !(info.name || info.model);
			ent.model.title = info.source === 'mac' ? _('Identified from MAC vendor') : info.source === 'manual' ? _('Manually assigned') : _('Reported device name');
			ent.ov.classList.toggle('up', !!d.online);
			ent.ov.classList.toggle('down', !d.online);

			setText(ent.name, devName(d));
			setText(ent.ip, d.ip4 || '—');
			setText(ent.mac, d.mac);
			ent.mac.title = d.mac;
			ent.name.title = devName(d);
			ent.ip.title = d.ip4 || d.ip6 || '';
			setText(ent.conn, connText(d));
			const connIcon = { wifi: 'zen-i-wifi', wired: 'zen-i-eth', router: 'zen-i-router' }[d.conn];
			if (ent.connIconType !== connIcon) {
				if (ent.connGlyph)
					ent.connGlyph.remove();
				ent.connGlyph = connIcon ? icons.icon(connIcon, 14) : null;
				if (ent.connGlyph)
					ent.connBox.insertBefore(ent.connGlyph, ent.conn);
				ent.connIconType = connIcon;
			}
			setText(ent.dl, fmt.fmtRate(d.rx_r || 0));
			setText(ent.ul, fmt.fmtRate(d.tx_r || 0));
			setText(ent.last, d.last > 0 ? new Date(d.last * 1000).toLocaleString() : fmt.MISSING);

			if (ent.li.classList.contains('open'))
				updateDetail(ent, d);
			if (this.activeDetail === ent && this.detailRates) {
				setText(this.detailRates.querySelector('.ul'), fmt.fmtRate(d.tx_r || 0));
				setText(this.detailRates.querySelector('.dl'), fmt.fmtRate(d.rx_r || 0));
				detailFacts(d).forEach((pair, i) => setText(this.detailFacts[i], pair[1]));
				setText(this.detailDialog.querySelector('h2'), devName(d));
			}
		});

		/* 消失的设备（含休眠）移除 */
		for (const [mac, ent] of this.cache) {
			if (!keep.has(mac)) {
				if (this.activeDetail === ent) panel.close();
				if (this.selected) this.selected.delete(mac);
				if (ent.historyResize) ent.historyResize.disconnect();
				ent.li.remove();
				this.cache.delete(mac);
			}
		}

		this.applyVisibility();
		setText(this.count,
			devs.length ? _('%d devices').format(devs.length) : _('No devices yet'));
	},

	applyVisibility() {
		if (!this.list)
			return;
		const rows = this.list.children;
		let matched = 0;
		for (let i = 0; i < rows.length; i++) {
			const ent = this.cache && Array.from(this.cache.values()).find(entry => entry.li === rows[i]);
			const match = !ent || this.matches(ent.d);
			rows[i].style.display = match && (this.showAll || matched < TOP_N) ? '' : 'none';
			if (match) matched++;
		}
		if (this.more)
			this.more.style.display = matched > TOP_N ? '' : 'none';
		if (this.empty) this.empty.hidden = matched > 0;
		this.syncSelection();
	},

	matches(d) {
		if (!d) return false;
		const query = this.query || '';
		return (!query || [d.host, d.mac, d.ip4, d.ip6].some(v => String(v || '').toLocaleLowerCase().includes(query))) &&
			(!this.connection || this.connection === 'all' || (this.connection === 'offline' ? !d.online : d.conn === this.connection));
	},

	syncSelection() {
		if (!this.selected || !this.selectionLabel) return;
		const matching = Array.from(this.cache.values()).filter(ent => this.matches(ent.d));
		const checked = matching.filter(ent => this.selected.has(ent.d.mac)).length;
		this.selectAll.checked = matching.length > 0 && checked === matching.length;
		this.selectAll.indeterminate = checked > 0 && checked < matching.length;
		this.selectAll.disabled = !matching.length;
		for (const ent of this.cache.values()) {
			ent.check.checked = this.selected.has(ent.d.mac);
			ent.li.classList.toggle('selected', ent.check.checked);
		}
		setText(this.selectionLabel, this.selected.size ? _('%d selected').format(this.selected.size) : _('%d matching devices').format(matching.length));
		this.bulkBar.classList.toggle('has-selection', this.selected.size > 0);
		this.exportButton.disabled = !this.selected.size;
		this.resetSelectedButton.disabled = !this.selected.size || !this.canReset || this.resetBusy;
		this.clearButton.hidden = !this.selected.size;
	},

	openDetail(ent) {
		if (this.activeDetail === ent) return;
		panel.close();
		this.activeDetail = ent;
		ent.li.classList.add('open');
		ent.li.setAttribute('aria-expanded', 'true');
		updateDetail(ent, ent.d);
		const d = ent.d;
		const historyUrl = L.url('admin/status/zen-traffic/history');
		const facts = E('dl', { 'class': 'zen-device-facts' }, detailFacts(d).map(([key, value]) => E('div', {}, [E('dt', {}, [key]), E('dd', {}, [value])])));
		this.detailFacts = facts.querySelectorAll('dd');
		const rates = E('div', { 'class': 'zen-device-live' }, [
			E('div', {}, [E('span', {}, [_('Realtime upload')]), E('strong', { 'class': 'ul' }, [fmt.fmtRate(d.tx_r || 0)])]),
			E('div', {}, [E('span', {}, [_('Realtime download')]), E('strong', { 'class': 'dl' }, [fmt.fmtRate(d.rx_r || 0)])])
		]);
		this.detailRates = rates;
		this.detailDialog = panel.open({ title: devName(d), subtitle: d.mac, content: [rates, facts, ent.detail], actions: [
			E('button', { type: 'button', 'class': 'cbi-button', click: () => { panel.close(); identity.edit(ent.d, () => this.render(this.devs || [])); } }, [_('Device identity')]),
			E('a', { 'class': 'cbi-button cbi-button-action', href: historyUrl + (historyUrl.includes('?') ? '&' : '?') + 'mac=' + encodeURIComponent(d.mac) + '#device-hourly' }, [_('History analysis')])
		], onClose: () => {
			ent.li.classList.remove('open'); ent.li.setAttribute('aria-expanded', 'false'); ent.li.appendChild(ent.detail);
			if (this.activeDetail === ent) this.activeDetail = null;
		} });
	},

	exportSelected() {
		const keys = ['host', 'mac', 'ip4', 'ip6', 'conn', 'tx_r', 'rx_r', 'tx_today', 'rx_today', 'tx_month', 'rx_month', 'tx_total', 'rx_total'];
		const quote = value => {
			let text = String(value == null ? '' : value);
			if (/^\s*[=+@\-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
			return '"' + text.replace(/"/g, '""') + '"';
		};
		const rows = (this.devs || []).filter(d => this.selected.has(d.mac));
		const csv = '\ufeff' + [keys.join(','), ...rows.map(d => keys.map(key => quote(d[key])).join(','))].join('\r\n');
		const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
		const link = E('a', { href: url, download: 'zen-devices-' + new Date().toISOString().slice(0, 10) + '.csv' });
		document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
	},

	resetSelected() {
		if (!this.canReset || this.resetBusy || !this.selected.size) return;
		let pending = (this.devs || []).filter(d => this.selected.has(d.mac));
		if (!pending.length) return;
		const error = E('p', { role: 'alert', 'class': 'zen-identity-error', hidden: true });
		const deviceList = E('ul', { 'class': 'zen-batch-device-list' });
		const updateList = () => deviceList.replaceChildren(...pending.map(d => E('li', {}, [E('strong', {}, [devName(d)]), E('span', {}, [d.mac])])));
		updateList();
		const cancel = E('button', { type: 'button', 'class': 'cbi-button', click: () => ui.hideModal() }, [_('Cancel')]);
		const confirm = E('button', { type: 'button', 'class': 'cbi-button cbi-button-negative', click: async () => {
			if (this.resetBusy) return;
			this.resetBusy = true; confirm.disabled = true; cancel.disabled = true; error.hidden = true;
			confirm.textContent = _('Resetting…');
			const failed = [];
			for (const d of pending) {
				try { const result = await callReset(d.mac); if (!result || result.ok !== true) throw Error('reset failed'); this.selected.delete(d.mac); }
				catch (e) { failed.push(d); }
			}
			this.resetBusy = false; confirm.disabled = false; cancel.disabled = false; this.syncSelection();
			if (failed.length) { pending = failed; updateList(); confirm.textContent = _('Retry failed devices'); error.textContent = _('%d devices could not be reset. Retry to process only these devices.').format(failed.length); error.hidden = false; }
			else { ui.hideModal(); this.feedback.textContent = _('Selected device counters have been reset.'); this.feedback.hidden = false; }
			this.tick();
		} }, [_('Reset counters')]);
		ui.showModal(_('Reset selected device counters'), [
			E('div', { 'class': 'zen-batch-confirm' }, [
				E('p', {}, [_('This clears the selected devices’ traffic counters. This action cannot be undone.')]),
				deviceList, error
			]), E('div', { 'class': 'right zen-tf-modal-actions' }, [cancel, confirm])
		]);
	}
});
