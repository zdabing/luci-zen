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
  if(page!=='dashboard'){
   const h1=document.createElement('h1');h1.textContent=title;h1.className='zc-sr-only';
   view.before(h1);
  }
  observer.disconnect();
 }
 const observer=new MutationObserver(build);observer.observe(document.documentElement,{subtree:true,childList:true});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',build,{once:true});else build();
})();
