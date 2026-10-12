'use strict';
'require baseclass';
'require rpc';

const status = rpc.declare({ object: 'zen.update', method: 'status', reject: true });
const start = rpc.declare({ object: 'zen.update', method: 'start', params: ['package', 'tag'], reject: true });
const access = rpc.declare({ object: 'session', method: 'access', params: ['scope', 'object', 'function'], reject: true });
const stages = () => ({ queued: _('Preparing update…'), checking: _('Checking package…'), downloading: _('Downloading on router…'),
	verifying: _('Verifying package…'), installing: _('Installing package…'), restarting: _('Restarting traffic service…'),
	success: _('Update completed.'), failed: _('Update failed.') });
const errors = () => ({ busy: _('Another update is running.'), invalid_request: _('Invalid update request.'),
	apk_required: _('This updater requires an APK-based OpenWrt system.'), not_installed: _('The selected package is not installed.'),
	incompatible: _('The package does not match this router.'), checksum: _('Package verification failed; nothing was installed.'),
	download: _('Download failed. Check the router internet connection and retry.'), download_size: _('The download size does not match.'),
	no_space: _('Not enough temporary space on the router.'), not_newer: _('The selected version is no longer newer.'),
	package_manager_busy: _('The system package manager is busy. Try again later.'),
	install: _('The package manager could not install the update.'), version: _('The installed version could not be verified.'),
	restart: _('The package was installed, but the traffic service could not start.'),
	interrupted: _('The update was interrupted. Refresh versions before retrying.'), launch: _('Unable to start the update service.') });

return baseclass.extend({
	render(onChange, onDone) {
		clearTimeout(this.timer); this.generation = (this.generation || 0) + 1;
		this.onChange = onChange; this.onDone = onDone;
		this.busy = false; this.available = false; this.canWrite = false; this.finished = '';
		this.text = E('p', { role: 'status', class: 'zen-update-note' });
		this.log = E('pre', { class: 'zen-update-log', hidden: true });
		this.node = E('div', { class: 'zen-update-progress', hidden: true }, [this.text, this.log]);
		return this.node;
	},
	async refresh() {
		const generation = this.generation;
		const [state, permission] = await Promise.all([status().catch(() => null), access('ubus', 'zen.update', 'start').catch(() => null)]);
		if (generation !== this.generation) return;
		this.available = state?.available === true && state?.ok !== false; this.canWrite = permission?.access === true;
		if (state) this.show(state);
		this.onChange?.();
		if (state?.busy) this.watch();
	},
	show(state) {
		this.busy = !!state.busy; this.job = state.job || {};
		this.node.hidden = !this.job.stage;
		this.text.textContent = (this.job.package ? this.job.package + (this.job.version ? ' → ' + this.job.version : '') + ' · ' : '') +
			(stages()[this.job.stage] || '') + (this.job.error ? ' ' + (errors()[this.job.error] || _('Unable to complete the update.')) : '');
		this.log.hidden = !this.job.details; this.log.textContent = this.job.details || '';
		this.onChange?.();
	},
	async install(name, tag) {
		if (this.busy || !this.available || !this.canWrite) return;
		this.busy = true; this.onChange?.(); this.node.hidden = false; this.log.hidden = true;
		this.text.textContent = _('Preparing update…');
		const generation = this.generation;
		try {
			const reply = await start(name, tag);
			if (generation !== this.generation) return;
			if (!reply?.ok) throw Error(errors()[reply?.error] || _('Unable to start the update service.'));
			this.show(reply); this.watch();
		} catch (error) {
			if (generation !== this.generation) return;
			// A lost response can occur while rpcd reloads. Resume the server job before allowing a retry.
			try {
				const state = await status();
				if (generation !== this.generation) return;
				if (state?.busy || (state?.job?.package === name && state.job.tag === tag && state.job.started >= Date.now() / 1000 - 30)) {
					this.show(state); this.watch(); return;
				}
			} catch (e) {}
			this.busy = false; this.text.textContent = error.message || _('Unable to start the update service.'); this.onChange?.();
		}
	},
	watch() {
		clearTimeout(this.timer);
		const generation = this.generation;
		const tick = async () => {
			if (generation !== this.generation || !this.node.isConnected) return;
			try {
				const state = await status();
				if (!state?.available || state.ok === false) throw Error('status');
				if (generation !== this.generation || !this.node.isConnected) return;
				this.show(state);
				if (!state.busy) {
					if (state.job?.id && this.finished !== state.job.id) { this.finished = state.job.id; await this.onDone?.(state.job); }
					return;
				}
			} catch (e) { this.text.textContent = _('Reconnecting to the update service…'); }
			this.timer = setTimeout(tick, 2000);
		};
		this.timer = setTimeout(tick, 1000);
	}
});
