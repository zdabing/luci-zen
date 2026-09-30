'use strict';
'require view';

return view.extend({
	render() {
		const source = document.getElementById('zen-login-source');
		const form = source.querySelector('form');
		const btn = source.querySelector('button.important');
		const pwd = form.querySelector('#luci_password');
		const messages = Array.from(source.querySelectorAll(':scope > .alert-message'));
		const host = source.getAttribute('data-hostname') || 'OpenWrt';
		document.body.classList.add('zen-login-page');

		const theme = E('button', { type: 'button', 'class': 'zen-login-theme' });
		const syncTheme = () => {
			const dark = document.documentElement.getAttribute('data-theme') === 'dark';
			theme.textContent = dark ? _('Light mode') : _('Dark mode');
			theme.setAttribute('aria-label', dark ? _('Switch to light mode') : _('Switch to dark mode'));
		};
		theme.addEventListener('click', () => {
			const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
			document.documentElement.setAttribute('data-theme', next);
			document.documentElement.setAttribute('data-darkmode', String(next === 'dark'));
			try { localStorage.setItem('luci-theme-zen', next); } catch (e) { /* private mode */ }
			syncTheme();
		});
		syncTheme();

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
				theme
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
