'use strict';
'require baseclass';
'require rpc';
'require view.zen-traffic.date-picker as datePicker';
'require view.zen-traffic.app-usage as appUsage';

const callTimeline = rpc.declare({ object: 'zen.traffic', method: 'getDeviceTimeline', params: ['mac', 'date'], reject: true });

function bytes(value) {
	let n = Math.max(0, Number(value) || 0), i = 0;
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

function blockedPackets(row) {
	const count = row.p2p?.dropped;
	return Number.isInteger(count) && count >= 0 ? count : null;
}

function packets(count) {
	return count == null ? '—' : _('%s packets').format(count.toLocaleString());
}

function tickStep(target) {
	const magnitude = 10 ** Math.floor(Math.log10(target));
	return [1, 2, 2.5, 5, 10].find(value => value * magnitude >= target) * magnitude;
}

function svg(tag, attrs, text) {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, String(value)));
	if (text != null) node.textContent = text;
	return node;
}

function state(row) {
	if (row.future) return _('Not started');
	if (!row.available) return _('Not recorded');
	if (row.in_progress) return _('Collecting');
	if (row.partial) return _('Partially recorded');
	if (!row.recorded) return _('No time records');
	return '';
}

return baseclass.extend({
	render(status) {
		this.supported = !!status?.device_timeline;
		// Old daemons provide their current epoch in getStatus.since.
		this.routerNow = Number(status?.now || status?.since) || 0;
		this.loadedAt = Date.now();
		this.mac = ''; this.request = (this.request || 0) + 1;
		this.date = E('input', { type: 'date', value: status?.timeline_today || '', max: status?.timeline_today || '',
			change: () => this.query() });
		this.date.disabled = !this.supported;
		const dateControl = datePicker.create(this.date, { today: status?.timeline_today });
		this.notice = E('p', { class: 'zen-app-muted', role: 'status' });
		this.summary = E('div', { class: 'zen-rt-summary' });
		this.body = E('div');
		this.apps = Object.create(appUsage);
		this.appUsage = this.apps.render(status);
		this.container = E('section', { id: 'device-hourly', class: 'cbi-section zen-device-timeline', tabindex: '-1' }, [
			E('h3', {}, _('Hourly device internet usage')),
			E('div', { class: 'zen-timeline-controls' }, [
				E('label', { class: 'zen-history-field' }, [_('Date'), dateControl])
			]),
			E('p', { class: 'zen-app-muted' }, _('Router local time · hourly usage retained for 30 days.')),
			this.notice, this.summary, this.body, this.appUsage
		]);
		this.select('');
		return this.container;
	},

	select(mac) {
		this.mac = mac || '';
		return this.query();
	},

	async query() {
		const request = this.request = (this.request || 0) + 1;
		this.apps.clear();
		this.selectedAppHour = null;
		this.body.replaceChildren(); this.summary.replaceChildren();
		if (!this.supported) { this.notice.textContent = _('Update the traffic service to enable device time history.'); return; }
		if (!this.mac) { this.notice.textContent = _('Choose a device above to see when it used traffic.'); return; }
		if (!datePicker.selectable(this.date.value, this.date.min, this.date.max)) { this.notice.textContent = _('Choose a valid date.'); return; }
		this.notice.textContent = _('Loading history…');
		try {
			const reply = await callTimeline(this.mac, this.date.value);
			if (request !== this.request) return;
			const data = JSON.parse(reply.json);
			if (data.step !== 3600 || !Array.isArray(data.samples) || data.samples.length > 25 ||
				!Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end) ||
				data.end - data.start < 23 * 3600 || data.end - data.start > 25 * 3600 ||
				data.samples.some(row => !Number.isSafeInteger(row.time) || row.time < data.start || row.time >= data.end ||
					(row.time - data.start) % 3600 !== 0 || !Number.isFinite(row.download) || row.download < 0 ||
					!Number.isFinite(row.upload) || row.upload < 0)) throw Error('response');
			this.draw(data);
		} catch (error) {
			if (request === this.request) this.notice.textContent = _('Unable to load device time history. Please try again.');
		}
	},

	draw(data) {
		if (data.expired || !data.samples.length) {
			this.notice.textContent = data.expired ? _('Time detail is no longer available for this period. Daily totals are kept separately.') :
				_('No device time records for this period. Older totals cannot be reconstructed.');
			return;
		}
		this.notice.textContent = '';
		if (data.available_from > data.start) this.notice.textContent += ' ' + _('This period is only partially recorded.');
		// Also fill sparse hourly responses from previous daemons, without detail RPCs.
		const byTime = new Map(data.samples.map(row => [row.time, row]));
		const now = data.now ?? (this.routerNow ? this.routerNow + (Date.now() - this.loadedAt) / 1000 : data.end);
		const rows = [];
		for (let time = data.start; time < data.end; time += 3600) {
			const sample = byTime.get(time), index = (time - data.start) / 3600;
			const label = String(index).padStart(2, '0') + ':00–' + String(index + 1).padStart(2, '0') + ':00';
			rows.push({ time, label, download: 0, upload: 0, recorded: !!sample,
				available: time + 3600 > (data.available_from || 0) && time <= now,
				partial: time < data.available_from && time + 3600 > data.available_from,
				in_progress: time <= now && now < time + 3600, future: time > now, ...sample });
		}
		const p2pHistory = data.p2p_history === true;
		const total = { download: 0, upload: 0, blocked: null };
		let peakBlocked = 0;
		for (const row of rows) {
			total.download += row.download;
			total.upload += row.upload;
			const count = blockedPackets(row);
			if (count != null) {
				total.blocked = (total.blocked ?? 0) + count;
				peakBlocked = Math.max(peakBlocked, count);
			}
		}
		const hasBytes = rows.some(row => row.available);
		const trafficAmount = value => hasBytes ? bytes(value) : '—';
		const metrics = [[_('Recorded upload'), trafficAmount(total.upload), 'zen-tf-ul'],
			[_('Recorded download'), trafficAmount(total.download), 'zen-tf-dl'], [_('Recorded total'), trafficAmount(total.download + total.upload), '']];
		if (p2pHistory) metrics.push([_('P2P blocked'), packets(total.blocked), 'zen-timeline-blocked']);
		this.summary.classList?.toggle('has-p2p', p2pHistory);
		this.summary.replaceChildren(...metrics.map(([label, value, cls]) => E('div', {}, [E('span', {}, label), E('strong', { class: cls }, value)])));

		const showPacketAxis = p2pHistory && peakBlocked > 0;
		const packetStep = showPacketAxis ? Math.ceil(tickStep(peakBlocked / 4)) : 0;
		const packetFormat = new Intl.NumberFormat(undefined, {
			notation: packetStep * 4 >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1
		});
		const packetTicks = showPacketAxis ? [0, 1, 2, 3, 4].map(i => packetFormat.format(i * packetStep)) : [];
		const right = showPacketAxis ? Math.max(46, 12 + Math.max(...packetTicks.map(label => label.length)) * 8) : 10;
		const W = Math.max(280, this.body.clientWidth || Math.min(700, window.innerWidth - 70)), H = 230;
		const left = 54, top = showPacketAxis ? 26 : 16, bottom = 30;
		const plotH = H - top - bottom, slot = (W - left - right) / rows.length;
		const peak = Math.max(0, ...rows.map(row => row.download + row.upload));
		const unit = 1024 ** Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(1, peak)) / Math.log(1024))));
		const limit = tickStep(Math.max(unit, peak) / unit / 4) * unit * 4;
		const height = value => value / limit * plotH;
		const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'zen-timeline-chart',
			'aria-label': _('Hourly device internet usage'), role: 'group', preserveAspectRatio: 'none' });
		for (let i = 0; i <= 4; i++) {
			const y = H - bottom - i * plotH / 4;
			chart.appendChild(svg('line', { x1: left, x2: W - right, y1: y, y2: y, class: 'zen-tf-grid' }));
			chart.appendChild(svg('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'zen-tf-ax' }, bytes(limit * i / 4)));
			if (showPacketAxis) chart.appendChild(svg('text', { x: W - 4, y: y + 4,
				'text-anchor': 'end', class: 'zen-tf-ax zen-timeline-packet-tick' }, packetTicks[i]));
		}
		if (showPacketAxis) chart.appendChild(svg('text', { x: W - 4, y: 12,
			'text-anchor': 'end', class: 'zen-tf-ax zen-timeline-packet-tick' }, _('Packets')));
		const readout = E('div', { class: 'zen-timeline-readout', 'aria-live': 'polite', 'aria-atomic': 'true' });
		const tip = E('div', { class: 'zen-history-tip zen-timeline-tip', role: 'tooltip', hidden: true });
		const scroll = E('div', { class: 'zen-timeline-scroll' }, chart);
		const frame = E('div', { class: 'zen-timeline-frame' }, [scroll, tip]);
		const groups = [];
		const hourLabel = row => row.label.split('–')[0];
		const repeated = new Set(rows.filter((row, index) => rows.some((other, j) => j !== index && hourLabel(other) === hourLabel(row))).map(hourLabel));
		const describe = row => {
			const parts = [row.label + (row.utc_offset && repeated.has(hourLabel(row)) ? ' (UTC' + row.utc_offset + ')' : '')];
			const status = state(row), blocked = blockedPackets(row);
			if (status && (row.available || blocked == null)) parts.push(status);
			if (row.available) parts.push(_('Total') + ' ' + bytes(row.download + row.upload),
				_('Download') + ' ' + bytes(row.download), _('Upload') + ' ' + bytes(row.upload));
			if (p2pHistory && !row.future) parts.push(_('P2P blocked') + ' ' + packets(blocked));
			return parts.join(' · ');
		};
		const positionTip = ev => {
			const box = frame.getBoundingClientRect(), anchor = (ev?.currentTarget || chart).getBoundingClientRect();
			const x = (Number.isFinite(ev?.clientX) ? ev.clientX : anchor.left + anchor.width / 2) - box.left;
			const y = (Number.isFinite(ev?.clientY) ? ev.clientY : anchor.top + anchor.height / 2) - box.top;
			tip.style.left = Math.max(8, Math.min(x + 12, frame.clientWidth - tip.offsetWidth - 8)) + 'px';
			tip.style.top = Math.max(8, Math.min(y - tip.offsetHeight - 12, frame.clientHeight - tip.offsetHeight - 8)) + 'px';
		};
		const select = (index, ev, showTip = true, refreshApps = false) => {
			this.chosenHour = rows[index].time; this.chosenMac = this.mac; this.chosenDate = this.date.value;
			groups.forEach((group, i) => group.setAttribute('aria-pressed', String(i === index)));
			readout.textContent = describe(rows[index]); tip.textContent = readout.textContent;
			tip.hidden = !showTip;
			if (showTip) positionTip(ev);
			if (refreshApps || this.selectedAppHour !== rows[index].time || this.selectedAppMac !== this.mac || this.selectedAppDate !== this.date.value) {
				this.selectedAppHour = rows[index].time; this.selectedAppMac = this.mac; this.selectedAppDate = this.date.value;
				this.apps.select(this.mac, this.date.value, rows[index]);
			}
		};
		const width = slot * (showPacketAxis ? .34 : .62);
		const gap = slot * .12;
		const barsWidth = showPacketAxis ? width * 2 + gap : width;
		rows.forEach((row, index) => {
			const x = left + index * slot, barX = x + (slot - barsWidth) / 2;
			const dl = height(row.download), ul = height(row.upload), blocked = blockedPackets(row);
			const group = svg('g', { class: 'zen-timeline-slot' + (row.in_progress ? ' is-current' : '') + (!row.available ? ' is-unavailable' : ''),
				role: 'button', tabindex: '0', 'aria-pressed': 'false', 'aria-label': describe(row) });
			group.appendChild(svg('rect', { x: x + 1, y: top, width: slot - 2, height: plotH, rx: 4, class: 'zen-timeline-hit' }));
			group.appendChild(svg('rect', { x: barX, y: H - bottom - dl, width, height: dl, class: 'zen-tf-bar-dl' }));
			group.appendChild(svg('rect', { x: barX, y: H - bottom - dl - ul, width, height: ul, class: 'zen-tf-bar-ul' }));
			if (showPacketAxis && blocked > 0) {
				const packetHeight = blocked / (4 * packetStep) * plotH;
				group.appendChild(svg('rect', { x: barX + width + gap, y: H - bottom - packetHeight,
					width, height: packetHeight, rx: 2, class: 'zen-timeline-block-bar', 'aria-hidden': 'true' }));
			}
			group.appendChild(svg('title', {}, describe(row)));
			for (const event of ['pointermove', 'focus']) group.addEventListener(event, ev => select(index, ev, false));
			group.addEventListener('click', ev => select(index, ev, false, true));
			group.addEventListener('keydown', ev => {
				if (['Enter', ' '].includes(ev.key)) { ev.preventDefault(); select(index, ev, false, true); }
				if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
					ev.preventDefault();
					const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (ev.key === 'ArrowLeft' ? -1 : 1)));
					groups[next].focus();
				}
				if (ev.key === 'Escape') tip.hidden = true;
			});
			groups.push(group); chart.appendChild(group);
			if(index%4===0||index===rows.length-1)chart.appendChild(svg('text', { x: x + slot / 2, y: H - bottom + 22, 'text-anchor': 'middle', class: 'zen-tf-ax' }, row.label.split('–')[0]));
		});
		chart.addEventListener('pointerleave', () => { tip.hidden = true; });
		chart.addEventListener('focusout', ev => { if (!chart.contains(ev.relatedTarget)) tip.hidden = true; });
		const legend = E('div', { class: 'zen-tf-legend' }, [
			E('span', { class: 'zen-tf-ul' }, _('Upload')), E('span', { class: 'zen-tf-dl' }, _('Download')),
			...(showPacketAxis ? [E('span', { class: 'zen-timeline-block-legend' }, _('P2P blocked'))] : [])
		]);
		this.body.replaceChildren(frame, legend, E('p', { class: 'zen-app-muted zen-timeline-scroll-hint' }, _('Swipe horizontally to view all hours.')), readout);
		const saved = this.chosenMac === this.mac && this.chosenDate === this.date.value ? rows.findIndex(row => row.time === this.chosenHour) : -1;
		const initial = saved >= 0 ? saved : rows.findIndex(row => row.in_progress && (row.upload + row.download > 0 || blockedPackets(row) > 0));
		const busiest = rows.reduce((best, row, index) => {
			const difference = row.download + row.upload - (rows[best].download + rows[best].upload);
			return difference > 0 || (difference === 0 && (blockedPackets(row) ?? 0) > (blockedPackets(rows[best]) ?? 0)) ? index : best;
		}, 0);
		select(initial >= 0 ? initial : busiest, null, false);
	}
});
