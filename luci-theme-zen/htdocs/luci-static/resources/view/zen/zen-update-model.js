'use strict';
'require baseclass';

const PACKAGES = ['luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic'];
const REPOS = { zen: 'zdabing/luci-zen', firmware: 'zdabing/10Wrt' };

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

function profile(board, identity) {
	if (identity && identity.schema === 1 && identity.repo === REPOS.firmware && identity.target === board.release?.target) return identity.profile;
	if (board.release?.target === 'x86/64' && /^(generic|x86)/.test(board.board_name || '')) return 'generic';
	return (board.board_name || '').replace(/,/g, '_');
}

function metadata(release, kind) {
	if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') return null;
	const marker = kind === 'zen' ? 'zen-update-metadata' : '10wrt-update-metadata';
	const match = new RegExp('<!-- ' + marker + '\\s+([\\s\\S]*?)\\s*-->').exec(release.body || '');
	if (!match || match[1].length > 65536) return null;
	try {
		const m = JSON.parse(match[1]);
		if (m.schema !== 1 || m.repo !== REPOS[kind] || m.tag !== release.tag_name || typeof m.target !== 'string') return null;
		const rows = kind === 'zen' ? m.packages : m.files;
		if (!Array.isArray(rows) || !rows.length || rows.length > 30) return null;
		const assets = release.assets || [];
		const names = new Set();
		for (const file of rows) {
			if (typeof file.filename !== 'string' || !/^[\w.+-]+$/.test(file.filename) || names.has(file.filename) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) return null;
			if (!assets.some(a => a.name === file.filename && a.size === file.size && a.state === 'uploaded' && (!a.digest || a.digest === 'sha256:' + file.sha256))) return null;
			names.add(file.filename);
		}
		if (kind === 'zen' && (!m.sdk_version || rows.length !== 3 || !PACKAGES.every(name => rows.filter(p => p.name === name && compare(p.version, p.version) === 0 && p.filename.endsWith('.apk')).length === 1))) return null;
		if (kind === 'firmware' && (typeof m.profile !== 'string' || !Number.isSafeInteger(m.build_number) || m.build_number < 1 || !rows.every(f => /-sysupgrade\.(img(?:\.gz)?|bin|tar(?:\.gz)?)$/.test(f.filename) || (m.target === 'x86/64' && m.profile === 'generic' && /-combined(?:-efi)?\.img(?:\.gz)?$/.test(f.filename))))) return null;
		return m;
	} catch (e) { return null; }
}

function select(releases, kind, board, identity) {
	if (!Array.isArray(releases)) throw Error('response');
	const firmwareProfile = profile(board, identity);
	const prefix = firmwareProfile === 'friendlyarm_nanopi-r5c' ? 'r5c-' : firmwareProfile === 'generic' ? 'x86_64-' : null;
	const stable = releases.filter(r => r && !r.draft && !r.prerelease && (kind !== 'firmware' || !prefix || r.tag_name?.startsWith(prefix))).sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
	const candidates = stable.map(release => ({ release, meta: metadata(release, kind) })).filter(c => c.meta);
	const target = board.release?.target;
	const match = candidates.find(c => c.meta.target === target && (kind === 'zen' ? c.meta.sdk_version === board.release?.version : c.meta.profile === profile(board, identity)));
	// A newer legacy/malformed release must not make an older structured release
	// appear to be the latest. Fail closed when its compatibility is unknown.
	const unknown = stable.find(r => !metadata(r, kind));
	if (unknown && (!match || stable.indexOf(unknown) < stable.indexOf(match.release))) return { state: 'metadata' };
	if (match) return { ...match, state: 'matched' };
	return { state: !stable.length ? 'empty' : !candidates.length ? 'metadata' : 'incompatible' };
}

return baseclass.extend({ PACKAGES, REPOS, installed, compare, profile, metadata, select });
