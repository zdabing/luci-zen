'use strict';
'require baseclass';
'require view.zen-traffic.style as trafficStyle';

let nextId = 0;
const DAY = 86400000;
function parse(value) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
	const date = new Date(value + 'T12:00:00Z');
	return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
}
function iso(date) { return date.toISOString().slice(0, 10); }
function selectable(value, min, max) { return !!parse(value) && (!min || value >= min) && (!max || value <= max); }
function shift(value, days) { const date = parse(value); return date ? iso(new Date(date.getTime() + days * DAY)) : ''; }
function shiftMonth(value, delta) {
	const date = parse(value); if (!date) return '';
	const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1, 12));
	const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
	target.setUTCDate(Math.min(date.getUTCDate(), end)); return iso(target);
}
function monthDays(value) {
	const date = parse(value); if (!date) return [];
	date.setUTCDate(1);
	const start = shift(iso(date), -(date.getUTCDay() + 6) % 7);
	return Array.from({ length: 42 }, (_, index) => shift(start, index));
}
function glyph(kind) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
	const path = document.createElementNS(svg.namespaceURI, 'path');
	path.setAttribute('d', ({ calendar: 'M5 5h14v15H5zM8 3v4m8-4v4M5 10h14', previous: 'M14 6l-6 6 6 6', next: 'M10 6l6 6-6 6', close: 'M6 6l12 12M18 6L6 18' })[kind]);
	svg.appendChild(path); return svg;
}

