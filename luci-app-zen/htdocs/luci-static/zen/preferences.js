/* Zen display preferences (Z Design System v2.0.0).
 * Native browser controls, no theme-library runtime.
 * Keeps public ZenAppearance API and existing mode/layout/skin storage keys. */
(function () {
	'use strict';
	if (window.ZenAppearance) return;
	const root = document.documentElement;
	const storageKeys = {
		mode: 'luci-theme-zen',
		layout: 'luci-theme-zen-layout',
		skin: 'luci-theme-zen-skin',
		accent: 'luci-theme-zen-accent'
	};
	const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	const router = root.dataset.zenAppearance === 'router';
	const managed = router && root.dataset.zenAuthenticated === 'true';
	let saved = root.dataset.zenSaved === 'true', storageOK = true;
	let adapter, activeWrite, queued = {}, failure = false, writing = false;
	let modal, returnFocus;
	const forms = new Set();
	const ACCENTS = [
		['blue', 'Aurora Blue', '#2563eb', '#3b82f6'],
		['teal', 'Emerald Teal', '#0d9488', '#14b8a6'],
		['indigo', 'Indigo', '#4f46e5', '#6366f1'],
		['ink', 'Minimal Ink', '#18181b', '#e4e4e7'],
		['amber', 'Warm Amber', '#ea580c', '#f97316']
	];
	const validMode = value => ['light', 'dark'].includes(value) ? value : 'auto';
	const validSkin = value => value === 'apple' ? 'apple' : 'meridian';
	const validLayout = value => value === 'top' ? 'top' : 'sidebar';
	const validAccent = value => ['blue', 'teal', 'indigo', 'ink', 'amber'].includes(value) ? value : 'blue';
	function read(key) { try { return localStorage.getItem(key); } catch (e) { storageOK = false; return null; } }
	function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { storageOK = false; } }
	const state = {
		mode: validMode(router && saved ? root.dataset.zenMode : read(storageKeys.mode)),
		layout: validLayout(router && saved ? root.dataset.zenLayout : read(storageKeys.layout)),
		skin: validSkin(router && saved ? root.dataset.zenSkin : read(storageKeys.skin)),
		accent: validAccent(router && saved ? root.dataset.zenAccent : read(storageKeys.accent))
	};
	function tr(text) {
		const _ = value => typeof window._ === 'function' ? window._(value) : value;
		const labels = {
			'Theme settings': _('Theme settings'), 'Appearance & layout': _('Appearance & layout'),
			'Visual theme': _('Visual theme'), 'Meridian': _('Meridian'),
			'Snow-white canvas, pure white cards and soft elevation.': _('Snow-white canvas, pure white cards and soft elevation.'),
			'Apple': _('Apple'), 'Crisp light-blue canvas, flat white cards and tinted icons.': _('Crisp light-blue canvas, flat white cards and tinted icons.'),
			'Accent color': _('Accent color'),
			'Aurora Blue': _('Aurora Blue'), 'Emerald Teal': _('Emerald Teal'),
			'Indigo': _('Indigo'), 'Minimal Ink': _('Minimal Ink'), 'Warm Amber': _('Warm Amber'),
			'A quieter view of your network.': _('A quieter view of your network.'),
			'Display mode': _('Display mode'), 'Follow system': _('Follow system'), 'Light mode': _('Light mode'), 'Dark mode': _('Dark mode'),
			'Navigation layout': _('Navigation layout'), 'Left navigation': _('Left navigation'), 'Top navigation': _('Top navigation'),
			'Keep pages within reach in the sidebar.': _('Keep pages within reach in the sidebar.'),
			'Use the full width with navigation above.': _('Use the full width with navigation above.'),
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
		const isDark = root.dataset.theme === 'dark';
		for (const form of forms) {
			for (const button of form.querySelectorAll('[data-pref-group]')) {
				const chosen = state[button.dataset.prefGroup] === button.dataset.prefValue;
				button.setAttribute('aria-pressed', String(chosen));
			}
			for (const dot of form.querySelectorAll('.zen-accent-dot[data-light-color]')) {
				dot.style.backgroundColor = isDark ? dot.dataset.darkColor : dot.dataset.lightColor;
			}
			const note = form.querySelector('.zen-pref-save-note');
			if (note) { note.textContent = tr(status()); note.classList.toggle('is-error', failure); }
			const retryButton = form.querySelector('.zen-pref-retry');
			if (retryButton) retryButton.hidden = !failure;
		}
		if (modal) {
			const note = modal.querySelector('.zen-dialog-actions .zen-pref-save-note');
			if (note) { note.textContent = tr(status()); note.classList.toggle('is-error', failure); }
			const retryButton = modal.querySelector('.zen-dialog-actions .zen-pref-retry');
			if (retryButton) retryButton.hidden = !failure;
		}
		for (const button of document.querySelectorAll('.zen-mode-toggle')) {
			const label = tr(isDark ? 'Switch to light mode' : 'Switch to dark mode');
			button.setAttribute('aria-label', label); button.title = label;
			const span = button.querySelector('.zen-mode-label');
			if (span) span.textContent = tr(isDark ? 'Light mode' : 'Dark mode');
		}
	}
	function apply() {
		const scheme = state.mode === 'auto' ? (media && media.matches ? 'dark' : 'light') : state.mode;
		root.dataset.theme = scheme;
		root.dataset.darkmode = String(scheme === 'dark');
		root.dataset.themeMode = state.mode;
		root.dataset.layout = state.layout;
		root.dataset.skin = state.skin;
		root.dataset.accent = state.accent;
		root.dataset.zStyle = state.skin;
		root.dataset.zScheme = scheme;
		root.dataset.zAccent = state.accent;
		sync();
		document.dispatchEvent(new CustomEvent('zenappearancechange', { detail: { ...state, theme: scheme } }));
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
		if (Object.prototype.hasOwnProperty.call(value, 'skin')) patch.skin = validSkin(value.skin);
		if (Object.prototype.hasOwnProperty.call(value, 'layout')) patch.layout = validLayout(value.layout);
		if (Object.prototype.hasOwnProperty.call(value, 'accent')) patch.accent = validAccent(value.accent);
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
		const isMode = group === 'mode';
		const wrap = node('div', 'zen-pref-group' + (isMode ? ' wide' : ''));
		wrap.appendChild(node('div', 'zen-pref-label', title));
		const list = node('div', 'zen-pref-options zen-pref-' + group);
		list.setAttribute('role', 'group');
		list.setAttribute('aria-label', tr(title));
		for (const [value, label] of options) {
			const button = node('button', 'zen-pref-choice' + (isMode ? ' zen-mode-btn' : ' zen-style-card'));
			button.type = 'button';
			button.dataset.prefGroup = group;
			button.dataset.prefValue = value;
			if (!isMode) {
				const mark = node('span', 'zen-pref-mark');
				mark.setAttribute('aria-hidden', 'true');
				button.append(mark);
			}
			button.append(node('span', 'zen-pref-text', label));
			button.addEventListener('click', () => set({ [group]: value }));
			list.appendChild(button);
		}
		wrap.appendChild(list);
		return wrap;
	}
	function accentChoices() {
		const wrap = node('div', 'zen-pref-group wide');
		wrap.appendChild(node('div', 'zen-pref-label', 'Accent color'));
		const list = node('div', 'zen-pref-options zen-pref-accent zen-accent-grid');
		list.setAttribute('role', 'group');
		list.setAttribute('aria-label', tr('Accent color'));
		const isDark = root.dataset.theme === 'dark';
		for (const [value, label, lightHex, darkHex] of ACCENTS) {
			const button = node('button', 'zen-pref-choice zen-accent-btn');
			button.type = 'button';
			button.dataset.prefGroup = 'accent';
			button.dataset.prefValue = value;
			const dot = node('span', 'zen-accent-dot');
			dot.setAttribute('aria-hidden', 'true');
			dot.dataset.lightColor = lightHex;
			dot.dataset.darkColor = darkHex;
			dot.style.backgroundColor = isDark ? darkHex : lightHex;
			button.append(dot, node('span', 'zen-accent-label', label));
			button.addEventListener('click', () => set({ accent: value }));
			list.appendChild(button);
		}
		wrap.appendChild(list);
		return wrap;
	}
	function render(options) {
		const inDialog = !!(options && options.inDialog);
		const form = node('div', 'zen-preferences');
		const intro = node('header', 'zen-pref-intro');
		intro.append(node('span', 'zen-pref-eyebrow', 'Theme settings'), node('h2', '', 'A quieter view of your network.'), node('p', '', 'Changes apply immediately.'));
		const controls = node('div', 'zen-pref-controls');
		controls.append(
			choices('skin', 'Visual theme', [['meridian', 'Meridian'], ['apple', 'Apple']]),
			choices('layout', 'Navigation layout', [['sidebar', 'Left navigation'], ['top', 'Top navigation']]),
			choices('mode', 'Display mode', [['auto', 'Follow system'], ['light', 'Light mode'], ['dark', 'Dark mode']]),
			accentChoices()
		);
		if (inDialog) {
			form.append(controls);
		} else {
			const footer = node('footer', 'zen-pref-footer');
			const note = node('p', 'zen-pref-save-note'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
			const retryButton = node('button', 'zen-pref-retry', 'Retry saving'); retryButton.type = 'button'; retryButton.addEventListener('click', retry);
			footer.append(note, retryButton); form.append(intro, controls, footer);
		}
		forms.add(form); sync(); return form;
	}
	function open(trigger) {
		if (!modal) {
			modal = node('dialog', 'zen-preferences-dialog'); modal.id = 'zen-appearance-dialog'; modal.setAttribute('aria-labelledby', 'zen-appearance-dialog-title');
			const head = node('div', 'zen-dialog-head');
			const title = node('h4', '', 'Theme settings'); title.id = 'zen-appearance-dialog-title';
			const close = node('button', 'zen-pref-close', '×'); close.type = 'button'; close.setAttribute('aria-label', tr('Close'));
			close.addEventListener('click', () => modal.close());
			head.append(title, close);
			const body = node('div', 'zen-dialog-body');
			body.append(render({ inDialog: true }));
			const actions = node('div', 'zen-dialog-actions');
			const note = node('p', 'zen-pref-save-note'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
			const retryButton = node('button', 'zen-pref-retry', 'Retry saving'); retryButton.type = 'button'; retryButton.addEventListener('click', retry);
			const doneButton = node('button', 'cbi-button cbi-button-positive zen-dialog-done', 'Close'); doneButton.type = 'button';
			doneButton.addEventListener('click', () => modal.close());
			actions.append(note, retryButton, doneButton);
			modal.append(head, body, actions);
			document.body.appendChild(modal);
			modal.addEventListener('close', () => { if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); });
			modal.addEventListener('click', event => {
				if (event.target !== modal) return;
				const r = modal.getBoundingClientRect();
				if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close();
			});
			sync();
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
		else if (event.key === storageKeys.skin) state.skin = validSkin(event.newValue);
		else if (event.key === storageKeys.layout) state.layout = validLayout(event.newValue);
		else if (event.key === storageKeys.accent) state.accent = validAccent(event.newValue);
		else if (event.key === null) {
			state.mode = validMode(read(storageKeys.mode));
			state.layout = validLayout(read(storageKeys.layout));
			state.skin = validSkin(read(storageKeys.skin));
			state.accent = validAccent(read(storageKeys.accent));
		}
		else return;
		apply();
	});
	const systemChanged = () => { if (state.mode === 'auto') apply(); };
	if (media && media.addEventListener) media.addEventListener('change', systemChanged);
	else if (media && media.addListener) media.addListener(systemChanged);
})();
