'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen.zen-format as fmt';
'require view.zen.zen-share-periods as periods';

const callUsage = rpc.declare({ object: 'zen.traffic', method: 'getWanUsage' });
const COLORS = ['#327563', '#ad8c5b', '#6d8792', '#82956d', '#9f7168', '#697d6b', '#9a927c', '#798da0'];
const C = 2 * Math.PI * 54;
const number = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const PERIODS = [['day',_('This day')],['week',_('This week')],['month',_('This month')],['all',_('All time')]];

function deviceHistoryUrl(mac) {
	if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac || '')) return null;
	const url = new URL(L.url('admin', 'zen', 'analysis'), window.location.href);
	url.searchParams.set('mac', mac.toLowerCase());
	url.hash = 'device-hourly';
	return url.pathname + url.search + url.hash;
}

function arcPath(offset, length) {
	const start = offset / 54, angle = Math.min(length / 54, 2 * Math.PI);
	const point = a => [72 + 54 * Math.cos(a), 72 + 54 * Math.sin(a)];
	const [x, y] = point(start), [endX, endY] = point(start + angle);
	if (angle >= 2 * Math.PI - 1e-9) {
		const [midX, midY] = point(start + Math.PI);
		return `M ${x} ${y} A 54 54 0 1 1 ${midX} ${midY} A 54 54 0 1 1 ${x} ${y}`;
	}
	return `M ${x} ${y} A 54 54 0 ${angle > Math.PI ? 1 : 0} 1 ${endX} ${endY}`;
}

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

// Share the ring denominators with overview totals, including accounting differences.
function usageTotals(data) {
	const upload = breakdown(data, 'upload', true).total;
	const download = breakdown(data, 'download', true).total;
	return { upload, download, total: upload + download };
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
	const percentValue = E('span', { 'class': 'zen-share-center-percent', hidden: true });
	const tooltipName = E('strong', {});
	const tooltipAmount = E('span', {});
	const tooltip = E('div', { 'class': 'zen-share-tooltip', role: 'tooltip', hidden: true }, [tooltipName, tooltipAmount]);
	const legend = E('ul', { 'class': 'zen-share-legend' });
	const note = E('p', { 'class': 'zen-share-note' });
	const more = E('button', { type: 'button', 'class': 'zen-share-more', hidden: true }, _('Show all'));
	const footer = E('div', { 'class': 'zen-share-footer', hidden: true }, [note, more]);
	let period = 'day', snapshot = null;
	const root = E('article', { 'class': 'zen-share-card ' + direction }, [
		E('div',{'class':'zen-share-head'},E('h4', {}, direction === 'upload' ? _('Upload share') : _('Download share'))),
		E('div', { 'class': 'zen-share-content' }, [E('div', { 'class': 'zen-share-ring' }, [ring,
			E('div', { 'class': 'zen-share-center' }, [name, value, percentValue]), tooltip]), legend]),
		footer
	]);
	let expanded = false, data = null, selected = null;
	const cache = new Map();
	function select(key) {
		const entry = cache.get(key);
		selected = entry ? key : null;
		for (const [id, item] of cache) item.arc.style.opacity = !entry || id === key ? '1' : '.25';
		name.textContent = entry ? entry.label : PERIODS.find(([key])=>key===period)[1];
		value.textContent = fmt.fmtBytes(entry ? entry.bytes : breakdown(data, direction, expanded).total);
		percentValue.hidden = !entry;
		percentValue.textContent = entry ? entry.percent.toFixed(1) + '%' : '';
		tooltip.hidden = !entry;
		if (entry) {
			tooltipName.textContent = entry.label;
			tooltipAmount.textContent = fmt.fmtBytes(entry.bytes) + ' · ' + entry.percent.toFixed(1) + '%';
		}
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
				const arc = svg('path', { fill: 'none', 'stroke-width': 15, tabindex: 0, role: 'button' });
				arc.addEventListener('mouseenter', () => select(slice.key));
				arc.addEventListener('mouseleave', () => select(null));
				arc.addEventListener('focus', () => select(slice.key));
				arc.addEventListener('blur', () => select(null));
				arc.addEventListener('click', () => select(slice.key));
				arc.addEventListener('keydown', ev => {
					if (ev.key === 'Escape') select(null);
					if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(slice.key); }
				});
				const title = svg('title', {}); arc.appendChild(title);
				const label = E('span', { 'class': 'zen-share-name' });
				const amount = E('span', { 'class': 'zen-share-amount' });
				const swatch = E('span', { 'class': 'zen-share-swatch', 'aria-hidden': 'true' });
				const href = deviceHistoryUrl(slice.key);
				const button = E(href ? 'a' : 'button', href ? { href, 'class': 'zen-share-device-link' } : { type: 'button' }, [swatch, label, amount]);
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
			entry.percent = percent;
			entry.arc.setAttribute('stroke', slice.color);
			entry.arc.setAttribute('d', arcPath(offset, C * percent / 100));
			entry.swatch.style.backgroundColor = slice.color;
			entry.labelNode.textContent = slice.label;
			entry.amount.textContent = fmt.fmtBytes(slice.bytes) + ' · ' + percent.toFixed(1) + '%';
			entry.title.textContent = slice.label + ': ' + entry.amount.textContent;
			entry.arc.setAttribute('aria-label', entry.title.textContent);
			entry.button.title = entry.title.textContent + (entry.button.tagName === 'A' ? ' · ' + _('View hourly usage') : '');
			const index = model.slices.indexOf(slice);
			if (arcs.children[index] !== entry.arc) arcs.insertBefore(entry.arc, arcs.children[index] || null);
			if (legend.children[index] !== entry.row) legend.insertBefore(entry.row, legend.children[index] || null);
			offset += C * percent / 100;
		}
		for (const [key, entry] of cache) if (!keep.has(key)) { entry.arc.remove(); entry.row.remove(); cache.delete(key); }
		select(selected);
		if (!model.total) legend.replaceChildren(E('li', { 'class': 'zen-share-empty' }, _('No internet traffic recorded yet')));
		else for (const empty of legend.querySelectorAll('.zen-share-empty')) empty.remove();
		more.hidden = model.devices <= 6;
		more.textContent = expanded ? _('Show less') : _('Show all');
		note.hidden = model.excess <= 0;
		note.textContent = note.hidden ? '' : _('WAN interface: %s').format(fmt.fmtBytes(model.observed));
		footer.hidden = note.hidden && more.hidden;
	}
	more.addEventListener('click', () => { expanded = !expanded; update(data); });
	return { root, setPeriod(key) { period=key;selected=null;if(snapshot)update(key==='all'?snapshot.all:snapshot[key]); }, update(next) { snapshot=next;update(period==='all' ? next.all : next[period]); } };
}

