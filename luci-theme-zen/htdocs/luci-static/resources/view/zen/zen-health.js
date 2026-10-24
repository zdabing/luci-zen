'use strict';
'require baseclass';
'require fs';

// Read-only router telemetry. Ping is deliberately fixed, never browser-supplied shell text.
const PROBE = '1.1.1.1';
const PROBE_ARGS = ['-n', '-c', '1', '-W', '1', PROBE];
const INTERVAL = 30000;
const safe = (fn, fallback = null) => Promise.resolve().then(fn).catch(() => fallback);
const integer = value => /^\d+$/.test(String(value == null ? '' : value).trim()) ? Number(String(value).trim()) : null;

function ipv4(value) {
	const parts = String(value || '').split('.');
	if (parts.length !== 4 || parts.some(v => !/^\d{1,3}$/.test(v) || Number(v) > 255)) return null;
	return parts.reduce((n, part) => n * 256 + Number(part), 0);
}

function netmask(value) {
	if (/^\d{1,2}$/.test(String(value))) {
		const bits = Number(value);
		return bits <= 32 ? (bits ? (0xffffffff << (32 - bits)) >>> 0 : 0) : null;
	}
	const mask = ipv4(value);
	if (mask == null) return null;
	const inverse = 0xffffffff - mask;
	return ((inverse & (inverse + 1)) >>> 0) === 0 ? mask : null;
}

function prefixes(net) {
	if (!net) return [];
	try {
		const list = typeof net.getIP6Prefixes === 'function' ? net.getIP6Prefixes() : null;
		if (Array.isArray(list) && list.length) return list.filter(v => typeof v === 'string' && v.includes('/'));
		const first = typeof net.getIP6Prefix === 'function' ? net.getIP6Prefix() : null;
		return typeof first === 'string' && first.includes('/') ? [first] : [];
	} catch (e) { return []; }
}

function dhcpUsage(config, leases, lan) {
	if (!config || !Array.isArray(leases && leases.dhcp_leases) || !lan) return { state: 'unavailable' };
	const name = typeof lan.getName === 'function' ? lan.getName() : 'lan';
	const sections = Object.values(config.values || config).filter(s => s && s['.type'] === 'dhcp' && s.interface === name);
	if (!sections.length || sections.every(s => String(s.ignore) === '1' || s.dhcpv4 === 'disabled')) return { state: 'disabled' };
	const address = typeof lan.getIPAddrs === 'function' ? (lan.getIPAddrs() || [])[0] : null;
	const [ip, cidr] = String(address || '').split('/');
	const ipNumber = ipv4(ip);
	const ranges = [];
	let staticOnly = false;
	for (const section of sections) {
		if (String(section.ignore) === '1' || section.dhcpv4 === 'disabled') continue;
		if (String(section.dynamicdhcpv4 ?? section.dynamicdhcp) === '0') { staticOnly = true; continue; }
		const mask = netmask(section.netmask || cidr || (typeof lan.getNetmask === 'function' ? lan.getNetmask() : ''));
		if (ipNumber == null || mask == null) return { state: 'unavailable' };
		const base = (ipNumber & mask) >>> 0, broadcast = base + (0xffffffff - mask);
		let start = integer(section.start == null ? 100 : section.start);
		if (start == null) { const absolute = ipv4(section.start); start = absolute == null ? null : absolute & (0xffffffff - mask); }
		const limit = integer(section.limit == null ? 150 : section.limit);
		if (start == null || limit == null || !limit) return { state: 'unavailable' };
		const low = Math.max(base + 1, base + start), high = Math.min(broadcast - 1, base + start + limit - 1);
		if (low <= high) ranges.push([low, high]);
	}
	if (!ranges.length) return { state: staticOnly ? 'static' : 'unavailable' };
	ranges.sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const [low, high] of ranges) {
		const last = merged[merged.length - 1];
		if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
		else merged.push([low, high]);
	}
	const used = new Set();
	for (const lease of leases.dhcp_leases) {
		// LuCI reports an unlimited lease as boolean false; numeric zero is expired.
		if (lease.expires !== false && lease.expires != null && Number(lease.expires) <= 0) continue;
		const address = ipv4(lease.ipaddr);
		if (address != null && merged.some(([low, high]) => address >= low && address <= high)) used.add(address);
	}
	return { state: 'ok', used: used.size, total: merged.reduce((sum, [low, high]) => sum + high - low + 1, 0) };
}

