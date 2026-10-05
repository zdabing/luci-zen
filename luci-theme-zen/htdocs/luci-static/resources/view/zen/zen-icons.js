'use strict';
'require baseclass';

/*
 * view.zen.zen-icons — 统一 SVG 图标集 + 设备类型推断（无识别数据库）。
 *
 * 图标 = 内联 <symbol> sprite（一次注入 body），行内 <svg><use> 引用，
 * stroke 1.8 / currentColor，随主题色变化。类型推断只用 hostname/conn 关键词，
 * 无法识别返回 unknown。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* 9 类设备 + 连接方式 + 界面符号；24 viewBox，stroke 风格统一 */
const SYMBOLS = {
	'zen-i-sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
	'zen-i-moon': '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
	'zen-i-appearance': '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="8" r="1"/><circle cx="14" cy="6" r="1"/><circle cx="17" cy="11" r="1"/><path d="M12 21c-2-3 0-4 2-5s1-3-1-3H9"/>',
	'zen-i-status': '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m6 13 3-4 3 6 3-4h3"/>',
	'zen-i-system': '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
	'zen-i-services': '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
	'zen-i-network': '<rect x="8" y="3" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="7" height="5" rx="1.5"/><rect x="15" y="16" width="7" height="5" rx="1.5"/><path d="M12 9v4M5.5 16v-3h13v3"/>',
	'zen-i-menu': '<path d="M4 6h16M4 12h16M4 18h16"/>',
	'zen-i-desktop': '<rect x="2" y="3.5" width="20" height="13" rx="2.5"/><path d="M8 20.5h8M12 16.5v4"/>',
	'zen-i-laptop': '<rect x="4" y="4" width="16" height="11.5" rx="2"/><path d="M2 19.5h20"/>',
	'zen-i-phone': '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
	'zen-i-tablet': '<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
	'zen-i-nas': '<rect x="3" y="3" width="18" height="5.4" rx="1.6"/><rect x="3" y="9.3" width="18" height="5.4" rx="1.6"/><rect x="3" y="15.6" width="18" height="5.4" rx="1.6"/><path d="M6.4 5.7h.01M6.4 12h.01M6.4 18.3h.01"/>',
	'zen-i-tv': '<rect x="2.5" y="6.5" width="19" height="13" rx="2.5"/><path d="M8 2.8 12 6.5l4-3.7"/>',
	'zen-i-router': '<rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6.01 17.5h-.01M10.01 17.5h-.01M15 13.5v-2M17.8 8.2a5 5 0 0 0-7 0M20.4 5.6a8.5 8.5 0 0 0-12 0"/>',
	'zen-i-iot': '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
	'zen-i-unknown': '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="12" cy="12" r="3.2"/>',
	'zen-i-wifi': '<path d="M12 19.5h.01M8.6 16a5 5 0 0 1 6.8 0M5.2 12.5a10 10 0 0 1 13.6 0M2 9a15 15 0 0 1 20 0"/>',
	'zen-i-eth': '<path d="m15 20 3-3h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2l3 3z"/><path d="M6 8v1M10 8v1M14 8v1M18 8v1"/>',
	'zen-i-chev': '<path d="m9 6 6 6-6 6"/>'
};

let injected = false;

function mountSymbols() {
	if (injected || !document.body)
		return;

	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('xmlns', SVG_NS);
	svg.setAttribute('width', '0');
	svg.setAttribute('height', '0');
	svg.style.position = 'absolute';
	svg.style.overflow = 'hidden';
	svg.setAttribute('aria-hidden', 'true');

	for (const id in SYMBOLS) {
		const sym = document.createElementNS(SVG_NS, 'symbol');
		sym.setAttribute('id', id);
		sym.setAttribute('viewBox', '0 0 24 24');
		sym.setAttribute('fill', 'none');
		sym.setAttribute('stroke', 'currentColor');
		sym.setAttribute('stroke-width', '1.8');
		sym.setAttribute('stroke-linecap', 'round');
		sym.setAttribute('stroke-linejoin', 'round');
		try {
			sym.innerHTML = SYMBOLS[id];
		} catch (e) {
			/* 极老环境无 innerHTML on SVG：降级为不渲染该符号 */
			continue;
		}
		svg.appendChild(sym);
	}

	document.body.appendChild(svg);
	injected = true;
}

