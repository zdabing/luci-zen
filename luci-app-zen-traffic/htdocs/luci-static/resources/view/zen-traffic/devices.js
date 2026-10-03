'use strict';
'require view';
'require poll';
'require rpc';
'require ui';
'require view.zen-traffic.style as trafficStyle';

/*
 * view.zen-traffic.devices — luci-app-zen-traffic 设备流量页。
 *
 * 数据源：ubus zen.traffic（zen-traffic daemon 直接发布，ACL 见
 * luci-app-zen-traffic.json）。方向约定：rx=下载、tx=上传，速率 B/s。
 *
 * 性能规范（与 luci-theme-zen dashboard 一致）：
 *   - DOM 行一次构建、按 MAC 缓存，更新只写 textContent/class；
 *   - Top-N 排序用 insertBefore 重排（移动已有节点，不重建）；
 *   - 2s 轮询；document.hidden 时跳过请求；
 *   - 本视图自包含，不 require 主题资源（主题未安装时页面完整可用）。
 */

const POLL_SECS = 2;
const MAX_ROWS = 100;

const callStatus = rpc.declare({
	object: 'zen.traffic',
	method: 'getStatus'
});

const callDevices = rpc.declare({
	object: 'zen.traffic',
	method: 'getDevices'
});

const callTotal = rpc.declare({
	object: 'zen.traffic',
	method: 'getTotal'
});

const callSetHostname = rpc.declare({
	object: 'zen.traffic',
	method: 'setHostname',
	params: ['mac', 'host']
});

const callReset = rpc.declare({
	object: 'zen.traffic',
	method: 'resetDevice',
	params: ['mac']
});

/* ---- 格式化（与 zen-format 同口径，独立实现避免跨包 require）---- */

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

function orDash(v) {
	return (v == null || v === '') ? '—' : String(v);
}

function ageStr(sec) {
	sec = Math.max(0, (Date.now() / 1000) - (Number(sec) || 0));
	if (sec < 90) return _('%d seconds ago').format(Math.round(sec));
	if (sec < 5400) return _('%d minutes ago').format(Math.round(sec / 60));
	if (sec < 172800) return _('%d hours ago').format(Math.round(sec / 3600));
	return _('%d days ago').format(Math.round(sec / 86400));
}

function connLabel(d) {
	let s = d.conn === 'wifi' ? _('Wi-Fi') : d.conn === 'router' ? _('Router') : _('Wired');
	if (d.band)
		s += ' · ' + d.band;
	return s;
}

function devName(d) {
	return d.host || d.ip4 || d.ip6 || d.mac;
}

