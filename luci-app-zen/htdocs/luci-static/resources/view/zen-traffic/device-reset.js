'use strict';
'require baseclass';
'require rpc';
'require ui';

const access=rpc.declare({object:'session',method:'access',params:['scope','object','function'],expect:{access:false}});
const reset=rpc.declare({object:'zen.traffic',method:'resetDevice',params:['mac'],reject:true});
return baseclass.extend({
 build(devices,selected,onReset) {
  const button=E('button',{type:'button',class:'cbi-button cbi-button-negative',hidden:true,click:()=>this.open(devices,selected(),onReset)},_('Reset counters…'));
  access('ubus','zen.traffic','resetDevice').then(result=>{button.hidden=!(result===true||result&&result.access===true);}).catch(()=>{});
  return button;
 },
 open(devices,initialMac,onReset) {
  const selected=new Set(initialMac?[initialMac]:[]), rows=[];
  let pending=null,busy=false;
  const error=E('p',{role:'alert',class:'zen-app-error',hidden:true});
  const list=E('div',{class:'zen-reset-devices'});
  const count=E('p',{'aria-live':'polite',class:'zen-app-muted'});
  const selectAll=E('input',{type:'checkbox',change:()=>{for(const row of rows){row.check.checked=selectAll.checked;if(selectAll.checked)selected.add(row.device.mac);else selected.delete(row.device.mac);}sync();}});
  const sync=()=>{
   count.textContent=_('%d selected').format(selected.size);confirm.disabled=!selected.size||busy;
   selectAll.checked=rows.length>0&&selected.size===rows.length;selectAll.indeterminate=selected.size>0&&selected.size<rows.length;
  };
  for(const device of devices) {
   const check=E('input',{type:'checkbox','aria-label':_('Select device')+': '+(device.host||device.mac),change:()=>{if(check.checked)selected.add(device.mac);else selected.delete(device.mac);sync();}});
   check.checked=selected.has(device.mac);rows.push({device,check});
   list.appendChild(E('label',{class:'zen-reset-device'},[check,E('span',{},[E('strong',{},device.host||device.mac),E('small',{},device.mac)])]));
  }
  const cancel=E('button',{type:'button',class:'cbi-button',click:()=>ui.hideModal()},_('Cancel'));
  const confirm=E('button',{type:'button',class:'cbi-button cbi-button-negative',click:async()=>{
   if(busy||!selected.size)return;
   if(!pending)pending=devices.filter(device=>selected.has(device.mac));
   busy=true;confirm.disabled=true;cancel.disabled=true;selectAll.disabled=true;rows.forEach(row=>row.check.disabled=true);error.hidden=true;
   confirm.textContent=_('Resetting…');
   const failed=[];
   for(const device of pending)try {const result=await reset(device.mac);if(!result||result.ok!==true)throw Error('reset failed');selected.delete(device.mac);}catch(e){failed.push(device);}
   busy=false;cancel.disabled=false;
   if(onReset)onReset();
   if(failed.length){
    pending=failed;list.replaceChildren(...failed.map(device=>E('p',{},(device.host||device.mac)+' · '+device.mac)));
    confirm.textContent=_('Retry failed devices');error.textContent=_('%d devices could not be reset. Retry to process only these devices.').format(failed.length);error.hidden=false;sync();
   }else ui.hideModal();
  }},_('Reset counters'));
  sync();
  ui.showModal(_('Reset selected device counters'),[
   E('p',{},_('This clears the selected devices’ traffic counters. This action cannot be undone.')),
   E('label',{class:'zen-reset-device'},[selectAll,E('span',{},_('Select all devices'))]),list,count,error,
   E('div',{class:'zen-tf-modal-actions'},[cancel,confirm])
  ]);
 }
});
