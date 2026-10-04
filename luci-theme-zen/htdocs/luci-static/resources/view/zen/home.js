'use strict';
'require view';
'require view.zen.dashboard as dashboard';

/* Owns a LuCI view at admin/zen. The stock overview keeps its original route. */
return view.extend({
	render() {
		const dash = dashboard.build();
		// LuCI inserts the returned node into #view; start only after insertion.
		requestAnimationFrame(() => {
			if (dash.isConnected) dashboard.start(dash);
		});
		return dash;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