function create(field, options = {}) {
	trafficStyle.inject();
	field.hidden = true; field.tabIndex = -1;
	const label = E('span', { class: 'zen-date-value' });
	const trigger = E('button', { type: 'button', class: 'zen-date-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, [label, glyph('calendar')]);
	const root = E('span', { class: 'zen-date-picker' }, [field, trigger]);
	const id = 'zen-date-calendar-' + (++nextId);
	let popup = null;
	function sync() {
		label.textContent = field.value ? field.value.replaceAll('-', ' / ') : _('Date');
		trigger.setAttribute('aria-label', _('Date') + (field.value ? ': ' + field.value : ''));
		trigger.disabled = field.disabled;
	}
	field.addEventListener('change', sync); sync();
	trigger.addEventListener('click', () => {
		if (popup || field.disabled) return;
		const local = new Date();
		const today = parse(options.today) ? options.today : [local.getFullYear(), String(local.getMonth() + 1).padStart(2, '0'), String(local.getDate()).padStart(2, '0')].join('-');
		const clamp = value => field.min && value < field.min ? field.min : field.max && value > field.max ? field.max : value;
		let focused = clamp(parse(field.value) ? field.value : today), month = focused.slice(0, 7) + '-01';
		const language = document.documentElement.lang || 'en';
		const monthFormat = new Intl.DateTimeFormat(language, { year: 'numeric', month: 'long', timeZone: 'UTC' });
		const dayFormat = new Intl.DateTimeFormat(language, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
		const weekdayFormat = new Intl.DateTimeFormat(language, { weekday: 'narrow', timeZone: 'UTC' });
		const title = E('span', { id, class: 'zen-date-month', 'aria-live': 'polite' });
		const previous = E('button', { type: 'button', class: 'zen-date-nav', 'aria-label': _('Previous month') }, glyph('previous'));
		const next = E('button', { type: 'button', class: 'zen-date-nav', 'aria-label': _('Next month') }, glyph('next'));
		const dismiss = E('button', { type: 'button', class: 'zen-date-nav', 'aria-label': _('Close') }, glyph('close'));
		const weekdays = E('div', { class: 'zen-date-weekdays', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, index) => E('span', {}, weekdayFormat.format(parse(shift('2024-01-01', index))))));
		const grid = E('div', { class: 'zen-date-days', role: 'group', 'aria-labelledby': id });
		const todayButton = E('button', { type: 'button', class: 'zen-date-today' }, _('Today'));
		todayButton.disabled = !selectable(today, field.min, field.max);
		const dialog = E('dialog', { class: 'zen-date-dialog', 'aria-labelledby': id }, [E('div', { class: 'zen-date-heading' }, [title, previous, next, dismiss]), weekdays, grid, E('div', { class: 'zen-date-footer' }, todayButton)]);
		popup = dialog;
		function close() { dialog.close(); cleanup(); }
		let cleaned = false;
		function cleanup() {
			if (cleaned) return; cleaned = true; popup = null;
			window.removeEventListener('resize', position);
			trigger.setAttribute('aria-expanded', 'false'); dialog.remove();
			if (trigger.isConnected) trigger.focus({ preventScroll: true });
		}
		function commit(value) {
			if (!selectable(value, field.min, field.max)) return;
			const changed = field.value !== value; field.value = value; sync(); close();
			if (changed) field.dispatchEvent(new Event('change', { bubbles: true }));
		}
		function focusDay() { grid.querySelector('[data-date="' + focused + '"]')?.focus({ preventScroll: true }); }
		function draw() {
			title.textContent = monthFormat.format(parse(month));
			previous.disabled = !!field.min && shiftMonth(month, -1).slice(0, 7) < field.min.slice(0, 7);
			next.disabled = !!field.max && shiftMonth(month, 1).slice(0, 7) > field.max.slice(0, 7);
			grid.replaceChildren(...monthDays(month).map(value => {
				const selected = value === field.value;
				const button = E('button', { type: 'button', class: 'zen-date-day' + (value.slice(0, 7) !== month.slice(0, 7) ? ' is-outside' : ''), 'data-date': value, 'aria-label': dayFormat.format(parse(value)), 'aria-pressed': String(selected), 'aria-current': value === today ? 'date' : null, tabindex: value === focused ? '0' : '-1' }, String(parse(value).getUTCDate()));
				button.disabled = !selectable(value, field.min, field.max);
				button.addEventListener('click', () => commit(value)); return button;
			}));
		}
		function position() {
			if (!dialog.isConnected) return;
			const anchor = trigger.getBoundingClientRect(), box = dialog.getBoundingClientRect();
			const below = anchor.bottom + 8, above = anchor.top - box.height - 8;
			dialog.style.left = Math.max(12, Math.min(anchor.left, window.innerWidth - box.width - 12)) + 'px';
			dialog.style.top = Math.max(12, Math.min(below + box.height <= window.innerHeight - 12 ? below : above, window.innerHeight - box.height - 12)) + 'px';
		}
		for (const [button, delta] of [[previous, -1], [next, 1]]) button.addEventListener('click', () => { month = shiftMonth(month, delta); focused = clamp(month); draw(); if (button.disabled) focusDay(); });
		dismiss.addEventListener('click', close); todayButton.addEventListener('click', () => commit(today));
		grid.addEventListener('keydown', event => {
			const value = event.target.closest('[data-date]')?.dataset.date; if (!value) return;
			let target;
			if (event.key === 'ArrowLeft') target = shift(value, -1);
			else if (event.key === 'ArrowRight') target = shift(value, 1);
			else if (event.key === 'ArrowUp') target = shift(value, -7);
			else if (event.key === 'ArrowDown') target = shift(value, 7);
			else if (event.key === 'PageUp' || event.key === 'PageDown') target = shiftMonth(value, (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1));
			else if (event.key === 'Home') target = shift(value, -(parse(value).getUTCDay() + 6) % 7);
			else if (event.key === 'End') target = shift(value, 6 - (parse(value).getUTCDay() + 6) % 7);
			if (!target) return; event.preventDefault(); focused = clamp(target); month = focused.slice(0, 7) + '-01'; draw(); focusDay();
		});
		dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
		dialog.addEventListener('close', cleanup, { once: true });
		dialog.addEventListener('click', event => { const box = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close(); });
		document.body.appendChild(dialog); draw(); dialog.showModal(); position(); focusDay();
		trigger.setAttribute('aria-expanded', 'true'); window.addEventListener('resize', position);
	});
	return root;
}

return baseclass.extend({ create, parse, shift, shiftMonth, monthDays, selectable });
