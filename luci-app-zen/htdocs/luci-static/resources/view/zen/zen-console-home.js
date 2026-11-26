'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen.zen-devices as devicesModule';
'require view.zen.zen-format as fmt';
'require view.zen.zen-wan-share as shares';

const callP2pUsage = rpc.declare({ object: 'zen.traffic', method: 'getP2pUsage' });
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
};

const ICON_PATHS = {
	router: ['M2 9h12v5H2z', 'M5 9V5.5M11 9V4M4.5 11.5h.01M7.5 11.5h.01M10.5 11.5h1'],
	pulse: ['M1.5 8.5h2.5l2-4.5 3 8 2-3.5h3.5'],
	devices: ['M2 3h8.5v6.5H2z', 'M4.5 12h4', 'M11.5 6h3v7h-3z'],
	cpu: ['M4 4h8v8H4z', 'M6.5 6.5h3v3h-3zM6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2'],
	ram: ['M2 5h12v6H2z', 'M5 8V6.5M8 8V6.5M11 8V6.5M4.5 11v2M8 11v2M11.5 11v2'],
	temp: ['M9.5 9.2V3.5a1.5 1.5 0 0 0-3 0v5.7a2.75 2.75 0 1 0 3 0Z'],
	conn: ['M5.75 4.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z', 'M13.75 4.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z', 'M9.75 12a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z', 'M5.5 5.5 7.2 10.3M10.5 5.5 8.8 10.3M5.8 4.5h4.4'],
	dl: ['M8 2.5v8.5', 'M4.5 7.5 8 11l3.5-3.5', 'M3 13.5h10'],
	ul: ['M8 11V2.5', 'M4.5 6 8 2.5 11.5 6', 'M3 13.5h10'],
	chart: ['M3 13V8.5M8 13V4M13 13V6.5'],
	shield: ['M8 2 3 4v3.8c0 3.1 2.1 5.3 5 6.2 2.9-.9 5-3.1 5-6.2V4L8 2Z', 'm6 8 1.4 1.4L10.3 6.5']
};

function svgIcon(name, cls) {
	const ns = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.7');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	if (cls) svg.setAttribute('class', cls);
	for (const d of (ICON_PATHS[name] || ICON_PATHS.chart)) {
		const p = document.createElementNS(ns, 'path');
		p.setAttribute('d', d);
		svg.append(p);
	}
	return svg;
}

const compactBytes = b => fmt.fmtBytes(b).replace(/\s+([KMGTPE])B$/i, '$1').replace(/\s+B$/i, 'B');

function splitFormatted(text) {
	const parts = String(text || '').trim().split(/\s+/);
	return [parts[0] || '—', parts.slice(1).join(' ')];
}

