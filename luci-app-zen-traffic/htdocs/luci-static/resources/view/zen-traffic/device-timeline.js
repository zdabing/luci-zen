'use strict';
'require baseclass';
'require rpc';

const callTimeline = rpc.declare({ object: 'zen.traffic', method: 'getDeviceTimeline', params: ['mac', 'date', 'hour'], reject: true });

function bytes(value) {
	let n = Math.max(0, Number(value) || 0), i = 0;
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

return baseclass.extend({
	render(status) {
		this.supported = !!status?.device_timeline;
		this.mac = ''; this.hour = ''; this.request = (this.request || 0) + 1;
		this.date = E('input', { type: 'date', value: status?.timeline_today || '', max: status?.timeline_today || '',
			change: () => this.query('') });
		this.date.disabled = !this.supported;
		this.back = E('button', { type: 'button', class: 'cbi-button', hidden: true, click: () => this.query('') }, _('Back to hours'));
		this.notice = E('p', { class: 'zen-app-muted', role: 'status' });
		this.summary = E('div', { class: 'zen-rt-summary' });
		this.body = E('div');
		this.container = E('section', { class: 'cbi-section zen-device-timeline' }, [
			E('h3', {}, _('Device internet usage by time')),
			E('div', { class: 'zen-timeline-controls' }, [
				E('label', { class: 'zen-history-field' }, [_('Date'), this.date]), this.back
			]),
			E('p', { class: 'zen-app-muted' }, _('Router local time · 5-minute detail for 7 days, hourly usage for 90 days.')),
			this.notice, this.summary, this.body
		]);
		this.select('');
		return this.container;
	},

	select(mac) {
		this.mac = mac || '';
		return this.query('');
	},

	async query(hour = '') {
		const request = this.request = (this.request || 0) + 1;
		this.hour = String(hour); this.back.hidden = this.hour === '';
		this.body.replaceChildren(); this.summary.replaceChildren();
		if (!this.supported) { this.notice.textContent = _('Update the traffic service to enable device time history.'); return; }
		if (!this.mac) { this.notice.textContent = _('Choose a device above to see when it used traffic.'); return; }
		if (!/^\d{4}-\d{2}-\d{2}$/.test(this.date.value)) { this.notice.textContent = _('Choose a valid date.'); return; }
		this.notice.textContent = _('Loading history…');
		try {
			const reply = await callTimeline(this.mac, this.date.value, this.hour);
			if (request !== this.request) return;
			const data = JSON.parse(reply.json);
			if (![300, 3600].includes(data.step) || !Array.isArray(data.samples) || data.samples.length > 400) throw Error('response');
			this.draw(data);
		} catch (error) {
			if (request === this.request) this.notice.textContent = _('Unable to load device time history. Please try again.');
		}
	},

	draw(data) {
		const rows = data.samples;
		this.notice.textContent = rows.length ? (data.step === 3600 ? _('Select an hour to see its 5-minute detail.') : _('Recorded 5-minute usage.')) :
			(data.expired ? _('Time detail is no longer available for this period. Daily totals are kept separately.') : _('No device time records for this period. Older totals cannot be reconstructed.'));
		if (!rows.length) return;
		if (data.available_from > data.start) this.notice.textContent += ' ' + _('This period is only partially recorded.');
		const total = rows.reduce((sum, row) => ({ download: sum.download + (Number(row.download) || 0), upload: sum.upload + (Number(row.upload) || 0) }), { download: 0, upload: 0 });
		this.summary.replaceChildren(...[[ _('Recorded download'), total.download, 'zen-tf-dl'], [ _('Recorded upload'), total.upload, 'zen-tf-ul']]
			.map(([label, value, cls]) => E('div', {}, [E('span', {}, label), E('strong', { class: cls }, bytes(value))])));
		const max = Math.max(1, ...rows.map(row => (Number(row.download) || 0) + (Number(row.upload) || 0)));
		const table = E('table', { class: 'table zen-timeline-table' }, [
			E('thead', {}, E('tr', {}, [_('Time period'), _('Download'), _('Upload')].map(label => E('th', { scope: 'col' }, label)))),
			E('tbody', {}, rows.map(row => {
				const time = E('span', { title: row.utc_offset ? 'UTC' + row.utc_offset : '' }, row.label);
				const cell = E('td', {}, [data.step === 3600 ? E('button', { type: 'button', class: 'zen-timeline-hour', click: () => this.query(String(row.time)) }, time) : time,
					E('span', { class: 'zen-timeline-bar', 'aria-hidden': 'true', style: 'width:' + Math.max(1, ((row.download || 0) + (row.upload || 0)) / max * 100) + '%' })]);
				return E('tr', {}, [cell, E('td', { class: 'zen-tf-dl' }, bytes(row.download)), E('td', { class: 'zen-tf-ul' }, bytes(row.upload))]);
			}))
		]);
		this.body.replaceChildren(table);
	}
});
