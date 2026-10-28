'use strict';
'require baseclass';
'require rpc';
'require fs';
'require ui';
'require view.zen.zen-update-model as model';
'require view.zen.zen-package-update as packageUpdate';

const boardCall = rpc.declare({ object: 'system', method: 'board' });
const statusCall = rpc.declare({ object: 'zen.traffic', method: 'getStatus' });
const safe = fn => Promise.resolve().then(fn).catch(() => null);
const titles = () => [_('Zen interface'), _('Zen backend')];

async function installedPackages() {
	for (const read of [() => fs.exec_direct('/usr/libexec/package-manager-call', ['list-installed']), () => fs.read_direct('/lib/apk/db/installed'), () => fs.read_direct('/usr/lib/opkg/status')]) {
		try { return model.installed(await read()); } catch (e) { /* Try the installed database on older LuCI. */ }
	}
	return null;
}

function menuNode(tree, route) {
	let node = tree;
	for (const part of route.split('/')) node = node?.children?.[part];
	return node;
}

async function releases() {
	const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetch('https://api.github.com/repos/' + model.REPO + '/releases?per_page=100', {
			credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal
		});
		if (!response.ok) throw Error(response.status === 403 || response.status === 429 ? 'rate' : response.status === 404 ? 'missing' : 'network');
		const body = await response.text();
		if (body.length > 4 * 1024 * 1024) throw Error('response');
		const data = JSON.parse(body);
		if (!Array.isArray(data) || data.length > 100) throw Error('response');
		return data;
	} finally { clearTimeout(timer); }
}