function icon(id, size) {
	mountSymbols();
	if (!SYMBOLS[id])
		id = 'zen-i-unknown';

	const s = document.createElementNS(SVG_NS, 'svg');
	s.setAttribute('width', size || 16);
	s.setAttribute('height', size || 16);
	s.setAttribute('viewBox', '0 0 24 24');
	s.setAttribute('aria-hidden', 'true');
	const u = document.createElementNS(SVG_NS, 'use');
	u.setAttribute('href', '#' + id);
	s.appendChild(u);
	return s;
}

/* 设备类型推断：hostname 关键词 → conn 兜底 → unknown（与 ARCHITECTURE.md §7 一致） */
const HOST_RULES = [
	[/yeelink|zhimi|tmall[-_ ]?genie|haier|midea|^mico$|watch|plug|bulb|lamp|sensor|cam|thermostat|vacuum|roborock|echo|homepod|switchbot/i, 'iot'],
	[/iphone|android|realme|samsung|galaxy|iqoo|redmi|xiaomi|pixel|oneplus|oppo|vivo|honor|huawei|harmony|phone/i, 'phone'],
	[/ipad|tablet|kindle|tab[-_ ]?\d/i, 'tablet'],
	[/macbook|laptop|thinkpad|notebook|xps|ideapad/i, 'laptop'],
	[/nas|ugreen|\bdxp\d+|synology|qnap|diskstation|truenas|unraid|storage/i, 'nas'],
	[/\btv\b|atv|apple\s?tv|firetv|mi-?box|projector|tivo|box$/i, 'tv'],
	[/router|repeater|openwrt|mikrotik|^ap[-_ ]?/i, 'router'],
	[/desktop|^pc\b|win\d|-pc$|desk/i, 'desktop']
];

function inferType(host, conn) {
	const h = String(host || '');
	for (let i = 0; i < HOST_RULES.length; i++)
		if (HOST_RULES[i][0].test(h))
			return HOST_RULES[i][1];
	if (conn === 'router')
		return 'router';
	return 'unknown';
}

const ICON_BY_TYPE = {
	desktop: 'zen-i-desktop',
	laptop: 'zen-i-laptop',
	phone: 'zen-i-phone',
	tablet: 'zen-i-tablet',
	nas: 'zen-i-nas',
	tv: 'zen-i-tv',
	router: 'zen-i-router',
	iot: 'zen-i-iot',
	unknown: 'zen-i-unknown'
};

function typeIcon(type, size) {
	return icon(ICON_BY_TYPE[type] || ICON_BY_TYPE.unknown, size);
}

/* 连接方式展示：wifi→频段（由频道号推断），router→下级路由，其余→有线 */
function bandOf(ch) {
	const c = Number(ch) || 0;
	if (c < 1)
		return null;
	if (c <= 14)
		return '2.4GHz';
	if (c <= 165)
		return '5GHz';
	return '6GHz';
}

function connGlyph(conn, ch) {
	if (conn === 'wifi')
		return { icon: 'zen-i-wifi', band: bandOf(ch) };
	if (conn === 'router')
		return { icon: 'zen-i-router', band: null };
	return { icon: 'zen-i-eth', band: null };
}

return baseclass.extend({
	mountSymbols: mountSymbols,
	icon: icon,
	inferType: inferType,
	typeIcon: typeIcon,
	connGlyph: connGlyph,
	bandOf: bandOf,
	ICON_BY_TYPE: ICON_BY_TYPE
});
