// Explicit confirmation, permissions, cancellation and partial-success retry.
const fs=require('node:fs'),assert=require('node:assert/strict'),{E,find}=require('./test-ui-dom.cjs');
String.prototype.format=function(...args){return this.replace(/%[ds]/g,()=>String(args.shift()));};
const source=fs.readFileSync('luci-app-zen-traffic/htdocs/luci-static/resources/view/zen-traffic/device-reset.js','utf8');
let modal,fail='b',allowed=true,refreshes=0;const calls=[];
const rpc={declare:spec=>async(...args)=>{
 if(spec.method==='access')return {access:allowed};
 calls.push(args[0]);if(args[0]===fail)throw Error('offline');return {ok:true};
}};
const ui={showModal:(title,children)=>{modal=E('div',{},children);},hideModal:()=>{modal=null;}};
const component=new Function('baseclass','rpc','ui','_','E',source)({extend:x=>x},rpc,ui,x=>x,E);
const devices=[{mac:'a',host:'Laptop'},{mac:'b',host:'NAS'}];
const button=label=>find(modal,node=>node.tag==='button'&&node.textContent===label);
(async()=>{
 const denied=component.build(devices,()=>'',()=>{});allowed=false;await new Promise(setImmediate);assert.equal(denied.hidden,false);
 const denied2=component.build(devices,()=>'',()=>{});await new Promise(setImmediate);assert.equal(denied2.hidden,true);
 component.open(devices,'a',()=>refreshes++);assert.deepEqual(calls,[]);button('Cancel').attrs.click();assert.equal(modal,null);assert.deepEqual(calls,[]);
 component.open(devices,'a',()=>refreshes++);
 const all=find(modal,node=>node.tag==='input'&&node.attrs.change&&!node.attrs['aria-label']);all.checked=true;all.attrs.change();
 await button('Reset counters').attrs.click();assert.deepEqual(calls,['a','b']);assert.equal(refreshes,1);
 assert.equal(button('Retry failed devices').disabled,false);
 fail=null;await button('Retry failed devices').attrs.click();assert.deepEqual(calls,['a','b','b'],'Successful devices are never retried');assert.equal(modal,null);
 console.log('PASS: reset permissions, explicit confirm, cancellation, selected MACs and partial-success retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
