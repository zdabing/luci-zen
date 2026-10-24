'use strict';
'require view';

// Optional traffic controls load on demand; appearance works without the plugin.
return view.extend({
 render() {
  const names = ['appearance', 'notifications', 'versions'];
  const labels = [_('Appearance & layout'), _('Notification settings'), _('Versions & updates')];
  const requested = new URLSearchParams(window.location.search).get('tab');
  let active = requested === 'updates' ? 'versions' : names.includes(requested) ? requested : 'appearance';
  const panels = {}, buttons = {}, pending = {};
  const appearance = window.ZenAppearance ? window.ZenAppearance.render() : E('p', {}, _('Appearance controls are available when using the Zen theme.'));
  const start = name => {
   if (name === 'appearance' || pending[name] || !panels[name].isConnected) return;
   panels[name].textContent = _('Loading…');
   pending[name] = (async () => {
    if (name === 'versions') {
     const updates = await L.require('view.zen.zen-updates');
     panels[name].replaceChildren(updates.build()); updates.start();
    } else {
     const component = Object.create(await L.require('view.zen-traffic.notification-settings'));
     const data = await component.load();
     panels[name].replaceChildren(component.render(data));
    }
   })().catch(() => {
    const retry = E('button', {type:'button',class:'cbi-button',click:()=>{delete pending[name];start(name);}}, _('Retry'));
    panels[name].replaceChildren(E('p', {class:'alert-message warning'}, name === 'notifications' ?
     _('Notification settings are unavailable. Install and enable luci-app-zen-traffic and zen-traffic.') : _('Unable to load versions. Please try again.')), retry);
   });
  };
  const select = (name, focus, remember) => {
   active=name;
   for (const key of names) {
    panels[key].hidden=key!==name;buttons[key].setAttribute('aria-selected',String(key===name));buttons[key].tabIndex=key===name?0:-1;
   }
   if(focus) buttons[name].focus();
   if(remember) {
    const url=new URL(window.location.href);
    if(name==='appearance')url.searchParams.delete('tab');else url.searchParams.set('tab',name==='versions'?'updates':name);
    window.history.replaceState(null,'',url);
   }
   start(name);
  };
  names.forEach((name,index)=>{
   panels[name]=E('section',{id:'zen-settings-'+name,class:'zen-settings-panel'+(name==='appearance'?' zen-appearance-host':''),role:'tabpanel','aria-labelledby':'zen-settings-tab-'+name,hidden:true},name==='appearance'?appearance:[]);
   buttons[name]=E('button',{id:'zen-settings-tab-'+name,type:'button',role:'tab','aria-controls':'zen-settings-'+name,'aria-selected':'false',tabindex:-1,
    click:()=>select(name,false,true),keydown:event=>{
     if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
     event.preventDefault();
     const next=event.key==='Home'?0:event.key==='End'?names.length-1:(names.indexOf(active)+(event.key==='ArrowLeft'?-1:1)+names.length)%names.length;
     select(names[next],true,true);
    }},labels[index]);
  });
  const root=E('div',{id:'zen-settings',class:'zen-settings-page'},[
   E('h2',{},_('Settings')),E('div',{class:'zen-settings-tabs zen-segmented',role:'tablist','aria-label':_('Settings')},names.map(name=>buttons[name])),...names.map(name=>panels[name])
  ]);
  select(active);requestAnimationFrame(()=>{if(root.isConnected)select(active);});
  return root;
 },
 handleSaveApply:null,handleSave:null,handleReset:null
});
