'use strict';
'require view';
'require poll';
'require rpc';
'require ui';

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
	method: 'setHostname'
});

const callReset = rpc.declare({
	object: 'zen.traffic',
	method: 'resetDevice'
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

/* 样式自包含：主题未安装时页面仍完整可用（幂等注入） */
const CSS_ID = 'zen-traffic-css';
function injectStyles() {
	if (document.getElementById(CSS_ID))
		return;
	const style = document.createElement('style');
	style.id = CSS_ID;
	style.textContent = [
		'.zen-tf-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 1.2em; }',
		'.zen-tf-sum-label { font-size: 12px; opacity: .65; margin-bottom: 2px; }',
		'.zen-tf-sum-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }',
		'.zen-tf-row.zen-tf-offline { opacity: .5; }',
		'.zen-tf-detail td { background: rgba(127,127,127,.06); }',
		'.zen-tf-detail { display: flex; justify-content: space-between; gap: 16px; padding: 8px 4px; font-size: 13px; }',
		'.zen-tf-detail-actions { display: flex; gap: 8px; align-items: flex-start; }',
		'.zen-tf-expand { min-width: 2.4em; }',
		'.th-right, .td-right { text-align: right; }',
		'.zen-tf-table td { white-space: nowrap; }'
	].join('\n');
	document.head.appendChild(style);
}

return view.extend({
	rows: null,     /* Map<mac, row>；row = {tr, cells, detailCells, detail, expanded, d} */
	tbody: null,
	summary: null,

	load() {
		return callStatus().catch(() => null);
	},

	render(status) {
		if (!status)
			return this.renderDegraded();

		injectStyles();

		const root = E('div', { 'class': 'cbi-map', 'id': 'zen-traffic-devices' }, [
			E('h2', {}, _('Device Traffic')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Realtime per-device traffic collected by zen-trafficd (eBPF). rx = download, tx = upload. LAN-local traffic is counted per device but does not inflate Internet usage totals.')),

			/* 汇总条 */
			this.summary = E('div', { 'class': 'cbi-section zen-tf-summary' }, []),
			/* 设备表 */
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table zen-tf-table' }, [
					E('thead', {}, E('tr', {}, [
						E('th', {}, _('Device')),
						E('th', {}, _('Connection')),
						E('th', { 'class': 'th-right' }, _('Download ↓')),
						E('th', { 'class': 'th-right' }, _('Upload ↑')),
						E('th', { 'class': 'th-right' }, _('Today')),
						E('th', {}, '')
					])),
					(this.tbody = E('tbody', {}))
				])
			])
		]);

		this.rows = new Map();
		poll.add(L.bind(this.tick, this), POLL_SECS);
		this.tick();
		return root;
	},

	renderDegraded() {
		return E('div', { 'class': 'cbi-map', 'id': 'zen-traffic-devices' }, [
			E('h2', {}, _('Device Traffic')),
			E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'alert-message warning' },
					_('The zen-traffic daemon is not reachable. Install/enable the zen-traffic package, then verify with "ubus call zen.traffic getStatus" on the device.'))
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
		}, this)).catch((e) => {
			console.warn('zen-traffic', e);
		});
	},

	renderSummary() {
		callTotal().then(L.bind((t) => {
			if (!t || !this.summary)
				return;
			const items = [
				[_('Download rate'), fmtRate(t.rx_r)],
				[_('Upload rate'), fmtRate(t.tx_r)],
				[_('Today'), fmtBytes((t.rx_today || 0) + (t.tx_today || 0))],
				[_('This month'), fmtBytes((t.rx_month || 0) + (t.tx_month || 0))]
			];
			if (!this.summary.firstChild) {
				for (const [label] of items)
					this.summary.appendChild(E('div', { 'class': 'zen-tf-sum-item' }, [
						E('div', { 'class': 'zen-tf-sum-label' }, label),
						E('div', { 'class': 'zen-tf-sum-value' }, '')
					]));
			}
			const vals = this.summary.querySelectorAll('.zen-tf-sum-value');
			items.forEach((it, i) => setText(vals[i], it[1]));
		}, this)).catch(() => {});
	},

	renderRows(devs) {
		if (!this.tbody || !this.rows)
			return;

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
		const cells = {
			name: E('td', {}, ''),
			conn: E('td', {}, ''),
			down: E('td', { 'class': 'td-right' }, ''),
			up: E('td', { 'class': 'td-right' }, ''),
			today: E('td', { 'class': 'td-right' }, '')
		};
		const expandBtn = E('button', {
			'class': 'cbi-button zen-tf-expand',
			'title': _('Details')
		}, '▸');
		const tr = E('tr', { 'class': 'zen-tf-row' }, [
			cells.name, cells.conn, cells.down, cells.up, cells.today,
			E('td', { 'class': 'td-right' }, [expandBtn])
		]);
		const row = { tr, cells, expanded: false, detail: null, detailCells: null, d: null };
		/* 绑定按钮 → row（避免闭包捕获陈旧设备数据；d 始终经 row.d 取最新） */
		expandBtn.addEventListener('click', L.bind(function (ev) {
			ev.preventDefault();
			this.toggleExpand(row);
		}, this));
		return row;
	},

	updateRow(row, d) {
		const c = row.cells;
		setText(c.name, devName(d));
		setText(c.conn, connLabel(d));
		setText(c.down, fmtRate(d.rx_r));
		setText(c.up, fmtRate(d.tx_r));
		setText(c.today, fmtBytes((d.rx_today || 0) + (d.tx_today || 0)));

		row.tr.classList.toggle('zen-tf-offline', !d.online);

		if (row.expanded && row.detailCells)
			this.updateDetail(row, d);
	},

	toggleExpand(row) {
		row.expanded = !row.expanded;
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
		const today = E('div', {}, '');
		const month = E('div', {}, '');
		const total = E('div', {}, '');

		const edit = E('button', { 'class': 'cbi-button' }, _('Edit hostname'));
		edit.addEventListener('click', L.bind(function () { this.editHostname(this); }, null));

		const detail = E('tr', { 'class': 'zen-tf-detail-row' },
			E('td', { 'colspan': 6 },
				E('div', { 'class': 'zen-tf-detail' }, [
					E('div', { 'class': 'zen-tf-detail-col' }, [ip, today, month, total]),
					E('div', { 'class': 'zen-tf-detail-actions' })
				])));

		detail.__cells = { ip, today, month, total, actions: detail.querySelectorAll('.zen-tf-detail-actions')[0] };
		return detail;
	},

	updateDetail(row, d) {
		const c = row.detailCells;
		setText(c.ip, _('IP') + ': ' + orDash(d.ip4) + (d.ip6 ? ' / ' + d.ip6 : ''));
		setText(c.today, _('Today') + ': ↓ ' + fmtBytes(d.rx_today) + '  ↑ ' + fmtBytes(d.tx_today));
		setText(c.month, _('This month') + ': ↓ ' + fmtBytes(d.rx_month) + '  ↑ ' + fmtBytes(d.tx_month));
		setText(c.total, _('Total') + ': ↓ ' + fmtBytes(d.rx_total) + '  ↑ ' + fmtBytes(d.tx_total)
			+ '  ·  ' + _('Last activity') + ': ' + ageStr(d.last));

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
			E('div', { 'class': 'cbi-value' },
				E('input', {
					'type': 'text',
					'id': 'zen-tf-host-input',
					'class': 'cbi-input-text',
					'value': d.host || ''
				})),
			E('div', { 'class': 'right' }, [
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
						callSetHostname({ mac: d.mac, host: host }).then(L.bind(() => {
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
		ui.confirm(_('Reset all counters for %s?').format(devName(d)), (ok) => {
			if (!ok)
				return;
			callReset({ mac: d.mac }).then(L.bind(() => {
				this.tick();
			}, this)).catch(L.bind((e) => {
				ui.addNotification(null, E('p', {}, _('Failed to reset: %s').format(e.message || e)));
			}, this));
		});
	}
});
