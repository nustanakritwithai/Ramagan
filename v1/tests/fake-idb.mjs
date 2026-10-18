// Small asynchronous storage double. Browser QA exercises actual IndexedDB.
export function fakeIndexedDB() {
  const databases=new Map();
  return {open(name){const request={};setTimeout(()=>{
    const fresh=!databases.has(name);if(fresh)databases.set(name,new Map());
    const rows=databases.get(name);
    request.result={createObjectStore(){},transaction(){
      const tx={aborted:false,abort(){this.aborted=true;queueMicrotask(()=>this.onabort?.());},objectStore(){return {
        get(key){const read={};setTimeout(()=>{if(tx.aborted)return;read.result=rows.has(key)?structuredClone(rows.get(key)):undefined;
          read.onsuccess?.();queueMicrotask(()=>{if(!tx.aborted)tx.oncomplete?.();});},0);return read;},
        put(value,key){rows.set(key,structuredClone(value));},delete(key){rows.delete(key);}
      };}};return tx;
    }};
    if(fresh)request.onupgradeneeded?.();request.onsuccess?.();
  },0);return request;}};
}
