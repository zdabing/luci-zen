'use strict';
'require baseclass';

const PACKAGES = ['luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic'];
const REPO = 'zdabing/luci-zen';

// Installed APK JSON, APK database and opkg status. Never infer a package
// revision from the daemon's (revision-less) Cargo version.
function installed(text) {
	const result = Object.create(null);
	if (text.trim().startsWith('[')) {
		const rows = JSON.parse(text);
		if (!Array.isArray(rows)) throw Error('packages');
		for (const row of rows) if (PACKAGES.includes(row?.name)) {
			if (typeof row.version !== 'string' || !row.version.trim()) throw Error('packages');
			result[row.name] = row.version;
		}
		return result;
	}
	if (!/^(P:|Package: )/m.test(text)) throw Error('packages');
	for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
		const apk = /^P:(.+)$/m.exec(block), opkg = /^Package: (.+)$/m.exec(block);
		const name = (apk || opkg || [])[1];
		const version = (apk ? /^V:(.+)$/m : /^Version: (.+)$/m).exec(block);
		if (PACKAGES.includes(name) && version && (apk || /^Status: \S+ \S+ installed\s*$/m.test(block))) result[name] = version[1];
	}
	return result;
}

function compare(a, b) {
	// Deliberately bounded to our published numeric versions. Unknown apk/opkg
	// epochs, git versions and prereleases are not reported as up to date.
	const parse = value => /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-(?:r)?(\d{1,9}))?$/.exec(value || '');
	const x = parse(a), y = parse(b);
	if (!x || !y) return null;
	for (let i = 1; i <= 4; i++) {
		const d = Number(x[i] || 0) - Number(y[i] || 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

function metadata(release) {
	if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') return null;
	const match = /<!-- zen-update-metadata\s+([\s\S]*?)\s*-->/.exec(release.body || '');
	if (!match || match[1].length > 65536) return null;
	try {
		const m = JSON.parse(match[1]);
		if (m.schema !== 1 || m.repo !== REPO || m.tag !== release.tag_name || typeof m.target !== 'string') return null;
		const rows = m.packages;
		if (!Array.isArray(rows) || !rows.length || rows.length > PACKAGES.length) return null;
		const assets = release.assets || [];
		const names = new Set();
		const packageNames = new Set();
		for (const file of rows) {
			if (!PACKAGES.includes(file.name) || packageNames.has(file.name) || compare(file.version, file.version) !== 0 || !file.filename?.endsWith('.apk')) return null;
			if (typeof file.filename !== 'string' || !/^[\w.+-]+$/.test(file.filename) || names.has(file.filename) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) return null;
			if (!assets.some(a => a.name === file.filename && a.size === file.size && a.state === 'uploaded' && (!a.digest || a.digest === 'sha256:' + file.sha256))) return null;
			names.add(file.filename);
			packageNames.add(file.name);
		}
		if (packageNames.has('zen-traffic') && !m.sdk_version) return null;
		if (m.compatible_systems !== undefined) {
			if (!Array.isArray(m.compatible_systems) || !m.compatible_systems.length || m.compatible_systems.length > 32) return null;
			const seen = new Set();
			for (const system of m.compatible_systems) {
				if (!system || !['OpenWrt', 'ImmortalWrt'].includes(system.distribution) || typeof system.version !== 'string' || !/^[A-Za-z0-9.+_-]{1,80}$/.test(system.version) || system.target !== m.target) return null;
				const key = system.distribution + '@' + system.version;
				if (seen.has(key)) return null;
				seen.add(key);
			}
		}
		return m;
	} catch (e) { return null; }
}

function select(releases, board, name) {
	if (!Array.isArray(releases)) throw Error('response');
	if (!PACKAGES.includes(name)) throw Error('package');
	const stable = releases.filter(r => r && !r.draft && !r.prerelease).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
	const candidates = stable.map(release => ({ release, meta: metadata(release) })).filter(c => c.meta);
	const target = board.release?.target;
	// The two LuCI packages contain no target binaries (PKGARCH=all).
	// Only the native daemon needs a matching target and SDK version.
	const match = candidates.find(c => c.meta.packages.some(file => file.name === name) &&
		(name !== 'zen-traffic' || (c.meta.compatible_systems ? c.meta.compatible_systems.some(system =>
			system.target === target && system.version === board.release?.version && system.distribution === board.release?.distribution)
			: (c.meta.target === target && c.meta.sdk_version === board.release?.version))));
	// A newer legacy/malformed release must not make an older structured release
	// appear to be the latest. Fail closed when its compatibility is unknown.
	const unknown = stable.find(r => !metadata(r));
	// Even when no native build matches, an older legacy release must not
	// obscure a newer validated build's known target/SDK incompatibility.
	const reference = match || candidates.find(c => c.meta.packages.some(file => file.name === name));
	if (unknown && (!reference || stable.indexOf(unknown) < stable.indexOf(reference.release))) return { state: 'metadata' };
	if (match) return { ...match, state: 'matched' };
	return { state: !stable.length ? 'empty' : !candidates.length ? 'metadata' : 'incompatible' };
}

return baseclass.extend({ PACKAGES, REPO, installed, compare, metadata, select });
