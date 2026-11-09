'use strict';
'require view';
'require view.zen.dashboard as dashboard';
'require view.zen.zen-console-home as consoleHome';

/* Owns a LuCI view at admin/zen/realtime. The stock overview keeps its original route. */
return view.extend({
	render() {
		const dash = dashboard.build();
		const startConsole = typeof window !== 'undefined' && window.ZenConsole?.enabled
			? consoleHome.build(dash, dashboard) : null;
		// LuCI inserts the returned node into #view; start only after insertion.
		requestAnimationFrame(() => {
			if (dash.isConnected) {
				dashboard.start(dash);
				startConsole?.().catch(error => console.warn('zen-console-home', error));
			}
		});
		return dash;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
