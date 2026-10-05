'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen.zen-format as fmt';
'require view.zen.zen-icons as icons';

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

function buildRow() {
	const li = E('li', { 'class': 'zen-dash-dev-row', role: 'button', tabindex: '0', 'aria-expanded': 'false' });

	const iconBox = E('span', { 'class': 'zen-dash-dev-icon' }, []);
	const ov = E('span', { 'class': 'zen-dash-ov-dot dot' });
	iconBox.appendChild(ov);

	const id = E('span', { 'class': 'zen-dash-dev-id' }, [
		E('span', { 'class': 'zen-dash-dev-name' }, '')
	]);
	const ip = E('span', { 'class': 'zen-dash-dev-ip' }, '');
	const mac = E('span', { 'class': 'zen-dash-dev-mac' }, '');

	const connLabel = E('span', {}, '');
	const conn = E('span', { 'class': 'zen-dash-dev-conn' }, [connLabel]);
	const rate = (direction, arrow, label) => E('span', { 'class': 'zen-dash-dev-rate ' + direction, 'aria-label': label }, [
		E('span', { 'class': 'zen-dash-dev-direction', 'aria-hidden': 'true' }, arrow),
		E('span', { 'class': 'zen-dash-dev-rate-value' }, '')
	]);
	const dl = rate('dl', '↓', _('Download'));
	const ul = rate('ul', '↑', _('Upload'));
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
		name: id.firstChild,
		d: null
	};

	/* 展开时立即使用缓存数据，不等待下一轮轮询。 */
	const toggle = (ev) => {
		if (ev.target.closest('.zen-dash-dev-detail'))
			return;
		if (!li.classList.contains('open') && ent.d)
			updateDetail(ent, ent.d);
		li.classList.toggle('open');
		li.setAttribute('aria-expanded', String(li.classList.contains('open')));
	};
	li.addEventListener('click', toggle);
	li.addEventListener('keydown', ev => {
		if (ev.target === li && (ev.key === 'Enter' || ev.key === ' ')) {
			ev.preventDefault();
			toggle(ev);
		}
	});

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
		this.sortKey = null;
		this.sortDescending = true;
		this.sortButtons = [];
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
		section.appendChild(this.more);

		poll.add(L.bind(this.tick, this), DEV_POLL_SECS);
		this.tick();

		dash.appendChild(section);
		return section;
	},

	tick() {
		if (document.hidden || !this.section)
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

		/* Top-N：实时速率优先，其次今日累计 */
		devs.sort((a, b) =>
			(this.sortKey ? ((a[this.sortKey] || 0) - (b[this.sortKey] || 0)) * (this.sortDescending ? -1 : 1) : 0) ||
			((b.rx_r || 0) + (b.tx_r || 0)) - ((a.rx_r || 0) + (a.tx_r || 0)) ||
			((b.rx_today || 0) + (b.tx_today || 0)) - ((a.rx_today || 0) + (a.tx_today || 0)));

		devs.forEach((d, idx) => {
			if (idx >= 50)
				return;
			keep.add(d.mac);

			let ent = this.cache.get(d.mac);
			if (!ent) {
				ent = buildRow();
				this.cache.set(d.mac, ent);
				this.list.appendChild(ent.li);
			}

			ent.d = d;
			const type = icons.inferType(devName(d), d.conn);
			if (ent.iconType !== type) {
				const icon = icons.typeIcon(type, 17);
				if (ent.glyph)
					ent.iconBox.replaceChild(icon, ent.glyph);
				else
					ent.iconBox.insertBefore(icon, ent.ov);
				ent.glyph = icon;
				ent.iconType = type;
			}
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
		});

		/* 消失的设备（含休眠）移除 */
		for (const [mac, ent] of this.cache) {
			if (!keep.has(mac)) {
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
		for (let i = 0; i < rows.length; i++)
			rows[i].style.display = (this.showAll || i < TOP_N) ? '' : 'none';
		if (this.more)
			this.more.style.display = rows.length > TOP_N ? '' : 'none';
	}
});
