'use strict';
'require baseclass';
'require rpc';
'require fs';
'require network';
'require poll';
'require view.zen.zen-format as fmt';
'require view.zen.zen-devices as devices';

/*
 * view.zen.dashboard — luci-theme-zen 首页（admin/status/overview）。
 *
 * 结构：状态条(主机名·型号·运行时间) + 系统四卡(负载/CPU/RAM/根文件系统，环形进度)
 *       + 网络状态卡(WAN 状态/WAN IPv4/WAN IPv6/LAN IP/在线客户端/DHCP 租约)
 *       + 全局实时流量卡(实时/累计 + 迷你曲线) + 设备流量模块(zen.traffic 探测)。
 *
 * 性能规范（与 ARCHITECTURE.md 一致）：DOM 一次构建缓存；轮询只更新 textContent /
 * class / SVG 属性；曲线滑动窗口；模块间 Promise 相互隔离，单个 RPC 失败不影响其他卡。
 */

// poll.add() 以秒为单位；5s 与官方 status 页一致，60 个样本覆盖 ~5 分钟。
const POLL_SECS = 5;
const HISTORY = 60;
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 46;
const RING_C = 2 * Math.PI * RING_R;
const SKIP_IFACE = /^(lo|ifb\d*|teql\d*|sit\d*|gre\d*|gretap\d*|erspan\d*|dummy\d*|tun\d*|tap\d*|ip6tnl\d*|ip6gre\d*|veth)/;

const callSystemInfo = rpc.declare({
	object: 'system',
	method: 'info'
});

const callRealtimeHistory = rpc.declare({ object: 'zen.traffic', method: 'getRealtimeHistory', params: ['iface', 'start', 'end', 'limit'] });

const callSystemBoard = rpc.declare({ object: 'system', method: 'board' });

const callDevStatus = rpc.declare({
	object: 'network.device',
	method: 'status'
});

const callDhcpLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

const callMountPoints = rpc.declare({
	object: 'luci',
	method: 'getMountPoints',
	expect: { result: [] }
});

const callNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
	expect: { '': {} }
});

function svg(name, attrs, children) {
	const el = document.createElementNS(SVG_NS, name);
	for (const key in attrs)
		el.setAttribute(key, attrs[key]);
	(children || []).forEach((child) => el.appendChild(child));
	return el;
}

function cpuFromStat(line) {
	if (!line)
		return null;
	const parts = line.trim().split(/\s+/);
	if (parts[0] !== 'cpu')
		return null;
	const nums = parts.slice(1).map((v) => parseInt(v, 10) || 0);
	const idle = (nums[3] || 0) + (nums[4] || 0);
	const total = nums.slice(0, 8).reduce((s, v) => s + v, 0);
	return { idle, total };
}

function addrsOf(net, v6) {
	if (!net)
		return [];
	try {
		const fn = v6 ? net.getIP6Addrs : net.getIPAddrs;
		if (typeof fn === 'function') {
			const addrs = fn.call(net) || [];
			return addrs
				.map((a) => (typeof a === 'string' ? a : (a && (a.address || a.addr)) || ''))
				.filter(Boolean);
		}
	} catch (e) { /* ignore */ }
	return [];
}

function settled(value, fallback) {
	try {
		return Promise.resolve(value).then((v) => (v == null ? fallback : v), () => fallback);
	} catch (e) {
		return Promise.resolve(fallback);
	}
}

