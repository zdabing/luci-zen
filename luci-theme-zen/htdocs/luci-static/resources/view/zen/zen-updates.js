'use strict';
'require baseclass';
'require rpc';
'require fs';
'require ui';
'require view.zen.zen-update-model as model';

const boardCall = rpc.declare({ object: 'system', method: 'board' });
const statusCall = rpc.declare({ object: 'zen.traffic', method: 'getStatus' });
const safe = fn => Promise.resolve().then(fn).catch(() => null);
const titles = () => [_('Zen theme'), _('Zen traffic interface'), _('Zen traffic service')];

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
		const version = (id, label) => {
			this.values[id] = E('strong', {}, _('Reading…'));
			return E('div', { class: 'zen-version-item' }, [E('span', {}, label), this.values[id]]);
		};
		this.refresh = E('button', { class: 'btn', type: 'button', click: () => this.reload() }, _('Refresh versions'));
		this.check = E('button', { class: 'btn cbi-button-action', type: 'button', disabled: true, click: () => this.checkUpdates() }, _('Check for updates'));
		this.details = E('p', { class: 'zen-update-note' });
		this.results = E('div', { class: 'zen-update-results', 'aria-live': 'polite', 'aria-atomic': 'true' }, _('Updates have not been checked.'));
		this.links = E('div', { class: 'zen-update-actions' });
		this.panel = E('section', { id: 'zen-updates', class: 'zen-updates', 'aria-labelledby': 'zen-updates-title' }, [
			E('div', { class: 'zen-update-heading' }, [E('div', {}, [E('h2', { id: 'zen-updates-title' }, _('Versions & updates')), E('p', { class: 'zen-update-note' }, _('Installed versions are read from this router.'))]), E('div', { class: 'zen-update-actions' }, [this.refresh, this.check])]),
			E('div', { class: 'zen-version-grid' }, model.PACKAGES.map((name, i) => version(name, titles()[i]))),
			this.details, this.results, this.links,
			E('p', { class: 'zen-update-note' }, _('Checks use public GitHub releases for Zen packages. Install updates through OpenWrt package management.'))
		]);
		return this.panel;
	},

	start() { this.ready = this.reload(); return this.ready; },

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
			for (const name of model.PACKAGES) this.values[name].textContent = packages ? packages[name] || _('Not installed') : _('Unable to read');
			const notes = [];
			if (status?.version && packages?.['zen-traffic'] && model.compare(status.version, packages['zen-traffic'].replace(/-(r)?\d+$/, '')) !== 0) notes.push(_('The running traffic service differs from its installed version. Restart the service after upgrading.'));
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
		} finally { if (generation === this.generation) { this.busy = false; this.refresh.disabled = this.check.disabled = false; } }
	},

	async checkUpdates() {
		if (this.busy) return;
		const generation = this.generation;
		this.busy = true; this.check.disabled = this.refresh.disabled = true;
		this.results.replaceChildren(document.createTextNode(_('Checking releases…')));
		try {
			let result;
			try {
				const available = await releases();
				result = E('div', {}, model.PACKAGES.map(name => this.result(name, model.select(available, this.board, name))));
			}
			catch (e) { result = E('div', { class: 'zen-update-result' }, [E('h3', {}, _('Zen components')), E('p', {}, e.message === 'rate' ? _('GitHub rate limit reached. Try again later.') : e.message === 'missing' ? _('Release source is unavailable.') : _('Update check failed. Check connectivity and retry.'))]); }
			if (generation === this.generation && this.panel.isConnected) this.results.replaceChildren(result, E('p', { class: 'zen-update-note' }, _('Last checked: %s').format(new Date().toLocaleString())));
		} finally { if (generation === this.generation) { this.busy = false; this.check.disabled = this.refresh.disabled = false; } }
	},

	result(name, found) {
		const repo = 'https://github.com/' + model.REPO, items = [E('h3', {}, titles()[model.PACKAGES.indexOf(name)])];
		const current = this.packages?.[name];
		if (this.packages && !current) return E('div', { class: 'zen-update-result' }, [...items, E('p', {}, name + ' · ' + _('Not installed'))]);
		const messages = { empty: _('No stable releases found.'), metadata: _('Release metadata is missing. Compatibility and freshness cannot be determined.'), incompatible: _('No compatible release found for this router.') };
		if (found.state !== 'matched') items.push(E('p', {}, messages[found.state]));
		else {
			const m = found.meta;
			items.push(E('p', {}, m.tag + (name === 'zen-traffic' ? ' · ' + m.target + ' · OpenWrt ' + m.sdk_version : '')));
			const file = m.packages.find(file => file.name === name), cmp = model.compare(current, file.version);
			const state = !this.packages || cmp === null ? _('Unable to compare') : cmp < 0 ? _('Update available') : cmp === 0 ? _('Up to date') : _('Installed version is newer');
			items.push(E('p', {}, name + ': ' + (current || _('Unknown')) + ' → ' + file.version + ' · ' + state));
			if (current) {
				items.push(E('p', { class: 'zen-update-note' }, _('Download this APK, then use Manage Zen packages to upload and install it.')));
				items.push(E('details', { class: 'zen-update-file' }, [E('summary', {}, file.filename), E('a', { href: repo + '/releases/download/' + encodeURIComponent(m.tag) + '/' + encodeURIComponent(file.filename), target: '_blank', rel: 'noopener noreferrer' }, _('Download')), E('code', {}, 'SHA256: ' + file.sha256)]));
			}
		}
		items.push(E('a', { href: repo + '/releases' + (found.meta ? '/tag/' + encodeURIComponent(found.meta.tag) : ''), target: '_blank', rel: 'noopener noreferrer' }, _('View releases')));
		return E('div', { class: 'zen-update-result' }, items);
	}
});