function decorateDevices(devices, syncTodayUsage) {
	const head = devices.querySelector('.zen-dash-dev-head');
	const h3 = devices.querySelector('h3');
	if (h3) {
		h3.textContent = '';
		h3.append(svgIcon('devices', 'rf-head-icon'), document.createTextNode('连接设备'));
	}
	const countEl = devices.querySelector('.zen-dash-dev-count');
	if (head && h3) {
		const titleWrap = el('div', 'rf-dev-head-title');
		titleWrap.append(h3);
		if (countEl) titleWrap.append(countEl);
		head.prepend(titleWrap);
	}

	const deviceModel = devicesModule;
	const toolbar = devices.querySelector('.zen-device-toolbar');
	if (toolbar) {
		if (head) head.append(toolbar);
		const filterSelect = toolbar.querySelector('select:not(.rf-device-sort)');
		if (filterSelect) {
			filterSelect.replaceChildren(...[
				['all', '全部设备'],
				['online', '仅看在线'],
				['active', '正在传输'],
				['wifi', '无线 Wi-Fi'],
				['wired', '有线连接'],
				['offline', '仅看离线']
			].map(([value, label]) => {
				const opt = el('option', '', label);
				opt.value = value;
				return opt;
			}));
			filterSelect.value = deviceModel.connection || 'all';
			filterSelect.zenPicker?.refresh();
		}

		const sortOptions = [
			['day_dl', '按今日下载', true],
			['day_ul', '按今日上传', true],
			['all_total', '按总用量', true],
			['wan_rx_r', '按下载速度', true],
			['wan_tx_r', '按上传速度', true]
		];
		const sorter = el('select', 'rf-device-sort');
		sorter.setAttribute('aria-label', '设备排序');
		for (const [key, label] of sortOptions) {
			const option = el('option', '', label);
			option.value = key;
			sorter.append(option);
		}
		if (!sortOptions.some(entry => entry[0] === deviceModel.sortKey)) {
			deviceModel.setSort('day_dl', true);
		}
		sorter.value = deviceModel.sortKey || 'day_dl';
		sorter.addEventListener('change', () => {
			const chosen = sortOptions.find(entry => entry[0] === sorter.value);
			if (chosen) deviceModel.setSort(chosen[0], chosen[2]);
		});
		toolbar.append(sorter);
		deviceModel.enhanceSelect(sorter);
	}

	const colHead = devices.querySelector('.zen-dash-dev-columns');
	const devList = devices.querySelector('.zen-dash-dev-list');
	if (colHead) {
		colHead.replaceChildren(
			el('span', '', '设备名称'),
			el('span', 'rf-col-sub', 'IP · MAC'),
			el('span', 'rf-col-conn', '连接状态'),
			el('span', 'rf-col-today', '今日流量'),
			el('span', 'rf-col-total', '总用量'),
			el('span', 'rf-col-speeds', '实时速率')
		);
	}
	if (colHead && devList && !devices.querySelector('.rf-device-table')) {
		const tableBox = el('div', 'rf-device-table');
		colHead.before(tableBox);
		tableBox.append(colHead, devList);
	}

	const decorateRows = () => {
		let added = false;
		for (const row of devices.querySelectorAll('.zen-dash-dev-row')) {
			if (row.dataset.rfDecorated === '1') continue;
			row.dataset.rfDecorated = '1';
			added = true;

			const iconBox = row.querySelector('.zen-dash-dev-icon');
			const idBox = row.querySelector('.zen-dash-dev-id');
			const ipEl = row.querySelector('.zen-dash-dev-ip');
			const macEl = row.querySelector('.zen-dash-dev-mac');
			const connEl = row.querySelector('.zen-dash-dev-conn');

			const identityWrap = el('div', 'rf-device-identity');
			if (iconBox) identityWrap.append(iconBox);
			if (idBox) identityWrap.append(idBox);

			const sub = el('span', 'rf-device-sub');
			if (ipEl && macEl) sub.append(ipEl, el('span', '', '·'), macEl);

			const todayCell = el('span', 'rf-device-today');
			todayCell.append(el('span', 'rf-up', '↑ —'), el('span', 'rf-down', '↓ —'));
			const totalCell = el('span', 'rf-device-total', '—');
			const speeds = el('div', 'rf-device-speeds');
			for (const rate of row.querySelectorAll('.zen-dash-dev-rate')) {
				rate.prepend(el('span', 'rf-rate-arrow', rate.classList.contains('zen-dash-dev-download') ? '↓' : '↑'));
				speeds.append(rate);
			}
			speeds.append(el('span', 'rf-offline-dash', '—'));

			if (connEl && !connEl.querySelector('.rf-status-badge')) {
				const online = row.dataset.online ? row.dataset.online === '1' : !row.classList.contains('is-offline');
				const badge = el('span', 'rf-status-badge ' + (online ? 'is-online' : 'is-offline'));
				badge.append(el('i', 'rf-status-dot'), el('span', 'rf-status-text', online ? '在线' : '离线'));
				connEl.prepend(badge);
				const sessionEl = connEl.querySelector('.zen-dash-dev-session');
				if (sessionEl && (sessionEl.textContent.trim() === '在线' || sessionEl.textContent.trim() === '离线')) {
					sessionEl.textContent = '';
				}
			}

			row.prepend(identityWrap);
			if (connEl) {
				connEl.before(sub);
				connEl.after(todayCell, totalCell, speeds);
			} else {
				identityWrap.after(sub, todayCell, totalCell, speeds);
			}
		}
		if (added) syncTodayUsage();
	};
	decorateRows();
	new MutationObserver(decorateRows).observe(devices, { subtree: true, childList: true });
}