return baseclass.extend({
	__init__() {
		this.prevCpu = null;
		this.prevNet = null;
		this.prevAt = 0;
		this.history = [];
		this.iface = 'all';
		this.dash = this.mount();
		if (!this.dash)
			return;
		poll.add(() => this.tick(), POLL_SECS);

		// 设备流量模块独立探测（zen.traffic 缺失时仅显示提示，不影响其他卡）
		try {
			devices.mount(this.dash).catch((e) => console.warn('zen-devices', e));
		} catch (e) { /* 模块缺失不阻塞首页 */ }
	},

	mount() {
		if (document.getElementById('zen-dashboard'))
			return document.getElementById('zen-dashboard');

		const container = document.querySelector('#maincontent > .container') || document.getElementById('maincontent');
		if (!container)
			return null;

		const dash = this.build();
		const view = document.getElementById('view');
		const tab = document.getElementById('tabmenu');
		if (view)
			container.insertBefore(dash, view);
		else if (tab && tab.parentNode === container)
			container.insertBefore(dash, tab.nextSibling);
		else
			container.insertBefore(dash, container.firstChild);
		return dash;
	},

	buildRing(key, label) {
		const arc = svg('circle', {
			'class': 'arc',
			cx: '60',
			cy: '60',
			r: String(RING_R),
			'stroke-dasharray': RING_C.toFixed(2),
			'stroke-dashoffset': RING_C.toFixed(2)
		});
		const pct = svg('text', { 'class': 'pct', x: '60', y: '63' }, []);
		pct.textContent = '0%';

		const attrs = { 'class': 'zen-dash-card zen-dash-card-action', 'data-gauge': key, 'data-level': 'ok' };
		if (key === 'disk') {
			attrs.type = 'button';
			attrs.click = () => this.showDiskInfo();
		} else {
			attrs.href = L.url('admin', 'status', 'processes');
			attrs.title = _('Open process list');
		}
		return E(key === 'disk' ? 'button' : 'a', attrs, [
			E('div', { 'class': 'zen-dash-meta' }, [
				E('div', { 'class': 'zen-dash-label' }, label),
				E('div', { 'class': 'zen-dash-value' }, fmt.MISSING),
				E('div', { 'class': 'zen-dash-sub' }, fmt.MISSING)
			]),
			E('div', { 'class': 'zen-dash-ring' }, [
				svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }, [
					svg('circle', { 'class': 'track', cx: '60', cy: '60', r: String(RING_R) }),
					arc,
					pct
				])
			])
		]);
	},

	showDiskInfo() {
		const disk = this.diskInfo;
		const dialog = E('dialog', { 'class': 'zen-dash-disk-dialog' }, [
			E('h3', {}, _('Storage')),
			E('p', {}, disk ? _('Used %s').format(fmt.fmtBytes(disk.used)) : fmt.MISSING),
			E('p', {}, disk ? _('Total %s').format(fmt.fmtBytes(disk.total)) : fmt.MISSING)
		]);
		const close = E('button', { type: 'button' }, _('Close'));
		close.addEventListener('click', () => dialog.close());
		dialog.appendChild(close);
		dialog.addEventListener('close', () => dialog.remove());
		document.body.appendChild(dialog);
		dialog.showModal();
	},

	buildSystemItem(key, label, paths) {
		const attrs = { 'data-system': key };
		if (key === 'uptime') attrs['data-uptime'] = 'value';
		if (key === 'startup') attrs['data-restart'] = 'value';
		return E('div', { 'class': 'zen-dash-system-item' }, [
			svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, paths.map(d => svg('path', { d }))),
			E('div', {}, [E('span', { 'class': 'zen-dash-system-label' }, label),
				E('strong', attrs, fmt.MISSING)])
		]);
	},

	setSystemInfo(board, info) {
		const release = board.release || {};
		const hardware = (board.system || '') + ' ' + (release.target || '');
		let arch = release.target || board.system;
		if (/x86\/64|x86_64/i.test(hardware)) arch = 'x86_64 · ' + _('64-bit');
		else if (/aarch64|ARMv8|\/armv8/i.test(hardware)) arch = 'ARMv8 · ' + _('64-bit');
		else if (/ARMv7/i.test(hardware)) arch = 'ARMv7 · ' + _('32-bit');
		this.setText(this.dash, '[data-system="host"]', fmt.orDash(board.hostname));
		this.setText(this.dash, '[data-system="architecture"]', fmt.orDash(arch));
		const firmware = release.version ? [release.distribution, release.version].filter(Boolean).join(' ') : release.description;
		this.setText(this.dash, '[data-system="firmware"]', fmt.orDash(firmware));
		this.dash.querySelector('[data-system="firmware"]').title = release.description || firmware || '';
		let time = fmt.MISSING;
		if (info.localtime != null && Number.isFinite(Number(info.localtime))) {
			const date = new Date(Number(info.localtime) * 1000);
			if (Number.isFinite(date.getTime())) time = date.toISOString().slice(0, 19).replace('T', ' ');
		}
		this.setText(this.dash, '[data-system="time"]', time);
	},

	buildNetworkRow(key, label) {
		return E('tr', { 'data-network': key }, [
			E('th', { scope: 'row' }, label),
			E('td', { 'data-network-field': 'protocol' }, fmt.MISSING),
			E('td', { 'data-network-field': 'address' }, fmt.MISSING),
			E('td', {}, [
				E('span', { 'class': 'zen-dash-net-status' }, [
					E('span', { 'class': 'zen-dash-ov-dot down', 'aria-hidden': 'true' }),
					E('span', { 'data-network-field': 'status' }, fmt.MISSING)
				])
			])
		]);
	},

	build() {
		const iface = E('select', { id: 'zen-dash-iface', 'aria-label': _('Interface') }, [
			E('option', { value: 'all' }, _('All'))
		]);
		iface.addEventListener('change', () => {
			this.historyLoadedFor = null;
			this.historyRequest = (this.historyRequest || 0) + 1;
			this.ifaceChosen = true;
			this.iface = iface.value || 'all';
			this.history = [];
			this.prevNet = null;
			this.prevAt = 0;
			this.renderTraffic({
				rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0, names: this.lastNames || ['all']
			});
		});

		const chart = svg('svg', { viewBox: '0 0 640 220', 'class': 'zen-dash-svg' }, [
			svg('g', { 'class': 'grid' }),
			svg('g', { 'class': 'yaxis' }),
			svg('g', { 'class': 'xaxis' }),
			svg('path', { 'class': 'fill rx' }),
			svg('path', { 'class': 'fill tx' }),
			svg('polyline', { 'class': 'line rx' }),
			svg('polyline', { 'class': 'line tx' }),
			svg('g', { 'class': 'hover', style: 'display:none' }, [
				svg('line', { 'class': 'cross' }),
				svg('circle', { 'class': 'dot rx', r: '3.5' }),
				svg('circle', { 'class': 'dot tx', r: '3.5' })
			]),
			svg('rect', { 'class': 'overlay', x: '0', y: '0', width: '100%', height: '100%' })
		]);
		const tip = E('div', { 'class': 'zen-dash-tip', style: 'display:none' });
		this.chartEl = chart;
		this.tipEl = tip;
		this.parts = {
			grid: chart.querySelector('g.grid'),
			yaxis: chart.querySelector('g.yaxis'),
			xaxis: chart.querySelector('g.xaxis'),
			lineRx: chart.querySelector('polyline.line.rx'),
			lineTx: chart.querySelector('polyline.line.tx'),
			fillRx: chart.querySelector('path.fill.rx'),
			fillTx: chart.querySelector('path.fill.tx')
		};
		this.lastW = 0;
		this.lastH = 0;
		this.yLabels = [];
		chart.addEventListener('pointermove', (ev) => this.onChartHover(ev));
		chart.addEventListener('pointerleave', () => this.hideHover());

		return E('div', { id: 'zen-dashboard' }, [
			E('div', { 'class': 'zen-dash-strip' }, [
				E('div', { 'class': 'zen-dash-system-info' }, [
					this.buildSystemItem('host', _('Hostname'), ['M3 10 12 3l9 7v11H3z', 'M8 13v2m4-2v2m4-2v2M10 21v-4h4v4']),
					this.buildSystemItem('architecture', _('Architecture'), ['M6 6h12v12H6zM9 9h6v6H9z', 'M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4']),
					this.buildSystemItem('firmware', _('Firmware version'), ['M4 9h16v12H4z', 'M8 9V6a4 4 0 0 1 8 0v3M12 13v4']),
					this.buildSystemItem('time', _('System time'), ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5l3 2']),
					this.buildSystemItem('uptime', _('Uptime'), ['M5 5a9 9 0 1 1-2 9M3 3v5h5M12 7v5l3 2']),
					this.buildSystemItem('startup', _('Startup time'), ['M12 3v9M7 5a9 9 0 1 0 10 0'])
				]),
			]),
			E('div', { 'class': 'zen-dash-gauges' }, [
				this.buildRing('load', _('Load')),
				this.buildRing('cpu', 'CPU'),
				this.buildRing('ram', 'RAM'),
				this.buildRing('disk', _('Storage'))
			]),
			E('div', { 'class': 'zen-dash-body' }, [
				E('section', { 'class': 'zen-dash-panel zen-dash-overview' }, [
					E('h3', {}, _('Network')),
					E('table', { 'class': 'zen-dash-network-table' }, [
						E('thead', {}, E('tr', {}, [_('Interface'), _('Protocol'), _('Address'), _('Status')].map(label =>
							E('th', { scope: 'col' }, label)))),
						E('tbody', {}, [
							this.buildNetworkRow('wan', 'WAN'),
							this.buildNetworkRow('lan', 'LAN'),
							this.buildNetworkRow('wan6', 'WAN6')
						])
					])
				]),
				E('section', { 'class': 'zen-dash-panel zen-dash-traffic' }, [
					E('header', { 'class': 'zen-dash-traffic-head' }, [
						E('h3', {}, [_('Realtime Traffic'), E('span', { 'class': 'zen-dash-hint' }, _('Last 5 minutes') + ' · ' + _('5-second updates'))]),
						E('label', { 'class': 'zen-dash-iface-control' }, [E('span', {}, _('Interface')), iface])
					]),
					E('div', { 'class': 'zen-dash-traffic-stats' }, [
						E('div', { 'class': 'zen-dash-stat tx' }, [
							E('span', { 'class': 'k' }, '↑ ' + _('Upload')),
							E('span', { 'class': 'v', 'data-k': 'txRate' }, fmt.MISSING)
						]),
						E('div', { 'class': 'zen-dash-stat rx' }, [
							E('span', { 'class': 'k' }, '↓ ' + _('Download')),
							E('span', { 'class': 'v', 'data-k': 'rxRate' }, fmt.MISSING)
						]),
						E('div', { 'class': 'zen-dash-stat total-tx' }, [
							E('span', { 'class': 'k' }, '↑ ' + _('Total sent')),
							E('span', { 'class': 'v', 'data-k': 'txTotal' }, fmt.MISSING)
						]),
						E('div', { 'class': 'zen-dash-stat total-rx' }, [
							E('span', { 'class': 'k' }, '↓ ' + _('Total received')),
							E('span', { 'class': 'v', 'data-k': 'rxTotal' }, fmt.MISSING)
						])
					])
				]),
				E('section', { 'class': 'zen-dash-panel zen-dash-trend' }, [
					E('div', { 'class': 'zen-dash-chart-legend' }, [
						E('span', { 'class': 'dl' }, [E('span', { 'class': 'swatch', 'aria-hidden': 'true' }), _('Download (solid)')]),
						E('span', { 'class': 'ul' }, [E('span', { 'class': 'swatch', 'aria-hidden': 'true' }), _('Upload (dashed)')])
					]),
					E('div', { 'class': 'zen-dash-chart' }, [chart, tip])
				])
			])
		]);
	},

	async loadRealtimeHistory() {
		const iface = this.iface;
		if (!this.wanDevice || iface !== this.wanDevice || this.historyLoadedFor === iface) return;
		this.historyLoadedFor = iface;
		const request = this.historyRequest = (this.historyRequest || 0) + 1;
		const end = Math.floor(Date.now() / 1000);
		try {
			const data = await callRealtimeHistory(iface, end - (HISTORY - 1) * POLL_SECS, end, HISTORY);
			if (request !== this.historyRequest || this.iface !== iface) return;
			this.history = ((data && data.samples) || []).filter(sample => Number.isFinite(sample.time))
				.map(sample => ({ t: sample.time * 1000, rx: Number(sample.download) || 0, tx: Number(sample.upload) || 0 })).slice(-HISTORY);
		} catch (e) { /* Older/unavailable daemon: continue collecting the browser's live samples. */ }
	},

	setText(root, selector, text) {
		const el = root.querySelector(selector);
		if (el)
			el.textContent = text;
	},

	setGauge(key, label, value, sub, pct) {
		const card = this.dash.querySelector('[data-gauge="%s"]'.format(key));
		if (!card)
			return;
		pct = fmt.clampPct(pct);
		card.setAttribute('data-level', fmt.levelFor(pct));
		this.setText(card, '.zen-dash-label', label);
		this.setText(card, '.zen-dash-value', value);
		this.setText(card, '.zen-dash-sub', sub);
		this.setText(card, 'text.pct', '%d%%'.format(Math.round(pct)));
		const arc = card.querySelector('circle.arc');
		if (arc)
			arc.setAttribute('stroke-dashoffset', (RING_C * (1 - pct / 100)).toFixed(2));
	},

	setOverview(key, value, sub, dotState) {
		const cell = this.dash.querySelector('[data-ov="%s"]'.format(key));
		if (!cell)
			return;
		this.setText(cell, '.zen-dash-ov-value', fmt.orDash(value));
		/* sub 为 null 时置空文本，由 CSS :empty 隐藏，不渲染无意义的 “—” */
		this.setText(cell, '.zen-dash-ov-sub', sub == null ? '' : sub);
		if (dotState != null) {
			const dot = cell.querySelector('.zen-dash-ov-dot');
			if (dot)
				dot.className = 'zen-dash-ov-dot ' + (dotState ? 'up' : 'down');
		}
	},

	setNetworkRow(key, net, ipv6) {
		const row = this.dash.querySelector('[data-network="%s"]'.format(key));
		if (!row)
			return;
		const addresses = addrsOf(net, !!ipv6);
		const up = !!net && (typeof net.isUp === 'function' ? net.isUp() : !!addresses.length);
		const proto = net && typeof net.getProtocol === 'function' ? net.getProtocol() : null;
		const protocols = { dhcp: _('DHCP client'), static: _('Static address'), dhcpv6: 'DHCPv6', pppoe: 'PPPoE' };
		this.setText(row, '[data-network-field="protocol"]', proto ? (protocols[proto] || proto) : fmt.MISSING);
		this.setText(row, '[data-network-field="address"]', addresses.join('\n') || fmt.MISSING);
		row.querySelector('[data-network-field="address"]').title = addresses.join('\n');
		row.classList.toggle('zen-dash-net-ipv6', !!ipv6);
		let status = up ? (key === 'lan' ? _('Running') : _('Connected')) : _('Down');
		const uptime = net && typeof net.getUptime === 'function' ? Number(net.getUptime()) : 0;
		if (up && key === 'wan' && uptime > 0) {
			const days = Math.floor(uptime / 86400);
			const clock = String(Math.floor(uptime / 3600)).padStart(2, '0') + ':' + String(Math.floor(uptime % 3600 / 60)).padStart(2, '0');
			status += ' ' + (days ? _('%dd').format(days) : clock);
		}
		this.setText(row, '[data-network-field="status"]', status);
		row.querySelector('.zen-dash-net-status').setAttribute('data-state', up ? (key === 'lan' ? 'running' : 'connected') : 'down');
		row.querySelector('.zen-dash-ov-dot').className = 'zen-dash-ov-dot ' + (up ? 'up' : 'down');
	},

	setUptime(sec, localtime) {
		let value = fmt.MISSING;
		let restart = fmt.MISSING;
		if (sec != null && sec !== '' && Number.isFinite(Number(sec)) && Number(sec) >= 0) {
			const minutes = Math.floor(Number(sec) / 60);
			const days = Math.floor(minutes / 1440);
			const hours = String(Math.floor(minutes % 1440 / 60)).padStart(2, '0');
			const mins = String(minutes % 60).padStart(2, '0');
			value = _('%dd').format(days) + ' ' + hours + ':' + mins;
			if (localtime != null && Number.isFinite(Number(localtime)) && Number(localtime) >= Number(sec)) {
				// procd localtime already includes the router's timezone offset.
				// UTC formatting preserves that wall clock without applying the browser's offset again.
				const date = new Date((Number(localtime) - Number(sec)) * 1000);
				if (Number.isFinite(date.getTime()))
					restart = date.toISOString().slice(0, 19).replace('T', ' ');
			}
		}
		this.setText(this.dash, '[data-uptime]', value);
		this.setText(this.dash, '[data-restart]', restart);
	},

	setStrip(host, model) {
		this.setText(this.dash, '[data-strip="host"]', fmt.orDash(host));
		this.setText(this.dash, '[data-strip="model"]', fmt.orDash(model));
	},

	countable(devs) {
		const members = new Set();
		for (const name in devs) {
			const list = (devs[name] && (devs[name]['bridge-members'] || devs[name].bridge_members)) || [];
			list.forEach((m) => members.add(m));
		}

		const all = {};
		const listed = [];
		for (const name in devs) {
			if (SKIP_IFACE.test(name))
				continue;
			const d = devs[name];
			if (d && d.present === false)
				continue;
			listed.push(name);
			if (!members.has(name))
				all[name] = d;
		}
		listed.sort();
		return { all, listed };
	},

	sumStats(devs) {
		let rx = 0, tx = 0;
		for (const name in devs) {
			const d = devs[name] || {};
			const st = d.statistics || d.stats || {};
			rx += Number(st.rx_bytes) || 0;
			tx += Number(st.tx_bytes) || 0;
		}
		return { rx, tx };
	},

	pickStats(devs, iface) {
		const counted = this.countable(devs);
		const src = (iface && iface !== 'all') ? (devs[iface] ? { tmp: devs[iface] } : {}) : counted.all;
		const stats = this.sumStats(src);
		stats.listed = counted.listed;
		return stats;
	},

	syncIfaceSelect(names) {
		const sel = this.dash.querySelector('#zen-dash-iface');
		if (!sel)
			return;
		const wanted = Array.from(new Set(['all'].concat(this.wanDevice ? [this.wanDevice] : [], names)));
		const have = Array.from(sel.options).map((o) => o.value);
		const current = this.iface;
		if (have.join('\0') !== wanted.join('\0')) {
			sel.textContent = '';
			wanted.forEach(name => sel.appendChild(E('option', { value: name }, name)));
		}
		Array.from(sel.options).forEach(option => {
			option.textContent = option.value === 'all' ? _('All') :
				(option.value === this.wanDevice ? 'WAN' + (this.wanProto ? ' · ' + this.wanProto : '') : option.value);
		});
		sel.value = wanted.indexOf(current) >= 0 ? current : 'all';
		this.iface = sel.value;
	},

	renderTraffic(t) {
		this.lastNames = t.names || [];
		this.syncIfaceSelect(this.lastNames);
		this.setText(this.dash, '[data-k="txRate"]', fmt.fmtRate(t.txRate));
		this.setText(this.dash, '[data-k="rxRate"]', fmt.fmtRate(t.rxRate));
		this.setText(this.dash, '[data-k="txTotal"]', fmt.fmtBytes(t.txTotal));
		this.setText(this.dash, '[data-k="rxTotal"]', fmt.fmtBytes(t.rxTotal));

		const chart = this.chartEl;
		const host = this.dash.querySelector('.zen-dash-chart');
		const parts = this.parts;
		if (!chart || !host || !parts)
			return;

		const w = Math.max(host.clientWidth || 0, 320);
		const h = Math.max(host.clientHeight || 0, 160);

		const padL = 58, padR = 12, padT = 12, padB = 28;
		const innerW = Math.max(w - padL - padR, 10);
		const innerH = Math.max(h - padT - padB, 10);
		const samples = this.history;

		let peak = 0;
		samples.forEach((s) => {
			if (s.rx > peak) peak = s.rx;
			if (s.tx > peak) peak = s.tx;
		});
		// Keep every visible peak, with ~5% headroom and finer rounding.
		const scaleUnit = Math.pow(10, Math.floor(Math.log10(Math.max(peak, 1)))) / 5;
		const max = Math.max(64, Math.ceil(peak * 1.05 / scaleUnit) * scaleUnit);
		// 固定时间窗口：采样点间距恒定，最新点贴右侧；数据不足时曲线只占右侧，
		// 如实反映“刚开始采集”。
		const step = innerW / (HISTORY - 1);

		// 网格线只在容器尺寸变化时重建 DOM；Y 轴刻度每帧只改文本。
		const DIV = 4;
		if (w !== this.lastW || h !== this.lastH || this.yLabels.length !== DIV + 1) {
			// viewBox 用容器真实像素，坐标 1:1，避免拉伸变形。
			chart.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
			parts.grid.textContent = '';
			parts.yaxis.textContent = '';
			parts.xaxis.textContent = '';
			parts.xaxis.appendChild(svg('text', {
				x: String(padL), y: String(h - 6), 'text-anchor': 'start'
			}, [document.createTextNode(_('5 minutes ago'))]));
			parts.xaxis.appendChild(svg('text', {
				x: String(padL + innerW), y: String(h - 6), 'text-anchor': 'end'
			}, [document.createTextNode(_('Now'))]));
			this.yLabels = [];
			for (let i = 0; i <= DIV; i++) {
				const gy = padT + (innerH * i) / DIV;
				parts.grid.appendChild(svg('line', {
					x1: String(padL),
					x2: String(padL + innerW),
					y1: gy.toFixed(1),
					y2: gy.toFixed(1)
				}));
				const label = svg('text', { x: String(padL - 8), y: (gy + 4).toFixed(1), 'text-anchor': 'end' }, []);
				parts.yaxis.appendChild(label);
				this.yLabels.push(label);
			}
			this.lastW = w;
			this.lastH = h;
		}
		for (let i = 0; i <= DIV; i++)
			this.yLabels[i].textContent = fmt.fmtRate(max * (1 - i / DIV));

		const count = samples.length;
		const xAt = (i) => padL + innerW - (count - 1 - i) * step;
		const yAt = (v) => padT + innerH * (1 - Math.min(v, max) / max);
		const y0 = padT + innerH;

		function series(key) {
			if (!count)
				return { line: '', fill: '' };
			const pts = samples.map((s, i) => xAt(i).toFixed(1) + ',' + yAt(s[key]).toFixed(1));
			const line = pts.join(' ');
			let fill = '';
			if (count > 1)
				fill = 'M' + xAt(0).toFixed(1) + ',' + y0.toFixed(1) +
					' L' + pts.join(' L') +
					' L' + xAt(count - 1).toFixed(1) + ',' + y0.toFixed(1) + ' Z';
			return { line, fill };
		}

		const rx = series('rx');
		const tx = series('tx');
		parts.lineRx.setAttribute('points', rx.line);
		parts.lineTx.setAttribute('points', tx.line);
		parts.fillRx.setAttribute('d', rx.fill);
		parts.fillTx.setAttribute('d', tx.fill);

		this.geom = { padL, padT, innerW, innerH, step, max, count };

		// 数据滑动后鼠标仍在图上时，按新坐标重定位十字线/提示框。
		if (this.hoverClientX != null) {
			const rect = chart.getBoundingClientRect();
			this.positionHover(this.hoverClientX - rect.left);
		} else {
			this.hideHover();
		}
	},

	onChartHover(ev) {
		const chart = this.chartEl;
		if (!chart)
			return;
		this.hoverClientX = ev.clientX;
		const rect = chart.getBoundingClientRect();
		this.positionHover(ev.clientX - rect.left);
	},

	positionHover(localX) {
		const chart = this.chartEl;
		const tip = this.tipEl;
		const g = this.geom;
		if (!chart || !tip || !g || !g.count) {
			this.hideHover();
			return;
		}
		const samples = this.history;
		const { padL, padT, innerW, innerH, step, max, count } = g;

		let i;
		if (count === 1)
			i = 0;
		else
			i = Math.round(count - 1 - (padL + innerW - localX) / step);
		i = Math.max(0, Math.min(count - 1, i));

		const s = samples[i] || { rx: 0, tx: 0, t: Date.now() };
		const xi = padL + innerW - (count - 1 - i) * step;
		const yRx = padT + innerH * (1 - Math.min(s.rx, max) / max);
		const yTx = padT + innerH * (1 - Math.min(s.tx, max) / max);

		const hover = chart.querySelector('g.hover');
		hover.style.display = '';
		const cross = hover.querySelector('line.cross');
		cross.setAttribute('x1', xi.toFixed(1));
		cross.setAttribute('x2', xi.toFixed(1));
		cross.setAttribute('y1', String(padT));
		cross.setAttribute('y2', (padT + innerH).toFixed(1));
		const dotRx = hover.querySelector('circle.dot.rx');
		dotRx.setAttribute('cx', xi.toFixed(1));
		dotRx.setAttribute('cy', yRx.toFixed(1));
		const dotTx = hover.querySelector('circle.dot.tx');
		dotTx.setAttribute('cx', xi.toFixed(1));
		dotTx.setAttribute('cy', yTx.toFixed(1));

		tip.style.display = '';
		tip.textContent = '';
		tip.appendChild(E('div', { 'class': 'tip-t' }, new Date(s.t || Date.now()).toLocaleTimeString()));
		tip.appendChild(E('div', { 'class': 'tip-row rx' }, [
			E('span', { 'class': 'dot' }), _('Download') + ': ' + fmt.fmtRate(s.rx)
		]));
		tip.appendChild(E('div', { 'class': 'tip-row tx' }, [
			E('span', { 'class': 'dot' }), _('Upload') + ': ' + fmt.fmtRate(s.tx)
		]));

		const cw = chart.clientWidth || (padL + innerW + 12);
		const tw = tip.offsetWidth || 150;
		let left = xi + 14;
		if (left + tw > cw - 4)
			left = xi - tw - 14;
		if (left < 4)
			left = 4;
		tip.style.left = left.toFixed(0) + 'px';
		tip.style.top = (padT + 6) + 'px';
	},

	hideHover() {
		this.hoverClientX = null;
		const chart = this.chartEl || (this.dash && this.dash.querySelector('.zen-dash-svg'));
		const tip = this.tipEl || (this.dash && this.dash.querySelector('.zen-dash-tip'));
		const hover = chart && chart.querySelector('g.hover');
		if (hover)
			hover.style.display = 'none';
		if (tip)
			tip.style.display = 'none';
	},

	async readCpu() {
		const raw = await L.resolveDefault(fs.read('/proc/stat'), '');
		const lines = String(raw || '').split(/\n/);
		const now = cpuFromStat(lines[0]);
		let cores = 0;
		for (let i = 0; i < lines.length; i++) {
			if (/^cpu\d+/.test(lines[i]))
				cores++;
		}
		if (!cores)
			cores = 1;

		let pct = 0;
		if (now && this.prevCpu && now.total > this.prevCpu.total) {
			const dTotal = now.total - this.prevCpu.total;
			const dIdle = now.idle - this.prevCpu.idle;
			pct = (1 - dIdle / dTotal) * 100;
		}
		this.prevCpu = now;
		return { pct: fmt.clampPct(pct), cores };
	},

	async readWifi() {
		try {
			if (!network || typeof network.getWifiNetworks !== 'function')
				return { ssid: null, count: null };
			const nets = await L.resolveDefault(network.getWifiNetworks(), []);
			const active = (nets || []).filter((n) => {
				try {
					return typeof n.isUp === 'function' ? n.isUp() : true;
				} catch (e) {
					return false;
				}
			});
			if (!active.length)
				return { ssid: null, count: null };

			const lists = await Promise.all(active.map((n) => {
				if (typeof n.getAssocList !== 'function')
					return Promise.resolve([]);
				return L.resolveDefault(n.getAssocList(), []);
			}));
			const count = lists.reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
			return { ssid: null, count: count };
		} catch (e) {
			return { ssid: null, count: null };
		}
	},

	async readDisk(info) {
		const root = info && info.root;
		if (root && Number(root.total) > 0) {
			return {
				total: Number(root.total) * 1024,
				used: Number(root.used) * 1024
			};
		}

		const mounts = await L.resolveDefault(callMountPoints(), []);
		if (Array.isArray(mounts)) {
			let hit = null;
			for (let i = 0; i < mounts.length; i++) {
				if (mounts[i] && mounts[i].mount === '/') {
					hit = mounts[i];
					break;
				}
			}
			if (!hit && mounts[0])
				hit = mounts[0];
			if (hit && Number(hit.size) > 0) {
				const total = Number(hit.size);
				const free = Number(hit.free) || 0;
				return { total, used: Math.max(0, total - free) };
			}
		}

		return { total: 0, used: 0 };
	},

	looksLikeDevs(devs) {
		if (!devs || typeof devs !== 'object' || Array.isArray(devs))
			return false;
		for (const name in devs) {
			const d = devs[name];
			if (d && typeof d === 'object' && (d.statistics || d.stats || d.type || d.up != null))
				return true;
		}
		return false;
	},

	unwrapDevs(raw) {
		if (this.looksLikeDevs(raw))
			return raw;
		if (raw && typeof raw === 'object') {
			if (this.looksLikeDevs(raw.values))
				return raw.values;
			if (this.looksLikeDevs(raw.devices))
				return raw.devices;
		}
		return null;
	},

	async readDevs() {
		return this.unwrapDevs(await settled(callDevStatus(), {}))
			|| this.unwrapDevs(await settled(callNetworkDevices(), {}))
			|| {};
	},

	async readLan() {
		try {
			if (!network || typeof network.getNetwork !== 'function')
				return null;
			const lan = await L.resolveDefault(network.getNetwork('lan'), null);
			if (lan)
				return lan;
			if (typeof network.getNetworks !== 'function')
				return null;
			const nets = await L.resolveDefault(network.getNetworks(), []);
			for (let i = 0; i < (nets || []).length; i++) {
				const n = nets[i];
				try {
					if (n && typeof n.isWAN === 'function' && !n.isWAN())
						return n;
				} catch (e) { /* ignore */ }
			}
			return (nets && nets[0]) || null;
		} catch (e) {
			return null;
		}
	},

	tick() {
		return this.refresh().catch((e) => console.error('zen-dashboard', e));
	},

	async refresh() {
		const now = Date.now();
		// network 模块默认命中缓存；每帧先 flushCache，否则 WAN/LAN/WiFi 状态
		// 首屏后冻结（对齐官方 status/index.js）。
		if (network && typeof network.flushCache === 'function')
			await L.resolveDefault(network.flushCache(), null);
		const wanP = (network && typeof network.getWANNetworks === 'function')
			? network.getWANNetworks()
			: [];
		const wan6P = (network && typeof network.getWAN6Networks === 'function')
			? network.getWAN6Networks() : [];
		if (!this.boardPromise) this.boardPromise = settled(callSystemBoard(), {});
		const [info, cpu, devs, wans, lan, wans6, board] = await Promise.all([
			settled(callSystemInfo(), {}),
			this.readCpu(),
			this.readDevs(),
			settled(wanP, []),
			this.readLan(),
			settled(wan6P, []),
			this.boardPromise
		]);

		const sys = info || {};
		this.setSystemInfo(board || {}, sys);
		this.setUptime(sys.uptime, sys.localtime);

		const loadRaw = (sys.load || [0, 0, 0]).map((v) => (Number(v) || 0) / 65535);
		const perCore = loadRaw[0] / (cpu.cores || 1);
		const loadPct = fmt.clampPct(perCore * 100);
		const loadTxt = loadRaw.map((v) => v.toFixed(2)).join(' / ');
		const loadHint = perCore < 0.7 ? _('Running smoothly') : (
			perCore < 1 ? _('Normal load') : _('High load')
		);

		const mem = sys.memory || {};
		const memTotal = Number(mem.total) || 0;
		const memAvail = Number(mem.available != null ? mem.available : ((Number(mem.free) || 0) + (Number(mem.buffered) || 0)));
		const memUsed = memTotal ? Math.max(0, memTotal - memAvail) : 0;
		const memPct = memTotal ? (memUsed / memTotal) * 100 : 0;

		const disk = await this.readDisk(sys);
		this.diskInfo = disk;
		const diskUsed = (disk && disk.used) || 0;
		const diskTotal = (disk && disk.total) || 0;
		const diskPct = diskTotal ? (diskUsed / diskTotal) * 100 : 0;

		this.setGauge('load', _('Load'), loadHint, loadTxt, loadPct);
		this.setGauge('cpu', 'CPU', '%d %s'.format(cpu.cores, _('cores')), '', cpu.pct);
		this.setGauge('ram', _('Memory'), fmt.fmtBytes(memUsed), _('Total %s').format(fmt.fmtBytes(memTotal)), memPct);
		this.setGauge('disk', _('Storage'), fmt.fmtBytes(diskUsed), _('Total %s').format(fmt.fmtBytes(diskTotal)), diskPct);

		const wan = (wans || [])[0];
		const wan6 = (wans6 || [])[0] || (addrsOf(wan, true).length ? wan : null);
		this.setNetworkRow('wan', wan, false);
		this.setNetworkRow('lan', lan, false);
		this.setNetworkRow('wan6', wan6, true);
		const wanDev = wan && (typeof wan.getL3Device === 'function' ? wan.getL3Device() :
			(typeof wan.getDevice === 'function' ? wan.getDevice() : null));
		this.wanDevice = wanDev && wanDev.getName();
		this.wanProto = wan && wan.getProtocol ? String(wan.getProtocol()).toUpperCase().replace('PPPOE', 'PPPoE') : '';
		if (!this.ifaceChosen && this.wanDevice && this.iface !== this.wanDevice) {
			this.iface = this.wanDevice;
			this.historyLoadedFor = null;
			this.history = [];
			this.prevNet = null;
			this.prevAt = 0;
		}

		await this.loadRealtimeHistory();
		const stats = this.pickStats(devs || {}, this.iface);
		const hadBaseline = !!(this.prevNet && this.prevAt);
		let rxRate = 0, txRate = 0;
		if (this.prevNet && this.prevAt) {
			const dt = Math.max((now - this.prevAt) / 1000, 0.001);
			rxRate = Math.max(0, (stats.rx - this.prevNet.rx) / dt);
			txRate = Math.max(0, (stats.tx - this.prevNet.tx) / dt);
		}
		this.prevNet = { rx: stats.rx, tx: stats.tx };
		this.prevAt = now;
		if (hadBaseline || !this.history.length)
			this.history.push({ t: now, rx: rxRate, tx: txRate });
		if (this.history.length > HISTORY)
			this.history.shift();

		this.renderTraffic({
			rxRate, txRate,
			rxTotal: stats.rx,
			txTotal: stats.tx,
			names: stats.listed
		});
	}
});
