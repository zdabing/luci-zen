'use strict';
'require baseclass';
'require ui';
'require view.zen.zen-icons as icons';

const STORAGE_KEY = 'luci-theme-zen';
const SIDEBAR_KEY = 'luci-theme-zen-sidebar';
const MOBILE_BP = 768;
const MENU_ICONS = {
	status: 'zen-i-status',
	system: 'zen-i-system',
	services: 'zen-i-services',
	network: 'zen-i-network'
};

function currentTheme() {
	return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme);
	document.documentElement.setAttribute('data-darkmode', theme === 'dark' ? 'true' : 'false');
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch (e) { /* private mode */ }
	syncThemeToggle();
}

function syncThemeToggle() {
	const dark = currentTheme() === 'dark';
	const label = document.getElementById('theme-toggle-label');
	if (label)
		label.textContent = dark ? _('Light mode') : _('Dark mode');

	const btn = document.getElementById('theme-toggle');
	if (btn) {
		btn.setAttribute('title', dark ? _('Switch to light mode') : _('Switch to dark mode'));
		btn.setAttribute('aria-label', dark ? _('Switch to light mode') : _('Switch to dark mode'));
	}
}

function bindThemeToggle() {
	const btn = document.getElementById('theme-toggle');
	if (btn) {
		btn.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
		});
	}

	syncThemeToggle();

	const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
	if (!mq)
		return;

	const onSystemChange = (e) => {
		try {
			if (!localStorage.getItem(STORAGE_KEY)) {
				document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
				document.documentElement.setAttribute('data-darkmode', e.matches ? 'true' : 'false');
				syncThemeToggle();
			}
		} catch (err) { /* ignore */ }
	};

	if (mq.addEventListener)
		mq.addEventListener('change', onSystemChange);
	else if (mq.addListener)
		mq.addListener(onSystemChange);
}

