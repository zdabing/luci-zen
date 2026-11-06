/* Apple skin decoration; all actions use the existing LuCI routes. */
(() => {
 'use strict';
 const paths={
  cpu:['M7 7h10v10H7z','M9 2v5m6-5v5M9 17v5m6-5v5M2 9h5m-5 6h5m10-6h5m-5 6h5'],
  memory:['M3 6h18v12H3z','M7 9v4m5-4v4m5-4v4M6 18v3m4-3v3m4-3v3m4-3v3'],
  temperature:['M9 14.5V5a3 3 0 0 1 6 0v9.5a5 5 0 1 1-6 0Z','M12 9v8m6-11h3m-3 4h2'],
  connections:['M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6z','M12 8v4M5 16v-4h14v4'],
  globe:['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','M3 12h18M12 3c-5 5-5 13 0 18m0-18c5 5 5 13 0 18'],
  clock:['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','M12 7v5l3 2'],
  chart:['M4 3v17h17','M8 15V9m5 6V5m5 10v-4'],
  wave:['M3 13h4l3-7 4 13 3-6h4'],
  devices:['M3 4h15v11H3zM7 20h7M10.5 15v5','M19 10h3v11h-7v-4'],
  settings:['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z','M10 2h4l1 3 3-1 2 3-2 3 3 1v4l-3 1 1 3-3 2-3-2-1 3H8l-1-3-3 1-2-3 2-3-3-1v-4l3-1-1-3 3-2 3 2Z'],
  arrow:['M5 12h14m-5-5 5 5-5 5']
 };
 function icon(doc,name,color,extra=''){
  const box=doc.createElement('span');box.className=`apple-icon apple-icon-${color} ${extra}`;box.setAttribute('aria-hidden','true');
  const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');
  for(const d of paths[name]||paths.globe){const p=doc.createElementNS(svg.namespaceURI,'path');p.setAttribute('d',d);svg.append(p);}
  box.append(svg);return box;
 }
 function add(doc,node,name,color,extra=''){
  if(!node||node.querySelector('.apple-icon'))return;
  node.classList.add('apple-icon-label');node.prepend(icon(doc,name,color,extra));
 }
 function decorate(doc){
  const health=doc.querySelector('.rf-health');
  if(health)for(const [i,metric] of [...health.children].entries()){
   add(doc,metric.firstElementChild,['cpu','memory','temperature','connections'][i],['blue','green','orange','purple'][i]);
  }
  const addressKinds={wan:['globe','blue'],wan6:['globe','purple'],lan:['connections','teal'],uptime:['clock','orange']};
  for(const card of doc.querySelectorAll('[data-connection-card]')){
   const [name,color]=addressKinds[card.dataset.connectionCard]||['globe','blue'];
   add(doc,card.querySelector('.zen-dash-connection-label'),name,color,'apple-small-icon');
  }
  add(doc,doc.querySelector('.rf-live h3'),'wave','blue','apple-section-icon');
  add(doc,doc.querySelector('.zen-dash-devices h3'),'devices','purple','apple-section-icon');
  add(doc,doc.querySelector('.rf-share-bounded .zu-usage h2'),'chart','green','apple-section-icon');
  for(const [i,link] of [...doc.querySelectorAll('.zc-app-nav a')].entries())add(doc,link,['wave','chart','settings'][i],['blue','purple','teal'][i],'apple-nav-icon');
  const head=doc.querySelector('.rf-router-head');
  if(head&&!head.querySelector('.apple-primary-button')){
   const actions=doc.createElement('div');actions.className='apple-head-actions';
   const state=head.querySelector('.rf-wan-pill');if(state)actions.append(state);
   const button=doc.createElement('a');button.className='apple-primary-button';
   const target=doc.defaultView.L?.url ? new URL(doc.defaultView.L.url('admin','zen','analysis'),doc.defaultView.location.origin) : new URL(doc.defaultView.location.href);
   if(!doc.defaultView.L?.url)target.searchParams.set('page','history');button.href=target.href;
   button.append(doc.createTextNode(typeof window._==='function'?_('View traffic'):'查看流量'),icon(doc,'arrow','blue','apple-action-arrow'));
   actions.append(button);head.append(actions);
  }
 }
 let queued=false;
 function schedule(){
  if(queued||document.documentElement.dataset.skin!=='apple')return;
  queued=true;requestAnimationFrame(()=>{queued=false;if(document.documentElement.dataset.skin==='apple')decorate(document);});
 }
 new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true});
 document.addEventListener('zenappearancechange',schedule);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
})();
