'use strict';
'require view';
'require view.zen.zen-updates as updates';

// One settings destination. Appearance preferences are saved on the router;
// router version reads and manual checks live only in the updates tab.
return view.extend({
	render() {
		const appearance = E('section', { id: 'zen-settings-appearance', class: 'zen-settings-panel zen-appearance-host', role: 'tabpanel', 'aria-labelledby': 'zen-settings-tab-appearance' },
			window.ZenAppearance ? window.ZenAppearance.render() : E('p', {}, _('Appearance controls are available when using the Zen theme.')));
		const versions = E('section', { id: 'zen-settings-versions', class: 'zen-settings-panel', role: 'tabpanel', 'aria-labelledby': 'zen-settings-tab-versions', hidden: true });
		let active = new URLSearchParams(window.location.search).get('tab') === 'updates' ? 'versions' : 'appearance', started = false;
		const buttons = {};
		const select = (name, focus, remember) => {
			active = name;
			appearance.hidden = name !== 'appearance'; versions.hidden = name !== 'versions';
			for (const key of ['appearance', 'versions']) {
				buttons[key].setAttribute('aria-selected', String(key === name));
				buttons[key].tabIndex = key === name ? 0 : -1;
			}
			if (focus) buttons[name].focus();
			if (remember) {
				const url = new URL(window.location.href);
				if (name === 'versions') url.searchParams.set('tab', 'updates'); else url.searchParams.delete('tab');
				window.history.replaceState(null, '', url);
			}
			if (name === 'versions' && versions.isConnected && !started) {
				started = true; versions.appendChild(updates.build()); updates.start();
			}
		};
		for (const [name, label] of [['appearance', _('Appearance & layout')], ['versions', _('Versions & updates')]]) {
			buttons[name] = E('button', { id: 'zen-settings-tab-' + name, type: 'button', role: 'tab', 'aria-controls': 'zen-settings-' + name, 'aria-selected': 'false', tabindex: -1, click: () => select(name, false, true), keydown: event => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
				event.preventDefault();
				select(event.key === 'Home' ? 'appearance' : event.key === 'End' ? 'versions' : active === 'appearance' ? 'versions' : 'appearance', true, true);
			} }, label);
		}
		const root = E('div', { id: 'zen-settings', class: 'zen-settings-page' }, [
			E('h2', {}, _('Zen settings')),
			E('div', { class: 'zen-settings-tabs', role: 'tablist', 'aria-label': _('Zen settings') }, [buttons.appearance, buttons.versions]), appearance, versions
		]);
		select(active);
		requestAnimationFrame(() => { if (root.isConnected) select(active); });
		return root;
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
