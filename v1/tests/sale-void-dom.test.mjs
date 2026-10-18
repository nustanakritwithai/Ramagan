import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createPageState,loadReceipts,renderSidePage,validateReceipt} from '../src/pages.js';
import {cleanupNavigation} from '../src/navigation.js';
import {renderPos,paymentPreview} from '../src/pos.js';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';

const SALE='11111111-1111-4111-8111-111111111111',CLIENT='22222222-2222-4222-8222-222222222222',
  ACTOR='33333333-3333-4333-8333-333333333333',STORE='44444444-4444-4444-8444-444444444444',
  LOT='55555555-5555-4555-8555-555555555555',VOID='66666666-6666-4666-8666-666666666666',
  REQUEST='77777777-7777-4777-8777-777777777777';
const caps={receipt_history:true,receipt_contract_version:1,sale_voids:true,sale_void_contract_version:1,split_payments:true,payment_contract_version:1};
const receipt=(changes={})=>({id:SALE,client_sale_id:CLIENT,status:'completed',void:null,created_at:'2026-10-18T16:00:00Z',cashier_id:ACTOR,
  payment_method:'split',payments:[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:19900}],
  subtotal_satang:30000,discount_satang:100,total_satang:29900,store_name:'Synthetic store',lines:[{lot_id:LOT,lot_code:'SYNTHETIC',
    product_name:'Synthetic A',quantity_mg:1000,unit_price_satang_per_gram:30000,subtotal_satang:30000,discount_satang:100,total_satang:29900}],...changes});
