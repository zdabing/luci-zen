'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen.zen-format as fmt';

const callUsage = rpc.declare({ object: 'zen.traffic', method: 'getWanUsage' });
const COLORS = ['#3275db', '#b269cd', '#d7802f', '#349b8b', '#d76785', '#899344', '#6a80ca', '#a66f46'];
const C = 2 * Math.PI * 54;
const number = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);

function color(key) {
	let hash = 0;
	for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
	return COLORS[hash % COLORS.length];
}

function breakdown(data, direction, all) {
	const rows = (data.dev || []).map(d => ({ key: d.mac, label: d.host || d.mac,
		bytes: number(d[direction]), color: color(d.mac) })).filter(d => d.bytes > 0);
	rows.sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
	const attributed = rows.reduce((sum, d) => sum + d.bytes, 0);
	const observed = number(data['interface_' + direction]);
	const unassigned = Math.max(0, observed - attributed);
	const total = attributed + unassigned;
	let slices = rows;
	if (!all && rows.length > 6) {
		slices = rows.slice(0, 6).concat([{ key: 'other', label: _('Other devices'),
			bytes: rows.slice(6).reduce((sum, d) => sum + d.bytes, 0), color: '#9099aa' }]);
	}
	if (unassigned > 0) slices = slices.concat([{ key: 'unassigned', label: _('Unassigned'), bytes: unassigned, color: '#b1a69a' }]);
	return { slices, total, observed, excess: Math.max(0, attributed - observed), devices: rows.length };
}

function svg(tag, attrs) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const key in attrs) el.setAttribute(key, attrs[key]);
	return el;
}

function chart(direction) {
	const ring = svg('svg', { viewBox: '0 0 144 144', role: 'img', 'aria-label': direction === 'upload' ? _('Upload share') : _('Download share') });
	ring.appendChild(svg('circle', { cx: 72, cy: 72, r: 54, 'class': 'zen-share-track' }));
	const arcs = svg('g', { transform: 'rotate(-90 72 72)' });
	ring.appendChild(arcs);
	const value = E('strong', {}, fmt.fmtBytes(0));
	const name = E('span', {}, _('Recorded traffic'));
	const legend = E('ul', { 'class': 'zen-share-legend' });
	const note = E('p', { 'class': 'zen-share-note' });
	const more = E('button', { type: 'button', 'class': 'zen-share-more', hidden: true }, _('Show all'));
	const root = E('article', { 'class': 'zen-share-card ' + direction }, [
		E('h4', {}, direction === 'upload' ? _('Upload share') : _('Download share')),
		E('div', { 'class': 'zen-share-content' }, [E('div', { 'class': 'zen-share-ring' }, [ring,
			E('div', { 'class': 'zen-share-center' }, [name, value])]), legend]), note, more
	]);
	let expanded = false, data = null;
	const cache = new Map();
	function select(key) {
		const entry = cache.get(key);
		for (const [id, item] of cache) item.arc.style.opacity = !entry || id === key ? '1' : '.25';
		name.textContent = entry ? entry.label : _('Recorded traffic');
		value.textContent = fmt.fmtBytes(entry ? entry.bytes : breakdown(data, direction, expanded).total);
	}
	function update(next) {
		data = next;
		const model = breakdown(data, direction, expanded);
		let offset = 0;
		const keep = new Set();
		for (const slice of model.slices) {
			keep.add(slice.key);
			let entry = cache.get(slice.key);
			if (!entry) {
				const arc = svg('circle', { cx: 72, cy: 72, r: 54, fill: 'none', 'stroke-width': 15 });
				const title = svg('title', {}); arc.appendChild(title);
				const label = E('span', { 'class': 'zen-share-name' });
				const amount = E('span', { 'class': 'zen-share-amount' });
				const swatch = E('span', { 'class': 'zen-share-swatch', 'aria-hidden': 'true' });
				const button = E('button', { type: 'button' }, [swatch, label, amount]);
				const row = E('li', {}, button);
				button.addEventListener('mouseenter', () => select(slice.key));
				button.addEventListener('focus', () => select(slice.key));
				button.addEventListener('mouseleave', () => select(null));
				button.addEventListener('blur', () => select(null));
				entry = { arc, title, labelNode: label, amount, swatch, button, row };
				cache.set(slice.key, entry);
			}
			entry.bytes = slice.bytes; entry.label = slice.label;
			const percent = model.total ? slice.bytes / model.total * 100 : 0;
			entry.arc.setAttribute('stroke', slice.color);
			entry.arc.setAttribute('stroke-dasharray', (C * percent / 100) + ' ' + C);
			entry.arc.setAttribute('stroke-dashoffset', String(-offset));
			entry.swatch.style.backgroundColor = slice.color;
			entry.labelNode.textContent = slice.label;
			entry.amount.textContent = fmt.fmtBytes(slice.bytes) + ' · ' + percent.toFixed(1) + '%';
			entry.title.textContent = slice.label + ': ' + entry.amount.textContent;
			entry.button.title = entry.title.textContent;
			arcs.appendChild(entry.arc); legend.appendChild(entry.row);
			offset += C * percent / 100;
		}
		for (const [key, entry] of cache) if (!keep.has(key)) { entry.arc.remove(); entry.row.remove(); cache.delete(key); }
		select(null);
		if (!model.total) legend.replaceChildren(E('li', { 'class': 'zen-share-empty' }, _('No internet traffic recorded yet')));
		else for (const empty of legend.querySelectorAll('.zen-share-empty')) empty.remove();
		more.hidden = model.devices <= 6;
		more.textContent = expanded ? _('Show less') : _('Show all');
		note.textContent = _('WAN interface: %s').format(fmt.fmtBytes(model.observed));
		if (model.excess > 0) note.textContent += ' · ' + _('Device-side excess: %s; shares use device-side totals.').format(fmt.fmtBytes(model.excess));
	}
	more.addEventListener('click', () => { expanded = !expanded; update(data); });
	return { root, update };
}

