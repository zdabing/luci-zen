'use strict';
'require baseclass';
'require rpc';

const callUsage = rpc.declare({ object: 'zen.traffic', method: 'getAppUsage', params: ['mac', 'date', 'hour'], reject: true });
const names = { 54: '爱奇艺', 120: 'X / Twitter', 197: '微信', 285: '腾讯', 324: '腾讯视频', 395: '腾讯游戏' };

function bytes(value) {
	let n = Math.max(0, Number(value) || 0), i = 0;
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

return baseclass.extend({
	render(status) {
		this.supported = !!status?.app_usage;
		this.request = 0;
		this.title = E('h4', {}, _('Application usage'));
		this.notice = E('p', { class: 'zen-app-muted', role: 'status' });
		this.body = E('div', { class: 'zen-app-usage-body' });
		this.container = E('div', { class: 'zen-app-usage' }, [this.title, this.notice, this.body]);
		return this.container;
	},

	clear() {
		clearTimeout(this.timer); this.request++;
		this.body?.replaceChildren();
		if (this.container) this.container.hidden = true;
		if (this.notice) this.notice.textContent = '';
	},

	select(mac, date, row) {
		this.clear();
		this.container.hidden = false;
		this.title.textContent = _('Application usage') + (row?.label ? ' · ' + row.label : '');
		if (!this.supported) { this.notice.textContent = _('Update the traffic service to enable application usage.'); return; }
		if (!mac || !row?.available || row.future) { this.notice.textContent = _('No application records for this hour.'); return; }
		this.notice.textContent = _('Loading application usage…');
		const request = this.request;
		const load = async () => {
			if (request !== this.request || !this.container.isConnected) return;
			try {
				const reply = await callUsage(mac, date, String(row.time));
				if (request !== this.request || !this.container.isConnected) return;
				const data = JSON.parse(reply.json);
				if (data.mac !== mac || data.date !== date || data.hour !== row.time || !Array.isArray(data.applications) ||
					data.applications.length > 2048 || data.applications.some(app => !Number.isInteger(app.id) || app.id < 0 || app.id > 65535 ||
						typeof app.name !== 'string' || app.name.length > 64 || ![app.download, app.upload].every(n => Number.isFinite(n) && n >= 0))) throw Error('response');
				this.draw(data);
				if (data.in_progress || (data.breakdown?.pending?.download || 0) + (data.breakdown?.pending?.upload || 0) > 0) {
					this.timer = setTimeout(load, 5000);
				}
			} catch (error) {
				if (request === this.request) this.notice.textContent = _('Unable to load application usage. Please try again.');
			}
		};
		this.timer = setTimeout(load, 160);
	},

	draw(data) {
		this.body.replaceChildren();
		if (!data.available) {
			this.notice.textContent = data.recognition?.failed ? _('Application recognition is currently unavailable.') : _('No application records for this hour.'); return;
		}
		const alerts = [];
		if (data.accounting_mismatch) alerts.push(_('Application and device counters have a sampling difference.'));
		if (data.partial) alerts.push(_('This hour is only partially recorded.'));
		if (data.hardware_offload) alerts.push(_('Hardware offload may bypass application recognition.'));
		if (!data.recognition?.active) alerts.push(_('Application recognition is currently unavailable.'));
		if (data.recognition?.queue_dropped) alerts.push(_('Some connections could not be classified.'));
		if (data.recognition?.worker_limited) alerts.push(_('Recognition capacity was reached.'));
		this.notice.textContent = alerts.join(' ');
		const validBytes = value => value && [value.download, value.upload].every(n => Number.isFinite(n) && n >= 0);
		let rows;
		if (data.breakdown) {
			for (const key of ['applications', 'protocols', 'unknown', 'pending', 'difference', 'excess']) {
				if (!validBytes(data.breakdown[key])) throw Error('breakdown');
			}
			const applications = data.applications.filter(app => app.kind === 'application').map(app => ({ ...app, label: names[app.id] || app.name }));
			const protocols = data.applications.filter(app => app.kind === 'protocol').map(app => ({ ...app, label: app.name }));
			const sort = list => list.sort((a, b) => b.download + b.upload - a.download - a.upload);
			rows = sort(applications);
			if (protocols.length) rows.push({ section: _('Protocol only') }, ...sort(protocols));
			const states = [];
			for (const [key, label] of [['unknown', _('Unidentified connections')], ['pending', _('Recognition in progress')], ['difference', _('Unattributed difference')]]) {
				const value = data.breakdown[key];
				if (value.download + value.upload > 0) states.push({ ...value, label, identified: false });
			}
			if (states.length) rows.push({ section: _('Recognition status and differences') }, ...states);
		} else {
			// Older backends do not expose enough information to split the gap.
			rows = data.applications.filter(app => app.identified === true).map(app => ({ ...app, label: names[app.id] || app.name }));
			const unknown = data.unattributed;
			if (validBytes(unknown) && unknown.download + unknown.upload > 0) rows.push({ ...unknown, label: _('Unclassified'), identified: false });
			rows.sort((a, b) => b.download + b.upload - a.download - a.upload);
		}
		if (!rows.length) { this.body.appendChild(E('p', { class: 'zen-app-muted' }, _('No application records for this hour.'))); return; }
		this.body.appendChild(E('table', { class: 'table zen-app-usage-table' }, [
			E('thead', {}, E('tr', {}, [_('Application / service'), _('Upload'), _('Download'), _('Total')].map(label => E('th', {}, label)))),
			E('tbody', {}, rows.map(app => app.section ? E('tr', { class: 'zen-app-section' }, E('th', { colspan: 4, scope: 'rowgroup' }, app.section)) : E('tr', { class: app.identified ? '' : 'is-unclassified' }, [
				E('td', {}, app.label), E('td', { class: 'zen-tf-ul' }, bytes(app.upload)),
				E('td', { class: 'zen-tf-dl' }, bytes(app.download)), E('td', {}, bytes(app.upload + app.download))
			])))
		]));
	}
});
