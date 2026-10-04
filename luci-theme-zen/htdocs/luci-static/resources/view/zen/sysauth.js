'use strict';
'require view';
'require view.zen.zen-icons as icons';

return view.extend({
	render() {
		const source = document.getElementById('zen-login-source');
		const form = source.querySelector('form');
		const btn = source.querySelector('button.important');
		const pwd = form.querySelector('#luci_password');
		const messages = Array.from(source.querySelectorAll(':scope > .alert-message'));
		const host = source.getAttribute('data-hostname') || 'OpenWrt';
		document.body.classList.add('zen-login-page');

		const theme = E('button', {
			type: 'button', 'class': 'zen-login-theme zen-appearance-trigger',
			'aria-label': _('Theme settings'), 'aria-haspopup': 'dialog',
			'aria-controls': 'zen-appearance-dialog'
		}, [icons.icon('zen-i-appearance', 18), E('span', { 'class': 'zen-appearance-label' }, _('Theme settings'))]);
		const dark = document.documentElement.dataset.theme === 'dark';
		const quickMode = E('button', {
			type: 'button', 'class': 'theme-toggle zen-mode-toggle',
			'aria-label': dark ? _('Switch to light mode') : _('Switch to dark mode'),
			title: dark ? _('Switch to light mode') : _('Switch to dark mode')
		}, [
			E('span', { 'class': 'theme-icon theme-icon-sun' }, icons.icon('zen-i-sun', 18)),
			E('span', { 'class': 'theme-icon theme-icon-moon' }, icons.icon('zen-i-moon', 18)),
			E('span', { 'class': 'zen-mode-label' }, dark ? _('Light mode') : _('Dark mode'))
		]);

		if (pwd) {
			const reveal = E('button', {
				type: 'button', 'class': 'zen-login-reveal',
				'aria-controls': 'luci_password', 'aria-pressed': 'false'
			}, _('Show password'));
			reveal.addEventListener('click', () => {
				const show = pwd.type === 'password';
				pwd.type = show ? 'text' : 'password';
				reveal.textContent = show ? _('Hide password') : _('Show password');
				reveal.setAttribute('aria-pressed', String(show));
			});
			pwd.parentNode.classList.add('zen-login-password');
			pwd.parentNode.appendChild(reveal);
		}

		messages.forEach((message, i) => {
			message.setAttribute('role', 'alert');
			message.id = 'zen-login-message-' + i;
		});
		if (pwd && messages.length)
			pwd.setAttribute('aria-describedby', messages.map(m => m.id).join(' '));
		btn.type = 'submit';
		btn.classList.add('zen-login-submit');
		form.appendChild(btn);
		let submitting = false;
		form.addEventListener('submit', ev => {
			ev.preventDefault();
			if (submitting)
				return;
			submitting = true;
			btn.disabled = true;
			form.setAttribute('aria-busy', 'true');
			btn.replaceChildren(E('span', { 'class': 'spinning', role: 'status' }, _('Logging in…')));
			form.submit();
		});

		requestAnimationFrame(() => { if (pwd) pwd.focus(); });
		return E('main', { 'class': 'zen-login-shell' }, [
			E('div', { 'class': 'zen-login-topbar' }, [
				E('span', { 'class': 'zen-login-brand' }, [E('span', { 'class': 'zen-login-mark', 'aria-hidden': 'true' }, 'Z'), 'OpenWrt']),
				E('div', { 'class': 'zen-header-actions' }, [quickMode, theme])
			]),
			E('section', { 'class': 'zen-login-card', 'aria-labelledby': 'zen-login-title' }, [
				E('div', { 'class': 'zen-login-heading' }, [
					E('span', { 'class': 'zen-login-host' }, host),
					E('h1', { id: 'zen-login-title' }, _('Welcome back')),
					E('p', {}, _('Sign in to manage your network.'))
				]),
				...messages,
				form
			]),
			E('p', { 'class': 'zen-login-footer' }, 'OpenWrt · LuCI · Zen')
		]);
	},

	addFooter() {},
});
