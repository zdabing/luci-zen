'use strict';
'require view';
'require rpc';
'require poll';
'require view.zen-traffic.style as trafficStyle';

const getSettings = rpc.declare({object:'zen.traffic',method:'getNotifications',reject:true});
const setSettings = rpc.declare({object:'zen.traffic',method:'setNotifications',params:['json'],reject:true});
const testChannel = rpc.declare({object:'zen.traffic',method:'testNotification',params:['channel'],reject:true});
const getDevices = rpc.declare({object:'zen.traffic',method:'getDevices',reject:true});
const decode = r => { if (!r || typeof r.json !== 'string') throw new Error('Invalid response'); return JSON.parse(r.json); };
const field = (label,input,note) => E('label',{'class':'zen-notify-field'},[
 E('span',{},label), input, note ? E('small',{'class':'zen-app-muted'},note) : ''
]);
const toggle = (label,on) => { const input=E('input',{type:'checkbox',checked:!!on});
 return {input,node:E('label',{'class':'zen-notify-toggle'},[input,E('span',{},label)])}; };
function styles() {
 if (document.getElementById('zen-notify-css')) return;
 document.head.appendChild(E('style',{id:'zen-notify-css'},
  '.zen-notify-channels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.zen-notify-card{min-width:0}.zen-notify-field{display:flex;flex-direction:column;gap:8px;margin:16px 0}.zen-notify-field input,.zen-notify-field select{width:100%;min-width:0;max-width:100%;min-height:38px}.zen-notify-toggle{display:flex;align-items:center;gap:10px;margin:14px 0}.zen-notify-toggle input{width:auto!important}.zen-notify-card h3{margin-top:0}.zen-notify-rule{display:grid;grid-template-columns:auto minmax(140px,2fr) minmax(100px,1fr) minmax(150px,1fr) auto;gap:12px;align-items:center;border-bottom:1px solid var(--border,rgba(127,127,127,.2));padding:12px 0}.zen-notify-rule .zen-notify-field{margin:0}.zen-notify-amount{display:flex;gap:6px}.zen-notify-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.zen-notify-result{font-size:13px;white-space:pre-wrap}.zen-notify-error{color:var(--danger,#dc2626)}.zen-notify-log{overflow-x:auto}.zen-notify-log td{white-space:nowrap}.zen-notify-rule button{align-self:end;min-height:38px}.zen-notify-master{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.zen-notify-report{display:flex;gap:32px;align-items:center;flex-wrap:wrap}@media(max-width:700px){.zen-notify-channels{grid-template-columns:1fr}.zen-notify-rule{grid-template-columns:1fr 1fr}.zen-notify-rule>label:first-child{grid-column:1/-1}.zen-notify-rule .zen-notify-device{grid-column:1/-1}.zen-notify-rule button{grid-column:2;justify-self:end}.zen-notify-rule .zen-notify-amount{min-width:0}.zen-notify-rule input{min-width:0}.zen-analysis-table{font-size:12px}}'
 ));
}

