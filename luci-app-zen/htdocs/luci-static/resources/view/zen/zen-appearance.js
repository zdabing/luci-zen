'use strict';
'require baseclass';
'require rpc';

const callSet = rpc.declare({ object: 'uci', method: 'set', params: ['config', 'section', 'values'], reject: true });
const callCommit = rpc.declare({ object: 'uci', method: 'commit', params: ['config'], reject: true });

return baseclass.extend({
	__init__() {
		if (!window.ZenAppearance) return;
		window.ZenAppearance.connect(async values => {
			await callSet('zen', 'appearance', { ...values, saved: '1' });
			await callCommit('zen');
		});
	}
});