function setText(el, s) {
	if (el && el.textContent !== s)
		el.textContent = s;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
	rows: null,     /* Map<mac, row>；row = {tr, cells, detailCells, detail, expanded, d} */
	tbody: null,
	summary: null,

	load() {
		return callStatus().catch(() => null);
	},

	render(status) {
		trafficStyle.inject();
		if (!status)
			return this.renderDegraded();

		const root = E('div', { 'class': 'cbi-map zen-traffic-page', 'id': 'zen-traffic-devices' }, [
			E('h2', {}, _('Device Traffic')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Device rates and usage include internet and local traffic passing through the router. Internet-only upload and download shares are shown on the overview page.')),

			/* 汇总条 */
			this.summary = E('div', { 'class': 'cbi-section zen-tf-summary' }, []),
			this.statusText = E('p', { 'class': 'zen-tf-status', role: 'status' }),
			/* 设备表 */
			E('div', { 'class': 'cbi-section zen-tf-list' }, [
				E('div', { 'class': 'zen-tf-list-head' }, [E('h3', {}, _('Devices')),
					this.count = E('span', { 'class': 'zen-tf-count' })]),
				E('table', { 'class': 'table zen-tf-table' }, [
					E('thead', {}, E('tr', {}, [
						E('th', { scope: 'col' }, _('Device')),
						E('th', { scope: 'col' }, _('Connection')),
						E('th', { scope: 'col', 'class': 'th-right' }, _('Download ↓')),
						E('th', { scope: 'col', 'class': 'th-right' }, _('Upload ↑')),
						E('th', { scope: 'col', 'class': 'th-right' }, _('Today')),
						E('th', { scope: 'col' }, '')
					])),
					(this.tbody = E('tbody', {}))
				]), this.empty = E('p', { 'class': 'zen-tf-empty' }, _('Loading devices…'))
			])
		]);

		this.rows = new Map();
		poll.add(L.bind(this.tick, this), POLL_SECS);
		this.tick();
		return root;
	},

	renderDegraded() {
		return E('div', { 'class': 'cbi-map zen-traffic-page', 'id': 'zen-traffic-devices' }, [
			E('h2', {}, _('Device Traffic')),
			E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'alert-message warning' },
					_('Device traffic is unavailable. Enable the traffic service and refresh this page.'))
			])
		]);
	},

	tick() {
		if (document.hidden)
			return;

		this.renderSummary();

		return callDevices().then(L.bind((data) => {
			const devs = (data && Array.isArray(data.dev)) ? data.dev : [];
			this.renderRows(devs);
			setText(this.statusText, '');
		}, this)).catch((e) => {
			setText(this.statusText, _('Unable to refresh device traffic; showing the last result.'));
			console.warn('zen-traffic', e);
		});
	},

	renderSummary() {
		callTotal().then(L.bind((t) => {
			if (!t || !this.summary)
				return;
			const items = [
				[_('Internet download rate'), fmtRate(t.rx_r), 'zen-tf-dl'],
				[_('Internet upload rate'), fmtRate(t.tx_r), 'zen-tf-ul'],
				[_('Device usage today'), fmtBytes((t.rx_today || 0) + (t.tx_today || 0)), ''],
				[_('Device usage this month'), fmtBytes((t.rx_month || 0) + (t.tx_month || 0)), '']
			];
			if (!this.summary.firstChild) {
				for (const [label, , cls] of items)
					this.summary.appendChild(E('div', { 'class': 'zen-tf-sum-item' }, [
						E('div', { 'class': 'zen-tf-sum-label' }, label),
						E('div', { 'class': 'zen-tf-sum-value ' + cls }, '')
					]));
			}
			const vals = this.summary.querySelectorAll('.zen-tf-sum-value');
			items.forEach((it, i) => setText(vals[i], it[1]));
		}, this)).catch(() => {});
	},

	renderRows(devs) {
		if (!this.tbody || !this.rows)
			return;
		this.empty.hidden = devs.length > 0;
		setText(this.empty, _('No devices detected yet.'));
		setText(this.count, _('%d devices · %d online').format(devs.length, devs.filter(d => d.online).length));

		/* Top-N：按（下行+上行实时速率）降序，其次今日累计 */
		devs.sort((a, b) =>
			((b.rx_r || 0) + (b.tx_r || 0)) - ((a.rx_r || 0) + (a.tx_r || 0)) ||
			((b.rx_today || 0) + (b.tx_today || 0)) - ((a.rx_today || 0) + (a.tx_today || 0)));

		const keep = new Set(devs.slice(0, MAX_ROWS).map((d) => d.mac));

		for (const [mac, row] of this.rows) {
			if (!keep.has(mac)) {
				row.tr.remove();
				if (row.detail)
					row.detail.remove();
				this.rows.delete(mac);
			}
		}

		/* cursor 按 DOM 节点前进，设备行和详情行保持为一组。 */
		let cursor = this.tbody.firstElementChild;
		devs.slice(0, MAX_ROWS).forEach((d) => {
			let row = this.rows.get(d.mac);
			if (!row) {
				row = this.buildRow();
				this.rows.set(d.mac, row);
			}
			row.d = d;
			this.updateRow(row, d);
			if (row.tr !== cursor)
				this.tbody.insertBefore(row.tr, cursor);
			cursor = row.tr.nextElementSibling;
			/* 收起的详情也留在所属设备旁，避免下一次展开时错位。 */
			if (row.detail) {
				if (row.detail !== cursor)
					this.tbody.insertBefore(row.detail, cursor);
				cursor = row.detail.nextElementSibling;
			}
		});
	},

	buildRow() {
		const name = E('strong', { 'class': 'zen-tf-device-name' });
		const address = E('span', { 'class': 'zen-tf-address' });
		const conn = E('span', { 'class': 'zen-tf-online' });
		const value = (label, cls) => E('td', { 'class': 'td-right ' + cls }, [
			E('span', { 'class': 'zen-tf-mobile-label' }, label), E('span', { 'class': 'zen-tf-number' })]);
		const cells = {
			name: E('td', { 'class': 'zen-tf-name' }, [name, address]),
			conn: E('td', { 'class': 'zen-tf-conn' }, conn),
			down: value(_('Download'), 'zen-tf-down zen-tf-dl'),
			up: value(_('Upload'), 'zen-tf-up zen-tf-ul'),
			today: value(_('Today'), 'zen-tf-today')
		};
		const expandBtn = E('button', {
			'class': 'cbi-button zen-tf-expand',
			type: 'button', 'aria-expanded': 'false',
			'title': _('Details')
		}, '▸');
		const tr = E('tr', { 'class': 'zen-tf-row' }, [
			cells.name, cells.conn, cells.down, cells.up, cells.today,
			E('td', { 'class': 'td-right zen-tf-action' }, [expandBtn])
		]);
		const row = { tr, cells, name, address, conn, expandBtn, expanded: false, detail: null, detailCells: null, d: null };
		/* 绑定按钮 → row（避免闭包捕获陈旧设备数据；d 始终经 row.d 取最新） */
		expandBtn.addEventListener('click', L.bind(function (ev) {
			ev.preventDefault();
			this.toggleExpand(row);
		}, this));
		return row;
	},

	updateRow(row, d) {
		const c = row.cells;
		setText(row.name, devName(d)); row.name.title = devName(d);
		setText(row.address, d.ip4 || d.ip6 || d.mac);
		setText(row.conn, connLabel(d) + ' · ' + (d.online ? _('Online') : _('Offline')));
		setText(c.down.lastChild, fmtRate(d.rx_r));
		setText(c.up.lastChild, fmtRate(d.tx_r));
		setText(c.today.lastChild, fmtBytes((d.rx_today || 0) + (d.tx_today || 0)));
		row.expandBtn.setAttribute('aria-label', _('Details for %s').format(devName(d)));

		row.tr.classList.toggle('zen-tf-offline', !d.online);

		if (row.expanded && row.detailCells)
			this.updateDetail(row, d);
	},

	toggleExpand(row) {
		row.expanded = !row.expanded;
		row.tr.classList.toggle('zen-tf-expanded', row.expanded);
		row.expandBtn.setAttribute('aria-expanded', String(row.expanded));
		setText(row.expandBtn, row.expanded ? '▾' : '▸');
		if (row.expanded && !row.detail) {
			row.detail = this.buildDetail();
			row.detailCells = row.detail.__cells;
			row.tr.insertAdjacentElement('afterend', row.detail);
		}
		if (row.detail)
			row.detail.style.display = row.expanded ? '' : 'none';
		if (row.expanded && row.d)
			this.updateDetail(row, row.d);
	},

	buildDetail() {
		const ip = E('div', {}, '');
		const mac = E('div', {});
		const last = E('p', { 'class': 'zen-tf-detail-last' });
		const metric = label => ({ label: E('strong', {}, label), down: E('span', { 'class': 'zen-tf-dl' }), up: E('span', { 'class': 'zen-tf-ul' }) });
		const today = metric(_('Today')), month = metric(_('This month')), total = metric(_('Total'));

		const detail = E('tr', { 'class': 'zen-tf-detail-row' },
			E('td', { 'colspan': 6 },
				E('div', { 'class': 'zen-tf-detail' }, [
					E('div', { 'class': 'zen-tf-detail-identities' }, [ip, mac]),
					E('div', { 'class': 'zen-tf-detail-stats' }, [today, month, total].map(m => E('div', {}, [m.label, m.down, m.up]))), last,
					E('div', { 'class': 'zen-tf-detail-actions' })
				])));

		detail.__cells = { ip, mac, last, today, month, total, actions: detail.querySelectorAll('.zen-tf-detail-actions')[0] };
		return detail;
	},

	updateDetail(row, d) {
		const c = row.detailCells;
		setText(c.ip, _('IP') + ': ' + orDash(d.ip4) + (d.ip6 ? ' / ' + d.ip6 : ''));
		setText(c.mac, 'MAC: ' + d.mac);
		for (const [metric, rx, tx] of [[c.today, d.rx_today, d.tx_today], [c.month, d.rx_month, d.tx_month], [c.total, d.rx_total, d.tx_total]]) {
			setText(metric.down, '↓ ' + fmtBytes(rx)); setText(metric.up, '↑ ' + fmtBytes(tx));
		}
		setText(c.last, _('Last activity') + ': ' + ageStr(d.last));

		/* 操作按钮只挂一次（MAC 唯一，事件转发到当前 row） */
		if (!c.actions.firstChild) {
			const edit = E('button', { 'class': 'cbi-button' }, _('Edit hostname'));
			edit.addEventListener('click', L.bind(() => this.editHostname(row), this));
			const reset = E('button', { 'class': 'cbi-button cbi-button-negative' }, _('Reset counters'));
			reset.addEventListener('click', L.bind(() => this.resetDevice(row), this));
			c.actions.appendChild(edit);
			c.actions.appendChild(reset);
		}
	},

	editHostname(row) {
		const d = row.d;
		if (!d)
			return;
		ui.showModal(_('Edit hostname'), [
			E('p', {}, devName(d) + ' (' + d.mac + ')'),
			E('label', { 'class': 'zen-tf-name-field' }, [E('span', {}, _('Hostname')),
				E('input', {
					'type': 'text',
					'id': 'zen-tf-host-input',
					'class': 'cbi-input-text',
					'value': d.host || ''
				})]),
			E('div', { 'class': 'zen-tf-modal-actions' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button-action important',
					'click': L.bind(() => {
						const host = document.getElementById('zen-tf-host-input').value.trim();
						ui.hideModal();
						callSetHostname(d.mac, host).then(L.bind(() => {
							this.tick();
						}, this)).catch(L.bind((e) => {
							ui.addNotification(null, E('p', {}, _('Failed to set hostname: %s').format(e.message || e)));
						}, this));
					}, this)
				}, _('Save'))
			])
		]);
	},

	resetDevice(row) {
		const d = row.d;
		if (!d)
			return;
		ui.showModal(_('Reset counters'), [
			E('p', {}, _('Reset all counters for %s?').format(devName(d))),
			E('div', { 'class': 'zen-tf-modal-actions' }, [
				E('button', { type: 'button', 'class': 'btn', click: ui.hideModal }, _('Cancel')),
				E('button', { type: 'button', 'class': 'btn cbi-button-negative', click: L.bind(() => {
					ui.hideModal();
					callReset(d.mac).then(() => this.tick()).catch((e) => {
						ui.addNotification(null, E('p', {}, _('Failed to reset: %s').format(e.message || e)));
					});
				}, this) }, _('Reset counters'))
			])
		]);
	}
});
