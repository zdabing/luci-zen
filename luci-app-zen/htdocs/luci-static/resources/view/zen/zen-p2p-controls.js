'use strict';
'require baseclass';
'require rpc';
const get=rpc.declare({object:'zen.traffic',method:'getP2pPolicy',params:['mac'],reject:true});
const set=rpc.declare({object:'zen.traffic',method:'setP2pPolicy',params:['json'],reject:true});
const getDomains=rpc.declare({object:'zen.traffic',method:'getP2pDomains',reject:true});
const setDomains=rpc.declare({object:'zen.traffic',method:'setP2pDomains',params:['json'],reject:true});
const access=rpc.declare({object:'session',method:'access',params:['scope','object','function'],reject:true});
const unwrap=raw=>raw&&typeof raw.json==='string'?JSON.parse(raw.json):raw;
const checked=raw=>{const v=unwrap(raw);if(!v||v.ok!==true)throw Error(v?.error||'failed');return v;};
const errors={
 p2p_offload_or_interface_unavailable:_('Disable flow offloading and check the traffic interfaces before enabling P2P control.'),
 invalid_p2p_bypass:_('Enter up to eight valid remote IP addresses or CIDR prefixes.'),
 invalid_p2p_policy:_('Use an idle timeout between 30 and 600 seconds and at most eight exceptions.'),
 p2p_storage_failed:_('Saving failed. The previous P2P policy was restored.'),
 p2p_rollback_failed:_('Restoring the previous policy failed. Check the traffic service.'),
 p2p_apply_failed:_('The kernel P2P policy could not be updated.'),
 invalid_p2p_domains:_('Enter up to sixteen valid domain names, one per line.'),
 p2p_domains_storage_failed:_('Saving domains failed. Check the traffic service.'),
 p2p_domain_resolve_failed:_('Domain resolution failed. The previous exceptions are kept.'),
 p2p_domain_resolve_timeout:_('Domain resolution timed out. The previous exceptions are kept.')
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
  const observePreset=E('button',{type:'button',class:'cbi-button',disabled:true},_('Observe first'));
  const strictPreset=E('button',{type:'button',class:'cbi-button cbi-button-negative',disabled:true},_('Strict mode'));
  const offPreset=E('button',{type:'button',class:'cbi-button',disabled:true},_('Turn off'));
  const form=E('form',{},[
   E('label',{},[E('span',{},_('P2P control mode')),mode]),
   E('label',{},[E('span',{},_('Idle timeout · seconds')),idle]),
   E('label',{},[E('span',{},_('Remote IP / CIDR exceptions')),bypass]),
   E('p',{},_('One remote IP or CIDR per line, up to eight. Exceptions bypass matching packets only. LAN traffic and TCP are unchanged.')),
   E('p',{},_('IPv4 fragments and IPv6 extension headers are not filtered. A full endpoint table passes new endpoints and increments the capacity counter. This is not a complete PCDN blocker.')),
   counters,E('div',{class:'zen-p2p-actions'},[observePreset,strictPreset,offPreset,refresh,save]),status
  ]);
  const domainHelp=E('p',{},_('One domain per line, up to sixteen. Resolved addresses bypass the P2P lock for every device, which weakens strict blocking. IP exceptions above remain per device.'));
  const domainArea=E('textarea',{rows:3,maxlength:1024,'aria-label':_('Domain whitelist')});
  const domainStatus=E('p',{role:'status'});
  const domainSave=E('button',{type:'button',class:'cbi-button',disabled:true},_('Save domains'));
  const domainSection=E('details',{class:'zen-p2p-domains'},[E('summary',{},_('Domain whitelist · global (auto-resolved)')),domainHelp,E('div',{class:'zen-p2p-fields'},[domainArea]),E('div',{class:'zen-p2p-actions'},[domainSave]),domainStatus]);
  root.append(description,form,domainSection);host.append(root);
  let writable=false,domainsWritable=false,busy=false,loaded=false,serial=0;
  const lock=()=>{
   save.disabled=busy||!writable||!loaded;refresh.disabled=busy;
   observePreset.disabled=busy||!writable||!loaded;
   strictPreset.disabled=busy||!writable||!loaded;
   offPreset.disabled=busy||!writable||!loaded;
   for(const field of [mode,idle,bypass])field.disabled=busy||!writable||!loaded;
  };
  const lockDomains=()=>{domainSave.disabled=busy||!domainsWritable;domainArea.disabled=busy||!domainsWritable;};
  function drawStats(stats){counters.textContent=_('Packets since traffic service start: conflicts %s · dropped %s · exceptions %s · skipped %s · capacity %s').format(...['conflicts','dropped','bypassed','skipped','capacity'].map(k=>String(Math.max(0,Number(stats?.[k])||0))));}
  function drawDomains(value){
   const count=Array.isArray(value.domains)?value.domains.length:0,resolved=Math.max(0,Number(value.resolved_count)||0);
   domainStatus.textContent=value.error?errors[value.error]||_('Domain refresh failed. The previous exceptions are kept.'):count?_('Whitelist: %s domains · %s resolved addresses').format(count,resolved):_('No domains configured.');
  }
  async function loadDomains(){
   try{
    const [value,permission]=await Promise.all([getDomains().then(checked),access('ubus','zen.traffic','setP2pDomains')]);
    if(!root.isConnected)return;
    domainsWritable=permission===true||permission?.access===true;
    domainArea.value=value.domains.join('\n');drawDomains(value);
   }catch(error){domainsWritable=false;domainStatus.textContent=errors[error?.message]||_('Domain whitelist could not be loaded.');}
   finally{lockDomains();}
  }
  async function load(){
   const token=++serial;busy=true;lock();lockDomains();
   try{
    const [value,permission]=await Promise.all([get(mac).then(checked),access('ubus','zen.traffic','setP2pPolicy')]);
    if(token!==serial||!root.isConnected)return;
    writable=permission===true||permission?.access===true;loaded=true;
    mode.value=value.policy.mode;idle.value=value.policy.idle_seconds;bypass.value=value.policy.bypass.join('\n');drawStats(value.stats);
    status.textContent=!writable?_('Device management permission is required.'):value.enforceable===false?_('Flow offloading or unavailable interfaces may bypass this policy. You can still turn it off.'):_('Counters reset when the traffic service restarts. Start with observation before blocking.');
   }catch(_error){if(token===serial&&root.isConnected){loaded=false;status.textContent=_('P2P settings could not be loaded. Update the traffic service or check permissions, then retry.');}}
   finally{if(token===serial){busy=false;lock();lockDomains();}}
  }
  async function savePolicy(forced){
   if(busy||!loaded||!writable)return;
   const seconds=Number(forced?.idle_seconds??idle.value);
   const target=forced?.mode??mode.value;
   const rules=(forced?.bypass??bypass.value).split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
   if(!Number.isInteger(seconds)||seconds<30||seconds>600||rules.length>8){status.textContent=errors.invalid_p2p_policy;return;}
   busy=true;lock();lockDomains();status.textContent='';
   try{
    const saved=checked(await set(JSON.stringify({mac,policy:{mode:target,idle_seconds:seconds,bypass:rules}})));
    mode.value=saved.policy.mode;idle.value=saved.policy.idle_seconds;bypass.value=saved.policy.bypass.join('\n');
    status.textContent=saved.policy.mode==='enforce'?_('Strict mode is on. Conflicting UDP peers are dropped; use observe if games or calls misbehave.'):_('P2P policy saved. Endpoint locks restart with this policy.');
   }catch(error){status.textContent=errors[error?.message]||_('Unable to save P2P settings. Check permissions and the traffic service.');}
   finally{busy=false;lock();lockDomains();}
  }
  refresh.addEventListener('click',()=>load());
  observePreset.addEventListener('click',()=>savePolicy({mode:'observe',idle_seconds:120}));
  offPreset.addEventListener('click',()=>savePolicy({mode:'off',idle_seconds:120}));
  strictPreset.addEventListener('click',()=>{
   if(typeof confirm==='function'&&!confirm(_('Strict mode drops conflicting UDP peers. Games, calls, QUIC fallback and mesh VPNs may be affected. Observe first if unsure. Enable now?')))return;
   savePolicy({mode:'enforce',idle_seconds:120});
  });
  domainSave.addEventListener('click',async()=>{
   if(busy||!domainsWritable)return;
   const domains=domainArea.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
   if(domains.length>16){domainStatus.textContent=errors.invalid_p2p_domains;return;}
   busy=true;lock();lockDomains();
   try{checked(await setDomains(JSON.stringify({domains})));await loadDomains();domainStatus.textContent=_('Domain whitelist saved. Addresses refresh within a minute.');}
   catch(error){domainStatus.textContent=errors[error?.message]||_('Domain whitelist could not be saved.');}
   finally{busy=false;lock();lockDomains();}
  });
  form.addEventListener('submit',event=>{event.preventDefault();savePolicy();});
  lock();lockDomains();load();loadDomains();return root;
 }
});
