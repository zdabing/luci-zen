'use strict';
'require baseclass';
'require rpc';
'require view.zen.zen-brand-icons as brandIcons';
'require view.zen.zen-select as picker';

const callUsage = rpc.declare({ object: 'zen.traffic', method: 'getAppUsage', params: ['mac', 'date', 'hour'], reject: true });
const callRates = rpc.declare({ object:'zen.traffic',method:'getAppRealtime',params:['mac'],reject:true });
const callUnmatched = rpc.declare({ object: 'zen.traffic', method: 'getUnmatchedDomains', params: ['mac', 'limit'], reject: true });
const callSetCustomRules = rpc.declare({ object: 'zen.traffic', method: 'setCustomDpiRules', params: ['json'], reject: true });
const callClearUnmatched = rpc.declare({ object: 'zen.traffic', method: 'clearUnmatchedDomains', params: ['mac'], reject: true });
const names = {
	37: 'BT 下载 (BitTorrent)', 48: 'QQ', 49: '抖音 / TikTok', 54: '爱奇艺', 120: 'X / Twitter',
	197: '微信', 285: '腾讯通用服务', 324: '腾讯视频', 395: '腾讯游戏',
	65537: '优酷', 65538: '哔哩哔哩', 65539: '芒果 TV', 65540: '抖音',
	65541: '快手', 65542: '斗鱼', 65543: '虎牙', 65544: '夸克网盘',
	65545: '迅雷 / 迅雷云盘', 65546: '百度网盘', 65547: '阿里云盘', 65548: '小红书',
	65549: '淘宝 / 天猫', 65550: '京东', 65551: '拼多多', 65552: '网易云音乐',
	65553: 'WPS 云文档', 65554: '美团 / 大众点评', 65555: '绿联云 NAS',
	65556: '欢太 / OPPO 云服务', 65557: '小米云服务', 65558: '百度服务', 65559: '115 网盘',
	65560: '微博', 65561: '知乎', 65562: '支付宝', 65563: '钉钉',
	65564: '飞书', 65565: '腾讯会议', 65566: 'QQ 音乐', 65567: '酷狗音乐',
	65568: '喜马拉雅', 65569: '高德地图', 65570: '米哈游游戏', 65571: '网易游戏',
	65572: '华为云服务', 65573: '荣耀云服务', 65574: 'vivo 云服务', 65575: '群晖 NAS',
	65576: '飞牛 NAS', 65577: '天翼云盘', 65578: '移动云盘', 65579: '123 云盘',
	65580: 'DeepSeek', 65581: '豆包 AI', 65582: 'Kimi AI', 65583: '通义千问',
	65584: '威联通 NAS', 65585: '自建服务 / 私有云', 65586: '开发与代码服务',
	65587: '其他影音服务', 65588: '其他网盘与下载', 65589: '其他常用应用',
	1048577: '腾讯云 / CDN', 1048578: '阿里云 / CDN'
};
const nameAliases = {
	appleicloud: 'Apple iCloud',
	appleitunes: 'Apple iTunes',
	applestore: 'App Store',
	apple: 'Apple 服务',
	playstore: 'Google Play 商店',
	githubpackages: 'GitHub Packages',
	fbookreelstory: 'Facebook Reels',
	mozilla: 'Mozilla / Firefox',
	xiaomi: '小米设备服务',
	huawei: '华为设备服务',
	huaweicloud: '华为云服务',
	json: 'JSON 数据传输',
	youtube: 'YouTube',
	netflix: 'Netflix',
	telegram: 'Telegram',
	steam: 'Steam'
};
const appLabel = app => names[app.id] || nameAliases[String(app.name || '').toLowerCase()] || app.name;
const CUSTOM_BUCKET_IDS = new Set([65585, 65586, 65587, 65588, 65589]);
const customRuleErrors = {
	shared_domain_cannot_identify_application: '公共云或基础域名（如 aliyuncs.com / qq.com）不能直接整域归属，请切换为精确子域名。',
	overlapping_application_rules: '该主域名下已有子域名归属其他应用，请切换为精确域名归属。',
	conflicting_domain_rules: '规则与现有域名归属冲突。',
	custom_rules_limit_exceeded: '已达到自定义规则数量上限（512 条）。',
	unknown_application_key: '所选目标应用不受支持。',
	invalid_infrastructure_rule: '不能将域名归属到基础设施类别。'
};
const decodedJson = reply => typeof reply?.json === 'string' ? JSON.parse(reply.json) : reply;
const sourceName = source=>({ndpi:_('Native DPI'),dedicated_domain:_('Dedicated domain'),dns:_('DNS assistance'),feature:_('Visible features'),infrastructure:_('Infrastructure'),unidentified:_('Unidentified'),legacy:_('Unrecorded source')})[source]||_('Unrecorded source');