return baseclass.extend({
	async mount(dash, options = {}) {
		if (dash.querySelector('.zen-wan-share')) return;
		const subtitle = E('p', { 'class': 'zen-share-description' }, _('Loading internet usage…'));
		const status = E('p', { 'class': 'zen-share-status', role: 'status' });
		const upload = chart('upload'), download = chart('download');
		let selectedPeriod = 'day', snapshot = null;
		function publishTotals() {
			if (snapshot && typeof options.onUpdate === 'function')
				options.onUpdate({ period: selectedPeriod, ...usageTotals(snapshot[selectedPeriod]),
					uploadBreakdown: breakdown(snapshot[selectedPeriod], 'upload', true),
					downloadBreakdown: breakdown(snapshot[selectedPeriod], 'download', true) });
		}
		const buttons=PERIODS.map(([key,label])=>E('button',{type:'button','aria-pressed':String(key==='day'),click:()=>{selectedPeriod=key;upload.setPeriod(key);download.setPeriod(key);buttons.forEach((button,index)=>button.setAttribute('aria-pressed',String(PERIODS[index][0]===key)));publishTotals();}},label));
		const range=E('div',{class:'zen-share-periods zen-segmented',role:'group','aria-label':_('Time range')},buttons);
		const cards = E('div', { 'class': 'zen-share-grid', hidden: true }, [upload.root, download.root]);
		const section = E('section', { 'class': 'zen-dash-panel zen-wan-share' }, [E('h3', {}, _('Internet usage by device')),
			subtitle, range, cards, status]);
		dash.appendChild(section);
		let loaded = false, busy = false;
		async function tick() {
			if (document.hidden || !section.isConnected || section.closest('[hidden]') || busy) return;
			busy=true;
			try {
				const data = await callUsage();
				if (!data || !Array.isArray(data.dev) || !number(data.since)) throw new Error('usage unavailable');
				snapshot={all:data,...await periods.load(data)};
				upload.update(snapshot); download.update(snapshot); cards.hidden = false; loaded = true;
				publishTotals();
				subtitle.hidden = true;
				subtitle.textContent = '';
				status.textContent = '';
			} catch (e) {
				if (!loaded) subtitle.textContent = _('Internet shares require an updated zen-traffic service and a valid system clock.');
				else status.textContent = _('Usage temporarily unavailable; showing the last result.');
			} finally {busy=false;}
		}
		poll.add(tick, 5); await tick();
	},
	breakdown,
	usageTotals,
	deviceHistoryUrl
});
