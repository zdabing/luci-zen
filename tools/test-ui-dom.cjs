// Minimal DOM fixture for lifecycle and retained form-state regression tests.
class Element {
 constructor(tag,attrs={}){this.tag=tag;this.attrs={...attrs};this.children=[];this.parentNode=null;this.hidden=!!attrs.hidden;this.disabled=!!attrs.disabled;this.value=attrs.value||'';this.style={};this.classList={add(){},remove(){}};this.isConnected=false;}
 appendChild(child){if(child&&typeof child==='object'){if(child.parentNode)child.parentNode.children=child.parentNode.children.filter(c=>c!==child);child.parentNode=this;}this.children.push(child);return child;}
 replaceChildren(...children){this.text='';this.children=[];for(const child of children)this.appendChild(child);}
 get firstChild(){return this.children[0];}
 get nextSibling(){const siblings=this.parentNode?.children||[];return siblings[siblings.indexOf(this)+1];}
 set textContent(value){this.text=value;this.children=[];}
 get textContent(){return this.text||this.children.map(c=>typeof c==='object'?c.textContent:c).join('');}
 setAttribute(key,value){this.attrs[key]=String(value);}
 addEventListener(type,fn){this.attrs[type]=fn;}
 focus(){Element.focused=this;}
 closest(){return null;}
}
const E=(tag,attrs={},children=[])=>{const node=new Element(tag,attrs);for(const child of Array.isArray(children)?children:[children])if(child!=null)node.appendChild(child);return node;};
const find=(node,predicate)=>node&&typeof node==='object'?(predicate(node)?node:node.children.map(child=>find(child,predicate)).find(Boolean)):null;
module.exports={Element,E,find};
