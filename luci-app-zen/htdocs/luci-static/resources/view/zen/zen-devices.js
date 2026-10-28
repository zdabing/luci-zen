'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen.zen-format as fmt';
'require view.zen.zen-icons as icons';
'require view.zen.zen-identity as identity';
'require view.zen.zen-device-panel as panel';
'require view.zen.zen-device-controls as controls';
'require view.zen.zen-select as picker';
'require view.zen.zen-connection-info as connectionInfo';

/*
 * view.zen.zen-devices — 首页“设备流量”模块。
 *
 * 数据源：ubus 对象 zen.traffic（zen-traffic 守护进程发布，LuCI ACL 见
 * luci-theme-zen.json / zen-traffic.json）。**主题不硬依赖该组件**：
 * probe() 失败时模块降级为提示卡片，其余仪表盘功能不受影响。
 *
 * MAC 缓存行、textContent-only 更新、Top-N 折叠/展开；
 * 列表仅互联网速率，抽屉分列互联网/局域网速率；历史用量与重置集中到分析页。
 * 2s 轮询、document.hidden 节流；历史详情跳转 luci-app-zen-traffic。
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
const callConnections = rpc.declare({object:'zen.device',method:'getConnections',reject:true});

// Missing scoped counters must never fall back to the legacy WAN + LAN fields.
function scopedRate(d, key) {
	const value = d[key];
	return value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function rateText(d, key) {
	const value = scopedRate(d, key);
	return value == null ? fmt.MISSING : fmt.fmtRate(value);
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
	return connectionInfo.connection(d);
}

function detailFacts(d) {
	return [[_('Connection'), connText(d)],
		...(d.online && connectionInfo.duration(d.connected_seconds) ? [[_('Connected for'), connectionInfo.duration(d.connected_seconds)]] : []),
		...(connectionInfo.linkRate(d) ? [[d.conn === 'wifi' ? _('Wi-Fi link rate') : _('Port link rate'), connectionInfo.linkRate(d)]] : []),
		['IPv4', d.ip4 || '—'], ['IPv6', d.ip6 || '—'], [_('MAC'), d.mac],
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
	const connStatus = E('span', {'class':'zen-dash-dev-session'}, '');
	const conn = E('span', { 'class': 'zen-dash-dev-conn' }, [connLabel,connStatus]);
	const rate = (direction, label) => E('span', { 'class': 'zen-dash-dev-rate ' + direction, 'aria-label': label }, [
		E('span', { 'class': 'zen-dash-dev-rate-value' }, '')
	]);
	const dl = rate('dl', _('Internet download'));
	const ul = rate('ul', _('Internet upload'));
	dl.classList.add('zen-dash-dev-download');
	ul.classList.add('zen-dash-dev-upload');
	const last = E('span', { 'class': 'zen-dash-dev-last', 'data-label': _('Last activity') }, '');
	const chev = E('span', { 'class': 'zen-dash-dev-chev' }, [icons.icon('zen-i-chev', 16)]);

	li.appendChild(iconBox);
	li.appendChild(id);
	li.appendChild(ip);
	li.appendChild(mac);
	li.appendChild(conn);
	li.appendChild(ul);
	li.appendChild(dl);
	li.appendChild(last);
	li.appendChild(chev);

	const ent = {
		li, iconBox, ov, ip, mac, last, conn: connLabel, connStatus, connBox: conn,
		dl: dl.lastChild, ul: ul.lastChild,
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

	return ent;
}

return baseclass.extend({
	/* 'ok' | 'missing'（权限/异常也归并为 missing，降级语义一致） */
	async probe() {
		return probeState();
	},

	/* 探测一次并返回挂载用的 section（missing 时为提示卡片） */
	async mount(dash) {
		controls.install(this);
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
		this.sortKey = 'wan_rx_r';
		this.sortDescending = true;
		this.sortButtons = [];
		this.query = '';
		this.connection = 'all';
		const search = E('input', { type: 'search', 'class': 'zen-device-search', placeholder: _('Search name, IP or MAC'), 'aria-label': _('Search devices'), input: ev => {
			this.query = ev.target.value.trim().toLocaleLowerCase(); this.applyVisibility();
		} });
		const filter = E('select', { 'aria-label': _('Connection filter'), change: ev => { this.connection = ev.target.value; this.applyVisibility(); } },
			[['all', _('All connections')], ['wifi', _('Wi-Fi')], ['wired', _('Wired')], ['offline', _('Offline')]].map(([value, label]) => E('option', { value }, [label])));
		this.empty = E('p', { 'class': 'zen-device-empty', hidden: true }, [_('No matching devices. Try another search or connection filter.')]);
		section.appendChild(E('div', { 'class': 'zen-device-toolbar' }, [search, filter]));
		picker.enhance(filter);
		const sortColumn = (key, label) => {
			const active = this.sortKey === key;
			const arrow = E('span', { 'class': 'zen-sort-arrow', 'aria-hidden': 'true' }, active ? '↓' : '↕');
			const button = E('button', { type: 'button', 'class': 'zen-dash-dev-sort', 'aria-pressed': String(active), title: active ? _('Sort ascending') : _('Sort descending') }, [label, arrow]);
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
			sortColumn('wan_tx_r', _('Internet upload')),
			sortColumn('wan_rx_r', _('Internet download')),
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

		this.refreshConnections();
		return callDevices().then(L.bind((data) => {
			const devs = (data && Array.isArray(data.dev)) ? data.dev : [];
			this.render(devs);
		}, this)).catch(() => {
			/* daemon 退出等瞬态错误：保留上次渲染，下一轮重试 */
		});
	},
	refreshConnections() {
		if (this.connectionsPending || Date.now()-(this.connectionsRequested||0)<15000) return;
		this.connectionsRequested=Date.now();this.connectionsPending=true;
		callConnections().then(data=>{
			if(data?.ok!==true||!data.devices||typeof data.devices!=='object')throw Error('unavailable');
			this.connectionMetadata=data.devices;this.connectionsReceived=Date.now();
			if(this.section?.isConnected&&this.devs)this.render(this.devs);
		}).catch(()=>{}).finally(()=>{this.connectionsPending=false;});
	},
	enhanceSelect(select) { return picker.enhance(select); },

	render(devs) {
		const keep = new Set();
		this.devs = devs.slice();
		devs = this.devs.slice();

		/* Internet rates only; unavailable counters stay last in either direction. */
		const sortKey = this.sortKey || 'wan_rx_r';
		devs.sort((a, b) => {
			const av = scopedRate(a, sortKey), bv = scopedRate(b, sortKey);
			return (av == null) - (bv == null) || ((av || 0) - (bv || 0)) * (this.sortDescending ? -1 : 1) ||
				String(a.mac || '').localeCompare(String(b.mac || ''));
		});

		devs=devs.map(d=>connectionInfo.merge(d,this.connectionMetadata?.[d.mac],this.connectionsReceived));
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
			setText(ent.connStatus, connectionInfo.status(d));
			ent.li.classList.toggle('is-offline',!d.online);
			const connIcon = { wifi: 'zen-i-wifi', wired: 'zen-i-eth', router: 'zen-i-router' }[d.conn];
			if (ent.connIconType !== connIcon) {
				if (ent.connGlyph)
					ent.connGlyph.remove();
				ent.connGlyph = connIcon ? icons.icon(connIcon, 14) : null;
				if (ent.connGlyph)
					ent.connBox.insertBefore(ent.connGlyph, ent.conn);
				ent.connIconType = connIcon;
			}
			setText(ent.dl, rateText(d, 'wan_rx_r'));
			setText(ent.ul, rateText(d, 'wan_tx_r'));
			setText(ent.last, d.last > 0 ? new Date(d.last * 1000).toLocaleString() : fmt.MISSING);

			if (this.activeDetail === ent && this.detailRates) {
				for (const el of this.detailRates.querySelectorAll('[data-rate]'))
					setText(el, rateText(d, el.dataset.rate));
				const facts=detailFacts(d),container=this.detailDialog.querySelector('.zen-device-facts');
				if(this.detailFacts.length!==facts.length||Array.from(container.querySelectorAll('dt')).some((node,i)=>node.textContent!==facts[i]?.[0])){container.replaceChildren(...facts.map(([key,value])=>E('div',{},[E('dt',{},key),E('dd',{},value)])));this.detailFacts=container.querySelectorAll('dd');}
				else facts.forEach((pair, i) => setText(this.detailFacts[i], pair[1]));
				setText(this.detailDialog.querySelector('h2'), devName(d));
			}
		});

		/* 消失的设备（含休眠）移除 */
		for (const [mac, ent] of this.cache) {
			if (!keep.has(mac)) {
				if (this.activeDetail === ent) panel.close();
				ent.li.remove();
				this.cache.delete(mac);
			}
		}

		this.applyVisibility();
		setText(this.count,devs.length?_('%d online · %d offline').format(devs.filter(d=>d.online).length,devs.filter(d=>!d.online).length):_('No devices yet'));
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
	},

	matches(d) {
		if (!d) return false;
		const query = this.query || '';
		return (!query || [d.host, d.mac, d.ip4, d.ip6].some(v => String(v || '').toLocaleLowerCase().includes(query))) &&
			(!this.connection || this.connection === 'all' || (this.connection === 'offline' ? !d.online : d.conn === this.connection));
	},

	openDetail(ent) {
		if (this.activeDetail === ent) return;
		panel.close();
		this.activeDetail = ent;
		ent.li.classList.add('open');
		ent.li.setAttribute('aria-expanded', 'true');
		const d = ent.d;
		const historyUrl = L.url('admin','zen','analysis');
		const facts = E('dl', { 'class': 'zen-device-facts' }, detailFacts(d).map(([key, value]) => E('div', {}, [E('dt', {}, [key]), E('dd', {}, [value])])));
		this.detailFacts = facts.querySelectorAll('dd');
		const rates = E('div', { 'class': 'zen-device-live' }, [
			['wan_tx_r', _('Internet upload'), 'ul'], ['wan_rx_r', _('Internet download'), 'dl'],
			['lan_tx_r', _('LAN upload'), 'ul'], ['lan_rx_r', _('LAN download'), 'dl']
		].map(([key, label, direction]) => E('div', {}, [E('span', {}, label),
			E('strong', { 'class': direction, 'data-rate': key }, rateText(d, key))])));
		this.detailRates = rates;
		this.detailDialog = panel.open({ title: devName(d), subtitle: d.mac, content: [rates, facts], actions: [
			E('button', { type: 'button', 'class': 'cbi-button', click: () => { panel.close(); identity.edit(ent.d, () => this.render(this.devs || [])); } }, [_('Device identity')]),
			E('a', { 'class': 'cbi-button cbi-button-action', href: historyUrl + (historyUrl.includes('?') ? '&' : '?') + 'mac=' + encodeURIComponent(d.mac) + '#device-hourly' }, [_('History analysis')])
		], onClose: () => {
			ent.li.classList.remove('open'); ent.li.setAttribute('aria-expanded', 'false');
			if (this.activeDetail === ent) this.activeDetail = null;
		} });
	}
});
