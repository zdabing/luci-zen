'use strict';
'require baseclass';
'require rpc';
'require view.zen.zen-format as fmt';
const calls={
 rename:rpc.declare({object:'zen.traffic',method:'setHostname',params:['mac','host'],reject:true}),
 policy:rpc.declare({object:'zen.traffic',method:'getDevicePolicy',params:['mac'],reject:true}),
 setPolicy:rpc.declare({object:'zen.traffic',method:'setDevicePolicy',params:['json'],reject:true}),
 binding:rpc.declare({object:'zen.device',method:'getBinding',params:['mac'],reject:true}),
 setBinding:rpc.declare({object:'zen.device',method:'setBinding',params:['mac','ip','enabled'],reject:true}),
 access:rpc.declare({object:'session',method:'access',params:['scope','object','function'],reject:true}),
 history:rpc.declare({object:'zen.traffic',method:'getInternetHistory',params:['agg','mac'],reject:true}),
 clock:rpc.declare({object:'zen.traffic',method:'getNotifications',reject:true})
};
const decode=response=>response&&typeof response.json==='string'?JSON.parse(response.json):response;
const checked=response=>{const value=decode(response);if(!value||value.ok!==true)throw Error(value?.error||'operation_failed');return value;};
const errors={ip_conflict:_('This IP address is already in use by another device.'),outside_lan:_('The IP address must belong to a LAN with DHCP enabled.'),router_ip:_('The router address cannot be reserved.'),invalid_ip:_('Enter a valid IPv4 address.'),shared_binding:_('This reservation is shared by multiple devices. Edit it on the DHCP page.'),ambiguous_binding:_('Multiple reservations match this device. Resolve them on the DHCP page.'),busy:_('Another operation is in progress. Try again shortly.'),dhcp_reload_failed:_('DHCP reload failed. The previous configuration was restored.'),rollback_failed:_('Rollback failed. Check the DHCP configuration and service.'),rollback_conflict:_('The configuration changed concurrently. Check DHCP settings.'),policy_storage_failed:_('Saving failed. The previous device policy was restored.'),policy_rollback_failed:_('Rollback failed. Check the device policy.'),hardware_offload_or_interface_unavailable:_('Hardware offload or unavailable interfaces prevent this policy. Check the traffic service.'),invalid_rate:_('Enter valid rate limits.'),policy_apply_failed:_('The kernel device policy could not be updated.'),operation_failed:_('Operation failed. Please retry.')};
const errorText=error=>errors[error?.message]||_('Operation failed. Check permissions and services, then retry.');
async function todayUsage(mac){const [raw,clock]=await Promise.all([calls.history('day',mac),calls.clock()]);const data=decode(raw),today=decode(clock)?.today;if(!Array.isArray(data?.days)||!today)throw Error('usage_unavailable');return data.days.filter(row=>row.date===today).reduce((sum,row)=>({upload:sum.upload+Math.max(0,Number(row.upload)||0),download:sum.download+Math.max(0,Number(row.download)||0)}),{upload:0,download:0});}

 const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=text;return node;};
 function install(owner,options={}){
  owner.zenControlOptions={...owner.zenControlOptions,...options};
  if(owner.zenControlsInstalled)return;owner.zenControlsInstalled=true;
  const original=owner.openDetail;
  owner.openDetail=function(entry){
   if(this.activeDetail===entry)return;
   original.call(this,entry);
   const dialog=this.detailDialog,body=dialog.querySelector('.zen-drawer-body'),footer=dialog.querySelector('.zen-drawer-footer'),device=entry.d;
   dialog.classList.add('rf-device-detail');
   const state={limit:null,fixedIP:'',blocked:false},allowed=new Map(),ready=new Map();let saving=false;
   const subtitle=dialog.querySelector('.zen-drawer-subtitle');
   const actions=el('div','rf-detail-actions');actions.setAttribute('aria-label',_('Device actions'));
   const buttons=new Map();
   for(const [key,label]of [['rename',_('Rename')],['limit',_('Rate limit')],['ip',_('Reserve IP')],['block',_('Block')]]){
    const button=el('button',key==='block'?'rf-detail-danger':'',label);button.type='button';button.disabled=true;button.dataset.deviceAction=key;button.setAttribute('aria-expanded','false');actions.append(button);buttons.set(key,button);
   }
   const policy=el('div','rf-detail-policy'),editor=el('section','rf-detail-editor');editor.hidden=true;editor.id='rf-device-editor';
   for(const button of buttons.values())button.setAttribute('aria-controls',editor.id);
   const message=el('p','rf-detail-message');message.setAttribute('role','status');message.hidden=true;
   const usage=el('section','rf-detail-usage'),usageHead=el('div','rf-detail-section-head');usageHead.append(el('h3','',_('Internet usage today')));
   const history=footer.querySelector('a');if(history){history.className='rf-detail-history';history.textContent=_('History analysis ↗');usageHead.append(history);}
   const amount=null,usageTotal=el('strong','rf-detail-total','—'),usageDirections=el('div','rf-detail-usage-directions');
   usageDirections.append(el('span','rf-up',_('↑ Upload ')+(amount?fmt.fmtBytes(amount.upload):'—')),el('span','rf-down',_('↓ Download ')+(amount?fmt.fmtBytes(amount.download):'—')));
   usage.append(usageHead,usageTotal,usageDirections);
   const rates=body.querySelector('.zen-device-live'),facts=body.querySelector('.zen-device-facts');
   const rateNodes=new Map([...rates.querySelectorAll('[data-rate]')].map(node=>[node.dataset.rate,node]));
   rates.classList.add('rf-detail-rate-table');rates.replaceChildren(el('span','rf-detail-table-label',_('Current speed')),el('span','rf-up',_('↑ Upload')),el('span','rf-down',_('↓ Download')));
   for(const [label,up,down]of [[_('Internet'),'wan_tx_r','wan_rx_r'],[_('LAN'),'lan_tx_r','lan_rx_r']])rates.append(el('span','rf-detail-table-label',label),rateNodes.get(up),rateNodes.get(down));
   facts.classList.add('rf-detail-facts');
   const info=el('section','rf-detail-info');info.append(el('h3','',_('Connection details')),facts);
   body.replaceChildren(actions,policy,editor,message,usage,rates,info);
   const identityButton=footer.querySelector('button');
   footer.replaceChildren(el('span','rf-detail-preview',document.body.dataset.previewReady==='true'?_('Example data'):_('Device management')));
   if(identityButton){identityButton.textContent=_('Device identity');footer.append(identityButton);}
   function sync(){
    subtitle.textContent=(device.online?_('● Online'):_('Offline'))+' · '+(device.conn==='wifi'?_('Wi-Fi')+(device.band?' · '+device.band:''):device.conn==='wired'?_('Wired'):device.conn||'');
    policy.replaceChildren();
    if(state.limit)policy.append(el('span','',_('Limit ↑ ')+(state.limit.upload||_('Unlimited'))+' / ↓ '+(state.limit.download||_('Unlimited'))+' Mbps'));
    if(state.fixedIP)policy.append(el('span','',_('Fixed IP ')+state.fixedIP));
    if(state.blocked)policy.append(el('span','rf-detail-danger',_('Blocked')));
    policy.hidden=!policy.children.length;
    buttons.get('block').textContent=state.blocked?_('Unblock'):_('Block');
    buttons.get('ip').textContent=state.fixedIP?_('Fixed IP'):_('Reserve IP');
    buttons.get('limit').classList.toggle('rf-detail-action-set',!!state.limit);
    buttons.get('ip').classList.toggle('rf-detail-action-set',!!state.fixedIP);
   }
   function closeEditor(){editor.hidden=true;editor.replaceChildren();for(const button of buttons.values())button.setAttribute('aria-expanded','false');}
   function notify(text){message.hidden=false;message.textContent=text;}
   function applyPolicy(value){state.blocked=!!value.blocked;state.limit=value.upload_kbps||value.download_kbps?{upload:value.upload_kbps/1000||'',download:value.download_kbps/1000||''}:null;}
   function availability(){for(const [key,button]of buttons){button.disabled=saving||!allowed.get(key)||!ready.get(key);button.title=allowed.get(key)?'':_('Device management permission is required.');}}
   function busy(value){saving=value;for(const input of editor.querySelectorAll('input,button'))input.disabled=value;availability();}
   async function run(operation,success,error){
    if(saving)return;busy(true);
    try{await operation();sync();closeEditor();notify(success);}
    catch(failure){error.hidden=false;error.textContent=errorText(failure);}
    finally{busy(false);}
   }
   async function load(){
    message.hidden=true;
    const permissions=await Promise.allSettled([['rename','zen.traffic','setHostname'],['limit','zen.traffic','setDevicePolicy'],['block','zen.traffic','setDevicePolicy'],['ip','zen.device','setBinding']].map(async([key,object,method])=>{const result=await calls.access('ubus',object,method);allowed.set(key,result===true||result?.access===true);}));
    ready.set('rename',true);
    const results=await Promise.allSettled([
     calls.policy(device.mac).then(checked).then(value=>{applyPolicy(value.policy);ready.set('limit',true);ready.set('block',true);if(value.enforceable===false&&(state.limit||state.blocked))notify(_('Hardware offload or the current interface state may bypass device policies.'));}),
     calls.binding(device.mac).then(checked).then(value=>{state.fixedIP=value.bound?value.ip:'';ready.set('ip',true);})
    ]);
    sync();availability();
    if(permissions.some(result=>result.status==='rejected')||results.some(result=>result.status==='rejected')){
     notify(_('Some device settings could not be loaded.'));const retry=el('button','rf-detail-retry',_('Retry'));retry.type='button';retry.addEventListener('click',()=>{retry.disabled=true;load();});message.append(' ',retry);
    }
   }
   Promise.resolve(owner.zenControlOptions.getUsage?.(device.mac)).then(value=>value||todayUsage(device.mac)).then(value=>{if(!dialog.isConnected)return;usageTotal.textContent=fmt.fmtBytes(value.upload+value.download);usageDirections.replaceChildren(el('span','rf-up',_('↑ Upload ')+fmt.fmtBytes(value.upload)),el('span','rf-down',_('↓ Download ')+fmt.fmtBytes(value.download)));}).catch(()=>{usageTotal.textContent='—';});
   function edit(key){
    const trigger=buttons.get(key),wasOpen=trigger.getAttribute('aria-expanded')==='true';closeEditor();message.hidden=true;if(wasOpen)return;
    trigger.setAttribute('aria-expanded','true');editor.hidden=false;
    const form=el('form'),heading=el('h3','',({rename:_('Rename'),limit:_('Device rate limits'),ip:_('Fixed IP'),block:state.blocked?_('Unblock'):_('Block device')})[key]),fields=el('div','rf-detail-fields'),controls=el('div','rf-detail-form-actions');
    const save=el('button','rf-detail-save',key==='block'?_('Confirm'):_('Save')),cancel=el('button','',_('Cancel'));save.type='submit';cancel.type='button';cancel.addEventListener('click',()=>{closeEditor();trigger.focus();});controls.append(cancel,save);
    const inputs={};
    function input(name,label,value,type='text'){
     const field=el('label'),node=el('input');node.name=name;node.type=type;node.value=value;field.append(el('span','',label),node);fields.append(field);inputs[name]=node;return node;
    }
    if(key==='rename'){const node=input('name',_('Device name'),device.host||'');node.required=true;node.maxLength=32;}
    if(key==='limit'){
     for(const [name,label]of [['upload',_('Upload · Mbps')],['download',_('Download · Mbps')]]){const node=input(name,label,state.limit?.[name]||'','number');node.min='0';node.max='100000';node.step='0.1';node.placeholder=_('Unlimited');}
     const reset=el('button','rf-detail-reset',_('Remove limits'));reset.type='button';reset.addEventListener('click',()=>run(async()=>{const response=checked(await calls.setPolicy(JSON.stringify({action:'limit',mac:device.mac,upload_kbps:0,download_kbps:0})));applyPolicy(response.policy);},_('Rate limits removed.'),error));if(state.limit)controls.prepend(reset);
    }
    if(key==='ip'){
     const node=input('address',_('IPv4 address'),state.fixedIP||device.ip4||'');node.required=true;node.inputMode='decimal';
     const reset=el('button','rf-detail-reset',_('Remove reservation'));reset.type='button';reset.addEventListener('click',()=>run(async()=>{checked(await calls.setBinding(device.mac,'',false));state.fixedIP='';},_('IP reservation removed.'),error));if(state.fixedIP)controls.prepend(reset);
    }
    if(key==='block')fields.append(el('p','',state.blocked?_('Restore Internet access for this device.'):_('Block Internet access for this device.')));
    const error=el('p','rf-detail-error');error.setAttribute('role','alert');error.hidden=true;
    form.append(heading,fields,error,controls);editor.append(form);
    form.addEventListener('submit',async event=>{
     event.preventDefault();error.hidden=true;
     if(key==='rename'){
      const value=inputs.name.value.trim();if(!value){error.textContent=_('Enter a device name.');error.hidden=false;return;}
      await run(async()=>{checked(await calls.rename(device.mac,value));device.host=value;for(const current of owner.devs||[])if(current.mac===device.mac)current.host=value;owner.render(owner.devs||[]);},_('Device name updated.'),error);return;
     }
     if(key==='limit'){
      const upload=Number(inputs.upload.value||0),download=Number(inputs.download.value||0);
      if(!Number.isFinite(upload)||!Number.isFinite(download)||upload<0||download<0||upload>100000||download>100000){error.textContent=_('Enter valid rate limits.');error.hidden=false;return;}
      await run(async()=>{const response=checked(await calls.setPolicy(JSON.stringify({action:'limit',mac:device.mac,upload_kbps:Math.round(upload*1000),download_kbps:Math.round(download*1000)})));applyPolicy(response.policy);},_('Rate limits saved.'),error);return;
     }
     if(key==='ip'){
      const value=inputs.address.value.trim(),parts=value.split('.');
      if(parts.length!==4||parts.some(part=>!/^\d{1,3}$/.test(part)||Number(part)>255)){error.textContent=_('Enter a valid IPv4 address.');error.hidden=false;return;}
      await run(async()=>{const response=checked(await calls.setBinding(device.mac,value,true));state.fixedIP=response.ip;},_('IP reservation saved. It takes effect at the next DHCP renewal.'),error);return;
     }
     if(key==='block'){const next=!state.blocked;await run(async()=>{const response=checked(await calls.setPolicy(JSON.stringify({action:'block',mac:device.mac,blocked:next})));applyPolicy(response.policy);},next?_('Internet access blocked.'):_('Internet access restored.'),error);}
    });
    (Object.values(inputs)[0]||save).focus({preventScroll:true});
   }
   for(const [key,button]of buttons)button.addEventListener('click',()=>{
    edit(key);
   });
   sync();load();
  };
 }
return baseclass.extend({install});
