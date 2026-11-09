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
const modes = { off: _('Off'), observe: _('Observe only'), enforce: _('Block conflicting peers') };
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
function packetCount(value) {
 return Number.isFinite(value) && value >= 0 ? _('%s packets').format(value.toLocaleString()) : '—';
}

function drawMetric(field, value) {
 if (!Number.isFinite(value) || value < 0) {
  field.textContent = '—';
  return;
 }
 const [prefix, suffix] = _('%s packets').split('%s');
 const parts = [prefix && E('small', {}, prefix), E('span', {}, value.toLocaleString()), suffix && E('small', {}, suffix)];
 field.replaceChildren(...parts.filter(Boolean));
}

return baseclass.extend({
 mount(host, mac) {
  const root = E('section', { class: 'zen-p2p-controls' });
  const modeStatus = E('span', { class: 'zen-p2p-mode' }, '—');
  const heading = E('div', { class: 'rf-detail-section-head' }, [E('h3', {}, _('P2P control')), modeStatus]);
  const droppedLabel = E('dt', {}, _('Blocked today')), dropped = E('dd', {}, '—');
  const conflictsLabel = E('dt', {}, _('Conflicts today')), conflicts = E('dd', {}, '—');
  const stats = E('dl', { class: 'zen-p2p-stats' }, [
   E('div', { class: 'zen-p2p-blocked-stat' }, [droppedLabel, dropped]),
   E('div', { class: 'zen-p2p-conflict-stat' }, [conflictsLabel, conflicts])
  ]);

  const mode = E('select', { 'aria-label': _('P2P control mode') }, Object.entries(modes).map(([value, label]) => E('option', { value }, label)));
  const idle = E('input', { type: 'number', min: 30, max: 600, step: 1, value: 120, 'aria-label': _('Idle timeout · seconds') });
  const bypass = E('textarea', { rows: 2, maxlength: 512, 'aria-label': _('Remote IP / CIDR exceptions') });
  const status = E('p', { role: 'status', class: 'rf-detail-message' });
  const risk = E('p', { class: 'zen-p2p-hint', hidden: true }, _('Blocking can affect games, calls and mesh VPNs.'));
  const save = E('button', { type: 'submit', class: 'rf-detail-save' }, _('Save'));
  const refresh = E('button', { type: 'button', class: 'rf-detail-reset' }, _('Reload'));
  const domainArea = E('textarea', { rows: 2, maxlength: 1024, 'aria-label': _('Domain whitelist') });
  const domainStatus = E('p', { role: 'status', class: 'rf-detail-message' });
  const domainSave = E('button', { type: 'button' }, _('Save domains'));
  const domainSection = E('details', { class: 'zen-p2p-domains' }, [
   E('summary', {}, _('Global domain whitelist')),
   E('p', { class: 'zen-p2p-hint' }, _('Applies to all devices. One domain per line, up to sixteen.')),
   domainArea, E('div', { class: 'rf-detail-form-actions' }, domainSave), domainStatus
  ]);
  const diagnostics = E('dl', { class: 'zen-p2p-stats zen-p2p-diagnostics' });
  const diagnosticValues = new Map();
  for (const [key, label] of [['bypassed', _('Exceptions')], ['skipped', _('Skipped packets')], ['capacity', _('Capacity misses')]]) {
   const value = E('dd', {}, '—');
   diagnosticValues.set(key, value);
   diagnostics.append(E('div', {}, [E('dt', {}, label), value]));
  }
  const advanced = E('details', { class: 'zen-p2p-advanced' }, [
   E('summary', {}, _('Advanced settings')),
   E('div', { class: 'rf-detail-fields' }, [
    E('label', {}, [E('span', {}, _('Idle timeout · seconds')), idle]),
    E('label', {}, [E('span', {}, _('Remote IP / CIDR exceptions')), bypass,
     E('small', { class: 'zen-p2p-hint' }, _('One IP or prefix per line, up to eight.'))])
   ]), diagnostics, domainSection
  ]);
  const form = E('form', { class: 'rf-detail-editor zen-p2p-editor', novalidate: true }, [
   E('div', { class: 'rf-detail-fields' }, E('label', {}, [E('span', {}, _('P2P control mode')), mode])),
   risk, advanced, E('div', { class: 'rf-detail-form-actions' }, [refresh, save]), status
  ]);
  root.append(heading, stats, E('details', { class: 'zen-p2p-settings' }, [E('summary', {}, _('P2P settings')), form]));
  host.append(root);

  let writable = false, domainsWritable = false, busy = false, policy = null;
  const canWrite = method => access('ubus', 'zen.traffic', method).then(result => result === true || result?.access === true, () => false);
  function lock() {
   save.disabled = busy || !writable || !policy;
   refresh.disabled = busy;
   for (const field of [mode, idle, bypass]) field.disabled = save.disabled;
   domainSave.disabled = domainArea.disabled = busy || !domainsWritable;
  }
  function drawStats(value) {
   const historical = Object.hasOwn(value, 'today_stats');
   const counts = historical ? value.today_stats : value.stats;
   droppedLabel.textContent = historical ? _('Blocked today') : _('Blocked this run');
   conflictsLabel.textContent = historical ? _('Conflicts today') : _('Conflicts this run');
   drawMetric(dropped, counts?.dropped);
   drawMetric(conflicts, counts?.conflicts);
   for (const [key, field] of diagnosticValues) field.textContent = packetCount(counts?.[key]);
  }
  function syncRisk() {
   risk.hidden = mode.value !== 'enforce' || policy?.mode === 'enforce';
  }
  function applyPolicy(value) {
   policy = value;
   modeStatus.textContent = modes[value.mode] || '—';
   mode.value = value.mode;
   idle.value = value.idle_seconds;
   bypass.value = value.bypass.join('\n');
   syncRisk();
  }
  async function loadDomains(saved = false) {
   try {
    const [value, permission] = await Promise.all([getDomains().then(checked), canWrite('setP2pDomains')]);
    if (!root.isConnected) return;
    domainsWritable = permission;
    domainArea.value = value.domains.join('\n');
    if (value.error) domainStatus.textContent = errors[value.error] || _('Domain refresh failed. The previous exceptions are kept.');
    else if (saved) domainStatus.textContent = _('Domain whitelist saved.');
    else domainStatus.textContent = value.domains.length ?
     _('Whitelist: %s domains · %s resolved addresses').format(value.domains.length, Number(value.resolved_count) || 0) : '';
   } catch (error) {
    domainsWritable = false;
    domainStatus.textContent = errors[error?.message] || _('Domain whitelist could not be loaded.');
   } finally { lock(); }
  }
  async function load() {
   if (busy) return;
   busy = true; lock();
   try {
    const [value, permission] = await Promise.all([get(mac).then(checked), canWrite('setP2pPolicy')]);
    if (!root.isConnected) return;
    writable = permission;
    applyPolicy(value.policy);
    drawStats(value);
    status.textContent = !writable ? _('Device management permission is required.') :
     value.enforceable === false ? _('Offloading or unavailable interfaces can bypass P2P control.') : '';
   } catch {
    policy = null;
    modeStatus.textContent = _('Unavailable');
    status.textContent = _('Unable to load P2P settings.');
   } finally { busy = false; lock(); }
  }
  async function savePolicy(event) {
   event.preventDefault();
   if (busy || !policy || !writable) return;
   const seconds = Number(idle.value);
   const rules = bypass.value.split(/\r?\n/).map(rule => rule.trim()).filter(Boolean);
   if (!Number.isInteger(seconds) || seconds < 30 || seconds > 600 || rules.length > 8) {
    status.textContent = errors.invalid_p2p_policy;
    return;
   }
   busy = true; lock(); status.textContent = '';
   try {
    const saved = checked(await set(JSON.stringify({ mac, policy: { mode: mode.value, idle_seconds: seconds, bypass: rules } })));
    applyPolicy(saved.policy);
    status.textContent = _('P2P settings saved.');
   } catch (error) {
    status.textContent = errors[error?.message] || _('Unable to save P2P settings.');
   } finally { busy = false; lock(); }
  }
  domainSave.addEventListener('click', async () => {
   if (busy || !domainsWritable) return;
   const domains = domainArea.value.split(/\r?\n/).map(domain => domain.trim()).filter(Boolean);
   if (domains.length > 16) { domainStatus.textContent = errors.invalid_p2p_domains; return; }
   busy = true; lock();
   try {
    checked(await setDomains(JSON.stringify({ domains })));
    await loadDomains(true);
   } catch (error) {
    domainStatus.textContent = errors[error?.message] || _('Domain whitelist could not be saved.');
   } finally { busy = false; lock(); }
  });
  mode.addEventListener('change', syncRisk);
  refresh.addEventListener('click', load);
  form.addEventListener('submit', savePolicy);
  load(); loadDomains();
  return root;
 }
});
