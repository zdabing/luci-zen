'use strict';
'require baseclass';

let sequence = 0;
// Keep the native value/change contract while rendering a themed, keyboardable list.
function enhance(select) {
 if (select.zenPicker) return select.zenPicker;
 const arrow=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');
 arrow.setAttribute('class','zen-picker-chevron');arrow.setAttribute('viewBox','0 0 16 16');arrow.setAttribute('aria-hidden','true');arrow.setAttribute('focusable','false');
 path.setAttribute('d','M4 6 8 10 12 6');arrow.append(path);
 const wrapper=E('div',{'class':'zen-picker'}),label=E('span',{'class':'zen-picker-label'}),button=E('button',{type:'button','class':'zen-picker-trigger',role:'combobox','aria-haspopup':'listbox','aria-expanded':'false','aria-label':select.getAttribute('aria-label')},[label,arrow]);
 const list=E('div',{'class':'zen-picker-list',role:'listbox',id:'zen-picker-'+(++sequence),hidden:true,'aria-label':select.getAttribute('aria-label')});
 button.setAttribute('aria-controls',list.id);
 const options=Array.from(select.options).map((option,index)=>E('button',{type:'button',role:'option',id:list.id+'-'+index,'data-value':option.value,'aria-selected':'false',tabindex:'-1'},option.textContent));
 list.append(...options); wrapper.append(button,list); select.before(wrapper); select.hidden=true;
 const sync=()=>{label.textContent=select.selectedOptions[0]?.textContent||''; options.forEach(option=>option.setAttribute('aria-selected',String(option.dataset.value===select.value)));};
 let listening=false;
 function outside(event){if(!wrapper.contains(event.target))close(false);}
 function close(focus){list.hidden=true;button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');if(listening){document.removeEventListener('pointerdown',outside);listening=false;}if(focus)button.focus();}
 function open(index){list.hidden=false;button.setAttribute('aria-expanded','true');index=Math.max(0,Math.min(options.length-1,index));options[index]?.focus();if(!listening){document.addEventListener('pointerdown',outside);listening=true;}}
 options.forEach((option,index)=>{
  option.addEventListener('click',()=>{select.value=option.dataset.value;select.dispatchEvent(new Event('change',{bubbles:true}));sync();close(true);});
  option.addEventListener('keydown',event=>{
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();open(event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length);}
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
   if(event.key==='Tab'){button.focus();close(false);}
  });
 });
 button.addEventListener('click',()=>list.hidden?open(Math.max(0,select.selectedIndex)):close(false));
 button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open(event.key==='ArrowUp'?options.length-1:Math.max(0,select.selectedIndex));}if(event.key==='Enter'||event.key===' '){event.preventDefault();list.hidden?open(Math.max(0,select.selectedIndex)):close(false);}if(event.key==='Escape')close(false);});
 wrapper.addEventListener('focusout',event=>{if(!wrapper.contains(event.relatedTarget))close(false);});
 select.addEventListener('change',sync);sync();
 select.zenPicker={wrapper,close,sync};return select.zenPicker;
}
return baseclass.extend({enhance});
