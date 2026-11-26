'use strict';
'require view';

// Display Appearance, Notifications and Versions stacked in one Settings page.
return view.extend({
 render() {
  const requested = new URLSearchParams(window.location.search).get('tab');
  const scrollTarget = requested === 'updates' ? 'versions' : ['appearance', 'notifications', 'versions'].includes(requested) ? requested : null;
  const panels = {}, slots = {}, pending = {};

  const appearance = window.ZenAppearance ? window.ZenAppearance.render() : E('p', {}, _('Appearance controls are available when using the Zen theme.'));
  panels.appearance = E('section', {
   id: 'zen-settings-appearance',
   class: 'zen-settings-panel zen-appearance-host',
   'aria-labelledby': 'zen-settings-heading-appearance'
  }, [
   E('h3', { id: 'zen-settings-heading-appearance', class: 'zen-settings-section-title' }, _('Appearance & layout')),
   E('div', { class: 'zen-settings-body' }, appearance)
  ]);

  slots.notifications = E('div', { class: 'zen-settings-body' });
  panels.notifications = E('section', {
   id: 'zen-settings-notifications',
   class: 'zen-settings-panel',
   'aria-labelledby': 'zen-settings-heading-notifications'
  }, [
   E('h3', { id: 'zen-settings-heading-notifications', class: 'zen-settings-section-title' }, _('Notification settings')),
   slots.notifications
  ]);

  slots.versions = E('div', { class: 'zen-settings-body' });
  panels.versions = E('section', {
   id: 'zen-settings-versions',
   class: 'zen-settings-panel',
   'aria-labelledby': 'zen-updates-title'
  }, slots.versions);

  const start = name => {
   if (name === 'appearance' || !panels[name].isConnected) return Promise.resolve();
   if (pending[name]) return pending[name];
   slots[name].textContent = _('Loading…');
   pending[name] = (async () => {
    if (name === 'versions') {
     const updates = await L.require('view.zen.zen-updates');
     slots[name].replaceChildren(updates.build());
     updates.start();
    } else {
     const component = Object.create(await L.require('view.zen-traffic.notification-settings'));
     const data = await component.load();
     slots[name].replaceChildren(component.render(data));
    }
   })().catch(() => {
    const retry = E('button', { type: 'button', class: 'cbi-button', click: () => { delete pending[name]; start(name); } }, _('Retry'));
    slots[name].replaceChildren(E('p', { class: 'alert-message warning' }, name === 'notifications' ?
     _('Notification settings are unavailable. Install and enable luci-app-zen and luci-zen.') : _('Unable to load versions. Please try again.')), retry);
   });
   return pending[name];
  };

  const root = E('div', { id: 'zen-settings', class: 'zen-settings-page' }, [
   E('h2', { class: 'zen-settings-title' }, _('Settings')),
   E('div', { class: 'zc-settings-content' }, [panels.appearance, panels.versions, panels.notifications])
  ]);

  requestAnimationFrame(() => {
   if (!root.isConnected) return;
   const loads = Promise.allSettled([start('notifications'), start('versions')]);
   if (scrollTarget) {
    (scrollTarget === 'appearance' ? Promise.resolve() : start(scrollTarget)).then(() => {
     if (panels[scrollTarget]?.isConnected) panels[scrollTarget].scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
   }
   return loads;
  });
  return root;
 },
 handleSaveApply:null,handleSave:null,handleReset:null
});
