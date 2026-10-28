'use strict';
'require baseclass';
'require rpc';
'require poll';
'require view.zen-traffic.style as trafficStyle';

const getSettings = rpc.declare({object:'zen.traffic',method:'getNotifications',reject:true});
const setSettings = rpc.declare({object:'zen.traffic',method:'setNotifications',params:['json'],reject:true});
const testChannel = rpc.declare({object:'zen.traffic',method:'testNotification',params:['channel'],reject:true});
const getDevices = rpc.declare({object:'zen.traffic',method:'getDevices',reject:true});
const decode = r => { if (!r || typeof r.json !== 'string') throw new Error('Invalid response'); return JSON.parse(r.json); };
function errorText(message,fallback) {
 const known={
  'Invalid feishu webhook':_('Enter the official Feishu bot webhook URL.'),
  'Invalid wecom webhook':_('Enter the official WeCom bot webhook URL.'),
  'Enable a notification channel first':_('Enable a notification channel first.'),
  'Invalid signing secret':_('Check the bot signing secret.'),
  'Unable to save settings':_('Unable to save notification settings.'),
  'Router time is not synchronised':_('Set the router’s time before sending messages.'),
  'Wait one minute before testing again':_('Wait one minute before testing again.'),
  'Save the webhook first':_('Save the webhook first.'),
  'HTTPS sender unavailable':_('The HTTPS sender is unavailable. Check that curl is installed.'),
  'Missing robot acknowledgement':_('The robot did not return a valid acknowledgement.'),
  'Invalid robot response':_('The robot did not return a valid acknowledgement.')
 };
 if(known[message])return known[message];
 if([_('Choose a valid report time.'),_('Enter a positive threshold no larger than 1 PiB.')].includes(message))return message;
 const curl=String(message||'').match(/curl code (-?\d+)/),bot=String(message||'').match(/Robot rejected message \(code (-?\d+)\)/);
 if(curl)return _('HTTPS delivery failed (code %s). Check network, certificates and webhook.').format(curl[1]);
 if(bot)return _('The robot rejected the message (code %s).').format(bot[1]);
 return fallback||_('Unable to deliver message.');
}
const field = (label,input,note) => E('label',{'class':'zen-notify-field'},[
 E('span',{},label), input, note ? E('small',{'class':'zen-app-muted'},note) : ''
]);
const toggle = (label,on) => { const input=E('input',{type:'checkbox'});
 // Boolean HTML attributes use presence, so checked="false" still checks it.
 input.checked=!!on;
 return {input,node:E('label',{'class':'zen-notify-toggle'},[input,E('span',{},label)])}; };
function styles() {
 if (document.getElementById('zen-notify-css')) return;
 document.head.appendChild(E('style',{id:'zen-notify-css'},
  '.zen-notify-channels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.zen-notify-card{min-width:0}.zen-notify-field{display:flex;flex-direction:column;gap:8px;margin:16px 0}.zen-notify-field input,.zen-notify-field select{width:100%;min-width:0;max-width:100%;min-height:38px}.zen-notify-toggle{display:flex;align-items:center;gap:10px;margin:14px 0}.zen-notify-toggle input{width:auto!important}.zen-notify-card h3{margin-top:0}.zen-notify-rule{display:grid;grid-template-columns:auto minmax(140px,2fr) minmax(100px,1fr) minmax(150px,1fr) auto;gap:12px;align-items:center;border-bottom:1px solid var(--border,rgba(127,127,127,.2));padding:12px 0}.zen-notify-rule .zen-notify-field{margin:0}.zen-notify-amount{display:flex;gap:6px}.zen-notify-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.zen-notify-result{font-size:13px;white-space:pre-wrap}.zen-notify-error{color:var(--danger,#dc2626)}.zen-notify-log{overflow-x:auto}.zen-notify-log td{white-space:nowrap}.zen-notify-rule button{align-self:end;min-height:38px}.zen-notify-master{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}.zen-notify-report{display:flex;gap:32px;align-items:center;flex-wrap:wrap}@media(max-width:700px){.zen-notify-channels{grid-template-columns:1fr}.zen-notify-rule{grid-template-columns:1fr 1fr}.zen-notify-rule>label:first-child{grid-column:1/-1}.zen-notify-rule .zen-notify-device{grid-column:1/-1}.zen-notify-rule button{grid-column:2;justify-self:end}.zen-notify-rule .zen-notify-amount{min-width:0}.zen-notify-rule input{min-width:0}.zen-analysis-table{font-size:12px}}'
 ));
}