function pingResult(result) {
	if (!result || result.code == null) return { state: 'unavailable', target: PROBE };
	const match = String(result.stdout || '').match(/time\s*([=<])\s*([\d.]+)\s*ms/i);
	if (Number(result.code) === 0 && match && Number.isFinite(Number(match[2])))
		return { state: 'ok', ms: Number(match[2]), lessThan: match[1] === '<', target: PROBE };
	return { state: Number(result.code) === 1 ? 'timeout' : 'unavailable', target: PROBE };
}

return baseclass.extend({
	prefixes, dhcpUsage, pingResult,
	async temperature() {
		const zones = await safe(() => fs.list('/sys/class/thermal'), []);
		const values = await Promise.all(zones.filter(zone => /^thermal_zone\d+$/.test(zone.name)).map(async zone => {
			const root = '/sys/class/thermal/' + zone.name;
			const [raw, type] = await Promise.all([safe(() => fs.read(root + '/temp')), safe(() => fs.read(root + '/type'), '')]);
			if (raw == null || !/^-?\d+$/.test(String(raw).trim())) return null;
			const celsius = Number(raw) / 1000;
			return celsius >= -40 && celsius <= 150 ? { celsius, sensor: String(type).trim(), path: root + '/temp' } : null;
		}));
		const available = values.filter(Boolean);
		if (!available.length) {
			const devices = await safe(() => fs.list('/sys/class/hwmon'), []);
			for (const device of devices.filter(d => /^hwmon\d+$/.test(d.name)).slice(0, 32)) {
				const root = '/sys/class/hwmon/' + device.name;
				const [entries, chip] = await Promise.all([safe(() => fs.list(root), []), safe(() => fs.read(root + '/name'), '')]);
				for (const entry of entries.filter(e => /^temp\d+_input$/.test(e.name)).slice(0, 32)) {
					const [raw, label] = await Promise.all([safe(() => fs.read(root + '/' + entry.name)), safe(() => fs.read(root + '/' + entry.name.replace('_input', '_label')), '')]);
					if (raw == null || !/^-?\d+$/.test(String(raw).trim())) continue;
					const celsius = Number(raw) / 1000;
					if (celsius >= -40 && celsius <= 150) available.push({ celsius, sensor: [chip, label].map(v => String(v).trim()).filter(Boolean).join(' · '), path: root + '/' + entry.name });
				}
			}
		}
		const cpu = available.filter(v => /cpu|soc|package|x86_pkg|coretemp|k10temp/i.test(v.sensor));
		return (cpu.length ? cpu : available).sort((a, b) => b.celsius - a.celsius)[0] || null;
	},
	async read(wanUp) {
		const now = Date.now();
		const slow = this.lastSlow == null || now - this.lastSlow >= INTERVAL || now < this.lastSlow;
		if (slow) this.lastSlow = now;
		if (!wanUp) { this.latencyValue = { state: 'offline', target: PROBE }; this.probedUp = false; }
		const probe = wanUp && (slow || !this.probedUp);
		if (probe) this.probedUp = true;
		const [count, maximum, temperature, latency] = await Promise.all([
			safe(() => fs.read('/proc/sys/net/netfilter/nf_conntrack_count')),
			safe(() => fs.read('/proc/sys/net/netfilter/nf_conntrack_max')),
			slow ? this.temperature() : this.temperatureValue,
			probe ? safe(() => fs.exec('/bin/ping', PROBE_ARGS)).then(pingResult) : this.latencyValue
		]);
		this.temperatureValue = temperature || null;
		this.latencyValue = latency || { state: 'unavailable', target: PROBE };
		return { connections: integer(count), connectionLimit: integer(maximum), temperature: this.temperatureValue, latency: this.latencyValue };
	}
});
