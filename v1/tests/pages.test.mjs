import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createPageState,loadReceipts,productLots,renderSidePage,supportsReceipts,validateReceipt} from '../src/pages.js';
import {cleanupNavigation} from '../src/navigation.js';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const CLIENT='33333333-3333-4333-8333-333333333333',CASHIER='44444444-4444-4444-8444-444444444444';
const clone=x=>structuredClone(x);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
function receipt(extra={}) {
  return {id:A,client_sale_id:CLIENT,created_at:'2026-10-13T17:00:00+00:00',cashier_id:CASHIER,
    payment_method:'split',payments:[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:19900}],
    subtotal_satang:30000,discount_satang:100,total_satang:29900,...extra};
}
function detail(extra={}) {
  return {...receipt(),store_name:'Synthetic receipt store',lines:[
    {lot_id:'lot-a',lot_code:'A',product_name:'Synthetic A',quantity_mg:1000,unit_price_satang_per_gram:10000,subtotal_satang:10000,discount_satang:33,total_satang:9967},
    {lot_id:'lot-b',lot_code:'B',product_name:'Synthetic B',quantity_mg:1000,unit_price_satang_per_gram:20000,subtotal_satang:20000,discount_satang:67,total_satang:19933}],...extra};
}
function page(rows=[],extra={}) {
  return {data:{sales:rows,next_cursor:null,from_date:'2026-10-01',to_date:'2026-10-31',timezone:'Asia/Bangkok',scope:'store',...extra},error:null};
}
function fixture(changes={},handlers={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/'});
  const oldGlobals=new Map(['window','document','FormData'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for(const k of oldGlobals.keys())Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:dom.window[k]});
  const root=dom.window.document.querySelector('#app');
  const state={user:{id:CASHIER,email:'fixture@example.invalid'},store:{id:'store-a',name:'Synthetic store',sales_enabled:true},role:'owner',view:'receipts',
    capabilities:{receipt_history:true,receipt_contract_version:1},pages:createPageState(),cart:new Map([['cart-lot',1250]]),
    checkout:{identity:'frozen-sale',payload:{client_sale_id:'pending-sale',discount_satang:100}},pendingId:'pending-sale',pendingBlocked:false,
    countDraft:{client_stocktake_id:'draft-count',photos:{lot:{uploadId:'frozen-upload',bytes:new Uint8Array([1,2,3]),metadata:{evidence_id:'photo'}}}},
    inventoryPending:{stocktake:{payload:{client_stocktake_id:'pending-count'}}},inventoryBlocked:false,
    products:[{id:'product-a',sku:'A',name:'Current expensive A',category:'flower',price_satang_per_gram:999900,active:true},
      {id:'product-b',sku:'B',name:'Current B',category:'extract',price_satang_per_gram:20000,active:false}],
    lots:[{id:'lot-a',product_id:'product-a',sku:'A',lot_code:'A',quantity_mg:1250,expires_on:null},
      {id:'lot-b',product_id:'product-b',sku:'B',lot_code:'B',quantity_mg:2000,expires_on:'2026-01-01'}],inventory:null,...changes};
  const calls={requests:[],routes:[],inventory:[],logout:0,server:0,renders:0};
  const api={base:'https://fixture.invalid/ramagan-api',
    receipts:async params=>{calls.requests.push({method:'GET',path:'/v1/sales',params:clone(params)});return handlers.receipts?handlers.receipts(params):page();},
    receipt:async id=>{calls.requests.push({method:'GET',path:'/v1/sales/'+id});return handlers.receipt?handlers.receipt(id):{data:detail({id}),error:null};},
    health:async()=>{calls.requests.push({method:'GET',path:'/health'});return {data:{status:'ok',version:'fixture',schema_version:4},error:null};},
    checkout:async()=>{calls.requests.push({method:'POST',path:'/v1/sales'});throw new Error('Receipt viewing must not checkout');}};
  let currentApi=api;
  const ctx={root,state,api,currentApi:()=>currentApi,appVersion:'fixture-v1',adminUrl:'https://admin.example.invalid/',
    canManage:()=>['owner','manager'].includes(state.role),render:()=>render(),
    openView:view=>{calls.routes.push(view);state.view=view;render();},
    openInventory:(id,mode)=>{calls.inventory.push({id,mode});state.view='inventory';render();},
    logout:()=>{calls.logout++;state.user=null;state.store=null;state.pages=createPageState();render();},
    changeServer:()=>{calls.server++;}};
  function render(){cleanupNavigation();calls.renders++;if(!state.user||!state.store)root.textContent='Login';
    else if(['receipts','products','settings','apps','support'].includes(state.view))renderSidePage(ctx);
    else root.innerHTML='<main data-test-destination="'+state.view+'">Existing business screen</main>';}
  render();
  return {dom,root,state,calls,ctx,render,setApi:value=>{currentApi=value;},q:s=>root.querySelector(s),
    click(s){const element=this.q(s);assert(element,'Missing test control '+s);element.click();},
    close(){cleanupNavigation();dom.window.close();for(const [k,descriptor]of oldGlobals){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}};
}
function unchangedBusiness(f,original) {
  assert.equal(f.state.cart,original.cart);assert.equal(f.state.checkout,original.checkout);
  assert.equal(f.state.countDraft,original.draft);assert.equal(f.state.inventoryPending,original.pending);
  assert.equal(f.state.pendingId,'pending-sale');assert.equal(f.state.cart.get('cart-lot'),1250);
  assert.deepEqual([...f.state.countDraft.photos.lot.bytes],[1,2,3]);
}

test('receipt validation accepts recorded zero/full-discount/split totals and rejects malformed money or tender claims',()=>{
  assert.equal(supportsReceipts({receipt_history:true,receipt_contract_version:1}),true);
  for(const cap of [null,{}, {receipt_history:1,receipt_contract_version:1},{receipt_history:true,receipt_contract_version:2}])assert.equal(supportsReceipts(cap),false);
  const valid=detail();assert.equal(validateReceipt(valid,true),valid);
  const zero=receipt({payment_method:'cash',payments:[{payment_method:'cash',amount_satang:0}],subtotal_satang:0,discount_satang:0,total_satang:0});
  assert.equal(validateReceipt(zero),zero);
  const full=receipt({payment_method:'transfer',payments:[{payment_method:'transfer',amount_satang:0}],discount_satang:30000,total_satang:0});
  assert.equal(validateReceipt(full),full);
  const invalid=[receipt({total_satang:30000}),receipt({created_at:'invalid'}),receipt({created_at:null}),receipt({payments:[]}),
    {...zero,payments:[]},receipt({payment_method:'cash'}),receipt({payments:[{payment_method:'cash',amount_satang:29900}]}),
    receipt({payments:[{payment_method:'cash',amount_satang:14950},{payment_method:'cash',amount_satang:14950}]}),
    receipt({payments:[{payment_method:'cash',amount_satang:0},{payment_method:'transfer',amount_satang:29900}]}),
    receipt({payment_method:'cash',payments:[{payment_method:'transfer',amount_satang:29900}]})];
  for(const amount of [true,null,'29900',29900.5,-1,Number.MAX_SAFE_INTEGER+1])invalid.push(receipt({payments:[{payment_method:'cash',amount_satang:amount}]}));
  for(const row of invalid)assert.throws(()=>validateReceipt(row));
  for(const changed of [detail({lines:[]}),detail({lines:[{...valid.lines[0],quantity_mg:1.5},valid.lines[1]]}),
    detail({lines:[{...valid.lines[0],total_satang:9968},valid.lines[1]]}),detail({lines:[valid.lines[0]]})])assert.throws(()=>validateReceipt(changed,true));
});

test('receipt detail refuses a different receipt ID from the selected request',async()=>{
  const f=fixture({}, {receipt:async()=>({data:detail({id:B}),error:null})});
  try{
    f.state.pages.receipts=[receipt()];f.render();f.click('[data-receipt="'+A+'"]');await settle();
    assert.equal(f.root.querySelector('.receipt-detail'),null);assert.match(f.root.textContent,/เลขใบเสร็จ.*ไม่ตรง/);
  }finally{f.close();}
});

test('receipt rendering uses saved amounts and escaped labels, including zero receipts, without consulting current prices or posting',async()=>{
  const saved=detail({store_name:'<img src=x onerror=alert(1)>',lines:detail().lines.map((x,i)=>({...x,product_name:i?'Synthetic B':'<script>bad()</script>',lot_code:'<b>Lot</b>'}))});
  const f=fixture({}, {receipt:async()=>({data:saved,error:null})});try{
    await loadReceipts(f.ctx);assert.match(f.root.textContent,/ไม่พบใบเสร็จ/);
    f.state.pages.receipts=[receipt(),receipt({id:B,payment_method:'cash',payments:[{payment_method:'cash',amount_satang:0}],subtotal_satang:0,discount_satang:0,total_satang:0})];
    f.render();assert.equal(f.root.querySelectorAll('[data-receipt]').length,2);assert.match(f.root.textContent,/299\.00/);assert.match(f.root.textContent,/0\.00/);
    f.click('[data-receipt="'+A+'"]');await settle();
    assert(f.q('.receipt-detail'));assert.match(f.root.textContent,/299\.00/);assert.match(f.root.textContent,/300\.00/);assert.match(f.root.textContent,/1\.00/);
    assert.doesNotMatch(f.q('.receipt-detail').textContent,/9,999\.00/);assert.match(f.root.textContent,/เวลาไทย/);
    assert.equal(f.root.querySelector('script,img,b[onerror]'),null);assert.match(f.root.textContent,/<script>bad\(\)<\/script>/);
    assert.equal(f.calls.requests.some(x=>x.method!=='GET'),false);
  }finally{f.close();}
});

test('search and more send only read requests, preserve filters, deduplicate pages and escape error/empty states',async()=>{
  let responses=[page([receipt()],{next_cursor:'opaque-page-2'}),page([receipt(),receipt({id:B})])];
  const f=fixture({}, {receipts:async()=>responses.shift()});try{
    await loadReceipts(f.ctx);f.click('#receipt-more');await settle();
    assert.deepEqual(f.state.pages.receipts.map(x=>x.id),[A,B]);assert.equal(f.q('#receipt-more'),null);
    assert.equal(f.calls.requests[1].params.cursor,'opaque-page-2');assert.equal(f.calls.requests[1].params.from_date,'2026-10-01');
    responses.push({data:null,error:{status:422,message:'bad cursor'}});
    f.q('[name="q"]').value='  LOT-%_  ';f.q('[name="from"]').value='2026-10-14';f.q('[name="to"]').value='2026-10-15';
    f.q('#receipt-search').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
    const search=f.calls.requests.at(-1).params;assert.equal(search.q,'LOT-%_');assert.equal(search.cursor,undefined);assert.equal(search.from_date,'2026-10-14');
    assert.match(f.root.textContent,/กรุณาค้นหาใหม่/);
    responses.push({data:null,error:{message:'<img src=x onerror=alert(1)>'}});await loadReceipts(f.ctx);
    assert.equal(f.root.querySelector('img'),null);assert.match(f.root.textContent,/<img src=x/);
    responses.push(page());await loadReceipts(f.ctx);assert.match(f.root.textContent,/ไม่พบใบเสร็จ/);
    assert.equal(f.calls.requests.some(x=>x.method!=='GET'),false);
  }finally{f.close();}
});

test('list responses from an old account, tenant, role, API or reset state are discarded',async()=>{
  for(const change of ['logout','store','user','role','api','reset']){
    const pending=deferred(),f=fixture({}, {receipts:()=>pending.promise});try{
      const task=loadReceipts(f.ctx);
      if(change==='logout')f.ctx.logout();
      if(change==='store')f.state.store={...f.state.store,id:'another-store'};
      if(change==='user')f.state.user={...f.state.user,id:'another-user'};
      if(change==='role')f.state.role='staff';
      if(change==='api')f.setApi({base:'https://different.invalid'});
      if(change==='reset')f.state.pages=createPageState();
      pending.resolve(page([receipt()]));await task;
      assert.deepEqual(f.state.pages.receipts,[],change);assert.equal(f.state.pages.receiptDetail,null);
      assert.doesNotMatch(f.root.textContent,/299\.00/);
    }finally{f.close();}
  }
});

test('a new search supersedes a pending list response and keeps the new query/date context',async()=>{
  const old=deferred(),fresh=deferred();let n=0;
  const f=fixture({}, {receipts:()=>++n===1?old.promise:fresh.promise});try{
    f.state.pages.receiptQuery='old';const first=loadReceipts(f.ctx);
    f.state.pages.receiptQuery='new';f.state.pages.receiptFrom='2026-10-15';f.state.pages.receiptTo='2026-10-20';
    const second=loadReceipts(f.ctx);assert.equal(f.calls.requests.length,2);
    fresh.resolve(page([receipt({id:B})],{from_date:'2026-10-15',to_date:'2026-10-20'}));await second;
    old.resolve(page([receipt()]));await first;
    assert.deepEqual(f.state.pages.receipts.map(x=>x.id),[B]);assert.equal(f.state.pages.receiptQuery,'new');
    assert.equal(f.state.pages.receiptFrom,'2026-10-15');assert.equal(f.state.pages.receiptTo,'2026-10-20');
    assert.equal(f.state.pages.receiptLoading,false);
  }finally{f.close();}
});

test('late receipt details cannot return after logout, store/API/reset, back or a fresh search',async()=>{
  for(const change of ['logout','store','api','reset','back','query']){
    const pending=deferred(),f=fixture({}, {receipt:()=>pending.promise});try{
      f.state.pages.receipts=[receipt()];f.state.pages.receiptsLoaded=true;f.render();f.click('[data-receipt]');
      if(change==='logout')f.ctx.logout();
      if(change==='store')f.state.store={...f.state.store,id:'different-store'};
      if(change==='api')f.setApi({});
      if(change==='reset')f.state.pages=createPageState();
      if(change==='back')f.click('#receipt-back');
      if(change==='query'){f.state.pages.receiptQuery='different';await loadReceipts(f.ctx);}
      pending.resolve({data:detail(),error:null});await settle();
      assert.equal(f.state.pages.receiptDetail,null,change);assert.equal(f.q('.receipt-detail'),null,change);
    }finally{f.close();}
  }
});

test('products submenu has list/categories/extras/discounts and restricts intake/create controls to current manager roles',()=>{
  for(const role of ['owner','manager','staff']){
    const f=fixture({view:'products',role});try{
      assert.deepEqual([...f.root.querySelectorAll('[data-product-screen]')].map(x=>x.dataset.productScreen),['list','categories','extras','discounts']);
      f.click('[data-product-screen="categories"]');assert.equal(f.root.querySelectorAll('[data-category]').length,2);
      f.click('[data-category="flower"]');assert.equal(f.root.querySelectorAll('[data-product]').length,1);assert.equal(f.q('[data-product]').dataset.product,'product-a');
      assert.equal(Boolean(f.q('#product-add')),role!=='staff');
      f.click('[data-product]');assert.match(f.root.textContent,/1\.25 กรัม/);assert.equal(Boolean(f.q('#product-receive')),role!=='staff');
      if(role!=='staff'){f.click('#product-receive');assert.deepEqual(f.calls.inventory,[{id:'product-a',mode:'receive-lot'}]);}
    }finally{f.close();}
  }
});

test('product Lot mapping uses product IDs, escapes categories/names, filters search and supports old catalog fallback',()=>{
  const product={id:'p-one',sku:'same',name:'<img src=x>',category:'<script>category</script>',price_satang_per_gram:100,active:true};
  const state={lots:[{id:'correct',product_id:'p-one',sku:'same'},{id:'wrong',product_id:'p-two',sku:'same'},{id:'legacy',sku:'same'}]};
  assert.deepEqual(productLots(state,product).map(x=>x.id),['correct','legacy']);
  const f=fixture({view:'products',products:[product],lots:[]});try{
    f.click('[data-product-screen="categories"]');assert.equal(f.root.querySelector('script,img'),null);assert.match(f.root.textContent,/<script>category<\/script>/);
    f.click('[data-category]');assert.equal(f.root.querySelector('img'),null);assert.match(f.root.textContent,/<img src=x>/);
    const input=f.q('#product-query');input.value='not-matching';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.match(f.root.textContent,/ไม่พบสินค้า/);
  }finally{f.close();}
});

test('side-page navigation, cart shortcut and discount destination preserve uncertain checkout and scale-photo drafts',async()=>{
  const f=fixture({view:'products'});try{
    const original={cart:f.state.cart,checkout:f.state.checkout,draft:f.state.countDraft,pending:f.state.inventoryPending};
    f.click('[data-product-screen="list"]');f.click('[data-product]');f.click('#product-back');f.click('#product-back');
    f.click('[data-product-screen="extras"]');f.click('#product-back');f.click('[data-product-screen="discounts"]');f.click('#discount-ticket');
    assert.equal(f.state.view,'sales');assert.equal(f.state.posScreen,'ticket');unchangedBusiness(f,original);
    for(const view of ['settings','apps','support','receipts']){f.ctx.openView(view);unchangedBusiness(f,original);}
    await loadReceipts(f.ctx);f.click('#open-ticket');assert.equal(f.state.view,'sales');unchangedBusiness(f,original);
    assert.equal(f.calls.requests.some(x=>x.method!=='GET'),false);
  }finally{f.close();}
});

test('old API capability fallback and settings/support destinations remain honest and read only',async()=>{
  const f=fixture({capabilities:{}});try{
    await loadReceipts(f.ctx);assert.equal(f.calls.requests.length,0);assert.match(f.root.textContent,/ยังไม่รองรับประวัติใบเสร็จ/);
    f.ctx.openView('settings');f.click('#settings-health');await settle();assert.match(f.root.textContent,/เชื่อมต่อสำเร็จ/);
    f.click('#settings-server');assert.equal(f.calls.server,1);
    f.ctx.openView('support');assert.match(f.root.textContent,/ห้ามสร้างบิลใหม่/);assert.match(f.root.textContent,/ไม่แสดงรหัสผ่าน PIN หรือ token/);
    f.ctx.openView('apps');assert.match(f.root.textContent,/fixture-v1/);
    assert.equal(f.calls.requests.some(x=>x.method!=='GET'),false);
  }finally{f.close();}
});
