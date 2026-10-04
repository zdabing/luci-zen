/* SPDX-License-Identifier: GPL-3.0-only
 * LuCI adapter for Sunny UI Design System (2022afe).
 * Palette values, preference contract and contrast logic adapted from
 * https://github.com/xudong7587/sunny-ui-design-system
 * No React runtime, RPC calls, or changes to router configuration.
 */
(function () {
	'use strict';
	if (window.ZenAppearance) return;
	const root = document.documentElement;
	const keys = { mode: 'luci-theme-zen', accent: 'luci-theme-zen-accent', material: 'luci-theme-zen-material', layout: 'luci-theme-zen-layout' };
	const palettes = [
		{ id: 'macaron', name: 'Macaron', light: '#329383', dark: '#a7dfd0', secondary: '#9461ac', secondaryDark: '#dab6ef', tertiary: '#b35a70', tertiaryDark: '#f4bacb' },
		{ id: 'nord', name: 'Nord', light: '#427fa4', dark: '#88c0d0', secondary: '#5e678d', secondaryDark: '#b48ead', tertiary: '#42776c', tertiaryDark: '#a3be8c' },
		{ id: 'honey', name: 'Honey', light: '#a17a24', dark: '#e4c278', secondary: '#397976', secondaryDark: '#9dcfcb', tertiary: '#ad6556', tertiaryDark: '#e5b0a3' },
		{ id: 'blue', name: 'Sunny blue', light: '#376bd8', dark: '#9dbbff' },
		{ id: 'coast', name: 'Coast', light: '#14869a', dark: '#79d5e5', secondary: '#b64d38', secondaryDark: '#ffaf98', tertiary: '#866519', tertiaryDark: '#edcf86' }
	];
	const materials = [
		{ id: 'glass', name: 'iOS glass', description: 'Frosted surfaces, bright edges and floating depth' },
		{ id: 'aurora', name: 'Aurora glass', description: 'Translucent layers with soft ambient color' },
		{ id: 'paper', name: 'Archive paper', description: 'Warm paper, fine lines and quiet reading' },
		{ id: 'outline', name: 'Fine outline', description: 'Clear surfaces, fine edges and restrained depth' },
		{ id: 'duotone', name: 'Duotone gradient', description: 'Directional color gradients with solid surfaces' }
	];
	const presets = [
		{ id: 'A', name: 'Bright macaron glass', accent: 'macaron', material: 'glass' },
		{ id: 'B', name: 'Northern aurora', accent: 'nord', material: 'aurora' },
		{ id: 'C', name: 'Honey paper', accent: 'honey', material: 'paper' },
		{ id: 'D', name: 'Clear blue outline', accent: 'blue', material: 'outline' },
		{ id: 'E', name: 'Coastal sunset', accent: 'coast', material: 'duotone' }
	];
	const system = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	const state = { mode: 'auto', accent: 'macaron', material: 'glass', layout: 'sidebar' };
	let dialog, opener, storageAvailable = true;
	const forms = [];
	const choiceButtons = [];

	let labels;
	function translate(text) {
		// The script runs before LuCI translations; do not cache fallback labels.
		if (typeof window._ !== 'function') return text;
		const _ = value => typeof window._ === 'function' ? window._(value) : value;
		// Literal translation calls keep LuCI's extraction and PO checks reliable.
		if (!labels) labels = {
			'Macaron': _('Macaron'), 'Nord': _('Nord'), 'Honey': _('Honey'),
			'Sunny blue': _('Sunny blue'), 'Coast': _('Coast'),
			'iOS glass': _('iOS glass'), 'Aurora glass': _('Aurora glass'),
			'Archive paper': _('Archive paper'), 'Fine outline': _('Fine outline'),
			'Duotone gradient': _('Duotone gradient'),
			'Frosted surfaces, bright edges and floating depth': _('Frosted surfaces, bright edges and floating depth'),
			'Translucent layers with soft ambient color': _('Translucent layers with soft ambient color'),
			'Warm paper, fine lines and quiet reading': _('Warm paper, fine lines and quiet reading'),
			'Clear surfaces, fine edges and restrained depth': _('Clear surfaces, fine edges and restrained depth'),
			'Directional color gradients with solid surfaces': _('Directional color gradients with solid surfaces'),
			'Bright macaron glass': _('Bright macaron glass'), 'Northern aurora': _('Northern aurora'),
			'Honey paper': _('Honey paper'), 'Clear blue outline': _('Clear blue outline'),
			'Coastal sunset': _('Coastal sunset'), 'Theme settings': _('Theme settings'),
			'Appearance & layout': _('Appearance & layout'),
			'Color, material, display mode and layout are independent. Changes apply immediately.': _('Color, material, display mode and layout are independent. Changes apply immediately.'),
			'Navigation layout': _('Navigation layout'), 'Left navigation': _('Left navigation'), 'Top navigation': _('Top navigation'),
			'Navigation stays on the left': _('Navigation stays on the left'),
			'Horizontal on desktop; collapsible menu on mobile': _('Horizontal on desktop; collapsible menu on mobile'),
			'Switch to light mode': _('Switch to light mode'), 'Switch to dark mode': _('Switch to dark mode'),
			'Close': _('Close'), 'Display mode': _('Display mode'), 'Follow system': _('Follow system'),
			'Light mode': _('Light mode'), 'Dark mode': _('Dark mode'), 'Style presets': _('Style presets'),
			'Color palette': _('Color palette'), 'Surface material': _('Surface material'),
			'Clear content, consistent layers': _('Clear content, consistent layers'),
			'Cards and controls share the material. Traffic and status colors keep their meaning.': _('Cards and controls share the material. Traffic and status colors keep their meaning.'),
			'Small card': _('Small card'), 'Your network': _('Your network'),
			'Preview input': _('Preview input'), 'Primary action': _('Primary action'),
			'Saved in this browser': _('Saved in this browser'),
			'Storage unavailable; appearance applies for this session only': _('Storage unavailable; appearance applies for this session only')
		};
		return labels[text] || text;
	}
	function read(key) { try { return localStorage.getItem(key); } catch (e) { storageAvailable = false; return null; } }
	function write(key, value) {
		try { if (value === 'auto') localStorage.removeItem(key); else localStorage.setItem(key, value); }
		catch (e) { storageAvailable = false; }
	}
	function valid(value, catalog, fallback) { return catalog.some(item => item.id === value) ? value : fallback; }
	function mode(value) { return value === 'light' || value === 'dark' ? value : 'auto'; }
	function layout(value) { return value === 'top' ? 'top' : 'sidebar'; }
	function load() {
		state.mode = mode(read(keys.mode));
		state.accent = valid(read(keys.accent), palettes, 'macaron');
		state.material = valid(read(keys.material), materials, 'glass');
		state.layout = layout(read(keys.layout));
	}
	function apply() {
		const theme = state.mode === 'auto' ? (system && system.matches ? 'dark' : 'light') : state.mode;
		const palette = palettes.find(item => item.id === state.accent);
		root.dataset.theme = theme;
		root.dataset.darkmode = String(theme === 'dark');
		root.dataset.themeMode = state.mode;
		root.dataset.accent = state.accent;
		root.dataset.material = state.material;
		root.dataset.layout = state.layout;
		root.dataset.palette = palette.secondary ? 'multi' : 'single';
		root.style.setProperty('--accent-light', palette.light);
		root.style.setProperty('--accent-dark', palette.dark);
		root.style.setProperty('--secondary-light', palette.secondary || palette.light);
		root.style.setProperty('--secondary-dark', palette.secondaryDark || palette.dark);
		root.style.setProperty('--tertiary-light', palette.tertiary || palette.light);
		root.style.setProperty('--tertiary-dark', palette.tertiaryDark || palette.dark);
		const channels = palette.light.slice(1).match(/.{2}/g).map(hex => {
			const value = parseInt(hex, 16) / 255;
			return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
		});
		const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
		root.style.setProperty('--accent-light-ink', 1.05 / (luminance + .05) >= 4.5 ? '#ffffff' : '#17202e');
		sync();
		document.dispatchEvent(new CustomEvent('zenappearancechange', { detail: { ...state, theme } }));
	}
	function set(next) {
		if (Object.prototype.hasOwnProperty.call(next, 'mode')) { state.mode = mode(next.mode); write(keys.mode, state.mode); }
		if (Object.prototype.hasOwnProperty.call(next, 'accent')) { state.accent = valid(next.accent, palettes, 'macaron'); write(keys.accent, state.accent); }
		if (Object.prototype.hasOwnProperty.call(next, 'material')) { state.material = valid(next.material, materials, 'glass'); write(keys.material, state.material); }
		if (Object.prototype.hasOwnProperty.call(next, 'layout')) { state.layout = layout(next.layout); write(keys.layout, state.layout); }
		apply();
	}
	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = translate(text);
		return node;
	}
	function wheel(palette) {
		const node = element('span', palette.secondary ? 'appearance-color-wheel' : 'appearance-color-strip');
		node.setAttribute('aria-hidden', 'true');
		node.dataset.swatch = palette.id;
		return node;
	}
	function choice(container, group, value, text, children) {
		const button = element('button', '', text);
		button.type = 'button';
		button.setAttribute('aria-pressed', 'false');
		if (children) { button.replaceChildren(); children.forEach(node => button.appendChild(node)); }
		button.addEventListener('click', () => {
			if (group === 'preset') { const preset = presets.find(item => item.id === value); set({ accent: preset.accent, material: preset.material }); }
			else set({ [group]: value });
		});
		choiceButtons.push({ button, group, value });
		container.appendChild(button);
	}
	function fieldset(label, className) {
		const field = element('fieldset');
		field.appendChild(element('legend', '', label));
		const grid = element('div', className);
		field.appendChild(grid);
		return { field, grid };
	}
	function renderContent(modal) {
		const content = element('div', 'appearance-content');
		const header = element('header');
		const heading = element('div');
		const title = element('h2', '', modal ? 'Theme settings' : 'Appearance & layout');
		if (modal) title.id = 'zen-appearance-title';
		heading.append(title, element('p', '', 'Color, material, display mode and layout are independent. Changes apply immediately.'));
		header.appendChild(heading);
		if (modal) {
			const close = element('button', 'icon', '×'); close.type = 'button'; close.setAttribute('aria-label', translate('Close'));
			close.addEventListener('click', () => dialog.close()); header.appendChild(close);
		}
		content.appendChild(header);
		const modes = fieldset('Display mode', 'appearance-modes');
		[['auto', 'Follow system'], ['light', 'Light mode'], ['dark', 'Dark mode']].forEach(([value, text]) => choice(modes.grid, 'mode', value, text));
		content.appendChild(modes.field);
		const layouts = fieldset('Navigation layout', 'zen-appearance-layouts');
		[['sidebar', 'Left navigation', 'Navigation stays on the left'], ['top', 'Top navigation', 'Horizontal on desktop; collapsible menu on mobile']].forEach(([value, name, description]) => {
			const mini = element('span', 'zen-layout-mini zen-layout-mini-' + value); mini.setAttribute('aria-hidden', 'true');
			mini.append(element('i'), element('i'), element('i'));
			const label = element('span'); label.append(element('strong', '', name), element('small', '', description));
			choice(layouts.grid, 'layout', value, null, [mini, label]);
		}); content.appendChild(layouts.field);
		const schemes = fieldset('Style presets', 'zen-appearance-presets');
		presets.forEach(preset => {
			const palette = palettes.find(item => item.id === preset.accent);
			choice(schemes.grid, 'preset', preset.id, null, [wheel(palette), element('span', '', preset.name)]);
		}); content.appendChild(schemes.field);
		const colors = fieldset('Color palette', 'appearance-swatches');
		palettes.forEach(palette => choice(colors.grid, 'accent', palette.id, null, [wheel(palette), element('span', '', palette.name)]));
		content.appendChild(colors.field);
		const textures = fieldset('Surface material', 'appearance-materials');
		materials.forEach(material => {
			const mini = element('span', 'appearance-mini appearance-mini-' + material.id); mini.setAttribute('aria-hidden', 'true');
			for (let i = 0; i < 3; i++) mini.appendChild(element('i'));
			const description = element('span'); description.append(element('strong', '', material.name), element('small', '', material.description));
			choice(textures.grid, 'material', material.id, null, [mini, description]);
		}); content.appendChild(textures.field);
		const preview = element('div', 'appearance-preview');
		preview.append(element('span'), element('strong', '', 'Clear content, consistent layers'), element('p', '', 'Cards and controls share the material. Traffic and status colors keep their meaning.'));
		const inner = element('div', 'appearance-surface-inner zen-appearance-sample', 'Small card');
		const input = element('input', 'appearance-control'); input.value = translate('Your network'); input.setAttribute('aria-label', translate('Preview input'));
		preview.append(inner, input, element('span', 'appearance-preview-action', 'Primary action'));
		content.appendChild(preview);
		const selectionStatus = element('footer'); selectionStatus.setAttribute('role', 'status'); selectionStatus.setAttribute('aria-live', 'polite');
		content.appendChild(selectionStatus); forms.push({ content, preview, selectionStatus }); sync();
		return content;
	}
	function mount() {
		if (dialog) return;
		dialog = element('dialog', 'appearance-dialog zen-appearance-dialog zen-appearance-host');
		dialog.id = 'zen-appearance-dialog';
		dialog.setAttribute('aria-labelledby', 'zen-appearance-title');
		dialog.appendChild(renderContent(true)); document.body.appendChild(dialog);
		dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
		dialog.addEventListener('close', () => { if (opener && opener.isConnected) opener.focus(); });
		sync();
	}
	function sync() {
		const dark = root.dataset.theme === 'dark';
		document.querySelectorAll('.zen-mode-toggle').forEach(button => {
			const label = translate(dark ? 'Switch to light mode' : 'Switch to dark mode');
			button.setAttribute('aria-label', label); button.setAttribute('title', label);
			const text = button.querySelector('.zen-mode-label');
			if (text) text.textContent = translate(dark ? 'Light mode' : 'Dark mode');
		});
		choiceButtons.forEach(({ button, group, value }) => {
			const preset = group === 'preset' ? presets.find(item => item.id === value) : null;
			button.setAttribute('aria-pressed', String(preset ? state.accent === preset.accent && state.material === preset.material : state[group] === value));
		});
		forms.forEach(({ content, preview, selectionStatus }) => {
			content.querySelectorAll('[data-swatch]').forEach(node => {
				const palette = palettes.find(item => item.id === node.dataset.swatch);
				const main = dark ? palette.dark : palette.light;
				node.style.background = palette.secondary ? `conic-gradient(from -90deg, ${main}, ${dark ? palette.secondaryDark : palette.secondary} 33%, ${dark ? palette.tertiaryDark : palette.tertiary} 67%, ${main})` : main;
			});
			const palette = palettes.find(item => item.id === state.accent), material = materials.find(item => item.id === state.material);
			preview.firstElementChild.textContent = translate(palette.name) + ' · ' + translate(material.name);
			selectionStatus.textContent = translate(storageAvailable ? 'Saved in this browser' : 'Storage unavailable; appearance applies for this session only');
		});
	}
	function open(trigger) { mount(); if (!dialog.open) { opener = trigger || document.activeElement; dialog.showModal(); } }
	load(); apply();
	window.ZenAppearance = Object.freeze({ set, open, render: () => renderContent(false), get: () => ({ ...state, theme: root.dataset.theme }) });
	document.addEventListener('click', event => {
		const toggle = event.target.closest && event.target.closest('.zen-mode-toggle');
		if (toggle) { event.preventDefault(); set({ mode: root.dataset.theme === 'dark' ? 'light' : 'dark' }); return; }
		const trigger = event.target.closest && event.target.closest('.zen-appearance-trigger');
		if (trigger && !trigger.classList.contains('zen-settings-link')) { event.preventDefault(); open(trigger); }
	});
	document.addEventListener('DOMContentLoaded', sync);
	window.addEventListener('storage', event => {
		if (event.key !== null && !Object.values(keys).includes(event.key)) return;
		// Only reload the changed dimension; blocked storage must not erase session choices.
		if (event.key === null) load();
		else if (event.key === keys.mode) state.mode = mode(event.newValue);
		else if (event.key === keys.accent) state.accent = valid(event.newValue, palettes, 'macaron');
		else if (event.key === keys.material) state.material = valid(event.newValue, materials, 'glass');
		else if (event.key === keys.layout) state.layout = layout(event.newValue);
		apply();
	});
	const onSystemChange = () => { if (state.mode === 'auto') apply(); };
	if (system && system.addEventListener) system.addEventListener('change', onSystemChange);
	else if (system && system.addListener) system.addListener(onSystemChange);
})();