return baseclass.extend({
	__init__() {
		bindThemeToggle();
		ui.menu.load().then((tree) => this.render(tree)).catch((e) => {
			console.warn('menu load failed:', e);
			const loading = document.querySelector('.main > .loading');
			if (loading) {
				loading.style.opacity = '0';
				loading.style.visibility = 'hidden';
			}
			ui.addNotification(null, E('p', _('Menu failed to load. Please refresh the page to retry.')), 'error');
		});
		if (document.body.getAttribute('data-page') === 'admin-status-overview')
			L.require('view.zen.dashboard');
	},

	render(tree) {
		this.renderModeMenu(tree);

		let node = tree;
		let url = '';

		if (L.env.dispatchpath.length >= 3) {
			for (let i = 0; i < 3 && node; i++) {
				node = node.children[L.env.dispatchpath[i]];
				url = url + (url ? '/' : '') + L.env.dispatchpath[i];
			}

			if (node)
				this.renderTabMenu(node, url);
		}

		const showSide = document.querySelector('.showSide');
		const darkMask = document.querySelector('.darkMask');
		if (showSide)
			showSide.addEventListener('click', ui.createHandlerFn(this, 'handleSidebarToggle'));
		if (darkMask)
			darkMask.addEventListener('click', ui.createHandlerFn(this, 'handleSidebarMask'));

		const loading = document.querySelector('.main > .loading');
		if (loading) {
			loading.style.opacity = '0';
			loading.style.visibility = 'hidden';
		}

		if (window.innerWidth <= MOBILE_BP)
			this.setSidebarOpen(false);
		else
			this.setDesktopCollapsed(this.readDesktopCollapsed());

		window.addEventListener('resize', () => {
			clearTimeout(this._resizeTimer);
			this._resizeTimer = setTimeout(() => this.handleSidebarResize(), 100);
		});
		window.addEventListener('keydown', ev => {
			if (ev.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
				this.setSidebarOpen(false);
				if (showSide) showSide.focus();
			}
		});
	},

	handleMenuExpand(ev) {
		const a = ev.currentTarget;
		const li = a.parentNode;
		const submenu = a.nextElementSibling;

		document.querySelectorAll('li.slide.active').forEach((el) => {
			if (el !== li) {
				el.classList.remove('active');
				if (el.firstElementChild)
					el.firstElementChild.classList.remove('active');
			}
		});

		if (!submenu)
			return;

		const willOpen = !li.classList.contains('active');
		li.classList.toggle('active', willOpen);
		a.classList.toggle('active', willOpen);
		a.blur();

		ev.preventDefault();
		ev.stopPropagation();
	},

	renderMainMenu(tree, url, level) {
		const l = (level || 0) + 1;
		const ul = E('ul', { 'class': level ? 'slide-menu' : 'nav' });
		const children = ui.menu.getChildren(tree);

		if (children.length == 0 || l > 2)
			return E([]);

		children.forEach(child => {
			if (child.name === 'logout')
				return;

			const submenu = this.renderMainMenu(child, url + '/' + child.name, l);
			const isActive = (L.env.dispatchpath[l] == child.name);
			const hasChildren = submenu.children.length;

			ul.appendChild(E('li', { 'class': (hasChildren ? 'slide' + (isActive ? ' active' : '') : (isActive ? ' active' : '')) }, [
				E('a', {
					'href': hasChildren ? '#' : L.url(url, child.name),
					'class': hasChildren ? 'menu' + (isActive ? ' active' : '') : (isActive ? 'active' : ''),
					'click': hasChildren ? ui.createHandlerFn(this, 'handleMenuExpand') : '',
					'data-title': _(child.title),
					'aria-current': !hasChildren && isActive ? 'page' : null,
				}, [
					...(l === 1 ? [icons.icon(MENU_ICONS[child.name] || 'zen-i-menu', 18)] : []),
					E('span', { 'class': 'zen-menu-label' }, _(child.title))
				]),
				submenu
			]));
		});

		if (l == 1) {
			const container = document.querySelector('#mainmenu');
			const footer = container.querySelector('.sidebar-footer');
			const toggle = document.getElementById('theme-toggle');
			if (footer)
				container.insertBefore(ul, footer);
			else if (toggle)
				container.insertBefore(ul, toggle);
			else
				container.appendChild(ul);
			container.style.display = '';
		}

		return ul;
	},

	renderModeMenu(tree) {
		const ul = document.querySelector('#modemenu');
		if (!ul)
			return;

		const children = ui.menu.getChildren(tree);

		children.forEach((child, index) => {
			const isActive = L.env.requestpath.length
				? child.name === L.env.requestpath[0]
				: index === 0;

			ul.appendChild(E('li', {}, [
				E('a', {
					'href': L.url(child.name),
					'class': isActive ? 'active' : ''
				}, [ _(child.title) ])
			]));

			if (isActive)
				this.renderMainMenu(child, child.name);
		});

		if (children.length > 1 && ul.parentElement)
			ul.parentElement.style.display = '';
	},

	renderTabMenu(tree, url, level) {
		const container = document.querySelector('#tabmenu');
		const l = (level || 0) + 1;
		const ul = E('ul', { 'class': 'tabs' });
		const children = ui.menu.getChildren(tree);
		let activeNode = null;

		if (children.length == 0)
			return E([]);

		children.forEach(child => {
			const isActive = (L.env.dispatchpath[l + 2] == child.name);
			const activeClass = isActive ? ' active' : '';
			const className = 'tabmenu-item-%s %s'.format(child.name, activeClass);

			ul.appendChild(E('li', { 'class': className }, [
				E('a', { 'href': L.url(url, child.name) }, [
					_(child.title)
				])
			]));

			if (isActive)
				activeNode = child;
		});

		container.appendChild(ul);
		container.style.display = '';

		if (activeNode)
			container.appendChild(this.renderTabMenu(activeNode, url + '/' + activeNode.name, l));

		return ul;
	},

	setSidebarOpen(open) {
		const darkMask = document.querySelector('.darkMask');
		const mainRight = document.querySelector('.main-right');
		const mainLeft = document.querySelector('.main-left');
		if (!mainLeft)
			return;

		document.body.classList.toggle('sidebar-open', open);
		const toggle = document.querySelector('.showSide');
		if (toggle) toggle.setAttribute('aria-expanded', String(open));

		if (darkMask) {
			darkMask.style.visibility = open ? 'visible' : '';
			darkMask.style.opacity = open ? 1 : '';
		}

		mainLeft.style.width = '';
		mainLeft.style.visibility = '';

		if (mainRight)
			mainRight.style['overflow-y'] = open && window.innerWidth <= MOBILE_BP ? 'hidden' : '';
	},

	readDesktopCollapsed() {
		try {
			return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
		} catch (e) {
			return false;
		}
	},

	setDesktopCollapsed(collapsed) {
		document.body.classList.toggle('sidebar-collapsed', collapsed);
		const toggle = document.querySelector('.showSide');
		if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
		try {
			localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open');
		} catch (e) { /* private mode */ }
	},

	handleSidebarToggle(ev) {
		if (window.innerWidth > MOBILE_BP)
			this.setDesktopCollapsed(!document.body.classList.contains('sidebar-collapsed'));
		else
			this.setSidebarOpen(!document.body.classList.contains('sidebar-open'));

		if (ev) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	},

	handleSidebarMask(ev) {
		if (window.innerWidth <= MOBILE_BP)
			this.setSidebarOpen(false);

		if (ev) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	},

	handleSidebarResize() {
		if (window.innerWidth > MOBILE_BP) {
			this.setSidebarOpen(false);
			this.setDesktopCollapsed(this.readDesktopCollapsed());
		}
	}
});
