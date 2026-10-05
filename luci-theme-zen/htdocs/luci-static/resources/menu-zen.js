'use strict';
'require baseclass';
'require ui';
'require view.zen.zen-icons as icons';

const SIDEBAR_KEY = 'luci-theme-zen-sidebar';
const MOBILE_BP = 768;
const MENU_ICONS = {
	zen: 'zen-i-status',
	status: 'zen-i-status',
	system: 'zen-i-system',
	services: 'zen-i-services',
	network: 'zen-i-network'
};

return baseclass.extend({
	__init__() {
		ui.menu.load().then((tree) => this.render(tree)).catch((e) => {
			console.warn('menu load failed:', e);
			const loading = document.querySelector('.main > .loading');
			if (loading) {
				loading.style.opacity = '0';
				loading.style.visibility = 'hidden';
			}
			ui.addNotification(null, E('p', _('Menu failed to load. Please refresh the page to retry.')), 'error');
		});
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
		document.addEventListener('click', ev => {
			if (this.isTopNavigation() && !ev.target.closest('#mainmenu')) this.closeTopMenus();
		});
		document.addEventListener('zenappearancechange', () => {
			const layout = document.documentElement.dataset.layout;
			if (layout !== this._layout) {
				this._layout = layout;
				this.setSidebarOpen(false);
				this.handleSidebarResize();
			}
		});

		const loading = document.querySelector('.main > .loading');
		if (loading) {
			loading.style.opacity = '0';
			loading.style.visibility = 'hidden';
		}

		if (window.innerWidth <= MOBILE_BP)
			this.setSidebarOpen(false);
		else
			this.setDesktopCollapsed(this.readDesktopCollapsed());
		this._layout = document.documentElement.dataset.layout;
		this.syncNavigationPlacement();
		this.syncMenuExpansion();

		window.addEventListener('resize', () => {
			clearTimeout(this._resizeTimer);
			this._resizeTimer = setTimeout(() => this.handleSidebarResize(), 100);
		});
		window.addEventListener('keydown', ev => {
			if (ev.key === 'Escape' && this.isTopNavigation()) {
				const open = document.querySelector('#mainmenu .zen-menu-open > a');
				if (open) { this.closeTopMenus(); open.focus(); ev.preventDefault(); }
			}
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
		if (this.isTopNavigation()) {
			const open = !li.classList.contains('zen-menu-open');
			this.closeTopMenus();
			li.classList.toggle('zen-menu-open', open);
			a.setAttribute('aria-expanded', String(open));
			if (open && submenu) {
				submenu.style.left = ''; submenu.style.right = '';
				if (submenu.getBoundingClientRect().right > window.innerWidth - 16) {
					submenu.style.left = 'auto'; submenu.style.right = '0';
				}
			}
			ev.preventDefault(); ev.stopPropagation();
			return;
		}

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
		this.syncMenuExpansion();

		ev.preventDefault();
		ev.stopPropagation();
	},

	isTopNavigation() {
		return document.documentElement.dataset.layout === 'top' && window.innerWidth > MOBILE_BP;
	},

	syncNavigationPlacement() {
		const menu = document.querySelector('#mainmenu');
		const header = document.querySelector('body > header .container');
		if (!menu || !header) return;
		if (!this._menuHome) this._menuHome = { parent: menu.parentNode, next: menu.nextSibling };
		if (this.isTopNavigation()) {
			if (menu.parentNode !== header) header.insertBefore(menu, header.querySelector('#indicators'));
		} else if (menu.parentNode !== this._menuHome.parent) {
			const next = this._menuHome.next;
			this._menuHome.parent.insertBefore(menu, next && next.parentNode === this._menuHome.parent ? next : null);
		}
	},

	syncMenuExpansion() {
		document.querySelectorAll('#mainmenu .slide > .menu').forEach(a => {
			a.setAttribute('aria-expanded', String(a.parentNode.classList.contains(this.isTopNavigation() ? 'zen-menu-open' : 'active')));
		});
	},

	closeTopMenus() {
		document.querySelectorAll('#mainmenu .zen-menu-open').forEach(li => li.classList.remove('zen-menu-open'));
		document.querySelectorAll('#mainmenu .slide-menu').forEach(ul => { ul.style.left = ''; ul.style.right = ''; });
		this.syncMenuExpansion();
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
			const title = url === 'admin/status' && child.name === 'overview' ? _('OpenWrt overview') : _(child.title);

			const submenu = this.renderMainMenu(child, url + '/' + child.name, l);
			const isActive = (L.env.dispatchpath[l] == child.name);
			const hasChildren = submenu.children.length;

			ul.appendChild(E('li', { 'class': (hasChildren ? 'slide' + (isActive ? ' active' : '') : (isActive ? ' active' : '')) }, [
				E('a', {
					'href': hasChildren ? '#' : L.url(url, child.name),
					'class': hasChildren ? 'menu' + (isActive ? ' active' : '') : (isActive ? 'active' : ''),
					'click': hasChildren ? ui.createHandlerFn(this, 'handleMenuExpand') : '',
					'data-title': title,
					'title': l === 1 ? title : null,
					'aria-label': l === 1 ? title : null,
					'aria-current': !hasChildren && isActive ? 'page' : null,
					'aria-expanded': hasChildren ? String(!this.isTopNavigation() && isActive) : null,
				}, [
					...(l === 1 ? [icons.icon(MENU_ICONS[child.name] || 'zen-i-menu', 18)] : []),
					E('span', { 'class': 'zen-menu-label' }, title)
				]),
				submenu
			]));
		});

		if (l == 1) {
			const container = document.querySelector('#mainmenu');
			const footer = container.querySelector('.sidebar-footer');
			if (footer)
				container.insertBefore(ul, footer);
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
		if (toggle) toggle.setAttribute('aria-expanded', String(this.isTopNavigation() || !collapsed));
		try {
			localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'open');
		} catch (e) { /* private mode */ }
	},

	handleSidebarToggle(ev) {
		if (this.isTopNavigation()) return;
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
		this.closeTopMenus();
		this.syncNavigationPlacement();
		if (window.innerWidth > MOBILE_BP) {
			this.setSidebarOpen(false);
			this.setDesktopCollapsed(this.readDesktopCollapsed());
		}
	}
});
