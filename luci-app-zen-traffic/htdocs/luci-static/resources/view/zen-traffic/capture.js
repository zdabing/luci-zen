'use strict';
'require view';
'require rpc';
'require fs';
'require poll';
'require ui';
'require view.zen-traffic.style as trafficStyle';

/*
 * view.zen-traffic.capture — 按设备抓包（docs/PACKET_CAPTURE.md）。
 *
 * 模式：
 *   tap     eBPF 抓包 → pcap 下载（Wireshark）+ DNS/SNI 域名画像（默认）
 *   http    透明代理 → 请求事件流 + HAR 导出；可选解密 HTTPS（需设备信任路由器 CA）
 *   tcpdump tcpdump fallback（不出现在 UI，ubus 可选）
 *
 * 会话表 3s 轮询；tap 会话详情为域名列表，http 会话详情为请求事件。
 */

const MAC_RE = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const DURATION_OPTIONS = [60, 300, 600, 1800];
const SIZE_OPTIONS = [4, 8, 16];
const EVENT_LIMIT = 500;

const callStatus = rpc.declare({ object: 'zen.capture', method: 'status' });
const callDevices = rpc.declare({ object: 'zen.traffic', method: 'getDevices' });
const callStart = rpc.declare({
	object: 'zen.capture', method: 'start',
	params: ['mac', 'mode', 'seconds', 'max_bytes', 'decrypt'], reject: true
});
const callStop = rpc.declare({
	object: 'zen.capture', method: 'stop',
	params: ['id'], reject: true
});
const callDelete = rpc.declare({
	object: 'zen.capture', method: 'delete',
	params: ['id'], reject: true
});
const callDomains = rpc.declare({
	object: 'zen.capture', method: 'getDomains',
	params: ['id'], reject: true
});
const callEvents = rpc.declare({
	object: 'zen.capture', method: 'getEvents',
	params: ['id'], reject: true
});
const callCA = rpc.declare({ object: 'zen.capture', method: 'getCA' });
const callHar = rpc.declare({
	object: 'zen.capture', method: 'getHar',
	params: ['id'], reject: true
});

const ERRORS = {
	invalid_mac: _('Invalid MAC address.'),
	tcpdump_missing: _('tcpdump is not installed on the router. Install the tcpdump package and try again.'),
	too_many_sessions: _('Session limit reached. Stop a running capture first.'),
	already_capturing: _('This device is already being captured.'),
	spawn_failed: _('Failed to start tcpdump. Check the system log.'),
	session_running: _('Stop the running capture before deleting it.'),
	not_found: _('Capture session not found.'),
	tap_unavailable: _('The eBPF capture engine is unavailable on this kernel. Try the tcpdump mode.'),
	nft_failed: _('The firewall (nftables) redirect could not be created. Check the system log.'),
	ca_unavailable: _('The capture CA is not available yet. It is created when you start an encrypted capture.'),
	mitm_unavailable: _('HTTPS decryption is not available on this router.')
};

function errText(code) {
	return ERRORS[code] || _('Capture failed: %s').format(code);
}

