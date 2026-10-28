'use strict';
'require view';
'require view.zen.dashboard as dashboard';

/* Owns a LuCI view at admin/zen/realtime. The stock overview keeps its original route. */
return view.extend({
	render() {
		const dash = dashboard.build();
		// LuCI inserts the returned node into #view; start only after insertion.
		requestAnimationFrame(() => {
			if (dash.isConnected) {
				dashboard.start(dash);
				if(typeof window!=='undefined'&&window.ZenConsole?.enabled)
					Promise.allSettled([dashboard.ready,dashboard.devicesReady]).then(()=>L.require('view.zen.zen-console-home'))
						.then(module=>module.mount(dash,dashboard)).catch(error=>console.warn('zen-console-home',error));
			}
		});
		return dash;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
