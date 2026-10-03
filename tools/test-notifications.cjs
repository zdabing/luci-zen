// Exercise the actual settings view: serialized rules, secret preservation,
// explicit test sends, stale polling, validation and backend errors.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
class Element {
 constructor(tag,attrs={}){this.tag=tag;this.attrs=attrs;this.children=[];this.value=attrs.value||'';this.checked=!!attrs.checked;this.textContent='';this.classList={add(){},remove(){}};this.events={};}
 appendChild(c){this.children.push(c);return c;}
 replaceChildren(...c){this.children=c;}
 addEventListener(k,f){this.events[k]=f;}
 remove(){}
}
const E=(tag,attrs={},children=[])=>{const e=new Element(tag,attrs);if(Array.isArray(children))e.children=children;else e.textContent=children;return e;};
const source=fs.readFileSync(path.join(__dirname,'../luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/notifications.js'),'utf8');
const requests=[],polls=[];
let config={enabled:false,feishu:{enabled:false,has_webhook:true,has_secret:true},wecom:{enabled:false,has_webhook:false,has_secret:false},daily_enabled:false,daily_time:'21:00',rules:[]};
let saveError=false,delaySave;
const rpc={declare:s=>(...args)=>{requests.push({method:s.method,args});
 if(s.method==='getNotifications')return Promise.resolve({json:JSON.stringify({config,recent:[]})});
 if(s.method==='setNotifications')return delaySave || Promise.resolve({json:JSON.stringify(saveError?{ok:false,error:'Unable to save settings'}:{ok:true})});
 return Promise.resolve({json:'{"ok":true}'});
}};
const document={hidden:false,getElementById:()=>null,head:new Element('head')};
const view=new Function('view','rpc','poll','trafficStyle','_','E','document',source)(
 {extend:x=>x},rpc,{add:f=>polls.push(f)},{inject(){}},s=>s,E,document);
(async()=>{
 view.render([{config,recent:[]},{dev:[{mac:'02:00:00:00:00:01',host:'NAS'}]}]);
 assert.equal(view.master.input.checked,false,'Notifications default off');
 assert.equal(polls.length,1);
 view.addRule({id:'stable-rule',enabled:true,mac:'02:00:00:00:00:01',metric:'upload',bytes:512*1024**2});
 assert.equal(view.collect().rules[0].bytes,512*1024**2,'MiB threshold retains exact bytes');
 view.rows[0].unit.value=String(1024**3);view.rows[0].amount.value='1.5';
 view.channels.feishu.enabled.input.checked=true;view.master.input.checked=true;
 view.daily.input.checked=true;view.time.value='23:15';
 let payload=view.collect();assert.equal(payload.rules[0].bytes,1.5*1024**3);
 assert.equal(payload.rules[0].mac,'02:00:00:00:00:01');assert.equal(payload.rules[0].id,'stable-rule');
 assert.equal(payload.feishu.webhook,'');assert.equal(payload.feishu.secret,'');
 assert.ok(!Object.hasOwn(payload.feishu,'has_secret'),'Read-only mask metadata must not be sent back');
 const before=requests.length;await view.test('feishu');assert.equal(requests.length,before,'Unsaved changes must not send a message');
 view.channels.feishu.webhook.value='https://open.feishu.cn/open-apis/bot/v2/hook/test';
 view.channels.feishu.secret.value='secret';await view.refreshLog();
 assert.equal(view.channels.feishu.secret.value,'secret','Polling must not replace unsaved secrets');
 view.rows[0].amount.value='0';await view.save();assert.equal(requests.filter(r=>r.method==='setNotifications').length,0);
 view.rows[0].amount.value='1.5';saveError=true;await view.save();
 assert.equal(view.channels.feishu.secret.value,'secret','Failed save must preserve the user’s inputs');
 saveError=false;await view.save();
 assert.equal(view.channels.feishu.secret.value,'');assert.equal(view.channels.feishu.webhook.value,'');assert.equal(view.dirty,false);
 const sent=JSON.parse(requests.findLast(r=>r.method==='setNotifications').args[0]);
 assert.equal(sent.daily_time,'23:15');assert.equal(sent.rules[0].metric,'upload');assert.equal(sent.feishu.secret,'secret');
 await view.test('feishu');assert.equal(requests.findLast(r=>r.method==='testNotification').args[0],'feishu');
 let resolveSave;delaySave=new Promise(resolve=>{resolveSave=resolve;});
 const saving=view.save();
 view.channels.feishu.secret.value='newer-secret';view.markDirty();
 resolveSave({json:'{"ok":true}'});await saving;
 assert.equal(view.channels.feishu.secret.value,'newer-secret','An in-flight save must not erase newer edits');
 assert.equal(view.dirty,true);assert.match(view.status.textContent,/newer changes/);
 console.log('PASS: actual notification view, byte thresholds, masks, save errors, polling and explicit test actions');
})().catch(e=>{console.error(e);process.exit(1);});
