// .po ↔ 源码字符串一致性校验（开发辅助，不进入包）
const fs = require('fs');
const path = require('path');
const root = process.argv[2] || '.';

const poDir = path.join(root, 'po/zh_Hans');
const ids = [];
const translated = new Map();
for (const file of fs.readdirSync(poDir).filter(f => f.endsWith('.po'))) {
 const po = fs.readFileSync(path.join(poDir, file), 'utf8');
 let id = '', value = '', field = null;
 const flush = () => {
  if (id) { ids.push(id); translated.set(id, value); }
  id = ''; value = ''; field = null;
 };
 for (const line of (po + '\n').split(/\r?\n/)) {
  const m = line.match(/^(msgid|msgstr)\s+(".*")$/);
  if (m) {
   if (m[1] === 'msgid') flush();
   field = m[1];
   if (field === 'msgid') id = JSON.parse(m[2]);
   else value = JSON.parse(m[2]);
  } else if (/^"/.test(line)) {
   if (field === 'msgid') id += JSON.parse(line);
   else if (field === 'msgstr') value += JSON.parse(line);
  } else if (!line.trim()) flush();
 }
 flush();
}
const files = [];
function walk(dir) {
 if (!fs.existsSync(dir)) return;
 for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  const p = path.join(dir, entry.name);
  if (entry.isDirectory()) walk(p);
  else if (/\.(js|ut)$/.test(p) || p.includes('menu.d') && p.endsWith('.json')) files.push(p);
 }
}
for (const dir of ['htdocs', 'ucode', 'root/usr/share/luci/menu.d']) walk(path.join(root, dir));

const used = new Set();
for (const f of files) {
	const p = f;
	if (!fs.existsSync(p)) continue;
	const t = fs.readFileSync(p, 'utf8');
	if (p.endsWith('.json')) {
		for (const node of Object.values(JSON.parse(t))) if (node.title) used.add(node.title);
		continue;
	}
	for (const mm of t.matchAll(/_\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g))
		used.add(mm[1]);
}

const idset = new Set(ids);
const missing = [...used].filter(s => !idset.has(s));
const obsolete = ids.filter(s => !used.has(s));

console.log('PO msgids:', ids.length, '| source strings:', used.size);
console.log('missing in .po:', JSON.stringify(missing, null, 1));
console.log('obsolete in .po:', JSON.stringify(obsolete, null, 1));
const empty = [...used].filter(s => idset.has(s) && !translated.get(s));
console.log('empty translations:', JSON.stringify(empty));
const placeholders = [...used].filter(s => translated.has(s) &&
 (s.match(/%[sd]/g) || []).sort().join(',') !== (translated.get(s).match(/%[sd]/g) || []).sort().join(','));
console.log('placeholder mismatches:', JSON.stringify(placeholders));
if (missing.length || empty.length || placeholders.length) process.exitCode = 1;