return baseclass.extend({
	build() {
		this.generation = (this.generation || 0) + 1;
		this.busy = false;
		this.values = {};
		this.outputs = {};
		const version = (id, label) => {
			this.values[id] = E('strong', {}, _('Reading…'));
			this.outputs[id] = E('div', { class: 'zen-version-status' });
			return E('div', { class: 'zen-version-item' }, [E('div', { class: 'zen-version-label' }, [E('span', {class:'zen-version-name'}, label), E('div',{class:'zen-version-current'},[E('span',{},_('Current version')),this.values[id]])]), this.outputs[id]]);
		};
		this.refresh = E('button', { class: 'btn zen-update-refresh', type: 'button', click: () => this.reload() }, _('Refresh versions'));
		this.check = E('button', { class: 'btn cbi-button-action zen-update-check', type: 'button', disabled: true, click: () => this.checkUpdates() }, _('Check for updates'));
		this.details = E('p', { class: 'zen-update-note' });
		this.results = E('div', { class: 'zen-update-results', 'aria-live': 'polite', 'aria-atomic': 'true' }, _('Updates have not been checked.'));
		this.links = E('div', { class: 'zen-update-actions zen-update-links' });
		this.updater = Object.create(packageUpdate);
		const progress = this.updater.render(() => this.updateButtons(), async job => {
			await this.reload();
			if (this.lastReleases) for (const name of model.PACKAGES)
				this.outputs[name].replaceChildren(this.result(name, model.select(this.lastReleases, this.board, name)));
			if (job.stage === 'success' && job.package === 'luci-app-zen') {
				this.updater.node.append(E('button', { type: 'button', class: 'btn', click: () => window.location.reload() }, _('Reload page')));
			}
		});
		this.panel = E('section', { id: 'zen-updates', class: 'zen-updates', 'aria-labelledby': 'zen-updates-title' }, [
			E('div', { class: 'zen-update-heading' }, [E('h2', { id: 'zen-updates-title' }, _('Versions & updates')), E('div', { class: 'zen-update-actions' }, [this.refresh, this.check])]),
			E('div', { class: 'zen-version-grid', 'aria-live': 'polite' }, model.PACKAGES.map((name, i) => version(name, titles()[i]))),
			E('div',{class:'zen-update-footer'},[this.details, progress, this.results, this.links])
		]);
		return this.panel;
	},

	start() { this.ready = this.reload(); return this.ready; },
	updateButtons() {
		if (!this.updater) return;
		this.refresh.disabled = this.check.disabled = this.busy || this.updater.busy;
		for (const button of this.panel?.querySelectorAll('.zen-update-install') || [])
			button.disabled = this.busy || this.updater.busy || !this.updater.canWrite;
	},

	async reload() {
		if (this.busy) return;
		const generation = this.generation;
		this.busy = true; this.refresh.disabled = this.check.disabled = true;
		try {
			const [board, packages, menu, status] = await Promise.all([
				safe(boardCall), installedPackages(), safe(() => ui.menu.load()), safe(statusCall)
			]);
			if (generation !== this.generation) return;
			this.board = board || {}; this.packages = packages;
			await this.updater.refresh();
			if (generation !== this.generation) return;
			for (const name of model.PACKAGES) {
				this.values[name].textContent = packages ? packages[name] || _('Not installed') : _('Unable to read');
				this.outputs[name].replaceChildren();
			}
			const notes = [];
			if (status?.version && packages?.['luci-zen'] && model.compare(status.version, packages['luci-zen'].replace(/-(r)?\d+$/, '')) !== 0) notes.push(_('The running traffic service differs from its installed version. Restart the service after upgrading.'));
			this.details.textContent = notes.join(' ');
			this.results.replaceChildren(document.createTextNode(_('Updates have not been checked.')));
			this.links.replaceChildren();
			for (const route of ['admin/system/package-manager', 'admin/system/software']) {
				const node = menuNode(menu, route);
				if (!node) continue;
				const url = L.url(...route.split('/'));
				const href = url + (url.includes('?') ? '&' : '?') + 'query=zen';
				this.links.append(E('a', { class: 'btn', href }, _('Manage Zen packages') + (node.readonly ? ' · ' + _('Read only') : '')));
				break;
			}
			if (!this.links.childElementCount) this.links.append(E('span', { class: 'zen-update-note' }, _('Package management is unavailable for this account.')));
			this.links.append(E('a', { href: 'https://github.com/' + model.REPO + '/releases', target: '_blank', rel: 'noopener noreferrer' }, _('View releases')));
		} finally { if (generation === this.generation) { this.busy = false; this.updateButtons(); } }
	},

	async checkUpdates() {
		if (this.busy) return;
		const generation = this.generation;
		this.busy = true; this.check.disabled = this.refresh.disabled = true;
		this.results.replaceChildren(document.createTextNode(_('Checking releases…')));
		for (const name of model.PACKAGES) this.outputs[name].replaceChildren();
		try {
			let result;
			try {
				const available = await releases();
				this.lastReleases = available;
				if (generation !== this.generation || !this.panel.isConnected) return;
				for (const name of model.PACKAGES) this.outputs[name].replaceChildren(this.result(name, model.select(available, this.board, name)));
				result = this.panel.querySelector('a[href*="/releases/download/"]') ? E('p', { class: 'zen-update-note' },
					this.updater.available ? _('Updates are downloaded, verified and installed by the router. Keep power connected during installation.') :
					_('Install the new Zen interface once to enable updates directly on the router.')) : null;
			}
			catch (e) { result = E('p', { class: 'zen-update-note' }, e.message === 'rate' ? _('GitHub rate limit reached. Try again later.') : e.message === 'missing' ? _('Release source is unavailable.') : _('Update check failed. Check connectivity and retry.')); }
			if (generation === this.generation && this.panel.isConnected) this.results.replaceChildren(...(result ? [result] : []), E('p', { class: 'zen-update-note' }, _('Last checked: %s').format(new Date().toLocaleString())));
		} finally { if (generation === this.generation) { this.busy = false; this.updateButtons(); } }
	},

	result(name, found) {
		const repo = 'https://github.com/' + model.REPO, items = [];
		const current = this.packages?.[name];
		if (this.packages && !current) return E('div', { class: 'zen-update-result' });
		const messages = { empty: _('No stable releases found.'), metadata: _('Release information is incomplete.'), incompatible: _('No compatible build has been published.') };
		if (found.state !== 'matched') {
			items.push(E('p', {}, messages[found.state]));
			if (found.state === 'incompatible' && name === 'luci-zen') items.push(E('p', { class: 'zen-update-note' }, [this.board.release?.distribution, this.board.release?.version, this.board.release?.target].filter(Boolean).join(' · ')));
		}
		else {
			const m = found.meta;
			const file = m.packages.find(file => file.name === name), cmp = model.compare(current, file.version);
			const state = !this.packages || cmp === null ? _('Unable to compare') : cmp < 0 ? _('Update available') : cmp === 0 ? _('Up to date') : _('Installed version is newer');
			items.push(E('div',{class:'zen-update-state-line'},[
				E('span',{class:'zen-update-state','data-state':cmp===null?'unknown':cmp<0?'available':cmp===0?'current':'newer'},state),
				...(cmp<0&&current?[E('span',{class:'zen-update-target'},file.version)]:[])
			]));
			if (current && cmp < 0) {
				if (this.updater.available) {
					const button = E('button', { class: 'btn cbi-button-action zen-update-install', type: 'button',
						click: () => this.updater.install(name, m.tag) }, this.updater.canWrite ? _('Update') : _('Read only'));
					button.disabled = this.updater.busy || !this.updater.canWrite; items.push(button);
				}
				items.push(E('details', { class: 'zen-update-file' }, [E('summary', {}, _('Package details')), E('span', {}, file.filename), E('code', {}, 'SHA256: ' + file.sha256),
					E('a', { href: repo + '/releases/download/' + encodeURIComponent(m.tag) + '/' + encodeURIComponent(file.filename), target: '_blank', rel: 'noopener noreferrer' }, _('Download APK'))]));
			}
		}
		return E('div', { class: 'zen-update-result' }, items);
	}
});
