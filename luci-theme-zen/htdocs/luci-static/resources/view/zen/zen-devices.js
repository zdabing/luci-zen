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

	const conn = E('span', { 'class': 'zen-dash-dev-conn' }, '');
	const dl = E('span', { 'class': 'zen-dash-dev-rate dl' }, '');
	const ul = E('span', { 'class': 'zen-dash-dev-rate ul' }, '');
	const chev = E('span', { 'class': 'zen-dash-dev-chev' }, [icons.icon('zen-i-chev', 16)]);

	const detail = E('div', { 'class': 'zen-dash-dev-detail' },
		E('div', { 'class': 'zen-dash-dev-detail-grid' }, []));

	li.appendChild(iconBox);
	li.appendChild(id);
	li.appendChild(ip);
	li.appendChild(mac);
	li.appendChild(conn);
	li.appendChild(E('span', { 'class': 'zen-dash-dev-rates' }, [dl, ul]));
	li.appendChild(chev);
	li.appendChild(detail);

	const ent = {
		li, iconBox, ov, ip, mac, conn, dl, ul, detail,
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
		[_('IP'), (d.ip4 || '—') + (d.ip6 ? ' / ' + d.ip6 : '')],
		[_('MAC'), d.mac],
		[_('Today'), '↓ ' + fmt.fmtBytes(d.rx_today) + '  ↑ ' + fmt.fmtBytes(d.tx_today)],
		[_('Month'), '↓ ' + fmt.fmtBytes(d.rx_month) + '  ↑ ' + fmt.fmtBytes(d.tx_month)],
		[_('Total'), '↓ ' + fmt.fmtBytes(d.rx_total) + '  ↑ ' + fmt.fmtBytes(d.tx_total)]
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
				E('span', { 'class': 'zen-dash-dev-count' }, '')
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
		section.appendChild(E('div', { 'class': 'zen-dash-dev-columns', 'aria-hidden': 'true' }, [
			E('span', {}, ''),
			E('span', {}, _('Hostname')),
			E('span', { 'class': 'zen-dash-dev-ip' }, 'IPv4'),
			E('span', { 'class': 'zen-dash-dev-mac' }, _('MAC')),
			E('span', { 'class': 'zen-dash-dev-conn' }, _('Connection')),
			E('span', { 'class': 'zen-dash-dev-rates' }, _('Realtime Traffic')),
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

		/* Top-N：实时速率优先，其次今日累计 */
		devs.sort((a, b) =>
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
			setText(ent.dl, '↓ ' + fmt.fmtRate(d.rx_r || 0));
			setText(ent.ul, '↑ ' + fmt.fmtRate(d.tx_r || 0));

			if (ent.li.classList.contains('open'))
				updateDetail(ent, d);
		});

		/* 消失的设备（含休眠）移除 */
		for (const [mac, ent] of this.cache) {
			if (!keep.has(mac)) {
				ent.li.remove();
				this.cache.delete(mac);
			}
		}

		this.applyVisibility();
		setText(this.count,
			devs.length ? '%d devices'.format(devs.length) : _('No devices yet'));
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