return baseclass.extend({
 handleSaveApply:null,handleSave:null,handleReset:null,
 load() { return Promise.all([getSettings().then(decode).catch(()=>null),getDevices().catch(()=>({dev:[]}))]); },
 render(data) {
  if(this._poll)poll.remove(this._poll);
  trafficStyle.inject();styles();
  if(!data[0])return E('p',{role:'alert'},_('Notification settings unavailable.'));
  this.devices=data[1].dev||[];this.rows=[];this.channels={};this.saved=structuredClone(data[0]);
  const config=data[0].config;
  this.master=toggle(_('Automatic notifications'),config.enabled);this.daily=toggle(_('Send daily report'),config.daily_enabled);
  this.time=E('input',{type:'time',value:config.daily_time,required:true,'aria-label':_('Send time')});
  this.rules=E('div',{class:'zc-rules'});this.log=E('div',{class:'zen-notify-log'});
  this.status=E('p',{class:'zen-notify-result',role:'status','aria-live':'polite'});
  this.dirtyState=E('span',{class:'zc-save-state'},_('Current configuration'));
  this.saveButton=E('button',{type:'button',class:'cbi-button cbi-button-action important',click:()=>this.save()},_('Save settings'));
  this.undoButton=E('button',{type:'button',class:'cbi-button',click:()=>{if(this.saving)return;const old=this.root;old.replaceWith(this.render([structuredClone(this.saved),{dev:this.devices}]));}},_('Undo'));
  this.channelSelect=E('select',{'aria-label':_('Notification channel')},[E('option',{value:'feishu'},_('Feishu')),E('option',{value:'wecom'},_('WeCom'))]);
  this.channelSelect.value=config.wecom.enabled&&!config.feishu.enabled?'wecom':'feishu';
  const channelRow=E('label',{class:'zc-form-row'},[E('span',{},_('Notification channel')),this.channelSelect]);
  const channelCard=E('section',{class:'cbi-section zc-channel-card'},[E('h3',{},_('Notification channel')),channelRow,this.channel('feishu',_('Feishu'),config.feishu),this.channel('wecom',_('WeCom'),config.wecom)]);
  const sync=()=>{for(const name of ['feishu','wecom']){const channel=this.channels[name];channel.node.hidden=name!==this.channelSelect.value;channel.enabled.input.checked=name===this.channelSelect.value;}};
  this.channelSelect.addEventListener('change',sync);sync();
  const master=E('section',{class:'cbi-section zc-master'},this.master.node);
  const ruleCard=E('section',{class:'cbi-section zc-rule-card'},[E('div',{class:'zc-card-head'},[E('h3',{},_('Usage alerts')),this.addButton=E('button',{type:'button',class:'cbi-button',click:()=>this.addRule()},_('Add rule'))]),this.rules]);
  const dailyCard=E('section',{class:'cbi-section zc-daily'},[E('h3',{},_('Daily report')),E('div',{class:'zc-daily-row'},[this.daily.node,E('label',{class:'zc-time-field'},[E('span',{},_('Send time')),this.time])])]);
  const recent=E('section',{class:'cbi-section zc-recent'},[E('h3',{},_('Recent deliveries')),this.log]);
  const save=E('div',{class:'zc-savebar'},[E('div',{class:'zc-save-feedback'},[this.dirtyState,this.status]),E('div',{class:'zc-save-actions'},[this.undoButton,this.saveButton])]);
  const root=E('div',{id:'zen-notifications',class:'cbi-map zen-traffic-page zc-notifications'},[master,channelCard,ruleCard,dailyCard,recent,save]);
  this.root=root;for(const rule of config.rules)this.addRule(rule);
  this.drawLog(data[0]);this.dirty=false;this.editRevision=0;this.dirtyState.textContent=_('Current configuration');this.undoButton.disabled=true;
  root.addEventListener('input',()=>this.markDirty());root.addEventListener('change',()=>this.markDirty());
  this._poll=()=>{if(root.isConnected&&!root.closest('[hidden]'))return this.refreshLog();};poll.add(this._poll,5);return root;
 },
 markDirty(){this.dirty=true;this.editRevision=(this.editRevision||0)+1;if(this.dirtyState)this.dirtyState.textContent=_('Unsaved changes');if(this.undoButton)this.undoButton.disabled=!!this.saving;},
 channel(name,label,config){
  const enabled=toggle(label,config.enabled);
  const webhook=E('input',{type:'password',autocomplete:'off',value:'',spellcheck:false,placeholder:config.has_webhook?_('Saved · leave blank to keep'):_('Webhook URL'),'aria-label':label+' Webhook'});
  const secret=E('input',{type:'password',autocomplete:'off',value:'',placeholder:config.has_secret?_('Saved · leave blank to keep'):_('Optional'),'aria-label':label+' '+_('Signing secret')});
  const result=E('p',{class:'zen-notify-result',role:'status'});
  const button=E('button',{type:'button',class:'cbi-button',click:()=>this.test(name)},_('Send test'));
  const show=E('button',{type:'button',class:'zc-reveal','aria-label':_('Show %s').format(label+' Webhook'),click:()=>{const visible=webhook.type==='password';webhook.type=visible?'text':'password';show.textContent=visible?_('Hide'):_('Show');show.setAttribute('aria-label',(visible?_('Hide %s'):_('Show %s')).format(label+' Webhook'));}},_('Show'));
  const wrap=E('div',{class:'zc-secret-input'},[webhook,show]);
  const row=E('label',{class:'zc-form-row'},[E('span',{},'Webhook'),wrap]);
  const children=[row];if(name==='feishu')children.push(E('label',{class:'zc-form-row'},[E('span',{},_('Signing secret')),secret]));
  children.push(E('div',{class:'zc-channel-actions'},[result,button]));
  const node=E('div',{class:'zc-channel-fields','data-channel':name},children);
  this.channels[name]={enabled,webhook,secret,result,button,node};return node;
 },
 addRule(rule) {
  if(this.rows.length>=20)return;
  rule=rule||{id:'r-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6),enabled:true,mac:'',metric:'total',bytes:10*1024**3};
  const enabled=toggle(_('Enabled'),rule.enabled);
  const options=[E('option',{value:''},_('Whole network')),...this.devices.map(d=>E('option',{value:d.mac},(d.host||d.ip4||d.mac)+' · '+d.mac))];
  if(rule.mac&&!this.devices.some(d=>d.mac===rule.mac))options.push(E('option',{value:rule.mac},rule.mac));
  const device=E('select',{},options);device.value=rule.mac;
  const metric=E('select',{},[['total',_('Total usage')],['upload',_('Upload')],['download',_('Download')]].map(([value,label])=>E('option',{value},label)));metric.value=rule.metric;
  const unit=E('select',{'aria-label':_('Threshold unit')},['MiB','GiB','TiB'].map((label,i)=>E('option',{value:String(1024**(i+2))},label)));
  const scale=rule.bytes>=1024**3?1024**3:1024**2;unit.value=String(scale);
  const amount=E('input',{type:'number',min:'0.001',step:'any',value:String(rule.bytes/scale),'aria-label':_('Threshold amount')});
  const devField=field(_('Monitor'),device);devField.classList.add('zen-notify-device');
  const row={id:rule.id,enabled,device,metric,amount,unit};
  row.node=E('div',{'class':'zen-notify-rule'},[enabled.node,devField,field(_('Metric'),metric),
   field(_('Threshold'),E('div',{'class':'zen-notify-amount'},[amount,unit])),
   E('button',{type:'button','class':'cbi-button cbi-button-negative',click:()=>{
    row.node.remove();this.rows=this.rows.filter(r=>r!==row);this.addButton.disabled=false;this.markDirty();
   }},_('Remove'))]);
  this.rows.push(row);this.rules.appendChild(row.node);this.addButton.disabled=this.rows.length>=20;this.markDirty();
 },
 collect() {
  const channels={};
  for (const name of ['feishu','wecom']) {
   const c=this.channels[name];channels[name]={enabled:name===this.channelSelect.value&&!!(this.master.input.checked||c.webhook.value.trim()||this.saved.config[name].has_webhook),webhook:c.webhook.value.trim(),secret:c.secret.value.trim()};
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
  this.status.classList.remove('zen-notify-error');if(this.saving)return;this.saving=true;this.saveButton.disabled=true;this.undoButton.disabled=true;
  try {
   const config=this.collect(),revision=this.editRevision;const result=decode(await setSettings(JSON.stringify(config)));
   if(!result.ok)throw new Error(_(result.error));
   this.saved=decode(await getSettings());this.drawLog(this.saved);
   for(const name of ['feishu','wecom']) {
    const c=this.channels[name],saved=this.saved.config[name];
    if(c.webhook.value.trim()===config[name].webhook)c.webhook.value='';
    if(c.secret.value.trim()===config[name].secret)c.secret.value='';
    c.webhook.placeholder=saved.has_webhook?_('Saved · leave blank to keep'):_('Paste your bot webhook URL');
    c.secret.placeholder=saved.has_secret?_('Saved · leave blank to keep'):_('Optional signing secret');
   }
   this.dirty=this.editRevision!==revision;this.dirtyState.textContent=this.dirty?_('Unsaved changes'):_('Saved');this.undoButton.disabled=!this.dirty;
   this.status.textContent=this.dirty?_('Settings saved; newer changes still need to be saved.'):_('Notification settings saved.');
  } catch(e) {this.status.classList.add('zen-notify-error');this.status.textContent=errorText(e.message,_('Unable to save notification settings.'));}
  finally {this.saving=false;this.saveButton.disabled=false;this.undoButton.disabled=!this.dirty;}
 },
 async test(name) {
  const c=this.channels[name];c.result.classList.remove('zen-notify-error');
  if(this.dirty){c.result.textContent=_('Save your changes before sending a test.');return;}
  c.button.disabled=true;
  try {
   const result=decode(await testChannel(name));if(!result.ok)throw new Error(_(result.error));
   c.result.textContent=_('Test queued. Check Recent deliveries for the result.');await this.refreshLog();
  } catch(e){c.result.classList.add('zen-notify-error');c.result.textContent=errorText(e.message,_('Unable to queue test message.'));}
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
  if(!data.recent.length){this.log.appendChild(E('p',{'class':'zen-app-muted'},_('No deliveries yet.')));return;}
  this.log.appendChild(E('table',{'class':'table'},[
   E('thead',{},E('tr',{},[_('Time'),_('Channel'),_('Message'),_('Status')].map(t=>E('th',{scope:'col'},t)))),
   E('tbody',{},data.recent.map(r=>E('tr',{},[
    E('td',{},new Date(r.at*1000).toLocaleString()),E('td',{},r.channel==='feishu'?_('Feishu'):_('WeCom')),
    E('td',{},kinds[r.kind]||r.kind),E('td',{},[E('span',{},labels[r.status]||r.status),
     r.error?E('small',{'class':'zen-notify-error'},' · '+errorText(r.error)):''])
   ])))
  ]));
 }
});
