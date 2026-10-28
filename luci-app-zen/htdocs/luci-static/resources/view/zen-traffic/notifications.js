'use strict';
'require view';
'require view.zen-traffic.notification-settings as notifications';

// Keep old bookmarks working; non-Zen themes retain their standalone form.
return view.extend({
 load() { return window.ZenAppearance ? Promise.resolve(null) : notifications.load(); },
 render(data) {
  if (window.ZenAppearance) {
   const target = L.url('admin','zen','settings');
   const url = target + (target.includes('?') ? '&' : '?') + 'tab=notifications';
   window.location.replace(url);
   return E('p', {}, E('a', {href:url}, _('Notification settings')));
  }
  return notifications.render(data);
 },
 handleSaveApply:null,handleSave:null,handleReset:null
});
