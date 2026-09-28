// .po ↔ 源码字符串一致性校验（开发辅助，不进入包）
const fs = require('fs');
const path = require('path');
const root = process.argv[2] || '.';

const po = fs.readFileSync(path.join(root, 'po/zh_Hans/theme.po'), 'utf8');
const ids = [];
const re = /msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)/g;
let m;
while ((m = re.exec(po))) {
	const s = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]).join('');
	if (s !== '') ids.push(s);
}

const files = [
	'htdocs/luci-static/resources/view/zen/dashboard.js',
	'htdocs/luci-static/resources/view/zen/zen-devices.js',
	'htdocs/luci-static/resources/view/zen/zen-format.js',
	'htdocs/luci-static/resources/view/zen/zen-icons.js',
	'htdocs/luci-static/resources/menu-zen.js',
	'htdocs/luci-static/resources/view/zen/sysauth.js',
	'ucode/template/themes/zen/header.ut',
	'ucode/template/themes/zen/footer.ut',
	'ucode/template/themes/zen/sysauth.ut'
];

const used = new Set();
for (const f of files) {
	const p = path.join(root, f);
	if (!fs.existsSync(p)) continue;
	const t = fs.readFileSync(p, 'utf8');
	for (const mm of t.matchAll(/_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g))
		used.add(mm[1]);
}

const idset = new Set(ids);
const missing = [...used].filter(s => !idset.has(s));
const obsolete = ids.filter(s => !used.has(s));

console.log('PO msgids:', ids.length, '| source strings:', used.size);
console.log('missing in .po:', JSON.stringify(missing, null, 1));
console.log('obsolete in .po:', JSON.stringify(obsolete, null, 1));
if (missing.length) process.exitCode = 1;
