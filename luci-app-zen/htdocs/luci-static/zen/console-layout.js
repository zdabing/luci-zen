/* Zen content enhancement. OpenWrt owns the header and complete navigation. */
(() => {
 'use strict';
 // firstchild/alias dispatches keep the requested URL in the address bar.
 const path=document.currentScript?.dataset.dispatchPath||window.L?.env?.dispatchpath?.join('/')||location.pathname;
 const resourceVersion=document.currentScript?.dataset.resourceVersion;
 if(resourceVersion&&window.L?.env)L.env.resource_version=resourceVersion;
 if(!/(?:^|\/)admin\/zen(?:\/|$)/.test(path))return;
 // Set this before the LuCI view renders; it selects the reviewed content UI.
 window.ZenConsole={enabled:true};
 const page=path.endsWith('/analysis')?'history':path.endsWith('/settings')?'settings':'dashboard';
 let started=false;
 function build(){
  const view=document.querySelector('#view');
  if(started||!view?.firstElementChild)return;
  started=true;
  document.documentElement.classList.add('zen-console');
  const title=({dashboard:'网络概览',history:'流量分析',settings:'设置'})[page];
  document.title='Zen · '+title;
  const heading=document.createElement('div');heading.className='rf-page-head';
  const h1=document.createElement('h1');h1.textContent=title;heading.append(h1);
  const nav=document.createElement('nav');nav.className='zc-app-nav';nav.setAttribute('aria-label','Zen 页面');
  for(const [key,label,route] of [['dashboard','网络概览','realtime'],['history','流量分析','analysis'],['settings','设置','settings']]){
   const link=document.createElement('a');link.textContent=label;
   link.href=window.L?.url?L.url('admin','zen',route):'/cgi-bin/luci/admin/zen/'+route;
   if(key===page)link.setAttribute('aria-current','page');nav.append(link);
  }
  view.before(nav,heading);
  observer.disconnect();
 }
 const observer=new MutationObserver(build);observer.observe(document.documentElement,{subtree:true,childList:true});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});else build();
})();
