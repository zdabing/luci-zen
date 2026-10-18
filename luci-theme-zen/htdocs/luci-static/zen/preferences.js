/* Zen display preferences. Native browser controls, no theme-library runtime.
 * Keep the public adapter name and mode/layout keys for existing installations. */
(function () {
	'use strict';
	if (window.ZenAppearance) return;
	const root = document.documentElement;
	const storageKeys = { mode: 'luci-theme-zen', layout: 'luci-theme-zen-layout' };
	const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	const router = root.dataset.zenAppearance === 'router';
	const managed = router && root.dataset.zenAuthenticated === 'true';
	let saved = root.dataset.zenSaved === 'true', storageOK = true;
	let adapter, activeWrite, queued = {}, failure = false, writing = false;
	let modal, returnFocus;
	const forms = new Set();
	const validMode = value => ['light', 'dark'].includes(value) ? value : 'auto';
	const validLayout = value => value === 'top' ? 'top' : 'sidebar';
	function read(key) { try { return localStorage.getItem(key); } catch (e) { storageOK = false; return null; } }
	function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { storageOK = false; } }
	const state = {
		mode: validMode(router && saved ? root.dataset.zenMode : read(storageKeys.mode)),
		layout: validLayout(router && saved ? root.dataset.zenLayout : read(storageKeys.layout))
	};
	function tr(text) {
		const _ = value => typeof window._ === 'function' ? window._(value) : value;
		const labels = {
			'Theme settings': _('Theme settings'), 'Appearance & layout': _('Appearance & layout'),
			'Mist': _('Mist'), 'A quieter view of your network.': _('A quieter view of your network.'),
			'Display mode': _('Display mode'), 'Follow system': _('Follow system'), 'Light mode': _('Light mode'), 'Dark mode': _('Dark mode'),
			'Navigation layout': _('Navigation layout'), 'Left navigation': _('Left navigation'), 'Top navigation': _('Top navigation'),
			'Keep pages within reach in the sidebar.': _('Keep pages within reach in the sidebar.'),
			'Use the full width with navigation above.': _('Use the full width with navigation above.'),
			'Your network': _('Your network'), 'Connected': _('Connected'), 'Preview': _('Preview'),
			'Changes apply immediately.': _('Changes apply immediately.'),
			'Saved in this browser': _('Saved in this browser'),
			'Saved on router; applies across browsers': _('Saved on router; applies across browsers'),
			'Saving to router…': _('Saving to router…'), 'Could not save to router. Try again.': _('Could not save to router. Try again.'),
			'Retry saving': _('Retry saving'), 'Choose an option to save it on the router': _('Choose an option to save it on the router'),
			'Log in to save appearance across browsers': _('Log in to save appearance across browsers'),
			'Storage unavailable; appearance applies for this session only': _('Storage unavailable; appearance applies for this session only'),
			'Switch to light mode': _('Switch to light mode'), 'Switch to dark mode': _('Switch to dark mode'), 'Close': _('Close')
		};
		return labels[text] || text;
	}
	function status() {
		if (failure) return 'Could not save to router. Try again.';
		if (writing) return 'Saving to router…';
		if (managed) return saved ? 'Saved on router; applies across browsers' : 'Choose an option to save it on the router';
		if (router) return 'Log in to save appearance across browsers';
		return storageOK ? 'Saved in this browser' : 'Storage unavailable; appearance applies for this session only';
	}
	function sync() {
		for (const form of forms) {
			for (const button of form.querySelectorAll('[data-pref-group]')) {
				const chosen = state[button.dataset.prefGroup] === button.dataset.prefValue;
				button.setAttribute('aria-pressed', String(chosen));
			}
			const note = form.querySelector('.zen-pref-save-note');
			if (note) { note.textContent = tr(status()); note.classList.toggle('is-error', failure); }
			const retryButton = form.querySelector('.zen-pref-retry');
			if (retryButton) retryButton.hidden = !failure;
		}
		for (const button of document.querySelectorAll('.zen-mode-toggle')) {
			const label = tr(root.dataset.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
			button.setAttribute('aria-label', label); button.title = label;
			const span = button.querySelector('.zen-mode-label');
			if (span) span.textContent = tr(root.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode');
		}
	}
	function apply() {
		root.dataset.theme = state.mode === 'auto' ? (media && media.matches ? 'dark' : 'light') : state.mode;
		root.dataset.darkmode = String(root.dataset.theme === 'dark');
		root.dataset.themeMode = state.mode; root.dataset.layout = state.layout;
		sync();
		document.dispatchEvent(new CustomEvent('zenappearancechange', { detail: { ...state, theme: root.dataset.theme } }));
	}
	function flush() {
		if (activeWrite || !adapter || !Object.keys(queued).length) return activeWrite || Promise.resolve();
		writing = true; failure = false; sync();
		activeWrite = Promise.resolve().then(async () => {
			while (Object.keys(queued).length) {
				const batch = queued; queued = {};
				try { await adapter(batch); saved = true; }
				catch (e) { queued = { ...batch, ...queued }; failure = true; break; }
			}
		}).finally(() => { writing = false; activeWrite = null; sync(); });
		return activeWrite;
	}
	function set(value) {
		const patch = {};
		if (Object.prototype.hasOwnProperty.call(value, 'mode')) patch.mode = validMode(value.mode);
		if (Object.prototype.hasOwnProperty.call(value, 'layout')) patch.layout = validLayout(value.layout);
		Object.assign(state, patch);
		for (const key of Object.keys(patch)) write(storageKeys[key], patch[key]);
		apply();
		if (managed && Object.keys(patch).length) {
			queued = { ...queued, ...(saved ? patch : state) }; flush();
		}
	}
	function connect(save) {
		if (!managed) return Promise.resolve();
		adapter = save;
		if (!saved && Object.values(storageKeys).some(key => read(key) !== null)) queued = { ...state, ...queued };
		return flush();
	}
	function failSave() { failure = true; sync(); }
	function retry() {
		if (!adapter && managed && window.L) return window.L.require('view.zen.zen-appearance').catch(failSave);
		return flush();
	}
	function node(tag, className, text) {
		const el = document.createElement(tag);
		if (className) el.className = className;
		if (text != null) el.textContent = tr(text);
		return el;
	}
	function choices(group, title, options) {
		const field = node('fieldset', 'zen-pref-field'); field.appendChild(node('legend', '', title));
		const list = node('div', 'zen-pref-options zen-pref-' + group);
		for (const [value, label, description] of options) {
			const button = node('button', 'zen-pref-choice'); button.type = 'button';
			button.dataset.prefGroup = group; button.dataset.prefValue = value;
			const mark = node('span', 'zen-pref-mark'); mark.setAttribute('aria-hidden', 'true');
			const words = node('span'); words.appendChild(node('strong', '', label));
			if (description) words.appendChild(node('small', '', description));
			button.append(mark, words); button.addEventListener('click', () => set({ [group]: value })); list.appendChild(button);
		}
		field.appendChild(list); return field;
	}
	function render() {
		const form = node('div', 'zen-preferences');
		const intro = node('header', 'zen-pref-intro');
		intro.append(node('span', 'zen-pref-eyebrow', 'Mist'), node('h2', '', 'A quieter view of your network.'), node('p', '', 'Changes apply immediately.'));
		const controls = node('div', 'zen-pref-controls');
		controls.append(
			choices('mode', 'Display mode', [['auto', 'Follow system'], ['light', 'Light mode'], ['dark', 'Dark mode']]),
			choices('layout', 'Navigation layout', [['sidebar', 'Left navigation', 'Keep pages within reach in the sidebar.'], ['top', 'Top navigation', 'Use the full width with navigation above.']])
		);
		const preview = node('aside', 'zen-pref-preview'); preview.setAttribute('aria-label', tr('Preview'));
		const canvas = node('div', 'zen-pref-canvas'); canvas.setAttribute('aria-hidden', 'true');
		const rail = node('div', 'zen-pref-mini-rail'); for (let i = 0; i < 4; i++) rail.appendChild(node('i'));
		const paper = node('div', 'zen-pref-mini-content'); paper.append(node('b', '', 'Your network'), node('span', 'zen-pref-mini-status', 'Connected'));
		const chart = node('div', 'zen-pref-mini-chart'); for (const height of [28, 47, 35, 64, 53, 76, 58, 90, 70, 85]) {
			const bar = node('i'); bar.style.height = height + '%'; chart.appendChild(bar);
		}
		paper.appendChild(chart); canvas.append(rail, paper);
		preview.append(canvas, node('strong', '', 'Your network'), node('p', '', 'A quieter view of your network.'));
		const body = node('div', 'zen-pref-grid'); body.append(controls, preview);
		const footer = node('footer', 'zen-pref-footer');
		const note = node('p', 'zen-pref-save-note'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
		const retryButton = node('button', 'zen-pref-retry', 'Retry saving'); retryButton.type = 'button'; retryButton.addEventListener('click', retry);
		footer.append(note, retryButton); form.append(intro, body, footer); forms.add(form); sync(); return form;
	}
	function open(trigger) {
		if (!modal) {
			modal = node('dialog', 'zen-preferences-dialog'); modal.id = 'zen-appearance-dialog'; modal.setAttribute('aria-label', tr('Theme settings'));
			const close = node('button', 'zen-pref-close', '×'); close.type = 'button'; close.setAttribute('aria-label', tr('Close'));
			close.addEventListener('click', () => modal.close()); modal.append(close, render()); document.body.appendChild(modal);
			modal.addEventListener('close', () => { if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); });
			modal.addEventListener('click', event => {
				if (event.target !== modal) return;
				const r = modal.getBoundingClientRect();
				if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close();
			});
		}
		if (!modal.open) { returnFocus = trigger || document.activeElement; modal.showModal(); }
	}
	window.ZenAppearance = Object.freeze({ set, connect, retry, failSave, flush, status, open, render, get: () => ({ ...state, theme: root.dataset.theme }) });
	apply();
	document.addEventListener('DOMContentLoaded', sync);
	document.addEventListener('click', event => {
		const toggle = event.target.closest && event.target.closest('.zen-mode-toggle');
		if (toggle) { event.preventDefault(); set({ mode: root.dataset.theme === 'dark' ? 'light' : 'dark' }); return; }
		const trigger = event.target.closest && event.target.closest('.zen-appearance-trigger');
		if (trigger && !trigger.classList.contains('zen-settings-link')) { event.preventDefault(); open(trigger); }
	});
	window.addEventListener('storage', event => {
		if (event.key === storageKeys.mode) state.mode = validMode(event.newValue);
		else if (event.key === storageKeys.layout) state.layout = validLayout(event.newValue);
		else if (event.key === null) { state.mode = validMode(read(storageKeys.mode)); state.layout = validLayout(read(storageKeys.layout)); }
		else return;
		apply();
	});
	const systemChanged = () => { if (state.mode === 'auto') apply(); };
	if (media && media.addEventListener) media.addEventListener('change', systemChanged);
	else if (media && media.addListener) media.addListener(systemChanged);
})();
