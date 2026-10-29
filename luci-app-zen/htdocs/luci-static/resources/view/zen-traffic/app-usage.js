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
		this.timer = setTimeout(async () => {
			try {
				const reply = await callUsage(mac, date, String(row.time));
				if (request !== this.request) return;
				const data = JSON.parse(reply.json);
				if (data.mac !== mac || data.date !== date || data.hour !== row.time || !Array.isArray(data.applications) ||
					data.applications.length > 2048 || data.applications.some(app => !Number.isInteger(app.id) || app.id < 0 || app.id > 65535 ||
						typeof app.name !== 'string' || app.name.length > 64 || ![app.download, app.upload].every(n => Number.isFinite(n) && n >= 0))) throw Error('response');
				this.draw(data);
			} catch (error) {
				if (request === this.request) this.notice.textContent = _('Unable to load application usage. Please try again.');
			}
		}, 160);
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
		this.notice.textContent = alerts.join(' ');
		const rows = data.applications.filter(app => app.identified === true).map(app => ({ ...app, label: names[app.id] || app.name }));
		const unknown = data.unattributed;
		if (unknown && [unknown.download, unknown.upload].every(n => Number.isFinite(n) && n >= 0) && unknown.download + unknown.upload > 0) {
			rows.push({ label: _('Unclassified'), download: unknown.download, upload: unknown.upload, identified: false });
		}
		rows.sort((a, b) => b.download + b.upload - a.download - a.upload);
		if (!rows.length) { this.body.appendChild(E('p', { class: 'zen-app-muted' }, _('No application records for this hour.'))); return; }
		this.body.appendChild(E('table', { class: 'table zen-app-usage-table' }, [
			E('thead', {}, E('tr', {}, [_('Application'), _('Upload'), _('Download'), _('Total')].map(label => E('th', {}, label)))),
			E('tbody', {}, rows.map(app => E('tr', { class: app.identified ? '' : 'is-unclassified' }, [
				E('td', {}, app.label), E('td', { class: 'zen-tf-ul' }, bytes(app.upload)),
				E('td', { class: 'zen-tf-dl' }, bytes(app.download)), E('td', {}, bytes(app.upload + app.download))
			])))
		]));
	}
});
