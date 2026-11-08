'use strict';
'require baseclass';
'require rpc';
'require view.zen-traffic.dpi-controls as dpiControls';
'require view.zen.zen-brand-icons as brandIcons';

const callUsage = rpc.declare({ object: 'zen.traffic', method: 'getAppUsage', params: ['mac', 'date', 'hour'], reject: true });
const callRates = rpc.declare({ object:'zen.traffic',method:'getAppRealtime',params:['mac'],reject:true });
const names = { 49:'抖音 / TikTok',54: '爱奇艺', 120: 'X / Twitter', 197: '微信', 285: '腾讯', 324: '腾讯视频', 395: '腾讯游戏',65537:'优酷',65538:'哔哩哔哩',65539:'芒果 TV',65540:'抖音',65541:'快手',65542:'斗鱼',65543:'虎牙' };
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
		this.hasRates=!!status?.app_realtime;this.mode='all';this.expandedKey=null;this.rates=new Map();
		this.request = 0;
		this.title = E('h4', {}, _('Application usage'));
		this.notice = E('p', { class: 'zen-app-muted', role: 'status' });
		this.body = E('div', { class: 'zen-app-usage-body' });
		this.controls=dpiControls.render(status);
		this.container = E('div', { class: 'zen-app-usage' }, [this.title, this.notice, this.body,this.controls]);
		return this.container;
	},

	clear() {
		clearTimeout(this.timer); this.request++;
		this.body?.replaceChildren();
		if (this.container) this.container.hidden = true;
		if (this.notice) this.notice.textContent = '';
	},

	select(mac, date, row) {
		this.clear();
		this.expandedKey=null;this.rates=new Map();dpiControls.setDevice(mac);
		this.container.hidden = false;
		this.title.textContent = _('Application usage') + (row?.label ? ' · ' + row.label : '');
		if (!this.supported) { this.notice.textContent = _('Update the traffic service to enable application usage.'); return; }
		if (!mac || !row?.available || row.future) { this.notice.textContent = _('No application records for this hour.'); return; }
		this.notice.textContent = _('Loading application usage…');
		const request = this.request;
		const load = async () => {
			if (request !== this.request || !this.container.isConnected) return;
			try {
				const [reply,rateReply] = await Promise.all([callUsage(mac,date,String(row.time)),this.hasRates&&row.time<=Date.now()/1000&&Date.now()/1000<row.time+3600?callRates(mac).catch(()=>null):Promise.resolve(null)]);
				if (request !== this.request || !this.container.isConnected) return;
				const data = JSON.parse(reply.json);
				if (data.mac !== mac || data.date !== date || data.hour !== row.time || !Array.isArray(data.applications) ||
					data.applications.length > 2048 || data.applications.some(app => !Number.isInteger(app.id) || app.id < 0 || app.id > 4294967295 ||
						typeof app.name !== 'string' || app.name.length > 64 || ![app.download, app.upload].every(n => Number.isFinite(n) && n >= 0))) throw Error('response');
				this.rates=new Map();
				try{const rate=rateReply?JSON.parse(rateReply.json):null;if(rate?.mac===mac&&rate.age_ms<10000&&Array.isArray(rate.applications)&&rate.applications.length<=2048)for(const item of rate.applications)if([item.download,item.upload].every(n=>Number.isFinite(n)&&n>=0))this.rates.set(item.id,item);}catch(_error){}
				this.data=data;
				this.draw(data);
				if (data.in_progress || (data.breakdown?.pending?.download || 0) + (data.breakdown?.pending?.upload || 0) > 0) {
					this.timer = setTimeout(load, 5000);
				}
			} catch (error) {
				if (request === this.request) this.notice.textContent = _('Unable to load application usage. Please try again.');
			}
		};
		this.timer = setTimeout(load, 160);
	},

	draw(data) {
		this.body.replaceChildren();
		if (!data.available) {
			this.notice.textContent = data.recognition?.failed ? _('Application recognition is currently unavailable.') : _('No application records for this hour.'); return;
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
		let rows;
		if (data.breakdown) {
			for (const key of ['applications', 'protocols', 'unknown', 'pending', 'difference', 'excess']) {
				if (!validBytes(data.breakdown[key])) throw Error('breakdown');
			}
			const applications = data.applications.filter(app => app.kind === 'application'&&(this.mode!=='video'||['video','short_video','live'].includes(app.category)||[49,54,324].includes(app.id))).map(app => ({ ...app, label: names[app.id] || app.name }));
			const protocols = data.applications.filter(app => app.kind === 'protocol').map(app => ({ ...app, label: app.name }));
			const sort = list => list.sort((a, b) => b.download + b.upload - a.download - a.upload);
			rows = sort(applications);
			const infrastructure=data.applications.filter(app=>app.kind==='infrastructure').map(app=>({...app,label:app.name}));
			if (this.mode!=='video'&&infrastructure.length) rows.push({section:_('Shared CDN / cloud')},...sort(infrastructure));
			if (this.mode!=='video'&&protocols.length) rows.push({ section: _('Protocol only') }, ...sort(protocols));
			const states = [];
			for (const [key, label] of [['unknown', _('Unidentified connections')], ['pending', _('Recognition in progress')], ['difference', _('Unattributed difference')]]) {
				const value = data.breakdown[key];
				if (value.download + value.upload > 0) states.push({ ...value, label, identified: false });
			}
			if (this.mode!=='video'&&states.length) rows.push({ section: _('Recognition status and differences') }, ...states);
		} else {
			// Older backends do not expose enough information to split the gap.
			rows = data.applications.filter(app => app.identified === true).map(app => ({ ...app, label: names[app.id] || app.name }));
			const unknown = data.unattributed;
			if (validBytes(unknown) && unknown.download + unknown.upload > 0) rows.push({ ...unknown, label: _('Unclassified'), identified: false });
			rows.sort((a, b) => b.download + b.upload - a.download - a.upload);
		}
		if(data.breakdown&&data.device){
			const total=(Number(data.device.download)||0)+(Number(data.device.upload)||0),identified=data.breakdown.applications.download+data.breakdown.applications.upload;
			const coverage=total>0?Math.min(100,Math.max(0,identified/total*100)):0;
			this.body.appendChild(E('div',{class:'zen-app-coverage'},[
				E('div',{},[E('span',{},_('Application coverage')),E('strong',{},coverage.toFixed(1)+'%')]),
				E('div',{},[E('span',{},_('Not attributed to an app')),E('strong',{},(total>0?100-coverage:0).toFixed(1)+'%')]),
				E('div',{},[E('span',{},_('Recorded total')),E('strong',{},bytes(total))])
			]));
		}
		this.body.appendChild(E('div',{class:'zen-app-filter',role:'group','aria-label':_('Application ranking')},[['all',_('All applications')],['video',_('Video ranking')]].map(([mode,label])=>E('button',{type:'button','aria-pressed':String(this.mode===mode),class:this.mode===mode?'is-active':'',click:()=>{this.mode=mode;this.draw(data);}},label))));
		if (!rows.length) { this.body.appendChild(E('p', { class: 'zen-app-muted' }, _('No application records for this hour.'))); return; }
		this.body.appendChild(E('table', { class: 'table zen-app-usage-table' }, [
			E('thead', {}, E('tr', {}, [_('Application / service'), _('Upload'), _('Download'), _('Total')].map(label => E('th', {}, label)))),
			E('tbody', {}, rows.flatMap(app => {
				if(app.section)return [E('tr',{class:'zen-app-section'},E('th',{colspan:4,scope:'rowgroup'},app.section))];
				const key=app.key||String(app.id),rate=this.rates.get(app.id),sources=Array.isArray(app.sources)?app.sources.slice(0,64):[];
				const icon=brandIcons.application(app,24);
				const heading=E('span',{class:'zen-app-name'},[...(icon?[icon]:[]),E('strong',{},app.label)]);
				const label=E('td',{},[heading,sources.length?E('button',{type:'button',class:'zen-app-source','aria-expanded':String(this.expandedKey===key),click:()=>{this.expandedKey=this.expandedKey===key?null:key;this.draw(data);}},[...new Set(sources.map(s=>sourceName(s.source)))].join(' / ')):'',rate?E('small',{class:'zen-app-rate'},'↑ '+bytes(rate.upload)+'/s · ↓ '+bytes(rate.download)+'/s'):'']);
				const result=[E('tr',{class:app.identified?'':'is-unclassified'},[label,E('td',{class:'zen-tf-ul'},bytes(app.upload)),E('td',{class:'zen-tf-dl'},bytes(app.download)),E('td',{},bytes(app.upload+app.download))])];
				if(this.expandedKey===key&&sources.length)result.push(E('tr',{},E('td',{colspan:4},E('ul',{class:'zen-app-source-list'},sources.map(source=>E('li',{},sourceName(source.source)+' · '+(source.version||'—')+' · ↑ '+bytes(source.upload)+' · ↓ '+bytes(source.download)))))));
				return result;
			}))
		]));
	}
});
