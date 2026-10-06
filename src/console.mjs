// SPDX-License-Identifier: MIT
import vm from "node:vm";

// All public functions and objects are created in the console's own realm.
// The private callback accepts/returns JSON strings only; native objects, host
// functions and host exceptions never cross into evaluated console expressions.
export function createConsole(session) {
  const context = vm.createContext(
    {},
    { codeGeneration: { strings: false, wasm: false } },
  );
  context.__nativeCall = (operation, payload) => {
    try {
      const p = JSON.parse(payload);
      let value;
      if (operation === "query") value = session.query(p.selector, p.root);
      else if (operation === "read") {
        const nativeId = session.nativeId(p.id);
        const dom = session.domGet(p.id);
        value = {
          ...(dom.nodeType === 3 ? dom : session.get(p.id)),
          nodeType: dom.nodeType,
          children: dom.children,
          cssText: session.relay.styles.get(nativeId)?.text || "",
        };
      } else if (operation === "selected") value = session.selected;
      else if (operation === "queue") session.queue(p);
      else if (operation === "inspect") session.pick(p.id);
      else if (operation === "log")
        session.emit("Runtime.consoleAPICalled", {
          type: p.type,
          args: p.args.map((value) => session.remote(value)),
          executionContextId: 1,
          timestamp: Date.now(),
        });
      else throw Error("Unknown console bridge operation");
      return JSON.stringify({ value: value ?? null });
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  };
  vm.runInContext(
    `
    ((send) => {
      const call = (op, p={}) => {
        const reply = JSON.parse(send(op, JSON.stringify(p)));
        if (reply.error) throw new Error(reply.error);
        return reply.value;
      };
      const wrappers = new Map();
      const keyName = key => String(key).replace(/[A-Z]/g, c=>'-'+c.toLowerCase());
      function wrap(id) {
        if (!id) return null;
        call('read',{id});
        if (wrappers.has(id)) return wrappers.get(id);
        const read = () => call('read',{id});
        const queue = p => call('queue',{node:id,...p});
        const node = {
          __nativeID:id,
          get tagName(){return read().tag},
          get nodeName(){return read().tag},
          get nodeType(){return read().nodeType},
          get nodeValue(){return read().nodeType===3?read().text:null},
          set nodeValue(value){if(read().nodeType!==3)throw new Error('Only text nodes have editable nodeValue');queue({method:'attribute',key:'text',value:String(value)})},
          get parentNode(){const parent=read().parent;return parent>1?wrap(parent):null},
          get childNodes(){return read().children.map(wrap)},
          get children(){return read().children.map(wrap).filter(node=>node.nodeType===1)},
          get textContent(){return read().text},
          set textContent(value){queue({method:'attribute',key:'text',value:String(value)})},
          get value(){return read().attributes.value},
          set value(value){queue({method:'attribute',key:'value',value:String(value)})},
          getAttribute:key=>read().attributes[key],
          setAttribute:(key,value)=>queue({method:'attribute',key,value:String(value)}),
          click:()=>queue({method:'action',key:'press'}),
          focus:()=>queue({method:'action',key:'focus'}),
          querySelector:selector=>wrap(call('query',{selector,root:id})[0]),
          querySelectorAll:selector=>call('query',{selector,root:id}).map(wrap),
          getBoundingClientRect:()=>{const {x,y,width,height}=read();return{x,y,width,height,left:x,top:y,right:x+width,bottom:y+height}},
        };
        node.style = new Proxy({}, {
          get:(_,key)=> {
            if(key==='cssText')return read().cssText;
            if(key==='setProperty')return(key,value)=>queue({method:'css',key,value:String(value)});
            if(key==='removeProperty')return key=>queue({method:'css',key,value:''});
            if(key==='getPropertyValue')return key=>read().styles[key]||'';
            return read().styles[keyName(key)]||'';
          },
          set:(_,key,value)=>{queue(key==='cssText'?{method:'cssText',value:String(value)}:{method:'css',key:keyName(key),value:String(value)});return true},
        });
        wrappers.set(id,node);return node;
      }
      globalThis.document = {
        querySelector:selector=>wrap(call('query',{selector})[0]),
        querySelectorAll:selector=>call('query',{selector}).map(wrap),
        getElementById:id=>wrap(call('query',{selector:'#'+id})[0]),
      };
      globalThis.console = Object.fromEntries(['log','warn','error','info'].map(type=>[type,(...args)=>call('log',{type,args})]));
      globalThis.window=globalThis;
      globalThis.$=document.querySelector;globalThis.$$=document.querySelectorAll;
      globalThis.getComputedStyle=node=>{const data=call('read',{id:node.__nativeID});const result={...data.styles,width:data.width+'px',height:data.height+'px'};result.getPropertyValue=key=>result[key]||'';return result};
      globalThis.inspect=node=>call('inspect',{id:node.__nativeID});
      globalThis.getEventListeners=node=>{
        const result={};
        for(const info of call('read',{id:node.__nativeID}).listeners||[]){
          const {address,...metadata}=info;
          (result[info.type]||=[]).push(metadata);
        }
        return result;
      };
      Object.defineProperty(globalThis,'$0',{get:()=>wrap(call('selected'))});
      globalThis.__wrapNative=wrap;
    })(__nativeCall);
  `,
    context,
    { timeout: 1000 },
  );
  const wrap = context.__wrapNative;
  delete context.__nativeCall;
  delete context.__wrapNative;
  return { context, wrap };
}