return view.extend({
 handleSaveApply:null,handleSave:null,handleReset:null,
 load() { return Promise.all([getSettings().then(decode).catch(()=>null),getDevices().catch(()=>({dev:[]}))]); },
 render(data) {
  trafficStyle.inject();styles();
  if (!data[0]) return E('div',{'class':'cbi-map zen-traffic-page'},[
   E('h2',{},_('Notification settings')),E('p',{'class':'alert-message warning'},_('Notification settings are unavailable. Update and enable the zen-traffic backend.'))
  ]);
  this.devices=data[1].dev || [];this.rows=[];this.channels={};this.saved=data[0];
  const config=data[0].config;
  this.master=toggle(_('Enable automatic notifications'),config.enabled);
  this.daily=toggle(_('Send a daily report'),config.daily_enabled);
  this.time=E('input',{type:'time',value:config.daily_time,required:true});
  this.rules=E('div');
  this.status=E('p',{'class':'zen-notify-result',role:'status','aria-live':'polite'});
  this.log=E('div',{'class':'zen-notify-log'});
  this.saveButton=E('button',{type:'button','class':'cbi-button cbi-button-action important',click:()=>this.save()},_('Save notification settings'));
  const root=E('div',{'class':'cbi-map zen-traffic-page',id:'zen-notifications'},[
   E('h2',{},_('Notification settings')),
   E('p',{'class':'cbi-map-descr'},_('Choose where to receive internet usage alerts. A threshold alerts once per rule, channel and day. Daily reports show today’s usage up to your chosen time.')),
   E('section',{'class':'cbi-section zen-notify-master'},[this.master.node,
    E('span',{'class':'zen-app-muted'},_('Automatic notifications are off until you enable and save them.'))]),
   E('div',{'class':'zen-notify-channels'},[this.channel('feishu',_('Feishu'),config.feishu),this.channel('wecom',_('WeCom'),config.wecom)]),
   E('section',{'class':'cbi-section'},[
    E('h3',{},_('Daily usage threshold alerts')),
    E('p',{'class':'zen-app-muted'},_('Watch the whole network or a chosen device. Only internet uploads and downloads count; local transfers do not.')),
    this.rules,
    this.addButton=E('button',{type:'button','class':'cbi-button',click:()=>this.addRule()},_('Add threshold rule'))
   ]),
   E('section',{'class':'cbi-section'},[
    E('h3',{},_('Daily report')),
    E('div',{'class':'zen-notify-report'},[this.daily.node,field(_('Send time (router local time)'),this.time)]),
    E('p',{'class':'zen-app-muted'},_('Includes the network’s upload and download totals and the top five devices. If the router restarts after the chosen time, it sends the missed report once that day.')),
    E('p',{'class':'zen-app-muted'},_('The first day starts when this version is installed and may be incomplete. Older mixed history is not used for alerts.'))
   ]),
   E('section',{'class':'cbi-section'},[E('div',{'class':'zen-notify-actions'},[
    this.saveButton,E('span',{'class':'zen-app-muted'},_('Saving applies immediately; collection does not restart.'))]),this.status]),
   E('section',{'class':'cbi-section'},[E('h3',{},_('Recent deliveries')),this.log])
  ]);
  for (const rule of config.rules) this.addRule(rule);
  this.drawLog(data[0]);
  this.dirty=false;root.addEventListener('input',()=>{this.dirty=true;});root.addEventListener('change',()=>{this.dirty=true;});
  poll.add(()=>this.refreshLog(),5);
  return root;
 },
 channel(name,label,config) {
  const enabled=toggle(_('Use this channel'),config.enabled);
  const webhook=E('input',{type:'password',autocomplete:'new-password',spellcheck:false,value:'',
   placeholder:config.has_webhook?_('Saved · leave blank to keep'):_('Paste your bot webhook URL')});
  const secret=E('input',{type:'password',autocomplete:'new-password',spellcheck:false,value:'',
   placeholder:config.has_secret?_('Saved · leave blank to keep'):_('Optional signing secret')});
  const result=E('p',{'class':'zen-notify-result',role:'status'});
  const button=E('button',{type:'button','class':'cbi-button',click:()=>this.test(name)},_('Send test message'));
  this.channels[name]={enabled,webhook,secret,result,button};
  const docs=name==='feishu'?'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot':'https://developer.work.weixin.qq.com/document/path/99110';
  const children=[E('h3',{},label),enabled.node,field(_('Bot webhook URL'),webhook,
   name==='feishu'?_('Add a custom bot in your Feishu group, then copy its webhook URL.'):_('Add a message-push bot in your WeCom group, then copy its webhook URL.'))];
  if(name==='feishu') children.push(field(_('Signing secret'),secret,_('Required if the Feishu bot uses signature verification. Enter a dash to clear a saved secret.')));
  children.push(E('p',{'class':'zen-app-muted'},_('If your bot requires a keyword, allow “Zen”.')),
   E('div',{'class':'zen-notify-actions'},[button,E('a',{href:docs,target:'_blank',rel:'noopener noreferrer'},_('Bot setup guide'))]),result);
  return E('section',{'class':'cbi-section zen-notify-card'},children);
 },
 addRule(rule) {
  if(this.rows.length>=20)return;
  rule=rule||{id:'r-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6),enabled:true,mac:'',metric:'total',bytes:10*1024**3};
  const enabled=toggle(_('Enable rule'),rule.enabled);
  const options=[E('option',{value:''},_('Whole network')),...this.devices.map(d=>E('option',{value:d.mac},(d.host||d.ip4||d.mac)+' · '+d.mac))];
  if(rule.mac&&!this.devices.some(d=>d.mac===rule.mac))options.push(E('option',{value:rule.mac},rule.mac));
  const device=E('select',{},options);device.value=rule.mac;
  const metric=E('select',{},[['total',_('Total usage')],['upload',_('Upload')],['download',_('Download')]].map(([value,label])=>E('option',{value},label)));metric.value=rule.metric;
  const unit=E('select',{'aria-label':_('Threshold unit')},['MiB','GiB','TiB'].map((label,i)=>E('option',{value:String(1024**(i+2))},label)));
  const scale=rule.bytes>=1024**3?1024**3:1024**2;unit.value=String(scale);
  const amount=E('input',{type:'number',min:'0.001',step:'any',value:String(rule.bytes/scale),'aria-label':_('Threshold amount')});
  const devField=field(_('Monitor'),device);devField.classList.add('zen-notify-device');
  const row={id:rule.id,enabled,device,metric,amount,unit};
  row.node=E('div',{'class':'zen-notify-rule'},[enabled.node,devField,field(_('Today’s'),metric),
   field(_('Alert at'),E('div',{'class':'zen-notify-amount'},[amount,unit])),
   E('button',{type:'button','class':'cbi-button cbi-button-negative',click:()=>{
    row.node.remove();this.rows=this.rows.filter(r=>r!==row);this.addButton.disabled=false;this.dirty=true;
   }},_('Remove'))]);
  this.rows.push(row);this.rules.appendChild(row.node);this.addButton.disabled=this.rows.length>=20;this.dirty=true;
 },
 collect() {
  const channels={};
  for (const name of ['feishu','wecom']) {
   const c=this.channels[name];channels[name]={enabled:c.enabled.input.checked,webhook:c.webhook.value.trim(),secret:c.secret.value.trim()};
  }
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(this.time.value))throw new Error(_('Choose a valid report time.'));
  const rules=this.rows.map(r=>{
   const value=Number(r.amount.value),bytes=Math.round(value*Number(r.unit.value));
   if(!Number.isFinite(value)||value<=0||!Number.isSafeInteger(bytes)||bytes<=0||bytes>1024**5)throw new Error(_('Enter a positive threshold no larger than 1 PiB.'));
   return {id:r.id,enabled:r.enabled.input.checked,mac:r.device.value,metric:r.metric.value,bytes};
  });
  return {enabled:this.master.input.checked,...channels,daily_enabled:this.daily.input.checked,daily_time:this.time.value,rules};
 },
 async save() {
  this.status.classList.remove('zen-notify-error');this.saveButton.disabled=true;
  try {
   const config=this.collect();const result=decode(await setSettings(JSON.stringify(config)));
   if(!result.ok)throw new Error(_(result.error));
   this.saved=decode(await getSettings());this.drawLog(this.saved);
   for(const name of ['feishu','wecom']) {
    const c=this.channels[name],saved=this.saved.config[name];c.webhook.value='';c.secret.value='';
    c.webhook.placeholder=saved.has_webhook?_('Saved · leave blank to keep'):_('Paste your bot webhook URL');
    c.secret.placeholder=saved.has_secret?_('Saved · leave blank to keep'):_('Optional signing secret');
   }
   this.dirty=false;this.status.textContent=_('Notification settings saved.');
  } catch(e) {this.status.classList.add('zen-notify-error');this.status.textContent=e.message||_('Unable to save notification settings.');}
  finally {this.saveButton.disabled=false;}
 },
 async test(name) {
  const c=this.channels[name];c.result.classList.remove('zen-notify-error');
  if(this.dirty){c.result.textContent=_('Save your changes before sending a test.');return;}
  c.button.disabled=true;
  try {
   const result=decode(await testChannel(name));if(!result.ok)throw new Error(_(result.error));
   c.result.textContent=_('Test queued. Check Recent deliveries for the result.');await this.refreshLog();
  } catch(e){c.result.classList.add('zen-notify-error');c.result.textContent=e.message||_('Unable to queue test message.');}
  finally {c.button.disabled=false;}
 },
 async refreshLog() {
  if(document.hidden||this.refreshing)return;
  this.refreshing=true;
  try {this.drawLog(decode(await getSettings()));}catch(e){/* Keep last delivery state; never overwrite unsaved input. */}
  finally {this.refreshing=false;}
 },
 drawLog(data) {
  this.log.replaceChildren();
  const labels={queued:_('Queued'),sending:_('Sending'),retry:_('Retry pending'),sent:_('Sent'),failed:_('Failed'),cancelled:_('Cancelled')};
  const kinds={threshold:_('Threshold alert'),daily:_('Daily report'),test:_('Connection test')};
  if(!data.recent.length){this.log.appendChild(E('p',{'class':'zen-app-muted'},_('No messages sent yet. Save a channel and send a test to check it.')));return;}
  this.log.appendChild(E('table',{'class':'table'},[
   E('thead',{},E('tr',{},[_('Time'),_('Channel'),_('Message'),_('Status')].map(t=>E('th',{scope:'col'},t)))),
   E('tbody',{},data.recent.map(r=>E('tr',{},[
    E('td',{},new Date(r.at*1000).toLocaleString()),E('td',{},r.channel==='feishu'?_('Feishu'):_('WeCom')),
    E('td',{},kinds[r.kind]||r.kind),E('td',{},[E('span',{},labels[r.status]||r.status),
     r.error?E('small',{'class':'zen-notify-error'},' · '+_(r.error)):''])
   ])))
  ]));
 }
});
