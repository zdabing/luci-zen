'use strict';
'require baseclass';
'require rpc';

const rules = rpc.declare({ object:'zen.traffic',method:'getDpiRules',reject:true });
const save = rpc.declare({ object:'zen.traffic',method:'setDpiRules',params:['json'],reject:true });
const rollback = rpc.declare({ object:'zen.traffic',method:'rollbackDpiRules',reject:true });
const dns = rpc.declare({ object:'zen.traffic',method:'setDpiDns',params:['enabled'],reject:true });
const feedback = rpc.declare({ object:'zen.traffic',method:'setDpiFeedback',params:['json'],reject:true });
const diagnostics = rpc.declare({ object:'zen.traffic',method:'getDpiDiagnostics',params:['mac','limit'],reject:true });
const detail = rpc.declare({ object:'zen.traffic',method:'setDpiDiagnostics',params:['seconds'],reject:true });
const decoded = reply => typeof reply?.json==='string' ? JSON.parse(reply.json) : reply;
const appLabels={'ndpi:324':'腾讯视频','ndpi:54':'爱奇艺','ndpi:197':'微信','ndpi:395':'腾讯游戏','community:youku':'优酷','community:bilibili':'哔哩哔哩','community:mgtv':'芒果 TV','community:douyin':'抖音','community:kuaishou':'快手','community:douyu':'斗鱼','community:huya':'虎牙'};
const levelName=level=>({dedicated:_('Dedicated domain'),candidate:_('Diagnostic candidate'),infrastructure:_('Infrastructure')})[level]||level;
const errors={invalid_rule_json:_('Invalid rule package JSON.'),invalid_rule_header:_('Invalid rule package format.'),unknown_application_key:_('Unsupported application identifier.'),conflicting_domain_rules:_('Conflicting domain ownership.'),overlapping_application_rules:_('Conflicting domain ownership.'),shared_domain_cannot_identify_application:_('Shared domains cannot identify one application.'),rule_version_conflict:_('Change the version before changing rule content.'),rules_not_found:_('No previous rule package.'),rules_stage_unavailable:_('Rule storage is unavailable.'),rules_directory_unavailable:_('Rule storage is unavailable.'),dns_capture_unavailable:_('DNS metadata capture is unavailable.')};

