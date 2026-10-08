/* Acceptance fixture only; never packaged. Render the real LuCI modules with
 * deterministic, read-only RPC fixtures and their actual Chinese PO strings. */
(async function () {
 'use strict';
 const page = new URLSearchParams(location.search).get('page') || 'dashboard';
 if (['realtime','devices'].includes(page)) { location.replace('?page=dashboard'); return; }
 const translations = {};
 for (const file of ['../luci-theme-zen/po/zh_Hans/theme.po','../luci-app-zen-traffic/po/zh_Hans/zen-traffic.po']) {
  const text = await (await fetch(file)).text();
  for (const match of text.matchAll(/^msgid (".*")\r?\nmsgstr (".*")/gm)) translations[JSON.parse(match[1])] = JSON.parse(match[2]);
 }
 window._ = text => translations[text] || text;
 String.prototype.format = function (...args) { let index = 0; return this.replace(/%%|%[sd]/g, token => token === '%%' ? '%' : String(args[index++])); };
 window.E = function (tag, attributes = {}, children = []) {
  if (Array.isArray(tag)) { const fragment = document.createDocumentFragment(); tag.forEach(child => fragment.append(child)); return fragment; }
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
   if (value == null) continue;
   if (typeof value === 'function') node.addEventListener(key, value);
   else if (key === 'value') node.value = value;
   else if (value !== false) node.setAttribute(key, String(value));
  }
  for (const child of (Array.isArray(children) ? children : [children])) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
 };
 const now = Math.floor(Date.now()/1000);
 const devices = ['工作电脑','家庭 NAS','客厅电视','小米手机'].map((host,index) => ({
  host, mac:'02:00:00:00:00:0'+index, ip4:'192.168.1.'+(108+index), ip6:'2001:db8::'+(10+index),
  conn:index<2?'wired':'wifi', band:'5GHz', online:true, last:now, last_seen:now,
  rx_r:6e6/(index+1), tx_r:1.2e6/(index+1), wan_rx_r:5e6/(index+1), wan_tx_r:1e6/(index+1),
  rx_today:5e9/(index+1), tx_today:1e9/(index+1), rx_month:80e9/(index+1), tx_month:16e9/(index+1), rx_total:400e9/(index+1), tx_total:70e9/(index+1)
 }));
 const samples = Array.from({length:60},(_,i)=>({time:now-(59-i)*5,download:6e6+Math.sin(i*.4)*2e6,upload:8e5+Math.cos(i*.5)*3e5}));
 const notificationConfig = { enabled:false, feishu:{enabled:false,has_webhook:false,has_secret:false}, wecom:{enabled:false,has_webhook:false,has_secret:false}, daily_enabled:false,daily_time:'21:00',rules:[{id:'sample',enabled:true,mac:'',metric:'total',bytes:20*1024**3}] };
 const history = { days:Array.from({length:7},(_,i)=>({date:new Date((now-(6-i)*86400)*1000).toISOString().slice(0,10),download:3e9+i*5e8,upload:7e8+i*1e8})), months:[{month:'2026-09',download:80e9,upload:16e9}], network_upload:7e9,network_download:40e9,ranking:devices.map(d=>({mac:d.mac,upload:d.tx_today,download:d.rx_today})),unassigned_upload:2e8,unassigned_download:1e9 };
 const requests=[]; window.previewRequests=requests;
 const rpc = { declare:spec => async (...args) => {
  requests.push({method:spec.method,args});
  const data = {
   getStatus:{version:'0.2.0',running:true,device_wan_rates:true,wan_daily:true,device_timeline:true,timeline_today:new Date(now*1000).toLocaleDateString('sv-SE'),now,since:now,interfaces:['pppoe-wan'],uptime:7200},
   getDevices:{dev:devices}, getTotal:{rx_r:9.2e6,tx_r:1.8e6,rx_today:12e9,tx_today:3e9},
   getRealtimeHistory:{samples,interfaces:['pppoe-wan'],iface:'pppoe-wan',step:5,now},
   getHistory:history,getInternetHistory:{json:JSON.stringify({...history,since:now-7*86400})},
   getWanUsage:{since:now-7*86400,interface_upload:10e9,interface_download:60e9,dev:devices.map(d=>({mac:d.mac,host:d.host,upload:d.tx_today,download:d.rx_today}))},
   getNotifications:{json:JSON.stringify({config:notificationConfig,recent:[],today:new Date(now*1000).toLocaleDateString('sv-SE')})},
   info:{uptime:1062720,localtime:now,load:[14000,12000,9000],memory:{total:1024**3,available:600*1024**2},root:{total:8*1024**2,used:2*1024**2}},
   board:{kernel:'6.12.74',board_name:'friendlyarm,nanopi-r5c',hostname:'OpenWrt',model:'FriendlyElec NanoPi R5C',system:'ARMv8 Processor',release:{description:'OpenWrt 25.12.5',version:'25.12.5',target:'rockchip/armv8'}},
   status:{'pppoe-wan':{up:true,statistics:{rx_bytes:40e9,tx_bytes:8e9}}},
   getDHCPLeases:{dhcp_leases:devices.map(d=>({hostname:d.host,macaddr:d.mac,ipaddr:d.ip4})),dhcp6_leases:[]},
   getMountPoints:[{mount:'/',size:8*1024**3,free:6*1024**3}],getNetworkDevices:{}
  };
  if (spec.method === 'getDeviceTimeline') {
   const start=Math.floor(new Date(args[1]+'T00:00:00').getTime()/1000), hour=args[2] === '' ? null : Number(args[2]);
   const step=hour == null?3600:300, first=hour??start;
   return {json:JSON.stringify({start:first,end:first+(hour==null?86400:3600),step,available_from:start-86400,samples:
    (hour==null?[8,13,19]:[0,2,3,7,8,9]).map((n,i)=>{const time=first+n*step;const label=value=>new Date(value*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});return {time,label:label(time)+'–'+label(time+step),utc_offset:'+0800',download:(hour==null?[.2,2.6,.2]:[.1,.2,.3,1.1,.7,.2])[i]*1024**3,upload:(i+1)*1024**2};})})};
  }
  if (!Object.prototype.hasOwnProperty.call(data,spec.method)) throw Error('Mutating or unsupported RPC disabled in preview: '+spec.method);
  return structuredClone(data[spec.method]);
 }};
 const polls=[];
 const poll={add:fn=>polls.push(fn),remove:fn=>{const i=polls.indexOf(fn);if(i>=0)polls.splice(i,1);}};
 const networkItem=(name,v6=false)=>({getName:()=>name,getProtocol:()=>name==='lan'?'static':'pppoe',isUp:()=>true,getUptime:()=>7200,getIPAddrs:()=>[name==='lan'?'192.168.1.1':'203.0.113.42'],getIP6Addrs:()=>v6?['2001:db8::1']:[],getGatewayAddr:()=> '203.0.113.1',getDNSAddrs:()=>['1.1.1.1'],getL3Device:()=>({getName:()=>name==='lan'?'br-lan':'pppoe-wan'})});
 const network={flushCache:async()=>{},getWANNetworks:async()=>[networkItem('wan')],getWAN6Networks:async()=>[networkItem('wan6',true)],getNetwork:async name=>networkItem(name),getNetworks:async()=>[networkItem('lan'),networkItem('wan')],getWifiNetworks:async()=>[]};
 const url=(...parts)=>['admin/system/zen','admin/status/zen-traffic/settings'].includes(parts.join('/'))?'?page=settings':'?page='+({zen:'dashboard','zen-traffic':'history'}[parts.at(-1)]||parts.at(-1));
 window.L={bind:(fn,owner,...args)=>fn.bind(owner,...args),url,resolveDefault:(promise,fallback)=>Promise.resolve(promise).catch(()=>fallback),env:{dispatchpath:page==='dashboard'?['admin','zen']:['realtime','history','notifications','settings'].includes(page)?['admin','status','zen-traffic',page]:['admin','status',page],requestpath:['admin']}};
 document.body.classList.add(page==='dashboard'?'node-admin-zen':page==='overview'?'node-admin-status-overview':'node-preview');
 const ui={menu:{load:async()=>({children:{admin:{name:'admin',title:'管理',children:{status:{name:'status',title:'状态',children:Object.fromEntries([['overview','概览'],['realtime','实时监控'],['history','历史分析'],['notifications','通知设置'],['login','登录页']].map(([name,title])=>[name,{name,title,children:{}}]))}}}}}),getChildren:node=>Object.values(node.children||{})},createHandlerFn:(owner,method)=>owner[method].bind(owner),addNotification:(_title,node)=>document.getElementById('view').prepend(node),showModal:(title,nodes)=>{const dialog=E('dialog',{},[E('h2',{},title),...nodes]);document.body.append(dialog);dialog.showModal();},hideModal:()=>document.querySelectorAll('dialog:not(.zen-appearance-dialog)').forEach(d=>d.remove())};
 const modules={baseclass:{extend:props=>props},view:{extend:props=>props},rpc,poll,ui,network,fs:{exec_direct:async (cmd,args)=>{requests.push({method:'list-installed',args});if(cmd!=='/usr/libexec/package-manager-call'||args.join(' ')!=='list-installed')throw Error('Mutation disabled');return JSON.stringify(['luci-theme-zen','luci-app-zen-traffic','zen-traffic'].map(name=>({name,version:'0.2.0-r10'})));},read:async path=>{if(path!=='/proc/stat')throw Error('Preview file unavailable: '+path);return 'cpu 200 0 100 900 0 0 0 0\ncpu0 0\ncpu1 0\ncpu2 0\ncpu3 0';}}};
 async function load(name) {
  if (modules[name]) return modules[name];
  const base=name.startsWith('view.zen-traffic.')?'../luci-app-zen-traffic/htdocs/luci-static/resources/':'../luci-theme-zen/htdocs/luci-static/resources/';
  const source=await (await fetch(base+name.replaceAll('.','/')+'.js')).text();
  const imports=[...source.matchAll(/['"]require ([\w.-]+)(?: as (\w+))?['"]/g)];
  const names=[],values=[];
  for (const [,dependency,alias] of imports){names.push(alias||dependency.replaceAll('-','_').split('.').at(-1));values.push(await load(dependency));}
  modules[name]=new Function(...names,source)(...values);
  return modules[name];
 }
 L.require=load;
 const originalMenuLoad=ui.menu.load;
 ui.menu.load=async()=>{
  const tree=await originalMenuLoad();
  tree.children.admin.children={zen:{name:'zen',title:_('Zen home'),children:{}},...tree.children.admin.children};
  for(const [name,title,children] of [['system','系统',[['admin','管理权'],['processes','进程'],['package-manager','软件包'],['flash','备份与升级']]],['services','服务',[['scheduled','计划任务']]],['network','网络',[['interfaces','接口'],['firewall','防火墙']]]]) {
   tree.children.admin.children[name]={name,title,children:Object.fromEntries(children.map(([name,title])=>[name,{name,title,children:{}}]))};
  }
  const status=tree.children.admin.children.status.children;
  for(const name of ['realtime','history','notifications']) delete status[name];
  status['zen-traffic']={name:'zen-traffic',title:'Zen 流量',children:{}};
  for(const file of ['../luci-app-zen-traffic/root/usr/share/luci/menu.d/luci-app-zen-traffic.json','../luci-theme-zen/root/usr/share/luci/menu.d/luci-theme-zen.json']) {
   const routes=await (await fetch(file)).json();
   for(const [route,entry] of Object.entries(routes)) {
    if(!route.startsWith('admin/status/zen-traffic/')||!entry.title)continue;
    const name=route.split('/').at(-1);status['zen-traffic'].children[name]={name,title:_(entry.title),order:entry.order,children:{}};
   }
  }
  status['zen-traffic'].children=Object.fromEntries(Object.entries(status['zen-traffic'].children).sort((a,b)=>a[1].order-b[1].order));
  return tree;
 };
 const menu=await load('menu-zen'); menu.__init__();
 let view;
 if(page==='dashboard') {
  view=await load('view.zen.home');document.getElementById('view').append(view.render());
  await new Promise(requestAnimationFrame);await modules['view.zen.dashboard'].ready;
 }
 else if(page==='settings') {
  view=await load('view.zen.settings');document.getElementById('view').append(view.render());await new Promise(requestAnimationFrame);if(modules['view.zen.zen-updates'].ready)await modules['view.zen.zen-updates'].ready;
 }
 else if(['package-manager','flash'].includes(page)) {
  view={};document.getElementById('view').append(E('section',{'class':'cbi-section'},[E('h2',{},page==='flash'?'备份 / 升级固件':'管理 Zen 软件包'),E('p',{},'本地预览只展示升级入口；实际安装、备份、固件校验及刷写由路由器上的 OpenWrt 原生页面提供。'),E('a',{'class':'btn',href:'?page=dashboard'},_('Zen home'))]));
 }
 else if(page==='overview') {
  view={};document.getElementById('view').append(E('section',{'class':'cbi-section',id:'native-overview-preview'},[
   E('h2',{},_('OpenWrt overview')),
   E('p',{},'原生概览使用独立地址 admin/status/overview。本地预览仅展示入口占位，完整页面由路由器上的 OpenWrt 提供。'),
   E('a',{'class':'btn',href:'?page=dashboard'},_('Zen home'))
  ]));
 }
 else if(page==='login') {
  document.body.className='';document.querySelector('body > header').remove();document.querySelector('.main').remove();
  const form=E('form',{method:'post','class':'cbi-map login-form'},E('div',{'class':'cbi-section'},E('div',{'class':'cbi-section-node'},[
   E('div',{'class':'cbi-value'},[E('label',{'class':'cbi-value-title',for:'luci_username'},_('Username')),E('div',{'class':'cbi-value-field'},E('input',{id:'luci_username',name:'luci_username',value:'root',type:'text'}))]),
   E('div',{'class':'cbi-value'},[E('label',{'class':'cbi-value-title',for:'luci_password'},_('Password')),E('div',{'class':'cbi-value-field'},E('input',{id:'luci_password',name:'luci_password',type:'password'}))])
  ])));
  form.addEventListener('submit',event=>event.preventDefault());form.submit=()=>{};
  document.body.append(E('section',{id:'zen-login-source','data-hostname':'OpenWrt',hidden:true},[form,E('button',{'class':'btn important'},_('Log in'))]));
  view=await load('view.zen.sysauth');document.body.append(view.render());
 } else {
  view=await load('view.zen-traffic.'+page);const data=await view.load();document.getElementById('view').append(view.render(data));
 }
 await Promise.allSettled(polls.map(fn=>fn()));
 await new Promise(resolve=>setTimeout(resolve,50));
 window.ZenAppearance.set({});
 window.previewModules=modules;window.previewView=view;document.body.dataset.previewReady='true';
})().catch(error=>{console.error(error);document.body.dataset.previewError=error.message;});
