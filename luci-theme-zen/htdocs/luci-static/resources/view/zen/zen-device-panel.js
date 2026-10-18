'use strict';
'require baseclass';

/* A single detail surface, outside the dashboard's container-query stacking
 * context. Native dialog provides focus trapping, Escape and modal semantics. */
let current;

function close() {
	if (current) { const dialog = current; dialog.close(); dialog.zenCleanup(); }
}

function open(options) {
	close();
	const trigger = document.activeElement;
	const dialog = E('dialog', { 'class': 'zen-device-drawer', 'aria-labelledby': 'zen-device-drawer-title' });
	const button = E('button', { type: 'button', 'class': 'zen-drawer-close', 'aria-label': _('Close details'), click: close }, '×');
	dialog.appendChild(E('div', { 'class': 'zen-drawer-heading' }, [
		E('div', {}, [E('p', { 'class': 'zen-drawer-eyebrow' }, [_('Device details')]),
			E('h2', { id: 'zen-device-drawer-title' }, [options.title]),
			E('p', { 'class': 'zen-drawer-subtitle' }, [options.subtitle || ''])]), button
	]));
	dialog.appendChild(E('div', { 'class': 'zen-drawer-body' }, options.content));
	dialog.appendChild(E('div', { 'class': 'zen-drawer-footer' }, options.actions || []));
	dialog.addEventListener('click', ev => {
		if (ev.target !== dialog) return;
		const box = dialog.getBoundingClientRect();
		if (ev.clientX < box.left || ev.clientX > box.right || ev.clientY < box.top || ev.clientY > box.bottom) close();
	});
	let cleaned = false;
	dialog.zenCleanup = () => {
		if (cleaned) return;
		cleaned = true;
		if (current === dialog) current = null;
		document.body.classList.remove('zen-drawer-active');
		if (options.onClose) options.onClose();
		dialog.remove();
		if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
	};
	dialog.addEventListener('close', dialog.zenCleanup, { once: true });
	document.body.appendChild(dialog);
	current = dialog;
	document.body.classList.add('zen-drawer-active');
	dialog.showModal();
	button.focus({ preventScroll: true });
	return dialog;
}

return baseclass.extend({ open, close });