const voidProof=(changes={})=>({id:VOID,sale_id:SALE,client_void_id:REQUEST,actor_user_id:ACTOR,actor_role:'manager',
  actor_email:'manager@synthetic.invalid',reason:'synthetic reason',created_at:'2026-10-18T17:30:00Z',...changes});
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture({changes={},detail=receipt(),rows=[receipt()],voidHandler=async()=>null}={}){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/',virtualConsole:console});
  const globals=new Map(['window','document','FormData','navigator'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for(const k of globals.keys())Object.defineProperty(globalThis,k,{value:dom.window[k],configurable:true,writable:true});
  const root=dom.window.document.querySelector('#app'),calls={reads:[],voids:[]};
  const state={user:{id:ACTOR,email:'owner@synthetic.invalid'},store:{id:STORE,name:'Synthetic store'},role:'owner',view:'receipts',
    capabilities:caps,pages:createPageState(),cart:new Map([['unsent-cart-lot',1250]]),lots:[],products:[],busy:false,voidPending:null,voidBlocked:false,...changes};
  const api={base:'https://fixture.invalid/ramagan-api',receipts:async query=>{calls.reads.push({kind:'list',query});return {data:{sales:structuredClone(rows),next_cursor:null,from_date:'2026-10-01',to_date:'2026-10-31'},error:null};},
    receipt:async id=>{calls.reads.push({kind:'detail',id});return {data:structuredClone(detail),error:null};}};
  let currentApi=api;
  const ctx={root,state,api,currentApi:()=>currentApi,canManage:()=>['owner','manager'].includes(state.role),hasPending:()=>Boolean(state.voidPending||state.voidBlocked||state.pending),
    render:()=>render(),openView:view=>{state.view=view;render();},logout:()=>{state.user=null;state.pages=createPageState();render();},changeServer:()=>{},
    appVersion:'synthetic',adminUrl:'https://admin.invalid/',voidReceipt:async(action,selected,reason)=>{calls.voids.push({action,selected:structuredClone(selected),reason});return voidHandler(action,selected,reason);}};
  function render(){cleanupNavigation();if(!state.user)root.textContent='Login';else if(state.view==='receipts')renderSidePage(ctx);else root.textContent='Other page';}
  render();
  return {dom,root,state,ctx,calls,render,setApi:x=>{currentApi=x;},q:s=>root.querySelector(s),
    input(s,value){const n=this.q(s);assert(n,s);n.value=value;n.dispatchEvent(new dom.window.Event('input',{bubbles:true}));},
    check(value=true){const n=this.q('#receipt-void-form [name=confirm]');assert(n);n.checked=value;n.dispatchEvent(new dom.window.Event('change',{bubbles:true}));},
    submit(){this.q('#receipt-void-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));},
    click(s){const n=this.q(s);assert(n,s);n.click();},
    async open(){await loadReceipts(ctx);this.click('[data-receipt]');await settle();assert(this.q('.receipt-detail'));},
    close(){cleanupNavigation();dom.window.close();for(const[k,original]of globals){if(original)Object.defineProperty(globalThis,k,original);else delete globalThis[k];}assert.deepEqual(errors,[]);}};
}
test('only current Owner/Manager with contract 1 receive void controls; history remains read only',async()=>{
  for(const role of ['owner','manager','staff']){
    const f=fixture({changes:{role}});try{await f.open();assert.equal(Boolean(f.q('#receipt-void-form')),role!=='staff');
      assert.equal(f.q('.receipt-detail input,.receipt-detail select,.receipt-detail textarea'),null);assert.equal(f.calls.voids.length,0);
      assert.equal(f.state.cart.get('unsent-cart-lot'),1250);assert(f.calls.reads.every(x=>['list','detail'].includes(x.kind)));
    }finally{f.close();}
  }
  for(const capability of [{receipt_history:true,receipt_contract_version:1},{...caps,sale_void_contract_version:2},{...caps,sale_voids:false}]){
    const f=fixture({changes:{capabilities:capability}});try{await f.open();assert.equal(f.q('#receipt-void-form'),null);assert.equal(f.calls.voids.length,0);}finally{f.close();}
  }
});
test('void needs explicit confirmation, reason edits reset confirmation and cannot edit the recorded receipt',async()=>{
  const f=fixture();try{
    await f.open();const original=structuredClone(f.state.pages.receiptDetail),input=f.q('#receipt-void-form [name=reason]');
    assert.equal(input.required,true);assert.equal(input.maxLength,300);f.input('#receipt-void-form [name=reason]','synthetic correction');f.submit();await settle();assert.equal(f.calls.voids.length,0);
    f.check();assert.equal(f.state.pages.voidConfirmed,true);input.focus();f.input('#receipt-void-form [name=reason]','changed reason');
    assert.equal(input.ownerDocument.activeElement,input);assert.equal(f.q('#receipt-void-form [name=confirm]').checked,false);f.submit();assert.equal(f.calls.voids.length,0);
    f.check();f.submit();await settle();assert.equal(f.calls.voids.length,1);assert.equal(f.calls.voids[0].action,'start');assert.equal(f.calls.voids[0].reason,'changed reason');
    assert.deepEqual(f.calls.voids[0].selected,original);assert.deepEqual(f.state.pages.receiptDetail,original);assert.equal(f.calls.reads.length,2);
  }finally{f.close();}
});
test('changing role, capability or a pending mutation after mount blocks synthetic void submit',async()=>{
  for(const change of ['staff','old-contract','pending','busy']){
    const f=fixture();try{await f.open();f.input('#receipt-void-form [name=reason]','reason');f.check();
      if(change==='staff')f.state.role='staff';if(change==='old-contract')f.state.capabilities={};if(change==='pending')f.state.pending=true;if(change==='busy')f.state.busy=true;
      f.submit();await settle();assert.equal(f.calls.voids.length,0,change);
    }finally{f.close();}
  }
});
test('voided list badge and immutable receipt proof escape actor and reason and show Bangkok time',async()=>{
  const proof=voidProof({actor_email:'<img src=x onerror=alert(1)>',reason:'<script>bad()</script> & "review"'});
  const data=receipt({status:'voided',void:proof}),f=fixture({rows:[data],detail:data});try{
    await loadReceipts(f.ctx);assert.match(f.q('.receipt-void-badge').textContent,/ยกเลิกแล้ว/);f.click('[data-receipt]');await settle();
    assert(f.q('.receipt-void-proof'));assert.equal(f.q('#receipt-void-form'),null);assert.equal(f.root.querySelector('img,script'),null);
    assert.match(f.q('.receipt-void-proof').textContent,/<img src=x/);assert.match(f.q('.receipt-void-proof').textContent,/<script>bad\(\)<\/script>/);
    assert.match(f.q('.receipt-void-proof').textContent,/manager/);assert.match(f.q('.receipt-void-proof').textContent,/00:30/);assert.match(f.q('.receipt-void-proof').textContent,/เวลาไทย/);
    assert.match(f.q('.receipt-detail').textContent,/299\.00/);assert.match(f.q('.receipt-detail').textContent,/300\.00/);assert.match(f.q('.receipt-detail').textContent,/1\.00/);
    assert.equal(f.calls.voids.length,0);assert.equal(f.q('.receipt-detail input'),null);
  }finally{f.close();}
});
test('missing or mismatched void proof is refused rather than displaying an editable completed receipt',()=>{
  for(const changes of [{status:'unknown'},{status:'voided',void:null},{status:'completed',void:voidProof()},
    {status:'voided',void:voidProof({sale_id:'wrong'})},{status:'voided',void:voidProof({actor_role:'staff'})},
    {status:'voided',void:voidProof({reason:''})},{status:'voided',void:voidProof({created_at:'invalid'})}]){
    assert.throws(()=>validateReceipt(receipt(changes),true));
  }
});
test('pending reversal exposes only same-request verification/retry and blocks a fresh reversal',async()=>{
  const pending={status:'pending',sale_id:SALE,payload:{client_void_id:REQUEST,reason:'<img src=x>'}},f=fixture({changes:{voidPending:pending}});
  try{await f.open();assert.match(f.root.textContent,new RegExp(REQUEST));assert.equal(f.root.querySelector('img'),null);
    assert.equal(f.q('#receipt-void-form [name=reason]').disabled,true);assert.equal(f.q('#receipt-void-form button').disabled,true);
    f.click('[data-void-action=verify]');await settle();f.click('[data-void-action=retry]');await settle();
    assert.deepEqual(f.calls.voids.map(x=>x.action),['verify','retry']);assert.equal(f.state.voidPending.payload.client_void_id,REQUEST);
    f.state.busy=true;f.render();assert.equal(f.q('[data-void-action=verify]').disabled,true);assert.equal(f.q('[data-void-action=retry]').disabled,true);
  }finally{f.close();}
});
test('late reversal callbacks cannot re-fetch or display the previous actor/store/API/page',async()=>{
  for(const change of ['logout','role','store','api','reset','back']){
    const pending=deferred(),f=fixture({voidHandler:()=>pending.promise});try{
      await f.open();f.input('#receipt-void-form [name=reason]','synthetic reason');f.check();f.submit();assert.equal(f.calls.voids.length,1);
      if(change==='logout')f.ctx.logout();if(change==='role')f.state.role='staff';if(change==='store')f.state.store={id:'other-store',name:'Other'};
      if(change==='api')f.setApi({base:'https://different.invalid'});if(change==='reset'){f.state.pages=createPageState();f.render();}if(change==='back')f.click('#receipt-back');
      const count=f.calls.reads.length;pending.resolve({result:{status:'voided'}});await settle();assert.equal(f.calls.reads.length,count,change);
      if(change==='logout'||change==='reset'||change==='back')assert.equal(f.q('.receipt-detail'),null,change);
    }finally{pending.resolve(null);f.close();}
  }
});
test('split-payment screen has exactly two allocation inputs and ignores stale cash-only tender',()=>{
  const f=fixture();try{
    Object.assign(f.state,{view:'sales',posScreen:'payment',payment:'split',splitCash:'100',splitTransfer:'199',cashReceived:'not-used',authRef:'',
      discount:'1',capabilities:{...caps,discounts:true,discount_contract_version:1},store:{...f.state.store,sales_enabled:true,requires_authorization:false},
      cart:new Map([[LOT,1000]]),lots:[{id:LOT,name:'Synthetic A',lot_code:'A',quantity_mg:10000,price:30000}]});
    const ctx={...f.ctx,preview:()=>({subtotal:30000,discount:100,total:29900}),previewHtml:()=>'',hasPending:()=>false,today:()=> '2026-10-18',
      refresh:()=>{},message:()=>{},checkout:()=>{},verify:()=>{},retry:()=>{}};
    cleanupNavigation();renderPos(ctx);
    assert(f.q('#split-cash'));assert(f.q('#split-transfer'));assert.equal(f.q('#cash-received'),null);assert.equal(f.q('#change'),null);
    assert.equal(f.q('#checkout').disabled,false);assert.equal(paymentPreview(f.state,29900).change,0);
    assert.deepEqual(paymentPreview(f.state,29900).payments,[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:19900}]);
  }finally{f.close();}
});

const mainURL=new URL('../src/main.js',import.meta.url);
const mainSource=(await readFile(mainURL,'utf8')).replace(/import '\.\/[^']+\.css';/g,'')
  .replaceAll('import.meta.env.VITE_RAMAGAN_API_URL',"''").replaceAll('import.meta.env.BASE_URL',"'/ramagan-v1/'")
  .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,mainURL).href}'`);
let mainInstance=0;
async function until(check){for(let n=0;n<200;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Real main.js did not reach expected synthetic DOM state');}
async function mainFixture(f,snapshot){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/',virtualConsole:console}),w=dom.window;
  if(snapshot){for(const[k,v]of snapshot.local)w.localStorage.setItem(k,v);for(const[k,v]of snapshot.session)w.sessionStorage.setItem(k,v);}
  else{w.localStorage.setItem('ramagan.v1.server.url','https://fixture.invalid/ramagan-api');w.sessionStorage.setItem('ramagan.v1.session.https://fixture.invalid/ramagan-api','synthetic-main-session');}
  Object.defineProperty(w.navigator,'locks',{value:{request:async(_key,_options,task)=>task({name:'synthetic-lock'})}});
  const headers={'Content-Type':'application/json'},reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
  const api='https://fixture.invalid/ramagan-api';
  const bindings={window:w,document:w.document,navigator:w.navigator,localStorage:w.localStorage,sessionStorage:w.sessionStorage,FormData:w.FormData,
    CSS:{escape:x=>String(x).replace(/[^a-zA-Z0-9_-]/g,'\\$&')},crypto:webcrypto,fetch:async(url,options={})=>{
      assert(String(url).startsWith(api+'/'),'All main.js traffic is synthetic');const path=new URL(url).pathname.replace('/ramagan-api','');
      f.requests.push({path,method:options.method||'GET'});
      if(path==='/health')return reply({status:'ok'});
      if(path==='/v1/me')return reply({user:{id:ACTOR,email:'owner@synthetic.invalid'},store_id:STORE,role:'owner',store:{id:STORE,name:'Synthetic store',sales_enabled:true,requires_authorization:false},capabilities:{...caps,discounts:true,discount_contract_version:1}});
      if(path==='/v1/catalog')return reply({products:[{id:'product-a',sku:'A',name:'Synthetic A',category:'synthetic',price_satang_per_gram:30000,active:true}],
        lots:[{id:LOT,product_id:'product-a',sku:'A',name:'Synthetic A',lot_code:'A',price_satang_per_gram:30000,quantity_mg:10000,active:true,product_active:true}]});
      if(path==='/v1/sales'&&options.method==='GET')return reply({sales:[receipt(f.saved?{status:'voided',void:voidProof({id:f.saved.id,client_void_id:f.saved.client_void_id})}:{})],next_cursor:null,from_date:'2026-10-01',to_date:'2026-10-31'});
      if(path==='/v1/sales/'+SALE&&options.method==='GET')return reply(receipt(f.saved?{status:'voided',void:voidProof({id:f.saved.id,client_void_id:f.saved.client_void_id})}:{}));
      if(path==='/v1/sales/'+SALE+'/void'&&options.method==='POST'){
        const p=JSON.parse(options.body);f.posts.push(p);
        if(f.holdPost)await f.holdPost;
        const data={id:VOID,status:'voided',client_void_id:p.client_void_id,sale_id:SALE,client_sale_id:CLIENT,reason:p.reason,
          actor_user_id:ACTOR,actor_role:'owner',actor_email:'owner@synthetic.invalid',created_at:'2026-10-18T17:30:00Z',duplicate:false,
          payment_method:'split',payments:receipt().payments,subtotal_satang:30000,discount_satang:100,total_satang:29900,
          restored_items:[{lot_id:LOT,quantity_mg:1000,sale_line_id:'88888888-8888-4888-8888-888888888888',ledger_event_id:'99999999-9999-4999-8999-999999999999',
            quantity_before_mg:9000,quantity_after_mg:10000,stock_revision_before:2,stock_revision_after:3,inventory_delta_satang:null}]};
        if(f.commit||!f.fail)f.saved=data;
        if(f.fail)throw new TypeError('mock lost void response');return reply(f.saved);
      }
      if(path.startsWith('/v1/sale-voids/by-client/'))return f.saved?reply(f.saved):reply({detail:'mock absent'},404);
      if(path==='/v1/auth/logout')return reply({ok:true});
      assert.fail('Unexpected synthetic main route '+options.method+' '+path);
    }};
  const old=new Map(Object.keys(bindings).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for(const[k,value]of Object.entries(bindings))Object.defineProperty(globalThis,k,{value,configurable:true,writable:true});
  await import('data:text/javascript;base64,'+Buffer.from(mainSource+`\n// synthetic main void ${++mainInstance}`).toString('base64'));
  const app={q:s=>w.document.querySelector(s),text:()=>w.document.body.textContent,
    click(s){const n=this.q(s);assert(n,'Missing '+s);n.click();},
    input(s,value){const n=this.q(s);assert(n,s);n.value=value;n.dispatchEvent(new w.Event('input',{bubbles:true}));},
    check(){const n=this.q('#receipt-void-form [name=confirm]');n.checked=true;n.dispatchEvent(new w.Event('change',{bubbles:true}));},
    submit(){this.q('#receipt-void-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));},
    menu(id){this.q('[data-navigation-trigger]').click();this.click(id);},
    snapshot:()=>({local:Object.entries(w.localStorage),session:Object.entries(w.sessionStorage)}),
    close(){cleanupNavigation();w.close();for(const[k,descriptor]of old){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}assert.deepEqual(errors,[]);}};
  await until(()=>app.q('[data-add]')||app.q('.receipt-void-pending'));return app;
}
test('real main controller confirms a lost response by lookup, acknowledges only the proven reversal and refreshes read-only history',async()=>{
  const f={posts:[],requests:[],fail:true,commit:true,saved:null},app=await mainFixture(f);
  try{
    app.menu('#nav-receipts');await until(()=>app.q('[data-receipt]'));app.click('[data-receipt]');await until(()=>app.q('#receipt-void-form'));
    app.input('#receipt-void-form [name=reason]','synthetic integration reversal');app.check();app.submit();
    await until(()=>app.q('.receipt-void-proof'));assert.equal(f.posts.length,1);assert.equal(app.q('#receipt-void-form'),null);
    assert.equal(app.snapshot().local.some(([key])=>key.startsWith('ramagan.v1.sale-void.v1.')),false);
    assert.equal(f.requests.some(x=>x.path==='/v1/sales'&&x.method==='POST'),false,'A reversal never creates a replacement sale');
    assert.match(app.text(),/คืนสต็อกครั้งเดียว/);
  }finally{app.close();}
});
test('real main controller restores uncertain reversal on reload, blocks a new sale and retries the same void UUID',async()=>{
  const f={posts:[],requests:[],fail:true,saved:null};let app=await mainFixture(f);
  try{
    app.menu('#nav-receipts');await until(()=>app.q('[data-receipt]'));app.click('[data-receipt]');await until(()=>app.q('#receipt-void-form'));
    app.input('#receipt-void-form [name=reason]','frozen integration reason');app.check();app.submit();
    await until(()=>app.q('[data-void-action=retry]')&&!app.q('[data-void-action=retry]').disabled);
    const pending=app.snapshot(),uuid=f.posts[0].client_void_id;assert(pending.local.some(([key,value])=>key.startsWith('ramagan.v1.sale-void.v1.')&&value.includes(uuid)));
    app.close();app=null;app=await mainFixture(f,pending);assert(app.q('.receipt-void-pending'));
    app.menu('#nav-sales');assert.equal(app.q('[data-add]').disabled,true);assert.equal(f.posts.length,1);
    app.menu('#nav-receipts');f.fail=false;app.click('[data-void-action=retry]');await until(()=>app.q('.receipt-void-proof'));
    assert.equal(f.posts.length,2);assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(f.posts[1].client_void_id,uuid);
    assert.equal(app.snapshot().local.some(([key])=>key.startsWith('ramagan.v1.sale-void.v1.')),false);
    assert.equal(f.requests.some(x=>x.path==='/v1/sales'&&x.method==='POST'),false);
  }finally{app?.close();}
});
