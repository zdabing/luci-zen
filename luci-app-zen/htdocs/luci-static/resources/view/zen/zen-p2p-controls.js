'use strict';
'require baseclass';
'require rpc';
const get=rpc.declare({object:'zen.traffic',method:'getP2pPolicy',params:['mac'],reject:true});
const set=rpc.declare({object:'zen.traffic',method:'setP2pPolicy',params:['json'],reject:true});
const access=rpc.declare({object:'session',method:'access',params:['scope','object','function'],reject:true});
const checked=raw=>{const v=raw&&typeof raw.json==='string'?JSON.parse(raw.json):raw;if(!v||v.ok!==true)throw Error(v?.error||'failed');return v;};
const errors={
 p2p_offload_or_interface_unavailable:_('Disable flow offloading and check the traffic interfaces before enabling P2P control.'),
 invalid_p2p_bypass:_('Enter up to eight valid remote IP addresses or CIDR prefixes.'),
 invalid_p2p_policy:_('Use an idle timeout between 30 and 600 seconds and at most eight exceptions.'),
 p2p_storage_failed:_('Saving failed. The previous P2P policy was restored.'),
 p2p_rollback_failed:_('Restoring the previous policy failed. Check the traffic service.'),
 p2p_apply_failed:_('The kernel P2P policy could not be updated.')
};
return baseclass.extend({
 mount(host,mac){
  const root=E('details',{class:'zen-p2p-controls'},E('summary',{},_('Strict P2P control')));
  const description=E('p',{},_('Optional UDP endpoint isolation. It can reduce P2P hole punching, including some PCDN traffic. Games, calls and mesh VPNs may be affected.'));
  const mode=E('select',{'aria-label':_('P2P control mode')},[
   E('option',{value:'off'},_('Off')),E('option',{value:'observe'},_('Observe only')),E('option',{value:'enforce'},_('Block conflicting peers'))
  ]);
  const idle=E('input',{type:'number',min:30,max:600,step:1,value:120,'aria-label':_('Idle timeout · seconds')});
  const bypass=E('textarea',{rows:3,maxlength:512,'aria-label':_('Remote IP / CIDR exceptions'),placeholder:'203.0.113.8\n2001:db8::/32'});
  const status=E('p',{role:'status'}),counters=E('p',{class:'zen-p2p-counters'});
  const save=E('button',{type:'submit',class:'cbi-button cbi-button-positive',disabled:true},_('Save'));
  const refresh=E('button',{type:'button',class:'cbi-button'},_('Refresh counters'));
  const form=E('form',{},[
   E('label',{},[E('span',{},_('P2P control mode')),mode]),
   E('label',{},[E('span',{},_('Idle timeout · seconds')),idle]),
   E('label',{},[E('span',{},_('Remote IP / CIDR exceptions')),bypass]),
   E('p',{},_('One remote IP or CIDR per line, up to eight. Exceptions bypass matching packets only. LAN traffic and TCP are unchanged.')),
   E('p',{},_('IPv4 fragments and IPv6 extension headers are not filtered. A full endpoint table passes new endpoints and increments the capacity counter. This is not a complete PCDN blocker.')),
   counters,E('div',{class:'zen-p2p-actions'},[refresh,save]),status
  ]);
  root.append(description,form);host.append(root);
  let writable=false,busy=false,loaded=false,serial=0;
  const lock=()=>{save.disabled=busy||!writable||!loaded;refresh.disabled=busy;for(const field of [mode,idle,bypass])field.disabled=busy||!writable||!loaded;};
  function drawStats(stats){counters.textContent=_('Packets since traffic service start: conflicts %s · dropped %s · exceptions %s · skipped %s · capacity %s').format(...['conflicts','dropped','bypassed','skipped','capacity'].map(k=>String(Math.max(0,Number(stats?.[k])||0))));}
  async function load(){
   const token=++serial;busy=true;lock();
   try{
    const [value,permission]=await Promise.all([get(mac).then(checked),access('ubus','zen.traffic','setP2pPolicy')]);
    if(token!==serial||!root.isConnected)return;
    writable=permission===true||permission?.access===true;loaded=true;
    mode.value=value.policy.mode;idle.value=value.policy.idle_seconds;bypass.value=value.policy.bypass.join('\n');drawStats(value.stats);
    status.textContent=!writable?_('Device management permission is required.'):value.enforceable===false?_('Flow offloading or unavailable interfaces may bypass this policy. You can still turn it off.'):_('Counters reset when the traffic service restarts. Start with observation before blocking.');
   }catch(_error){if(token===serial&&root.isConnected){loaded=false;status.textContent=_('P2P settings could not be loaded. Update the traffic service or check permissions, then retry.');}}
   finally{if(token===serial){busy=false;lock();}}
  }
  refresh.addEventListener('click',()=>load());
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy||!loaded||!writable)return;
   const seconds=Number(idle.value),rules=bypass.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
   if(!Number.isInteger(seconds)||seconds<30||seconds>600||rules.length>8){status.textContent=errors.invalid_p2p_policy;return;}
   busy=true;lock();status.textContent='';
   try{checked(await set(JSON.stringify({mac,policy:{mode:mode.value,idle_seconds:seconds,bypass:rules}})));status.textContent=_('P2P policy saved. Endpoint locks restart with this policy.');}
   catch(error){status.textContent=errors[error?.message]||_('Unable to save P2P settings. Check permissions and the traffic service.');}
   finally{busy=false;lock();}
  });
  lock();load();return root;
 }
});
