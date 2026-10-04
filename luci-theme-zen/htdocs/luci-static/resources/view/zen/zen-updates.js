'use strict';
'require baseclass';
'require rpc';
'require fs';
'require ui';
'require view.zen.zen-update-model as model';

const boardCall = rpc.declare({ object: 'system', method: 'board' });
const luciCall = rpc.declare({ object: 'luci', method: 'getVersion' });
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

async function releases(kind) {
	const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
	try {
		const response = await fetch('https://api.github.com/repos/' + model.REPOS[kind] + '/releases?per_page=100', {
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
			E('div', { class: 'zen-version-grid' }, [version('firmware', _('Router firmware')), version('kernel', _('Kernel')), version('luci', 'LuCI'), ...model.PACKAGES.map((name, i) => version(name, titles()[i]))]),
			this.details, this.results, this.links,
			E('p', { class: 'zen-update-note' }, _('Checks use public GitHub releases for Zen and 10Wrt. Component installation and firmware backup, validation and flashing continue in OpenWrt.'))
		]);
		return this.panel;
	},

	start() { this.ready = this.reload(); return this.ready; },

	async reload() {
		if (this.busy) return;
		const generation = this.generation;
		this.busy = true; this.refresh.disabled = this.check.disabled = true;
		try {
			const [board, luci, packages, identityText, menu, status] = await Promise.all([
				safe(boardCall), safe(luciCall), installedPackages(), safe(() => fs.read('/usr/share/10wrt/release.json')), safe(() => ui.menu.load()), safe(statusCall)
			]);
			if (generation !== this.generation) return;
			this.board = board || {}; this.packages = packages; this.identity = null;
			try {
				const id = JSON.parse(identityText);
				if (id.schema === 1 && id.repo === model.REPOS.firmware && id.target === board?.release?.target && typeof id.profile === 'string' && id.profile === model.profile(this.board, null) && typeof id.tag === 'string' && Number.isSafeInteger(id.build_number) && id.build_number > 0) this.identity = id;
			} catch (e) { /* Older and non-10Wrt firmware has no build identity. */ }
			this.values.firmware.textContent = board?.release?.description || board?.release?.version || _('Unknown');
			this.values.kernel.textContent = board?.kernel || _('Unknown');
			this.values.luci.textContent = [luci?.branch, luci?.revision].filter(Boolean).join(' / ') || _('Unknown');
			for (const name of model.PACKAGES) this.values[name].textContent = packages ? packages[name] || _('Not installed') : _('Unable to read');
			const notes = [this.identity ? '10Wrt: ' + this.identity.tag : _('10Wrt build identity is unavailable; firmware freshness cannot be determined.')];
			const versions = packages && model.PACKAGES.map(name => packages[name]).filter(Boolean);
			if (versions && new Set(versions).size > 1) notes.push(_('Zen package versions differ. Upgrade the three components together.'));
			if (status?.version && packages?.['zen-traffic'] && model.compare(status.version, packages['zen-traffic'].replace(/-(r)?\d+$/, '')) !== 0) notes.push(_('The running traffic service differs from its installed version. Restart the service after upgrading.'));
			this.details.textContent = notes.join(' ');
			this.results.replaceChildren(document.createTextNode(_('Updates have not been checked.')));
			this.links.replaceChildren();
			const routes = [['admin/system/package-manager', _('Manage Zen packages'), true], ['admin/system/software', _('Manage Zen packages'), true], ['admin/system/flash', _('Backup / flash firmware'), false]];
			let packageLink = false;
			for (const [route, label, pkg] of routes) {
				const node = menuNode(menu, route);
				if (!node || (pkg && packageLink)) continue;
				const url = L.url(...route.split('/'));
				const href = url + (pkg ? (url.includes('?') ? '&' : '?') + 'query=zen' : '');
				this.links.append(E('a', { class: 'btn', href }, label + (node.readonly ? ' · ' + _('Read only') : '')));
				if (pkg) packageLink = true;
			}
			if (!this.links.childElementCount) this.links.append(E('span', { class: 'zen-update-note' }, _('Upgrade pages are unavailable for this account.')));
		} finally { if (generation === this.generation) { this.busy = false; this.refresh.disabled = this.check.disabled = false; } }
	},

	async checkUpdates() {
		if (this.busy) return;
		const generation = this.generation;
		this.busy = true; this.check.disabled = this.refresh.disabled = true;
		this.results.replaceChildren(document.createTextNode(_('Checking releases…')));
		try {
			const results = await Promise.all(['zen', 'firmware'].map(async kind => {
				try { return this.result(kind, model.select(await releases(kind), kind, this.board, this.identity)); }
				catch (e) { return E('div', { class: 'zen-update-result' }, [E('h3', {}, kind === 'zen' ? _('Zen components') : _('10Wrt firmware')), E('p', {}, e.message === 'rate' ? _('GitHub rate limit reached. Try again later.') : e.message === 'missing' ? _('Release source is unavailable.') : _('Update check failed. Check connectivity and retry.'))]); }
			}));
			if (generation === this.generation && this.panel.isConnected) this.results.replaceChildren(...results, E('p', { class: 'zen-update-note' }, _('Last checked: %s').format(new Date().toLocaleString())));
		} finally { if (generation === this.generation) { this.busy = false; this.check.disabled = this.refresh.disabled = false; } }
	},

	result(kind, found) {
		const repo = 'https://github.com/' + model.REPOS[kind], items = [E('h3', {}, kind === 'zen' ? _('Zen components') : _('10Wrt firmware'))];
		const messages = { empty: _('No stable releases found.'), metadata: _('Release metadata is missing. Compatibility and freshness cannot be determined.'), incompatible: _('No compatible release found for this router.') };
		if (found.state !== 'matched') items.push(E('p', {}, messages[found.state]));
		else {
			const m = found.meta;
			items.push(E('p', {}, m.tag + ' · ' + m.target + (kind === 'zen' ? ' · OpenWrt ' + m.sdk_version : '')));
			if (kind === 'zen') for (const file of m.packages) {
				const current = this.packages?.[file.name], cmp = model.compare(current, file.version);
				const state = !this.packages ? _('Unable to compare') : !current ? _('Not installed') : cmp === null ? _('Unable to compare') : cmp < 0 ? _('Update available') : cmp === 0 ? _('Up to date') : _('Installed version is newer');
				items.push(E('p', {}, file.name + ': ' + (current || _('Unknown')) + ' → ' + file.version + ' · ' + state));
			}
			else {
				const id = this.identity;
				const state = !id ? _('Compatible image available; current build is unknown.') : id.tag === m.tag ? _('Up to date') : id.build_number < m.build_number ? _('Update available') : id.build_number > m.build_number ? _('Installed version is newer') : _('Unable to compare');
				items.push(E('p', {}, state));
			}
			items.push(E('p', { class: 'zen-update-note' }, kind === 'zen' ? _('Download the three matching APKs, then use Manage Zen packages to upload and install them. Do not bypass dependency or signature checks.') : _('Choose the correct filesystem image, download it, then use Backup / flash firmware. OpenWrt validates the image before confirmation.')));
			for (const file of (kind === 'zen' ? m.packages : m.files)) items.push(E('details', { class: 'zen-update-file' }, [E('summary', {}, file.filename), E('a', { href: repo + '/releases/download/' + encodeURIComponent(m.tag) + '/' + encodeURIComponent(file.filename), target: '_blank', rel: 'noopener noreferrer' }, _('Download')), E('code', {}, 'SHA256: ' + file.sha256)]));
		}
		items.push(E('a', { href: repo + '/releases' + (found.meta ? '/tag/' + encodeURIComponent(found.meta.tag) : ''), target: '_blank', rel: 'noopener noreferrer' }, _('View releases')));
		return E('div', { class: 'zen-update-result' }, items);
	}
});