return baseclass.extend({
 render(status) {
  this.mac=null; this.pending=false; this.loaded=false;
  if(!status?.dpi_rules)return E('span');
  this.message=E('p',{class:'zen-app-muted',role:'status'});
  this.version=E('span',{class:'zen-app-muted'});
  this.dns=E('input',{type:'checkbox',change:()=>this.perform(async()=>{await this.mutate(dns(this.dns.checked));await this.load();})});
  this.input=E('textarea',{class:'cbi-input-textarea',rows:5,'aria-label':_('Rule package JSON'),spellcheck:'false'});
  const file=E('input',{type:'file',accept:'.json,application/json','aria-label':_('Import rule package'),change:async event=>{
   const selected=event.target.files?.[0];if(!selected)return;
   if(selected.size>524288){this.message.textContent=_('Rule package is too large.');return;}
   try{this.input.value=await selected.text();JSON.parse(this.input.value);this.message.textContent=_('Ready to validate and apply.');}
   catch(_error){this.message.textContent=_('Invalid rule package JSON.');}
  }});
  this.rule=E('select',{'aria-label':_('Matching rule'),change:()=>this.ruleInfoText()});this.expected=E('select',{'aria-label':_('Correct application')});
  this.ruleInfo=E('p',{class:'zen-app-muted'});
  this.output=E('div',{class:'zen-dpi-diagnostics','aria-live':'polite'});
  const button=(label,fn)=>E('button',{type:'button',class:'cbi-button',click:()=>this.perform(fn)},label);
  this.panel=E('details',{class:'zen-dpi-controls',toggle:()=>{if(this.panel.open&&!this.loaded)this.perform(()=>this.load());}},[
   E('summary',{},_('Recognition settings and diagnostics')),
   this.version,this.message,
   E('label',{class:'zen-dpi-dns'},[this.dns,E('span',{},_('Device-scoped DNS assistance'))]),
   E('details',{},[E('summary',{},_('Rule management')),E('p',{class:'zen-app-muted'},_('Rule changes apply to new connections.')),
    file,this.input,E('div',{class:'zen-dpi-actions'},[
     button(_('Validate and apply'),async()=>{if(this.input.value.length>524288)throw Error(_('Rule package is too large.'));try{JSON.parse(this.input.value);}catch(_error){throw Error(_('Invalid rule package JSON.'));}await this.mutate(save(this.input.value));await this.load();}),
     button(_('Restore previous rules'),async()=>{await this.mutate(rollback());await this.load();}),
     button(_('Export rules'),async()=>{
      const data=decoded(await rules());const blob=new Blob([JSON.stringify(data.package,null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob);const anchor=E('a',{href:url,download:'zen-app-rules.json'});document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
     })
    ])]),
   E('details',{},[E('summary',{},_('Report a classification error')),this.rule,this.ruleInfo,this.expected,
    button(_('Save feedback'),async()=>{await this.mutate(feedback(JSON.stringify({rule_id:this.rule.value,expected:this.expected.value})));this.message.textContent=_('Feedback saved.');})]),
   E('div',{class:'zen-dpi-actions'},[
    button(_('Refresh diagnostics'),async()=>{await this.load();await this.inspect();}),
    button(_('Enable details for 60 seconds'),async()=>{await this.mutate(detail(60));await this.inspect();}),
    button(_('Stop details'),async()=>{await this.mutate(detail(0));await this.inspect();})
   ]),this.output
  ]);
  return this.panel;
 },
 setDevice(mac){this.mac=mac;if(this.output)this.output.replaceChildren();},
 async mutate(promise){const result=decoded(await promise);if(result?.ok!==true)throw Error(errors[result?.error]||_('Unable to save recognition settings.'));},
 async perform(fn){
  if(this.pending)return;this.pending=true;
  this.panel.querySelectorAll('button,input,select,textarea').forEach(control=>control.disabled=true);
  this.message.textContent=_('Working…');
  try{await fn();if(this.message.textContent===_('Working…'))this.message.textContent=_('Done.');}
  catch(error){
   this.dns.checked=!!this.savedDns;
   const safeMessages=[...Object.values(errors),_('Invalid rule package JSON.'),_('Rule package is too large.'),_('Choose a device first.'),_('Invalid recognition response.')];
   this.message.textContent=_('Operation failed: ')+(safeMessages.includes(error?.message)?error.message:_('Unable to save recognition settings.'));
  }
  finally{this.pending=false;this.panel.querySelectorAll('button,input,select,textarea').forEach(control=>control.disabled=false);}
 },
 async load(){
  const data=decoded(await rules());
  if(!Array.isArray(data.rules)||data.rules.length>2200||!Array.isArray(data.applications))throw Error(_('Invalid recognition response.'));
  this.loaded=true;this.savedDns=data.dns_enabled===true;this.dns.checked=this.savedDns;
  this.version.textContent=data.version+' · '+data.rules.length+' '+_('rules');
  this.ruleData=new Map(data.rules.map(rule=>[rule.match+':'+rule.domain+':'+rule.app,rule]));this.hitData=new Map((data.rule_hits||[]).map(row=>[row.rule_id,row.counts?.connections||0]));
  this.rule.replaceChildren(...data.rules.map(rule=>E('option',{value:rule.match+':'+rule.domain+':'+rule.app},rule.domain+' · '+levelName(rule.level))));
  this.expected.replaceChildren(E('option',{value:'unidentified'},_('Unidentified')), ...data.applications.map(app=>E('option',{value:app.key},appLabels[app.key]||app.name)));
  this.ruleInfoText();if(data.error)this.message.textContent=data.error==='restored_previous_rules'?_('Previous rules were restored.'):_('Custom rules could not be loaded.');
 },
 ruleInfoText(){const rule=this.ruleData?.get(this.rule.value);if(rule)this.ruleInfo.textContent=[rule.source,rule.revision?.slice(0,16),rule.license,_('Live connections')+': '+(this.hitData?.get(this.rule.value)||0)].join(' · ');},
 async inspect(){
  if(!this.mac)throw Error(_('Choose a device first.'));
  const mac=this.mac;const data=decoded(await diagnostics(mac,20));if(mac!==this.mac)return;
  if(!data.categories||!data.engine||!Array.isArray(data.connections))throw Error(_('Invalid recognition response.'));
  this.output.replaceChildren(E('p',{},[
   _('Live connection snapshot'), ' · ',String(data.total?.connections||0),' · ',
   _('Dropped samples'),': ',String(data.engine.queue_dropped||0), ' · ',
   _('Rule conflicts'),': ',String(data.facets?.conflicts?.connections||0)
  ]));
  this.output.appendChild(E('p',{class:'zen-app-muted'},_('Domain details stay in memory and expire automatically.')));
  if(data.detail?.enabled){
   this.output.appendChild(E('ul',{},data.connections.slice(0,20).map(row=>E('li',{},[
    E('strong',{},row.application||_('Recognition in progress')), ' · ',row.evidence?.hostname||row.remote_ip||'—',
    ' · ',({ndpi:_('Native DPI'),dedicated_domain:_('Dedicated domain'),dns:_('DNS assistance'),infrastructure:_('Infrastructure')})[row.evidence?.source]||'—', row.evidence?.conflict?' · '+_('Conflict'):''
   ]))));
  }
 }
});
