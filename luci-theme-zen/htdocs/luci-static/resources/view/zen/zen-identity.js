'use strict';
'require baseclass';
'require rpc';
'require ui';
'require view.zen.zen-icons as icons';
'require view.zen.zen-vendors as vendors';

const BRANDS = {
 realme: ['realme','R','#e7b900'], xiaomi: ['Xiaomi','mi','#f57921'],
 apple: ['Apple','A','#64748b'], samsung: ['Samsung','S','#2563eb'],
 huawei: ['Huawei','H','#dc2626'], honor: ['HONOR','H','#7658dd'],
 oppo: ['OPPO','O','#159447'], vivo: ['vivo','V','#2563eb'],
 oneplus: ['OnePlus','1+','#dc2626'], google: ['Google','G','#4285f4'],
 motorola: ['Motorola','M','#1769aa'], lenovo: ['Lenovo','L','#e2231a'],
 ugreen: ['UGREEN','U','#13875c'], synology: ['Synology','S','#475569'], qnap: ['QNAP','Q','#186cb6']
};
const NAMES = [[/realme|真我/i,'realme'],[/redmi|xiaomi|poco|小米|红米/i,'xiaomi'],[/iphone|ipad|macbook|apple|苹果/i,'apple'],
 [/samsung|galaxy|三星/i,'samsung'],[/huawei|harmony|华为/i,'huawei'],[/honor|荣耀/i,'honor'],[/oneplus|一加/i,'oneplus'],
 [/oppo/i,'oppo'],[/vivo|iqoo/i,'vivo'],[/pixel|google/i,'google'],[/motorola|moto[-_ ]/i,'motorola'],
 [/lenovo|thinkpad|ideapad/i,'lenovo'],[/ugreen|\bdxp\d+/i,'ugreen'],[/synology|diskstation/i,'synology'],[/qnap/i,'qnap']];
const get = rpc.declare({object:'uci',method:'get',params:['config','section'],expect:{values:{}},reject:true});
const set = rpc.declare({object:'uci',method:'set',params:['config','section','values'],reject:true});
const commit = rpc.declare({object:'uci',method:'commit',params:['config'],reject:true});
let saved = {}, loading;
const key = mac => 'device_' + String(mac||'').replace(/:/g,'').toLowerCase();
const TYPES = {phone:_('Phone'),tablet:_('Tablet'),desktop:_('Desktop'),laptop:_('Laptop'),nas:'NAS',tv:_('TV'),router:_('Router'),iot:_('Smart device'),unknown:_('Unknown')};

function identify(d) {
 let custom;
 try { custom=JSON.parse(saved[key(d.mac)]||'null'); } catch(e) {}
 const host=String(d.host||'');
 const match=NAMES.find(([re])=>re.test(host));
 const automatic=match ? match[1] : vendors.lookup(d.mac);
 const brand=custom && custom.brand ? custom.brand : automatic;
 const type=custom && custom.type ? custom.type : icons.inferType(host,d.conn);
 // Host names are user editable. Show them as reported models only when the
 // name itself identifies a phone; MAC vendor data never implies a model.
 const reported=match && type==='phone' ? host.replace(match[0],'').replace(/^[\s_-]+/,'').replace(/[-_]+/g,' ') : '';
 const model=custom && custom.model ? custom.model : (/\d/.test(reported) ? reported : '');
 const known=BRANDS[brand];
 return {type,brand:known ? brand : '',name:known ? known[0] : '',model,
  source:custom && (custom.brand||custom.type||custom.model) ? 'manual' : match ? 'name' : known ? 'mac' : ''};
}

return baseclass.extend({
 identify, BRANDS,
 load() { return loading || (loading=get('zen','device_identity').then(values=>{saved=values||{};}).catch(()=>{})); },
 glyph(info,size) {
  if(!info.brand) return icons.typeIcon(info.type,size);
  const b=BRANDS[info.brand];
  return E('span',{'class':'zen-device-brand','aria-hidden':'true',style:'--device-brand-color:'+b[2]},b[1]);
 },
 edit(d,changed) {
  let previous={};try {previous=JSON.parse(saved[key(d.mac)]||'{}');}catch(e){}
  const brand=E('select',{},[E('option',{value:''},_('Automatic')),
   ...Object.entries(BRANDS).map(([id,b])=>E('option',{value:id},b[0]))]);brand.value=previous.brand||'';
  const type=E('select',{},[E('option',{value:''},_('Automatic')),
   ...Object.keys(icons.ICON_BY_TYPE).map(id=>E('option',{value:id},TYPES[id]))]);type.value=previous.type||'';
  const model=E('input',{type:'text',maxlength:64,value:previous.model||'',placeholder:_('Automatic')});
  const error=E('p',{role:'alert','class':'zen-identity-error',hidden:true});
  const save=E('button',{type:'button','class':'cbi-button cbi-button-positive',click:async()=>{
   save.disabled=true;error.hidden=true;
   const value=JSON.stringify({brand:brand.value,type:type.value,model:model.value.trim()});
   try {await set('zen','device_identity',{[key(d.mac)]:value});await commit('zen');saved[key(d.mac)]=value;ui.hideModal();changed();}
   catch(e){error.textContent=_('Unable to save device identity');error.hidden=false;}
   finally{save.disabled=false;}
  }},_('Save'));
  ui.showModal(_('Device identity'),[
   E('p',{},d.host||d.ip4||d.mac),
   E('div',{'class':'zen-identity-form'},[
    E('label',{},[_('Brand'),brand]),E('label',{},[_('Device type'),type]),E('label',{},[_('Model'),model])]),
   E('p',{},_('Automatic uses device names and MAC vendors. Private MAC addresses cannot identify a brand.')),
   error,E('div',{'class':'right'},[E('button',{type:'button','class':'cbi-button',click:()=>ui.hideModal()},_('Cancel')),' ',save])]);
 }
});