return baseclass.extend({
	build(dash, model) {
		model.compactChart = true;
		model.lastW = 0;
		dash.dataset.homeLayout = 'split';

		const analysisHref = L.url('admin', 'zen', 'analysis');
		const live = dash.querySelector('.zen-dash-traffic');
		const trend = dash.querySelector('.zen-dash-trend');
		live.classList.add('rf-live');

		const liveHead = live.querySelector('.zen-dash-traffic-head');
		const liveTitle = live.querySelector('h3');
		liveTitle.textContent = '';
		liveTitle.append(svgIcon('pulse', 'rf-head-icon'), document.createTextNode('实时流量'));
		const liveLink = el('a', 'rf-live-link', '分析详情 →');
		liveLink.href = analysisHref;
		liveHead.append(liveLink);

		const details = el('details', 'rf-system');
		details.append(el('summary', '', '系统与接口详情'));
		for (const selector of ['.zen-dash-iface-control', '.zen-dash-strip', '.zen-dash-gauges', '.zen-dash-overview', '.zen-dash-interface-totals']) {
			const n = dash.querySelector(selector);
			if (n) details.append(n);
		}

		const statsRow = live.querySelector('.zen-dash-traffic-stats');
		const rxStat = statsRow.querySelector('.zen-dash-stat.rx');
		const txStat = statsRow.querySelector('.zen-dash-stat.tx');
		if (rxStat && txStat) statsRow.insertBefore(rxStat, txStat);

		for (const [stat, iconName, titleText, dirKey] of [
			[rxStat, 'dl', '下载速率', 'rx'],
			[txStat, 'ul', '上传速率', 'tx']
		]) {
			if (!stat) continue;
			const k = stat.querySelector('.k');
			if (k) {
				k.textContent = '';
				k.append(svgIcon(iconName, 'rf-kpi-icon'), document.createTextNode(titleText));
			}
			const peak = el('span', 'rf-peak', '峰值 ' + fmt.fmtRate(0));
			peak.dataset.peak = dirKey;
			stat.append(peak);
		}

		const todayStat = el('div', 'zen-dash-stat rf-kpi-today');
		const todayK = el('span', 'k');
		todayK.append(svgIcon('chart', 'rf-kpi-icon rf-kpi-icon-dl'), document.createTextNode('今日累计'));
		const todayNum = el('span', 'rf-number', '—');
		const todayUnit = el('small', 'rf-unit', '');
		const todayVal = el('span', 'v');
		todayVal.append(todayNum, todayUnit);
		const todayDlSub = el('span', 'rf-down', '↓ —');
		const todayUlSub = el('span', 'rf-up', '↑ —');
		const todayDirs = el('span', 'rf-kpi-sub rf-today-dirs');
		todayDirs.append(todayDlSub, todayUlSub);
		todayStat.append(todayK, todayVal, todayDirs);

		const p2pStat = el('a', 'zen-dash-stat rf-kpi-p2p');
		p2pStat.href = analysisHref;
		const p2pK = el('span', 'k');
		p2pK.append(svgIcon('shield', 'rf-kpi-icon rf-kpi-icon-dl'), document.createTextNode('P2P 拦截'));
		const p2pNum = el('span', 'rf-number', '—');
		const p2pUnit = el('small', 'rf-unit', '');
		const p2pVal = el('span', 'v');
		p2pVal.append(p2pNum, p2pUnit);
		const p2pMore = el('span', 'rf-kpi-sub rf-p2p-more', '查看明细 ›');
		p2pStat.append(p2pK, p2pVal, p2pMore);

		statsRow.append(todayStat, p2pStat);

		const readings = el('div', 'rf-live-readings');
		readings.append(statsRow);
		live.append(readings, trend);

		trend.querySelector('.zen-dash-svg').setAttribute('preserveAspectRatio', 'none');
		for (const [selector, label] of [['.ul', '上传'], ['.dl', '下载']]) {
			const item = trend.querySelector('.zen-dash-chart-legend ' + selector);
			item.replaceChildren(item.querySelector('.swatch'), document.createTextNode(label));
		}
		const chartCaption = el('span', 'rf-chart-caption', '每 5 秒 · 最近 5 分钟');
		trend.querySelector('.zen-dash-chart-legend').append(chartCaption);
		const chartFoot = el('div', 'rf-chart-foot');
		chartFoot.append(el('span', '', '5 分钟前'), el('span', '', '现在'));
		live.append(chartFoot);

		/* Keep hidden wan-share container mounted inside live (never inside [hidden] details). */
		const shareSource = el('div');
		shareSource.style.display = 'none';
		shareSource.setAttribute('aria-hidden', 'true');
		live.append(shareSource);

		/* Left Card: 路由器状态 */
		const router = el('section', 'rf-router');
		router.setAttribute('aria-label', '路由器状态');
		const routerHead = el('div', 'rf-router-head');
		const routerTitleWrap = el('div', 'rf-router-title-wrap');
		const routerTitle = el('h1', 'rf-router-title');
		routerTitle.append(svgIcon('router', 'rf-head-icon'), document.createTextNode('路由器状态'));
		const routerMeta = el('span', 'rf-router-meta');
		routerTitleWrap.append(routerTitle, routerMeta);
		routerHead.append(routerTitleWrap);

		const syncMeta = () => {
			const parts = ['host', 'firmware'].map(key => details.querySelector('[data-system="' + key + '"]')?.textContent.trim()).filter(v => v && v !== fmt.MISSING);
			routerMeta.textContent = parts.join(' · ');
			routerMeta.hidden = !parts.length;
		};
		new MutationObserver(syncMeta).observe(details, { subtree: true, childList: true, characterData: true });
		syncMeta();

		const connection = dash.querySelector('.zen-dash-connections');
		const wanPill = el('div', 'rf-wan-pill');
		const wanState = el('span', 'rf-wan-status');
		wanState.append(el('span', '', 'WAN'), connection.querySelector('[data-connection="state"]'));
		wanPill.append(wanState, connection.querySelector('[data-health-metric="latency"]'));
		routerHead.append(wanPill);

		const health = el('div', 'rf-health');
		const gaugeSource = details.querySelector('.zen-dash-gauges');
		const metrics = [];
		for (const [key, label, iconName, toneCls] of [
			['cpu', 'CPU', 'cpu', 'rf-kpi-icon-ul'],
			['ram', '内存', 'ram', 'rf-kpi-icon-dl']
		]) {
			const item = el('span', 'rf-health-metric');
			const labelWrap = el('span', 'rf-kpi-label');
			labelWrap.append(svgIcon(iconName, 'rf-kpi-icon ' + toneCls), document.createTextNode(label));
			const value = el('b', '', '—');
			const bar = el('i', 'rf-health-fill');
			const track = el('span', 'rf-health-track');
			track.append(bar);
			item.append(labelWrap, value, track);
			health.append(item);
			metrics.push({ key, value, bar });
		}
		function syncHealth() {
			for (const { key, value, bar } of metrics) {
				const source = gaugeSource.querySelector('[data-gauge="' + key + '"] text.pct');
				value.textContent = source?.textContent || '—';
				bar.style.width = Math.min(100, Math.max(0, parseFloat(value.textContent) || 0)) + '%';
			}
		}
		new MutationObserver(syncHealth).observe(gaugeSource, { subtree: true, childList: true, characterData: true });
		syncHealth();

		const tempMetric = connection.querySelector('[data-health-metric="temperature"]');
		if (tempMetric) {
			const lbl = tempMetric.querySelector('span:first-child');
			if (lbl) {
				lbl.className = 'rf-kpi-label';
				lbl.prepend(svgIcon('temp', 'rf-kpi-icon rf-kpi-icon-ul'));
			}
			const sub = el('span', 'rf-kpi-sub rf-kpi-ok', '运行正常');
			tempMetric.append(sub);
			const tempStrong = tempMetric.querySelector('[data-health="temperature"]');
			if (tempStrong) {
				const syncTempState = () => {
					const val = parseFloat(tempStrong.textContent);
					const hot = Number.isFinite(val) && val >= 75;
					sub.textContent = hot ? '温度偏高' : '运行正常';
					sub.classList.toggle('rf-kpi-warn', hot);
					sub.classList.toggle('rf-kpi-ok', !hot);
				};
				new MutationObserver(syncTempState).observe(tempStrong, { subtree: true, childList: true, characterData: true });
				syncTempState();
			}
			health.append(tempMetric);
		}
		const connMetric = connection.querySelector('[data-health-metric="connections"]');
		if (connMetric) {
			const lbl = connMetric.querySelector('span:first-child');
			if (lbl) {
				lbl.className = 'rf-kpi-label';
				lbl.prepend(svgIcon('conn', 'rf-kpi-icon rf-kpi-icon-dl'));
			}
			connMetric.append(el('span', 'rf-kpi-sub', '活跃会话'));
			health.append(connMetric);
		}
		connection.querySelector('.zen-dash-health')?.remove();

		for (const key of ['wan', 'wan6', 'lan', 'uptime']) {
			connection.querySelector('[data-connection="' + key + '"]').closest('.zen-dash-connection').dataset.connectionCard = key;
		}
		const ipv6 = connection.querySelector('[data-connection="wan6"]');
		const ipv6Card = ipv6.closest('.zen-dash-connection');
		const syncIPv6 = () => {
			const available = ipv6.textContent.trim() !== fmt.MISSING && ipv6.textContent.trim() !== '';
			ipv6Card.hidden = !available;
			connection.classList.toggle('rf-has-ipv6', available);
		};
		new MutationObserver(syncIPv6).observe(ipv6, { subtree: true, childList: true, characterData: true });
		syncIPv6();

		for (const field of connection.querySelectorAll('[data-connection="wan"],[data-connection="wan6"],[data-connection="lan"]')) {
			const button = el('button', 'rf-copy', '复制');
			button.type = 'button';
			button.setAttribute('aria-label', '复制 ' + field.previousElementSibling.textContent);
			const line = el('div', 'rf-address-line');
			field.before(line);
			line.append(field, button);
			button.addEventListener('click', async () => {
				if (field.textContent === '—') return;
				try {
					await navigator.clipboard.writeText(field.textContent);
					button.textContent = '已复制';
				} catch {
					button.textContent = '复制失败';
				}
				setTimeout(() => (button.textContent = '复制'), 1200);
			});
		}
		router.append(routerHead, health, connection);

		const devicePlaceholder = el('section', 'zen-dash-panel');
		const deviceStatus = el('p', 'zen-dash-dev-note', '正在读取连接设备…');
		deviceStatus.setAttribute('role', 'status');
		devicePlaceholder.append(el('h3', '', '连接设备'), deviceStatus);
		details.hidden = true;
		details.setAttribute('aria-hidden', 'true');

		dash.replaceChildren(router, live, devicePlaceholder, details);

		return async () => {
			let hasDayUsage = false;
			let hasAllUsage = false;
			let devicesNode = null;
			const dayUsageByMac = new Map();
			const allUsageByMac = new Map();
			devicesModule.zenControlOptions = {
				...devicesModule.zenControlOptions,
				getUsage: mac => (hasDayUsage ? (dayUsageByMac.get(String(mac || '').toLowerCase()) || { upload: 0, download: 0 }) : null),
				getTotalUsage: mac => (hasAllUsage ? (allUsageByMac.get(String(mac || '').toLowerCase()) || { upload: 0, download: 0 }) : null)
			};

			const syncDeviceUsage = () => {
				if (!devicesNode || (!hasDayUsage && !hasAllUsage)) return;
				for (const row of devicesNode.querySelectorAll('.zen-dash-dev-row')) {
					const mac = row.dataset.mac;
					if (!mac) continue;
					if (hasDayUsage) {
						const cell = row.querySelector('.rf-device-today');
						if (cell) {
							const usage = dayUsageByMac.get(mac);
							const ul = usage ? usage.upload : 0;
							const dl = usage ? usage.download : 0;
							const upSpan = cell.querySelector('.rf-up');
							const dnSpan = cell.querySelector('.rf-down');
							const nextUp = '↑ ' + fmt.fmtBytes(ul);
							const nextDn = '↓ ' + fmt.fmtBytes(dl);
							if (upSpan && upSpan.textContent !== nextUp) upSpan.textContent = nextUp;
							if (dnSpan && dnSpan.textContent !== nextDn) dnSpan.textContent = nextDn;
							const nextTitle = '今日总计 ' + fmt.fmtBytes(ul + dl);
							if (cell.title !== nextTitle) cell.title = nextTitle;
						}
					}
					if (hasAllUsage) {
						const totalCell = row.querySelector('.rf-device-total');
						if (totalCell) {
							const totalUsage = allUsageByMac.get(mac);
							const allUl = totalUsage ? totalUsage.upload : 0;
							const allDl = totalUsage ? totalUsage.download : 0;
							const sumBytes = allUl + allDl;
							const nextTotal = fmt.fmtBytes(sumBytes);
							if (totalCell.textContent !== nextTotal) totalCell.textContent = nextTotal;
							const isZero = sumBytes <= 0;
							if (totalCell.classList.contains('is-zero') !== isZero) totalCell.classList.toggle('is-zero', isZero);
							const nextTotalTitle = '累计总用量 ' + nextTotal + '（↑ ' + fmt.fmtBytes(allUl) + ' · ↓ ' + fmt.fmtBytes(allDl) + '）';
							if (totalCell.title !== nextTotalTitle) totalCell.title = nextTotalTitle;
						}
					}
				}
			};

			const fmtPktsParts = n => {
				const v = Math.max(0, Math.round(Number(n) || 0));
				if (v >= 1e8) return [(v / 1e8).toFixed(2), '亿包'];
				if (v >= 1e4) return [(v / 1e4).toFixed(v >= 1e6 ? 1 : 2), '万包'];
				return [v.toLocaleString(), '包'];
			};

			const refreshP2p = async () => {
				if (document.hidden || !live.isConnected) return;
				try {
					const res = await callP2pUsage();
					const data = typeof res?.json === 'string' ? JSON.parse(res.json) : res;
					if (data && data.ok) {
						const todayRow = (data.days || []).find(r => r.date === data.today);
						const dropped = todayRow ? todayRow.dropped : (data.total?.dropped || 0);
						const [num, unit] = fmtPktsParts(dropped);
						p2pNum.textContent = num;
						p2pUnit.textContent = unit;
					}
				} catch (_e) {}
			};
			poll.add(refreshP2p, 10);
			refreshP2p();

			Promise.resolve(model.devicesReady).then(devices => {
				if (!dash.isConnected) return;
				if (!devices) {
					deviceStatus.textContent = '暂时无法读取连接设备。';
					return;
				}
				devicesNode = devices;
				devicePlaceholder.replaceWith(devices);
				decorateDevices(devices, syncDeviceUsage);
			}).catch(error => console.warn('zen-console-devices', error));

			const redraw = () => {
				model.lastW = 0;
				model.renderTraffic(model.lastTraffic || { rxRate: 0, txRate: 0, rxTotal: 0, txTotal: 0, names: model.lastNames || [] });
			};
			new ResizeObserver(redraw).observe(live);
			redraw();

			const usageReady = shares.mount(shareSource, {
				onUpdate: data => {
					let devUl = 0, devDl = 0;
					if (Array.isArray(data.dayDevices)) {
						dayUsageByMac.clear();
						for (const entry of data.dayDevices) {
							const mac = String(entry?.mac || entry?.key || '').toLowerCase();
							const ul = Math.max(0, Number(entry.upload) || 0);
							const dl = Math.max(0, Number(entry.download) || 0);
							devUl += ul;
							devDl += dl;
							if (mac) dayUsageByMac.set(mac, { upload: ul, download: dl });
						}
						hasDayUsage = true;
					}
					if (Array.isArray(data.allDevices)) {
						allUsageByMac.clear();
						for (const entry of data.allDevices) {
							const mac = String(entry?.mac || entry?.key || '').toLowerCase();
							const ul = Math.max(0, Number(entry.upload) || 0);
							const dl = Math.max(0, Number(entry.download) || 0);
							if (mac) allUsageByMac.set(mac, { upload: ul, download: dl });
						}
						hasAllUsage = true;
					}
					const dayUl = data.period === 'day' ? Math.max(Number(data.upload) || 0, devUl) : devUl;
					const dayDl = data.period === 'day' ? Math.max(Number(data.download) || 0, devDl) : devDl;
					const [totNum, totUnit] = splitFormatted(fmt.fmtBytes(dayUl + dayDl));
					todayNum.textContent = totNum;
					todayUnit.textContent = totUnit;
					todayDlSub.textContent = '↓' + compactBytes(dayDl);
					todayUlSub.textContent = '↑' + compactBytes(dayUl);
					todayStat.title = '下载 ' + fmt.fmtBytes(dayDl) + ' · 上传 ' + fmt.fmtBytes(dayUl);
					syncDeviceUsage();
					if ((devicesModule.sortKey === 'day_dl' || devicesModule.sortKey === 'day_ul' || devicesModule.sortKey === 'all_total') && devicesModule.devs) {
						devicesModule.render(devicesModule.devs);
					}
				}
			});
			await usageReady;
		};
	}
});