function bytes(value) {
	let n = Math.max(0, Number(value) || 0), i = 0;
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + units[i];
}

return baseclass.extend({
	render(status) {
		this.supported = !!status?.app_usage;
		this.hasRates=!!status?.app_realtime;this.hasUnmatched=!!status?.dpi_custom_rules;
		this.mode='all';this.expandedKey=null;this.rates=new Map();this.mac='';
		this.showAll=false;this.expandedSections=new Set();
		this.unmatchedReq=0;
		this.unmatchedState={loading:false,saving:false,data:null,error:'',statusMsg:'',selected:new Set(),scopeMode:new Map(),targetApp:''};
		this.request = 0;
		this.today = status?.timeline_today || '';
		this.onUnpin = null;
		this.title = E('h4', {}, _('Application usage'));
		this.unpinBtn = E('button', { type: 'button', class: 'za-text-button zen-app-unpin', hidden: true, click: () => this.onUnpin?.() }, '返回全天汇总 ×');
		this.head = E('div', { class: 'zen-app-head' }, [this.title, this.unpinBtn]);
		this.notice = E('p', { class: 'zen-app-muted', role: 'status' });
		this.body = E('div', { class: 'zen-app-usage-body' });
		this.container = E('div', { class: 'zen-app-usage' }, [this.head, this.notice, this.body]);
		return this.container;
	},

	clear() {
		clearTimeout(this.timer); this.request++;
		this.onUnpin = null;
		if (this.unpinBtn) this.unpinBtn.hidden = true;
		this.body?.replaceChildren();
		if (this.container) this.container.hidden = true;
		if (this.notice) this.notice.textContent = '';
	},

	selectRange(mac, startDate, endDate, summaryRow) {
		return this._loadUsage(mac, startDate, {
			...summaryRow,
			queryHour: endDate || startDate,
			available: true,
			future: false,
			time: 0
		}, null);
	},

	select(mac, date, row, onUnpin) {
		return this._loadUsage(mac, date, {
			...row,
			queryHour: String(row?.time || 0)
		}, onUnpin || null);
	},

	_loadUsage(mac, date, row, onUnpin) {
		this.clear();
		const nextMac = mac || '';
		if (this.mac !== nextMac && this.unmatchedState) {
			this.unmatchedState.selected.clear();
			this.unmatchedState.scopeMode.clear();
			this.unmatchedState.data = null;
			this.unmatchedState.statusMsg = '';
			this.unmatchedState.error = '';
		}
		this.mac = nextMac;
		this.lastQuery = { mac, date, row, onUnpin };
		this.expandedKey=null;this.expandedSections=new Set();this.rates=new Map();this.onUnpin=onUnpin||null;
		if (this.unpinBtn) this.unpinBtn.hidden = !this.onUnpin;
		this.container.hidden = false;
		this.title.textContent = _('Application usage') + (row?.label ? ' · ' + row.label : '');
		if (!this.supported) { this.notice.textContent = _('Update the traffic service to enable application usage.'); return; }
		if (mac == null || !row?.available || row.future) {
			if (this.hasUnmatched && this.mode === 'unmatched') {
				this.draw({ available: false });
				this.loadUnmatched();
				return;
			}
			this.notice.textContent = _('No application records for this hour.');
			return;
		}
		this.notice.textContent = _('Loading application usage…');
		const request = this.request;
		const isRange = row.time === 0;
		const queryHour = String(row.queryHour ?? row.time);
		const nowSec = Date.now() / 1000;
		const includesNow = isRange ? (!this.today || (date <= this.today && queryHour >= this.today)) : (row.time <= nowSec && nowSec < row.time + 3600);
		const load = async () => {
			if (request !== this.request || !this.container.isConnected) return;
			try {
				const [reply,rateReply] = await Promise.all([callUsage(mac,date,queryHour),this.hasRates&&includesNow?callRates(mac).catch(()=>null):Promise.resolve(null)]);
				if (request !== this.request || !this.container.isConnected) return;
				const data = JSON.parse(reply.json);
				if ((data.mac || '') !== (mac || '') || data.date !== date || (isRange ? data.hour !== 0 : data.hour !== row.time) || !Array.isArray(data.applications) ||
					data.applications.length > 2048 || data.applications.some(app => !Number.isInteger(app.id) || app.id < 0 || app.id > 4294967295 ||
						typeof app.name !== 'string' || app.name.length > 64 || ![app.download, app.upload].every(n => Number.isFinite(n) && n >= 0))) throw Error('response');
				this.rates=new Map();
				try{const rate=rateReply?JSON.parse(rateReply.json):null;if((rate?.mac||'')===(mac||'')&&rate.age_ms<10000&&Array.isArray(rate.applications)&&rate.applications.length<=2048)for(const item of rate.applications)if([item.download,item.upload].every(n=>Number.isFinite(n)&&n>=0))this.rates.set(item.id,item);}catch(_error){}
				const firstDraw = !this.body.children.length;
				this.data=data;
				if (this.mode !== 'unmatched' || firstDraw) {
					this.draw(data);
				}
				if (this.mode === 'unmatched' && this.hasUnmatched && !this.unmatchedState.data && !this.unmatchedState.loading) {
					this.loadUnmatched();
				}
				if (data.in_progress || (data.breakdown?.pending?.download || 0) + (data.breakdown?.pending?.upload || 0) > 0) {
					this.timer = setTimeout(load, 5000);
				}
			} catch (error) {
				if (request === this.request) this.notice.textContent = _('Unable to load application usage. Please try again.');
			}
		};
		this.timer = setTimeout(load, 160);
	},

	_filterModes() {
		const modes = [['all', _('All applications')], ['video', _('Video ranking')], ['download', '网盘与下载'], ['social', '社交与购物'], ['game', '游戏与服务']];
		if (this.hasUnmatched) modes.push(['unmatched', '未识别域名']);
		return modes;
	},

	_renderFilterBar(data, hiddenCount) {
		const bar = E('div', { class: 'zen-app-filter zen-segmented zu-periods', role: 'group', 'aria-label': _('Application ranking') },
			this._filterModes().map(([mode, label]) => E('button', {
				type: 'button',
				'aria-pressed': String(this.mode === mode),
				class: this.mode === mode ? 'is-active' : '',
				click: () => {
					this.mode = mode;
					this.draw(data || this.data || { available: false });
					if (mode === 'unmatched') this.loadUnmatched();
				}
			}, label)));
		const canToggleCompact = this.mode !== 'unmatched' && (hiddenCount > 0 || this.showAll);
		if (!canToggleCompact) {
			this.body.appendChild(bar);
			return;
		}
		const toggleBtn = E('button', {
			type: 'button',
			class: 'zen-app-compact-toggle',
			'aria-pressed': String(this.showAll),
			click: () => {
				this.showAll = !this.showAll;
				if (!this.showAll) this.expandedSections.clear();
				this.draw(data || this.data || { available: false });
			}
		}, this.showAll ? '精简展示（隐藏低流量）' : '显示全部（已收起 ' + hiddenCount + ' 项低流量）');
		this.body.appendChild(E('div', { class: 'zen-app-toolbar' }, [bar, toggleBtn]));
	},

	_partitionRows(list, sectionKey, maxShown, minKeep, minBytes) {
		const nonZero = list.filter(r => (Number(r.upload) || 0) + (Number(r.download) || 0) > 0);
		if (this.showAll || this.expandedSections.has(sectionKey) || nonZero.length <= minKeep + 1) {
			return { shown: nonZero, hidden: [] };
		}
		const shown = [];
		for (const item of nonZero) {
			const total = (Number(item.upload) || 0) + (Number(item.download) || 0);
			if (shown.length < minKeep || (shown.length < maxShown && total >= minBytes)) {
				shown.push(item);
			} else {
				break;
			}
		}
		if (nonZero.length - shown.length <= 1) {
			return { shown: nonZero, hidden: [] };
		}
		return { shown, hidden: nonZero.slice(shown.length) };
	},

	async loadUnmatched() {
		if (!this.hasUnmatched) return;
		const req = ++this.unmatchedReq;
		const st = this.unmatchedState;
		st.loading = true;
		st.error = '';
		if (this.mode === 'unmatched') this.draw(this.data || { available: false });
		try {
			const res = decodedJson(await callUnmatched(this.mac || '', 50));
			if (req !== this.unmatchedReq || !this.container.isConnected) return;
			if (!res || !Array.isArray(res.domains) || !Array.isArray(res.applications)) throw Error('response');
			st.data = res;
			const visible = new Set(res.domains.map(d => d.domain));
			for (const dom of [...st.selected]) if (!visible.has(dom)) st.selected.delete(dom);
			if (!st.targetApp && res.applications.length) {
				const preferred = res.applications.find(a => a.key === 'community:selfhosted') || res.applications[0];
				st.targetApp = preferred.key;
			}
		} catch (_error) {
			if (req === this.unmatchedReq) st.error = '无法加载未识别域名榜单，请确认流量服务已更新并运行。';
		} finally {
			if (req === this.unmatchedReq) {
				st.loading = false;
				if (this.mode === 'unmatched') this.draw(this.data || { available: false });
			}
		}
	},

	_ruleSpecFor(item) {
		const st = this.unmatchedState;
		const mode = st.scopeMode.get(item.domain) || item.suggested_match || 'exact';
		const canSuffix = item.suggested_domain && (item.suggested_match === 'suffix' || item.suggested_domain !== item.domain);
		if (mode === 'suffix' && canSuffix) {
			return { domain: item.suggested_domain, match: 'suffix' };
		}
		return { domain: item.domain, match: 'exact' };
	},

	async assignSelected() {
		const st = this.unmatchedState;
		const rows = st.data?.domains || [];
		const target = st.targetApp;
		if (!target || !st.selected.size || st.saving) return;
		const dedup = new Map();
		for (const item of rows) {
			if (!st.selected.has(item.domain)) continue;
			const spec = this._ruleSpecFor(item);
			dedup.set(spec.match + ':' + spec.domain, { domain: spec.domain, match: spec.match, app: target });
		}
		const add = [...dedup.values()];
		if (!add.length) return;
		st.saving = true; st.error = ''; st.statusMsg = '';
		this.draw(this.data || { available: false });
		try {
			const res = decodedJson(await callSetCustomRules(JSON.stringify({ add })));
			if (res?.ok !== true) throw Error(customRuleErrors[res?.error] || '保存自定义规则失败，请稍后重试。');
			const appEntry = (st.data?.applications || []).find(a => a.key === target);
			const appLabel = appEntry ? (names[appEntry.id] || appEntry.name) : target;
			const moved = Number(res.reclassified_flows) || 0;
			st.selected.clear();
			st.statusMsg = '已将 ' + add.length + ' 条域名规则归属至「' + appLabel + '」' + (moved > 0 ? '，并立即重分类 ' + moved + ' 条活跃连接' : '（后续新连接将自动识别）') + '。';
			await this.loadUnmatched();
			if (this.lastQuery?.row?.available && !this.lastQuery.row.future) {
				const q = this.lastQuery;
				const queryHour = String(q.row.queryHour ?? q.row.time);
				callUsage(q.mac, q.date, queryHour).then(reply => {
					const parsed = JSON.parse(reply.json);
					this.data = parsed;
					if (this.mode === 'unmatched') this.draw(parsed);
				}).catch(() => {});
			}
		} catch (error) {
			st.error = error?.message || '保存自定义规则失败，请稍后重试。';
		} finally {
			st.saving = false;
			if (this.mode === 'unmatched') this.draw(this.data || { available: false });
		}
	},

	async removeCustomRule(rule) {
		const st = this.unmatchedState;
		if (st.saving) return;
		st.saving = true; st.error = ''; st.statusMsg = '';
		this.draw(this.data || { available: false });
		try {
			const res = decodedJson(await callSetCustomRules(JSON.stringify({ remove: [{ domain: rule.domain, match: rule.match }] })));
			if (res?.ok !== true) throw Error(customRuleErrors[res?.error] || '移除规则失败。');
			st.statusMsg = '已移除自定义规则「' + (rule.match === 'suffix' ? '*.' : '') + rule.domain + '」。';
			await this.loadUnmatched();
		} catch (error) {
			st.error = error?.message || '移除规则失败。';
		} finally {
			st.saving = false;
			if (this.mode === 'unmatched') this.draw(this.data || { available: false });
		}
	},

	async clearUnmatchedList() {
		const st = this.unmatchedState;
		if (st.loading || st.saving) return;
		st.loading = true; st.error = ''; st.statusMsg = '';
		this.draw(this.data || { available: false });
		try {
			const res = decodedJson(await callClearUnmatched(this.mac || ''));
			if (res?.ok !== true) throw Error('清空榜单失败。');
			st.selected.clear();
			st.statusMsg = '已清空当前未识别域名榜单，后续新流量将重新累计。';
			await this.loadUnmatched();
		} catch (_error) {
			st.loading = false;
			st.error = '清空榜单失败。';
			if (this.mode === 'unmatched') this.draw(this.data || { available: false });
		}
	},

	_drawUnmatched() {
		const st = this.unmatchedState;
		const res = st.data;
		const panel = E('div', { class: 'zen-unmatched-panel' });
		const refreshBtn = E('button', { type: 'button', class: 'cbi-button', click: () => this.loadUnmatched() }, st.loading ? '刷新中…' : '刷新榜单');
		const clearBtn = E('button', { type: 'button', class: 'cbi-button', click: () => this.clearUnmatchedList() }, '清空榜单');
		refreshBtn.disabled = !!(st.loading || st.saving);
		clearBtn.disabled = !!(st.loading || st.saving);
		panel.appendChild(E('div', { class: 'zen-unmatched-head' }, [
			E('span', { class: 'zen-app-muted' }, '统计当前已提取域名（SNI / Host）但尚未归属具体应用的流量（仅内存统计，不落盘）。'),
			E('div', { class: 'zen-unmatched-head-actions' }, [refreshBtn, clearBtn])
		]));
		if (st.error) panel.appendChild(E('p', { class: 'alert-message warning', role: 'status' }, st.error));
		else if (st.statusMsg) panel.appendChild(E('p', { class: 'zen-app-muted', role: 'status' }, st.statusMsg));

		if (!res && st.loading) {
			panel.appendChild(E('p', { class: 'zen-app-muted' }, '正在读取高频未识别域名…'));
			this.body.appendChild(panel);
			return;
		}
		if (!res) {
			this.body.appendChild(panel);
			return;
		}

		const domains = res.domains || [];
		const apps = res.applications || [];
		const customRules = res.custom_rules || [];

		const customGroup = apps.filter(a => CUSTOM_BUCKET_IDS.has(a.id)).map(a => ({ ...a, label: names[a.id] || a.name }));
		const normalGroup = apps.filter(a => !CUSTOM_BUCKET_IDS.has(a.id)).map(a => ({ ...a, label: names[a.id] || a.name }))
			.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
		const appSelect = E('select', {
			'aria-label': '归属目标应用',
			change: ev => { st.targetApp = ev.target.value; }
		}, [
			...(normalGroup.length ? [E('optgroup', { label: '常用应用与服务' }, normalGroup.map(a => E('option', { value: a.key }, a.label)))] : []),
			...(customGroup.length ? [E('optgroup', { label: '自定义分类桶' }, customGroup.map(a => E('option', { value: a.key }, a.label)))] : [])
		]);
		appSelect.disabled = !!st.saving;
		if (st.targetApp) appSelect.value = st.targetApp;

		const allSelected = domains.length > 0 && domains.every(d => st.selected.has(d.domain));
		const selectAllBox = E('input', {
			type: 'checkbox',
			change: ev => {
				if (ev.target.checked) domains.forEach(d => st.selected.add(d.domain));
				else domains.forEach(d => st.selected.delete(d.domain));
				this.draw(this.data || { available: false });
			}
		});
		selectAllBox.checked = allSelected;
		selectAllBox.disabled = !domains.length || !!st.saving;
		const assignBtn = E('button', {
			type: 'button',
			class: 'cbi-button cbi-button-apply',
			click: () => this.assignSelected()
		}, st.saving ? '正在保存…' : '一键归属所选应用（' + st.selected.size + '）');
		assignBtn.disabled = !st.selected.size || !st.targetApp || !!st.saving;

		panel.appendChild(E('div', { class: 'zen-unmatched-bar' }, [
			E('label', { class: 'zen-unmatched-checkall' }, [selectAllBox, E('span', {}, '全选（已选 ' + st.selected.size + '/' + domains.length + '）')]),
			appSelect,
			assignBtn
		]));
		picker.enhance(appSelect);

		if (!domains.length) {
			panel.appendChild(E('p', { class: 'zen-app-muted' }, '暂无未识别的高频域名。有未归属域名产生流量后将按总流量自动排序。'));
		} else {
			panel.appendChild(E('table', { class: 'table zen-app-usage-table zen-unmatched-table' }, [
				E('thead', {}, E('tr', {}, [
					E('th', {}, ''),
					E('th', {}, '域名与归属规则'),
					E('th', {}, '连接'),
					E('th', {}, _('Upload')),
					E('th', {}, _('Download')),
					E('th', {}, _('Total'))
				])),
				E('tbody', {}, domains.map(item => {
					const checked = st.selected.has(item.domain);
					const spec = this._ruleSpecFor(item);
					const canToggle = !!(item.suggested_domain && (item.suggested_match === 'suffix' || item.suggested_domain !== item.domain));
					const rowCheck = E('input', {
						type: 'checkbox',
						'aria-label': '选择域名 ' + item.domain,
						change: ev => {
							if (ev.target.checked) st.selected.add(item.domain);
							else st.selected.delete(item.domain);
							this.draw(this.data || { available: false });
						}
					});
					rowCheck.checked = checked;
					rowCheck.disabled = !!st.saving;
					const scopeBtn = E('button', {
						type: 'button',
						class: 'zen-unmatched-scope',
						'aria-pressed': String(spec.match === 'suffix'),
						title: canToggle ? '点击切换按主域名后缀合并或仅精确匹配当前子域名' : '仅精确匹配当前子域名',
						click: () => {
							st.scopeMode.set(item.domain, spec.match === 'suffix' ? 'exact' : 'suffix');
							this.draw(this.data || { available: false });
						}
					}, spec.match === 'suffix' ? '后缀 *.' + spec.domain : '精确 ' + spec.domain);
					scopeBtn.disabled = !canToggle || !!st.saving;
					const candidateLabel = item.candidate_app ? (names[(apps.find(a => a.key === item.candidate_app) || {}).id] || item.candidate_name || item.candidate_app) : '';
					const domainCell = E('td', {}, E('div', { class: 'zen-unmatched-domain' }, [
						E('strong', {}, item.domain),
						E('div', { class: 'zen-unmatched-meta' }, [
							item.last_protocol ? E('span', { class: 'zen-unmatched-badge' }, item.last_protocol) : '',
							candidateLabel ? E('span', { class: 'zen-unmatched-badge' }, '候选: ' + candidateLabel) : '',
							scopeBtn
						])
					]));
					return E('tr', {}, [
						E('td', {}, rowCheck),
						domainCell,
						E('td', {}, String(item.connections || 0) + ' 次 · ' + String(item.devices || 1) + ' 台'),
						E('td', { class: 'zen-tf-ul' }, bytes(item.upload)),
						E('td', { class: 'zen-tf-dl' }, bytes(item.download)),
						E('td', {}, bytes((Number(item.upload) || 0) + (Number(item.download) || 0)))
					]);
				}))
			]));
		}

		const customBox = E('details', { class: 'zen-custom-rules' }, [
			E('summary', {}, '已自定义的域名规则（' + customRules.length + '）'),
			customRules.length
				? E('div', { class: 'zen-custom-rules-list' }, customRules.map(rule => {
					const label = names[rule.app_id] || rule.app_name || rule.app;
					const removeBtn = E('button', {
						type: 'button',
						class: 'cbi-button',
						click: () => this.removeCustomRule(rule)
					}, '移除');
					removeBtn.disabled = !!st.saving;
					return E('div', { class: 'zen-custom-rule-row' }, [
						E('span', {}, (rule.match === 'suffix' ? '*.' : '') + rule.domain + ' → ' + label),
						removeBtn
					]);
				}))
				: E('p', { class: 'zen-app-muted' }, '尚未添加自定义域名规则。')
		]);
		panel.appendChild(customBox);
		this.body.appendChild(panel);
	},

	draw(data) {
		this.body.replaceChildren();
		if (!data?.available) {
			if (this.hasUnmatched && this.mode === 'unmatched') {
				this.notice.textContent = '';
				this._renderFilterBar(data, 0);
				this._drawUnmatched();
				return;
			}
			this.notice.textContent = data?.recognition?.failed ? _('Application recognition is currently unavailable.') : _('No application records for this hour.');
			if (this.hasUnmatched) this._renderFilterBar(data, 0);
			return;
		}
		const alerts = [];
		if (data.accounting_mismatch) alerts.push(_('Application and device counters have a sampling difference.'));
		if (data.partial) alerts.push(_('This hour is only partially recorded.'));
		if (data.hardware_offload) alerts.push(_('Hardware offload may bypass application recognition.'));
		if (!data.recognition?.active) alerts.push(_('Application recognition is currently unavailable.'));
		if (data.recognition?.queue_dropped) alerts.push(_('Some connections could not be classified.'));
		if (data.recognition?.worker_limited) alerts.push(_('Recognition capacity was reached.'));
		this.notice.textContent = alerts.join(' ');
		const validBytes = value => value && [value.download, value.upload].every(n => Number.isFinite(n) && n >= 0);
		const sort = list => list.sort((a, b) => (b.download + b.upload) - (a.download + a.upload));
		const devTotal = data.device ? (Number(data.device.download) || 0) + (Number(data.device.upload) || 0) : 0;
		const sumApps = data.applications.reduce((s, a) => s + (Number(a.download) || 0) + (Number(a.upload) || 0), 0);
		const refTotal = devTotal || sumApps;
		const minAppBytes = refTotal >= 50 * 1048576 ? 1048576 : (refTotal >= 1048576 ? 102400 : 0);
		const minProtoBytes = refTotal >= 20 * 1048576 ? 1048576 : 65536;
		let rows, hiddenCount = 0;
		if (data.breakdown) {
			for (const key of ['applications', 'protocols', 'unknown', 'pending', 'difference', 'excess']) {
				if (!validBytes(data.breakdown[key])) throw Error('breakdown');
			}
			const matchCategory = app => {
				if (this.mode === 'video') return ['video', 'short_video', 'live', 'music'].includes(app.category) || [49, 54, 324].includes(app.id);
				if (this.mode === 'download') return ['download', 'cloud', 'nas'].includes(app.category) || [37, 65544, 65545, 65546, 65547, 65555, 65559].includes(app.id);
				if (this.mode === 'social') return ['chat', 'messaging', 'social', 'shopping', 'life', 'office', 'productivity'].includes(app.category) || [48, 120, 197, 65548, 65549, 65550, 65551, 65553, 65554].includes(app.id);
				if (this.mode === 'game') return ['game', 'vendor', 'portal', 'ai'].includes(app.category) || [395, 65556, 65557, 65558].includes(app.id);
				return true;
			};
			const applications = sort(data.applications.filter(app => app.kind === 'application' && matchCategory(app)).map(app => ({ ...app, label: appLabel(app) })));
			const appsPart = this._partitionRows(applications, 'apps', 10, 5, minAppBytes);
			rows = [...appsPart.shown];
			hiddenCount += appsPart.hidden.length;
			if (appsPart.hidden.length) rows.push({ tail: true, sectionKey: 'apps', items: appsPart.hidden, unitLabel: '应用' });
			if (this.mode === 'all') {
				const infrastructure = sort(data.applications.filter(app => app.kind === 'infrastructure').map(app => ({ ...app, label: appLabel(app) })));
				if (infrastructure.length) {
					const infraPart = this._partitionRows(infrastructure, 'infra', 4, 2, minProtoBytes);
					hiddenCount += infraPart.hidden.length;
					rows.push({ section: _('Shared CDN / cloud') }, ...infraPart.shown);
					if (infraPart.hidden.length) rows.push({ tail: true, sectionKey: 'infra', items: infraPart.hidden, unitLabel: '云服务' });
				}
				const protocols = sort(data.applications.filter(app => app.kind === 'protocol').map(app => ({ ...app, label: appLabel(app) })));
				if (protocols.length) {
					const protoPart = this._partitionRows(protocols, 'proto', 4, 2, minProtoBytes);
					hiddenCount += protoPart.hidden.length;
					rows.push({ section: _('Protocol only') }, ...protoPart.shown);
					if (protoPart.hidden.length) rows.push({ tail: true, sectionKey: 'proto', items: protoPart.hidden, unitLabel: '协议' });
				}
				const states = [];
				for (const [key, label] of [['unknown', _('Unidentified connections')], ['pending', _('Recognition in progress')], ['difference', _('Unattributed difference')]]) {
					const value = data.breakdown[key];
					if (value.download + value.upload > 0) states.push({ ...value, label, identified: false });
				}
				if (states.length) rows.push({ section: _('Recognition status and differences') }, ...states);
			}
		} else {
			// Older backends do not expose enough information to split the gap.
			const allRows = data.applications.filter(app => app.identified === true).map(app => ({ ...app, label: appLabel(app) }));
			const unknown = data.unattributed;
			if (validBytes(unknown) && unknown.download + unknown.upload > 0) allRows.push({ ...unknown, label: _('Unclassified'), identified: false });
			sort(allRows);
			const legacyPart = this._partitionRows(allRows, 'apps', 10, 5, minAppBytes);
			hiddenCount += legacyPart.hidden.length;
			rows = [...legacyPart.shown];
			if (legacyPart.hidden.length) rows.push({ tail: true, sectionKey: 'apps', items: legacyPart.hidden, unitLabel: '应用' });
		}
		if(data.breakdown&&data.device){
			const total=devTotal,identified=data.breakdown.applications.download+data.breakdown.applications.upload;
			const coverage=total>0?Math.min(100,Math.max(0,identified/total*100)):0;
			this.body.appendChild(E('div',{class:'zen-app-coverage'},[
				E('div',{},[E('span',{},_('Application coverage')),E('strong',{},coverage.toFixed(1)+'%')]),
				E('div',{},[E('span',{},_('Not attributed to an app')),E('strong',{},(total>0?100-coverage:0).toFixed(1)+'%')]),
				E('div',{},[E('span',{},_('Recorded total')),E('strong',{},bytes(total))])
			]));
		}
		this._renderFilterBar(data, hiddenCount);
		if (this.mode === 'unmatched' && this.hasUnmatched) {
			this._drawUnmatched();
			return;
		}
		if (!rows.length) { this.body.appendChild(E('p', { class: 'zen-app-muted' }, _('No application records for this hour.'))); return; }
		const dataRows = rows.filter(r => !r.section && !r.tail);
		const grandTotal = refTotal || dataRows.reduce((s, r) => s + (Number(r.upload) || 0) + (Number(r.download) || 0), 0);
		const maxRowBytes = Math.max(1, ...dataRows.map(r => (Number(r.upload) || 0) + (Number(r.download) || 0)));
		this.body.appendChild(E('table', { class: 'table zen-app-usage-table' }, [
			E('thead', {}, E('tr', {}, [_('Application / service'), _('Upload'), _('Download'), _('Total')].map(label => E('th', {}, label)))),
			E('tbody', {}, rows.flatMap(app => {
				if (app.section) return [E('tr', { class: 'zen-app-section' }, E('th', { colspan: 4, scope: 'rowgroup' }, app.section))];
				if (app.tail) {
					const tailUl = app.items.reduce((s, i) => s + (Number(i.upload) || 0), 0);
					const tailDl = app.items.reduce((s, i) => s + (Number(i.download) || 0), 0);
					return [E('tr', { class: 'zen-app-tail-row' }, [
						E('td', {}, E('button', {
							type: 'button',
							class: 'zen-app-tail-btn',
							click: () => {
								this.expandedSections.add(app.sectionKey);
								this.draw(data);
							}
						}, '展开其余 ' + app.items.length + ' 项低流量' + app.unitLabel + ' ⌄')),
						E('td', { class: 'zen-tf-ul' }, bytes(tailUl)),
						E('td', { class: 'zen-tf-dl' }, bytes(tailDl)),
						E('td', {}, bytes(tailUl + tailDl))
					])];
				}
				const rowTotal = (Number(app.upload) || 0) + (Number(app.download) || 0);
				const share = grandTotal > 0 ? rowTotal / grandTotal * 100 : 0;
				const shareText = grandTotal > 0 && rowTotal > 0 ? (share >= 0.1 ? share.toFixed(1) + '%' : '<0.1%') : '';
				const barWidth = Math.max(2, Math.min(100, rowTotal / maxRowBytes * 100)).toFixed(1) + '%';
				const key=app.key||String(app.id),rate=this.rates.get(app.id),sources=Array.isArray(app.sources)?app.sources.slice(0,64):[];
				const icon=brandIcons.application(app,24);
				const heading=E('span',{class:'zen-app-name'},[...(icon?[icon]:[]),E('strong',{},app.label)]);
				const rowHead=E('div',{class:'zen-app-row-head'},[
					heading,
					sources.length?E('button',{type:'button',class:'zen-app-source','aria-expanded':String(this.expandedKey===key),click:()=>{this.expandedKey=this.expandedKey===key?null:key;this.draw(data);}},[...new Set(sources.map(s=>sourceName(s.source)))].join(' / ')):'',
					shareText?E('span',{class:'zen-app-pct'},shareText):''
				]);
				const labelChildren = [rowHead];
				if (rowTotal > 0) labelChildren.push(E('div', { class: 'zen-app-bar', 'aria-hidden': 'true' }, E('i', { style: 'width:' + barWidth })));
				if (rate) labelChildren.push(E('small',{class:'zen-app-rate'},'↑ '+bytes(rate.upload)+'/s · ↓ '+bytes(rate.download)+'/s'));
				const result=[E('tr',{class:app.identified?'':'is-unclassified'},[E('td',{},labelChildren),E('td',{class:'zen-tf-ul'},bytes(app.upload)),E('td',{class:'zen-tf-dl'},bytes(app.download)),E('td',{},bytes(rowTotal))])];
				if(this.expandedKey===key&&sources.length)result.push(E('tr',{},E('td',{colspan:4},E('ul',{class:'zen-app-source-list'},sources.map(source=>E('li',{},sourceName(source.source)+' · '+(source.version||'—')+' · ↑ '+bytes(source.upload)+' · ↓ '+bytes(source.download)))))));
				return result;
			}))
		]));
	}
});