return baseclass.extend({
	async mount(dash) {
		if (dash.querySelector('.zen-wan-share')) return;
		const subtitle = E('p', { 'class': 'zen-share-description' }, _('Loading internet usage…'));
		const status = E('p', { 'class': 'zen-share-status', role: 'status' });
		const upload = chart('upload'), download = chart('download');
		const cards = E('div', { 'class': 'zen-share-grid', hidden: true }, [upload.root, download.root]);
		const section = E('section', { 'class': 'zen-dash-panel zen-wan-share' }, [E('h3', {}, _('Internet usage by device')),
			subtitle, cards, status, E('details', { 'class': 'zen-share-help' }, [E('summary', {}, _('How shares are counted')),
				E('p', {}, _('Only internet traffic recorded since the date above is included. Earlier combined LAN/WAN history is excluded. Collection pauses while the service is stopped.')),
				E('p', {}, _('Unassigned is interface traffic not allocated to a device, including possible router traffic, cleared devices and accounting differences.'))])]);
		dash.appendChild(section);
		let loaded = false;
		async function tick() {
			if (document.hidden || !section.isConnected) return;
			try {
				const data = await callUsage();
				if (!data || !Array.isArray(data.dev) || !number(data.since)) throw new Error('usage unavailable');
				upload.update(data); download.update(data); cards.hidden = false; loaded = true;
				subtitle.textContent = _('Internet traffic since %s').format(new Date(data.since * 1000).toLocaleString());
				status.textContent = '';
			} catch (e) {
				if (!loaded) subtitle.textContent = _('Internet shares require an updated zen-traffic service and a valid system clock.');
				else status.textContent = _('Usage temporarily unavailable; showing the last result.');
			}
		}
		poll.add(tick, 5); await tick();
	},
	breakdown
});