function fmtBytes(n) {
	n = Math.max(0, Number(n) || 0);
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtClock(ts) {
	return new Date(Number(ts) * 1000).toLocaleString();
}

function fmtDuration(seconds) {
	seconds = Math.max(0, Math.round(seconds));
	if (seconds % 60 !== 0)
		return _('%d s').format(seconds);
	const minutes = seconds / 60;
	return minutes >= 60 ? _('%d h').format(minutes / 60) : _('%d min').format(minutes);
}

function modeLabel(mode) {
	return { tap: _('pcap (Wireshark)'), http: _('HTTP requests'), tcpdump: _('pcap (tcpdump)') }[mode] || mode;
}

function stateLabel(session) {
	if (session.state === 'running')
		return _('Capturing…');
	const reasons = {
		completed: _('Completed'),
		time: _('Stopped: time limit'),
		size: _('Stopped: size limit'),
		stopped: _('Stopped by user'),
		disk: _('Stopped: low disk space'),
		failed: _('Failed (tcpdump exited)'),
		interrupted: _('Interrupted (service restart)')
	};
	return reasons[session.stop_reason] || _('Completed');
}

function eventKindLabel(kind) {
	const labels = {
		http: _('HTTP'),
		https: _('HTTPS'),
		passthrough: _('Passthrough (protected app)'),
		tls_failed: _('Decryption failed')
	};
	return labels[kind] || kind;
}

const CSS_ID = 'zen-traffic-capture-css';
function injectStyles() {
	if (document.getElementById(CSS_ID))
		return;
	const style = document.createElement('style');
	style.id = CSS_ID;
	style.textContent = [
		'#zen-traffic-capture .zen-capture-controls { display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px; }',
		'#zen-traffic-capture .zen-capture-field { display:grid; gap:8px; min-width:0; flex:0 1 280px; margin:0; font-size:13px; line-height:20px; }',
		'#zen-traffic-capture .zen-capture-field select { width:100%; height:44px; min-height:44px; margin:0; }',
		'#zen-traffic-capture .zen-capture-start { height:44px; min-height:44px; }',
		'#zen-traffic-capture .zen-capture-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }',
		'#zen-traffic-capture .zen-capture-files { display:flex; flex-wrap:wrap; gap:8px; }',
		'#zen-traffic-capture .zen-capture-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; line-height:20px; }',
		'#zen-traffic-capture .zen-capture-badge.is-running { background:rgba(234,88,12,.14); color:var(--zt-warn,#ea580c); }',
		'#zen-traffic-capture .zen-capture-badge.is-done { background:rgba(127,127,127,.12); color:var(--zt-muted,inherit); }',
		'#zen-traffic-capture .zen-capture-detail { margin-top:16px; }',
		'#zen-traffic-capture .zen-capture-detail table { width:100%; table-layout:fixed; }',
		'#zen-traffic-capture .zen-capture-detail td, #zen-traffic-capture .zen-capture-detail th { overflow-wrap:anywhere; font-size:12px; }'
	].join('\n');
	document.head.appendChild(style);
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
	status: null,
	devices: [],
	mac: '',
	mode: 'tap',
	decrypt: false,
	seconds: 300,
	maxBytes: 8 * 1024 * 1024,
	detailId: null,
	detail: null,

	load() {
		return Promise.all([
			callStatus().then(r => JSON.parse(r.json)).catch(() => null),
			callDevices().catch(() => ({ dev: [] })).then(r => (r && r.dev) || [])
		]);
	},

	render(data) {
		const status = data[0];
		this.status = status;
		this.devices = data[1] || [];
		const requestedMac = new URLSearchParams(window.location.search).get('mac') || '';
		if (MAC_RE.test(requestedMac))
			this.mac = requestedMac.toLowerCase();

		trafficStyle.inject();
		injectStyles();

		if (!status || !status.ok) {
			this.body = E('div', { 'class': 'cbi-map zen-traffic-page', 'id': 'zen-traffic-capture' }, [
				E('h2', {}, _('Packet Capture')),
				E('div', { 'class': 'cbi-section' }, [
					E('p', { 'class': 'alert-message warning' },
						_('The capture service (zen-capture) is not reachable. Is zen-traffic installed and running?'))
				])
			]);
			return this.body;
		}

		const caps = status.caps || {};
		const durations = DURATION_OPTIONS.filter(s => s <= (caps.max_duration || 600));
		if (!durations.includes(caps.max_duration || 600))
			durations.push(caps.max_duration || 600);
		durations.sort((a, b) => a - b);
		if (!durations.includes(this.seconds))
			this.seconds = durations.includes(300) ? 300 : durations[durations.length - 1];
		const sizes = SIZE_OPTIONS.filter(mb => mb <= (caps.max_file_mb || 8));
		if (!sizes.includes(caps.max_file_mb || 8))
			sizes.push(caps.max_file_mb || 8);
		sizes.sort((a, b) => a - b);
		if (!sizes.includes(this.maxBytes / 1024 / 1024))
			this.maxBytes = (sizes.includes(8) ? 8 : sizes[sizes.length - 1]) * 1024 * 1024;

		const deviceSel = E('select', {
			id: 'zen-capture-device', 'class': 'cbi-input-select',
			'change': L.bind(ev => { this.mac = ev.target.value; }, this)
		}, [
			E('option', { 'value': '' }, _('Select a device…'))
		].concat(this.devices.map(d =>
			E('option', { 'value': d.mac }, d.host || d.ip4 || d.mac))));
		if (this.mac && !this.devices.some(d => String(d.mac).toLowerCase() === this.mac))
			deviceSel.appendChild(E('option', { 'value': this.mac }, this.mac));
		deviceSel.value = this.mac;

		const modeSel = E('select', {
			id: 'zen-capture-mode', 'aria-label': _('Capture mode'),
			'change': L.bind(ev => { this.mode = ev.target.value; this.renderControls(); }, this)
		}, [
			E('option', { 'value': 'tap' }, _('pcap (Wireshark)')),
			E('option', { 'value': 'http' }, _('HTTP requests'))
		]);
		modeSel.value = this.mode;

		const durationSel = E('select', {
			id: 'zen-capture-duration', 'aria-label': _('Duration'),
			'change': L.bind(ev => { this.seconds = Number(ev.target.value); }, this)
		}, durations.map(s => E('option', { 'value': s }, fmtDuration(s))));
		durationSel.value = this.seconds;

		const sizeSel = E('select', {
			id: 'zen-capture-size', 'aria-label': _('Size limit'),
			'change': L.bind(ev => { this.maxBytes = Number(ev.target.value) * 1024 * 1024; }, this)
		}, sizes.map(mb => E('option', { 'value': mb }, _('%d MB').format(mb))));
		sizeSel.value = this.maxBytes / 1024 / 1024;

		const decryptCheck = E('input', {
			id: 'zen-capture-decrypt', type: 'checkbox',
			'change': L.bind(ev => { this.decrypt = ev.target.checked; this.renderControls(); }, this)
		});

		this.controlsHost = E('div', { 'class': 'cbi-section' });
		this.table = E('div', { 'class': 'cbi-section' });
		this.detail = E('div', { 'class': 'zen-capture-detail' });
		this.renderControls({ deviceSel, modeSel, durationSel, sizeSel, decryptCheck });
		this.renderTable();

		poll.add(L.bind(this.refresh, this), 3);

		this.body = E('div', { 'class': 'cbi-map zen-traffic-page', 'id': 'zen-traffic-capture' }, [
			E('h2', {}, _('Packet Capture')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Capture one device into pcap files for Wireshark, list its HTTP requests, or decrypt HTTPS after trusting the router CA on that device. Captures stop automatically at the time or size limit, and files are kept on the router only until deleted or rebooted.')),
			this.controlsHost,
			this.table,
			this.detail
		]);
		return this.body;
	},

	/** 模式相关控件的显隐与解密提示（重渲染保留 select 元素以维持焦点）。 */
	renderControls(nodes) {
		if (!this.controlsHost)
			return;
		nodes = nodes || {
			deviceSel: document.getElementById('zen-capture-device'),
			modeSel: document.getElementById('zen-capture-mode'),
			durationSel: document.getElementById('zen-capture-duration'),
			sizeSel: document.getElementById('zen-capture-size'),
			decryptCheck: document.getElementById('zen-capture-decrypt')
		};
		const http = this.mode === 'http';
		const caReady = !!(this.status && this.status.ca_ready);
		const fields = [
			E('label', { 'class': 'zen-capture-field', 'for': 'zen-capture-device' }, [_('Device'), nodes.deviceSel]),
			E('label', { 'class': 'zen-capture-field', 'for': 'zen-capture-mode' }, [_('Capture mode'), nodes.modeSel]),
			E('label', { 'class': 'zen-capture-field', 'for': 'zen-capture-duration' }, [_('Duration'), nodes.durationSel])
		];
		if (!http)
			fields.push(E('label', { 'class': 'zen-capture-field', 'for': 'zen-capture-size' }, [_('Size limit'), nodes.sizeSel]));
		const actions = [E('button', {
			'class': 'btn cbi-button cbi-button-positive important zen-capture-start',
			'click': ui.createHandlerFn(this, 'handleStart')
		}, _('Start capture'))];
		if (http) {
			const label = E('label', { 'class': 'zen-capture-field', 'for': 'zen-capture-decrypt', 'style': 'flex-direction:row;align-items:center;gap:8px;' }, [nodes.decryptCheck, _('Decrypt HTTPS')]);
			fields.push(label);
			actions.push(E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(this, 'handleDownloadCA')
			}, _('Download CA certificate')));
			if (this.decrypt && !caReady)
				actions.push(E('span', { 'class': 'zen-capture-ca-hint' },
					_('The router creates its CA on the first encrypted capture. Install the downloaded certificate on the device and trust it for HTTPS.')));
		}
		this.controlsHost.replaceChildren(
			E('div', { 'class': 'zen-capture-controls' }, fields.concat(actions))
		);
	},

	renderTable() {
		if (!this.table)
			return;
		const sessions = (this.status && this.status.sessions) || [];
		if (!sessions.length) {
			this.table.replaceChildren(E('p', { 'class': 'zen-capture-empty' }, _('No captures yet.')));
			return;
		}
		this.table.replaceChildren(E('table', { 'class': 'table zen-capture-table' }, [
			E('tr', { 'class': 'tr-table-titles' }, [
				E('th', {}, _('Device')),
				E('th', {}, _('Mode')),
				E('th', {}, _('Started')),
				E('th', {}, _('Duration')),
				E('th', {}, _('Size')),
				E('th', {}, _('State')),
				E('th', {}, _('Details'))
			]),
			...sessions.map(session => E('tr', {}, [
				E('td', {}, this.deviceLabel(session.mac)),
				E('td', {}, modeLabel(session.mode) + (session.decrypt ? ' · ' + _('decrypt') : '')),
				E('td', {}, fmtClock(session.started)),
				E('td', {}, fmtDuration(session.seconds)),
				E('td', {}, fmtBytes(session.bytes)),
				E('td', {}, E('span', {
					'class': 'zen-capture-badge ' + (session.state === 'running' ? 'is-running' : 'is-done')
				}, stateLabel(session))),
				E('td', {}, this.sessionActions(session))
			]))
		]));
	},

	deviceLabel(mac) {
		const found = this.devices.find(d => String(d.mac).toLowerCase() === String(mac).toLowerCase());
		return E('span', {}, (found && (found.host || found.ip4)) || mac);
	},

	sessionActions(session) {
		const actions = [];
		if (session.state === 'running') {
			actions.push(E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(this, 'handleStop', session.id)
			}, _('Stop')));
		}
		else {
			for (const path of session.files || []) {
				const name = String(path).split('/').pop();
				actions.push(E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(this, 'handleDownload', path, name)
				}, _('Download') + ' · ' + name));
			}
			if (session.mode === 'http')
				actions.push(E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(this, 'handleDownloadHar', session.id)
				}, _('Download HAR')));
			actions.push(E('button', {
				'class': 'btn cbi-button cbi-button-remove',
				'click': ui.createHandlerFn(this, 'handleDelete', session.id, session.mac)
			}, _('Delete')));
		}
		const detailLabel = this.detailId === session.id ? _('Hide details') : _('Details');
		actions.push(E('button', {
			'class': 'btn',
			'click': ui.createHandlerFn(this, 'toggleDetail', session.id, session.mode)
		}, detailLabel));
		return E('div', { 'class': 'zen-capture-files' }, actions);
	},

	refresh() {
		return callStatus().then(r => {
			this.status = JSON.parse(r.json);
			this.renderTable();
			if (this.detailId)
				return this.loadDetail(this.detailId, this.detailMode);
		}).catch(() => {});
	},

	toggleDetail(ev, id, mode) {
		if (this.detailId === id) {
			this.detailId = null;
			this.detail.replaceChildren();
			this.renderTable();
			return;
		}
		this.detailId = id;
		this.detailMode = mode;
		this.renderTable();
		return this.loadDetail(id, mode);
	},

	loadDetail(id, mode) {
		const fetch = mode === 'http'
			? callEvents(id).then(r => ({ events: JSON.parse(r.json).events || [] }))
			: callDomains(id).then(r => ({ domains: JSON.parse(r.json).domains || [] }));
		return fetch.then(data => {
			if (this.detailId !== id)
				return;
			this.detailData = data;
			this.renderDetail();
		}).catch(() => {
			if (this.detailId === id) {
				this.detail.replaceChildren(E('p', { 'class': 'alert-message warning' }, _('Unable to load the session details.')));
			}
		});
	},

	renderDetail() {
		if (!this.detail || !this.detailData)
			return;
		if (this.detailData.domains) {
			const domains = this.detailData.domains;
			if (!domains.length) {
				this.detail.replaceChildren(E('h3', {}, _('Domains visited')), E('p', {}, _('No domains captured yet.')));
				return;
			}
			this.detail.replaceChildren(E('h3', {}, _('Domains visited')), E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr-table-titles' }, [
					E('th', {}, _('Domain')), E('th', {}, _('Count')), E('th', {}, _('Last seen'))
				]),
				...domains.map(row => E('tr', {}, [
					E('td', {}, row.domain),
					E('td', {}, String(row.count)),
					E('td', {}, fmtClock(row.last_ts))
				]))
			]));
			return;
		}
		const events = (this.detailData.events || []).slice(-EVENT_LIMIT).reverse();
		if (!events.length) {
			this.detail.replaceChildren(E('h3', {}, _('Request events')), E('p', {}, _('No requests captured yet.')));
			return;
		}
		this.detail.replaceChildren(E('h3', {}, _('Request events')), E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr-table-titles' }, [
				E('th', {}, _('Time')), E('th', {}, _('Kind')), E('th', {}, _('Method')),
				E('th', {}, _('Host')), E('th', {}, _('Path')), E('th', {}, _('Status')),
				E('th', {}, _('↑')), E('th', {}, _('↓'))
			]),
			...events.map(event => E('tr', {}, [
				E('td', {}, fmtClock(event.ts)),
				E('td', {}, eventKindLabel(event.kind)),
				E('td', {}, event.method || '—'),
				E('td', {}, event.host || '—'),
				E('td', {}, event.path || '—'),
				E('td', {}, event.status ? String(event.status) : '—'),
				E('td', {}, fmtBytes(event.req_bytes)),
				E('td', {}, fmtBytes(event.resp_bytes))
			]))
		]));
	},

	notifyError(error, fallback) {
		ui.addNotification(null, E('p', {}, (error && error.message) || fallback), 'error');
	},

	handleStart(ev) {
		if (!MAC_RE.test(this.mac)) {
			ui.addNotification(null, E('p', {}, _('Select a device to capture.')), 'error');
			return;
		}
		const decrypt = this.mode === 'http' && this.decrypt;
		return callStart(this.mac, this.mode, this.seconds, decrypt ? 0 : this.maxBytes, decrypt).then(r => {
			const reply = JSON.parse(r.json);
			if (!reply || !reply.ok) {
				ui.addNotification(null, E('p', {}, errText(reply && reply.error)), 'error');
				return;
			}
			return this.refresh();
		}).catch(e => this.notifyError(e, _('Capture failed: %s').format('start')));
	},

	handleStop(ev, id) {
		return callStop(id).then(r => {
			const reply = JSON.parse(r.json);
			if (!reply || !reply.ok) {
				ui.addNotification(null, E('p', {}, errText(reply && reply.error)), 'error');
				return;
			}
			return this.refresh();
		}).catch(e => this.notifyError(e, _('Capture failed: %s').format('stop')));
	},

	handleDelete(ev, id, mac) {
		if (ui.confirm && !ui.confirm(_('Delete the capture of %s?').format(mac)))
			return;
		return callDelete(id).then(r => {
			const reply = JSON.parse(r.json);
			if (!reply || !reply.ok) {
				ui.addNotification(null, E('p', {}, errText(reply && reply.error)), 'error');
				return;
			}
			if (this.detailId === id) {
				this.detailId = null;
				this.detail.replaceChildren();
			}
			return this.refresh();
		}).catch(e => this.notifyError(e, _('Capture failed: %s').format('delete')));
	},

	handleDownload(ev, path, name) {
		return fs.read(path, 'blob').then(blob => {
			const url = (window.URL || URL).createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = name;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => (window.URL || URL).revokeObjectURL(url), 1000);
		}).catch(() => ui.addNotification(null, E('p', {}, _('Download failed. The capture file is no longer available.')), 'error'));
	},

	handleDownloadHar(ev, id) {
		return callHar(id).then(r => {
			const reply = JSON.parse(r.json);
			if (!reply || !reply.ok) {
				ui.addNotification(null, E('p', {}, errText(reply && reply.error)), 'error');
				return;
			}
			const blob = new window.Blob([reply.har], { type: 'application/json' });
			const url = (window.URL || URL).createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'zen-capture-' + id + '.har';
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => (window.URL || URL).revokeObjectURL(url), 1000);
		}).catch(() => ui.addNotification(null, E('p', {}, _('Download failed. The capture file is no longer available.')), 'error'));
	},

	handleDownloadCA() {
		return callCA().then(r => {
			const reply = JSON.parse(r.json);
			if (!reply || !reply.ok) {
				ui.addNotification(null, E('p', {}, errText(reply && reply.error)), 'error');
				return;
			}
			const blob = new window.Blob([reply.pem], { type: 'application/x-x509-ca-cert' });
			const url = (window.URL || URL).createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'zen-capture-ca.crt';
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => (window.URL || URL).revokeObjectURL(url), 1000);
		}).catch(() => ui.addNotification(null, E('p', {}, errText('ca_unavailable')), 'error'));
	}
});
