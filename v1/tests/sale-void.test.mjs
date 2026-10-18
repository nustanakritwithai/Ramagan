import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaleVoid,supportsSaleVoids,voidPendingKey,validateVoid} from '../src/sale-void.js';
import {createClient} from '../src/backend-api.js';
import {pendingDeviceActor} from '../src/device-session.js';
import {assertNoPendingMutation} from '../src/inventory.js';
import {usesRedactedCosts} from '../src/permissions.js';

const ids={actor:'11111111-1111-4111-8111-111111111111',store:'22222222-2222-4222-8222-222222222222',
  sale:'33333333-3333-4333-8333-333333333333',client:'44444444-4444-4444-8444-444444444444',
  request:'55555555-5555-4555-8555-555555555555',void:'66666666-6666-4666-8666-666666666666',
  lot:'77777777-7777-4777-8777-777777777777',line:'88888888-8888-4888-8888-888888888888',
  ledger:'99999999-9999-4999-8999-999999999999',other:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const identity={api:'https://fixture.invalid/ramagan-api',store:ids.store,actor:ids.actor};
const caps={sale_voids:true,sale_void_contract_version:1};
class Storage {
  map=new Map();get length(){return this.map.size;}key(i){return [...this.map.keys()][i]??null;}
  getItem(k){return this.map.get(k)??null;}setItem(k,v){this.map.set(k,String(v));}removeItem(k){this.map.delete(k);}
}
const receipt=()=>({id:ids.sale,status:'completed',void:null,client_sale_id:ids.client,payment_method:'split',
  payments:[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:19900}],
  subtotal_satang:30000,discount_satang:100,total_satang:29900,lines:[{lot_id:ids.lot,quantity_mg:1250}]});
function response(p,extra={}){return {id:ids.void,status:'voided',client_void_id:p.client_void_id,sale_id:ids.sale,client_sale_id:ids.client,
  reason:p.reason,actor_user_id:ids.actor,actor_role:'owner',actor_email:'synthetic@example.invalid',created_at:'2026-10-18T17:00:00Z',
  duplicate:false,subtotal_satang:30000,discount_satang:100,total_satang:29900,payment_method:'split',payments:receipt().payments,
  restored_items:[{lot_id:ids.lot,quantity_mg:1250,sale_line_id:ids.line,ledger_event_id:ids.ledger,quantity_before_mg:8750,
    quantity_after_mg:10000,stock_revision_before:3,stock_revision_after:4,inventory_delta_satang:1000}],...extra};}
function fixture(changes={}){
  const f={storage:new Storage(),posts:[],lookups:[],capCalls:0,saved:null,fail:null,lookupFail:false,malformed:false,...changes};
  f.options={storage:f.storage,identity,uuid:()=>ids.request,lock:async(_,task)=>task(),transport:{
    capabilities:async i=>{assert.deepEqual(i,identity);f.capCalls++;return f.caps??caps;},
    post:async(id,p)=>{assert.equal(id,ids.sale);assert.equal(JSON.parse(f.storage.getItem(voidPendingKey(identity))).uncertain,true);
      f.posts.push(structuredClone(p));if(f.commitBeforeError)f.saved=response(p);if(f.fail)throw f.fail;
      return f.malformed?{id:ids.void}:f.saved??=response(p);},
    lookup:async id=>{assert.equal(id,ids.request);f.lookups.push(id);if(f.lookupFail)throw Error('mock lookup offline');return f.saved;}
  }};
  f.create=()=>createSaleVoid(f.options);return f;
}
test('void capability is strict and confirmed reversal retains original receipt and exact integer allocations',async()=>{
  assert.equal(supportsSaleVoids(caps),true);
  for(const c of [null,{}, {sale_voids:1,sale_void_contract_version:1},{sale_voids:true,sale_void_contract_version:2}])assert.equal(supportsSaleVoids(c),false);
  const f=fixture(),original=receipt(),before=structuredClone(original),op=f.create();
  const result=await op.start(original,'  บันทึกผิด  ');assert.equal(result.result.status,'voided');assert.equal(result.result.reason,'บันทึกผิด');
  assert.deepEqual(original,before);assert.equal(op.read().status,'confirmed');assert.equal(f.posts.length,1);
  await op.acknowledge();assert.equal(op.read(),null);assert.equal(f.storage.length,0);
});
test('timeout after commit confirms through lookup without a second POST',async()=>{
  const f=fixture({fail:Error('mock timeout'),commitBeforeError:true}),op=f.create();
  const result=await op.start(receipt(),'synthetic reversal');assert(result.result);assert.equal(f.posts.length,1);assert.equal(f.lookups.length,1);
  const restored=f.create();assert((await restored.verify()).result);assert.equal(f.posts.length,1);
});
test('lost response remains durable across reload and retries the same UUID and frozen payload',async()=>{
  const f=fixture({fail:Error('offline')}),first=f.create();
  assert.equal((await first.start(receipt(),'synthetic reason')).pending,true);const saved=first.read();
  assert.equal(saved.uncertain,true);await assert.rejects(first.acknowledge());
  await assert.rejects(first.start(receipt(),'replacement'),/ค้าง/);f.fail=null;
  const resumed=f.create(),result=await resumed.retry();assert(result.result);assert.deepEqual(f.posts[0],f.posts[1]);
  assert.equal(f.posts[1].client_void_id,saved.payload.client_void_id);assert.equal(f.posts[1].reason,saved.payload.reason);
  assert(!JSON.stringify([...f.storage.map]).includes('token'));
});
test('malformed result or failed lookup retains uncertainty and original intent',async()=>{
  for(const changes of [{malformed:true},{fail:Error('timeout'),lookupFail:true}]){
    const f=fixture(changes),op=f.create();assert.equal((await op.start(receipt(),'synthetic')).pending,true);
    const frozen=op.read();assert.equal(frozen.status,'pending');assert.equal(frozen.uncertain,true);assert.equal(frozen.sale_id,ids.sale);
    await assert.rejects(op.acknowledge());assert.equal(f.posts.length,1);
  }
});
test('initial authoritative 4xx with verified absence may reject, but prior uncertainty cannot be cleared by a later 4xx',async()=>{
  for(const status of [400,401,403,404,409,422]){
    const f=fixture({fail:Object.assign(Error('mock rejected'),{status})}),op=f.create();
    assert.equal((await op.start(receipt(),'synthetic')).rejected,true);assert.equal(op.read().status,'rejected');await op.acknowledge();assert.equal(op.read(),null);
  }
  const f=fixture({fail:Error('mock timeout')}),op=f.create();await op.start(receipt(),'synthetic');
  f.fail=Object.assign(Error('mock now conflicts'),{status:409});assert.equal((await f.create().retry()).pending,true);
  assert.equal(op.read().status,'pending');assert.equal(op.read().uncertain,true);await assert.rejects(op.acknowledge());
});
test('storage failure, lock refusal, missing capability and invalid reason prevent any POST',async()=>{
  const noWrite=fixture();noWrite.storage.setItem=()=>{throw Error('mock disk full');};await assert.rejects(noWrite.create().start(receipt(),'reason'),/disk full/);assert.equal(noWrite.posts.length,0);
  const lostWrite=fixture();lostWrite.storage.setItem=()=>{};await assert.rejects(lostWrite.create().start(receipt(),'reason'));assert.equal(lostWrite.posts.length,0);
  const noLock=fixture();noLock.options.lock=null;await assert.rejects(async()=>noLock.create().start(receipt(),'reason'));assert.equal(noLock.posts.length,0);
  const refused=fixture();refused.options.lock=async()=>{throw Error('mock lock held');};await assert.rejects(refused.create().start(receipt(),'reason'),/lock held/);assert.equal(refused.posts.length,0);
  const old=fixture({caps:{}});await assert.rejects(old.create().start(receipt(),'reason'));assert.equal(old.posts.length,0);
  for(const reason of ['', '   ', null, false, 'x'.repeat(301)]){const f=fixture();await assert.rejects(f.create().start(receipt(),reason));assert.equal(f.posts.length,0);}
  const voided=fixture();await assert.rejects(voided.create().start({...receipt(),status:'voided'},'reason'));assert.equal(voided.posts.length,0);
});
test('wrong scope, actor, UUID or tampered original/persisted result fails closed',async()=>{
  const f=fixture({fail:Error('offline')}),op=f.create();await op.start(receipt(),'synthetic');const frozen=op.read(),key=voidPendingKey(identity);
  for(const mutate of [x=>x.identity.actor=ids.other,x=>x.identity.store=ids.other,x=>x.identity.api='https://other.invalid',
    x=>x.payload.client_void_id='not-uuid',x=>x.original.total_satang++,x=>x.original.items[0].quantity_mg=0,
    x=>x.original.payments[0].amount_satang++,x=>{x.status='confirmed';x.result={id:ids.void};}]){
    const bad=structuredClone(frozen);mutate(bad);f.storage.setItem(key,JSON.stringify(bad));assert.throws(()=>f.create().read());
  }
  f.storage.setItem(key,'{bad-json');assert.throws(()=>f.create().read());assert.equal(f.posts.length,1);
});
test('void response validates amounts, restored lots/revisions, exact request and immutable original receipt',async()=>{
  const f=fixture(),result=await f.create().start(receipt(),'reason'),op=result.op,good=result.result;
  for(const mutate of [x=>x.client_void_id=ids.other,x=>x.sale_id=ids.other,x=>x.client_sale_id=ids.other,x=>x.reason='other',
    x=>x.total_satang++,x=>x.discount_satang++,x=>x.payments[0].amount_satang++,x=>x.created_at='invalid',
    x=>x.actor_role='staff',x=>x.actor_user_id=ids.other,x=>x.restored_items[0].quantity_mg++,x=>x.restored_items[0].lot_id=ids.other,
    x=>x.restored_items[0].quantity_after_mg++,x=>x.restored_items[0].stock_revision_after++,x=>x.restored_items[0].ledger_event_id='bad']){
    const bad=structuredClone(good);mutate(bad);assert.throws(()=>validateVoid(bad,op));
  }
});
test('pending void participates in global mutation exclusion and restricts the PIN actor across reload',async()=>{
  const f=fixture({fail:Error('offline')});await f.create().start(receipt(),'synthetic');
  assert.equal(pendingDeviceActor(f.storage,identity.api,identity.store),identity.actor);
  assert.throws(()=>assertNoPendingMutation(f.storage,identity),/ยกเลิก|ค้าง/);
  const stockKey='ramagan.v1.inventory.v1.'+encodeURIComponent(identity.api)+'.'+identity.store+'.'+identity.actor+'.stocktake';
  f.storage.setItem(stockKey,JSON.stringify({identity:{...identity}}));assert.equal(pendingDeviceActor(f.storage,identity.api,identity.store),identity.actor);
  f.storage.setItem(stockKey,JSON.stringify({identity:{...identity,actor:ids.other}}));assert.throws(()=>pendingDeviceActor(f.storage,identity.api,identity.store));
  f.storage.removeItem(stockKey);f.storage.setItem(voidPendingKey(identity),JSON.stringify({identity:{...identity,api:'https://wrong.invalid'}}));
  assert.throws(()=>pendingDeviceActor(f.storage,identity.api,identity.store));
});
test('REST void bridge refreshes capabilities, denies Staff or changed identity and uses only exact POST/lookup paths',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.sessionStorage,requests=[],storage=new Storage();let role='owner',actor=identity.actor,store=identity.store,lookupStatus=200;
  storage.setItem('ramagan.v1.session.'+identity.api,'synthetic-memory-session');globalThis.sessionStorage=storage;
  globalThis.fetch=async(url,options)=>{
    assert(String(url).startsWith(identity.api+'/'));const route=String(url).slice(identity.api.length);requests.push({route,options});
    let status=200,data;if(route==='/v1/me')data={user:{id:actor},store_id:store,role,capabilities:caps};
    else if(route==='/v1/sales/'+ids.sale+'/void')data=response(JSON.parse(options.body));
    else if(route==='/v1/sale-voids/by-client/'+ids.request){status=lookupStatus;data=status===200?response({client_void_id:ids.request,reason:'reason'}):{detail:'mock absent'};}
    else assert.fail('Unexpected route '+route);
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  };
  try{
    const transport=createClient(identity.api).saleVoidTransport;
    assert.deepEqual(await transport.capabilities(identity),caps);role='manager';assert.deepEqual(await transport.capabilities(identity),caps);
    await assert.rejects(transport.capabilities({...identity,api:'https://wrong.invalid/ramagan-api'}));
    role='staff';await assert.rejects(transport.capabilities(identity));role='owner';actor=ids.other;await assert.rejects(transport.capabilities(identity));actor=ids.actor;store=ids.other;await assert.rejects(transport.capabilities(identity));store=ids.store;
    assert.equal((await transport.post(ids.sale,{client_void_id:ids.request,reason:'reason'})).status,'voided');
    assert.equal((await transport.lookup(ids.request)).sale_id,ids.sale);lookupStatus=404;assert.equal(await transport.lookup(ids.request),null);lookupStatus=503;await assert.rejects(transport.lookup(ids.request));
    assert.equal(requests.filter(x=>x.route==='/v1/me').length,5);assert.equal(requests.filter(x=>x.options.method==='POST').length,1);
    assert(requests.every(x=>x.options.headers.Authorization==='Bearer synthetic-memory-session'));
  }finally{globalThis.fetch=oldFetch;if(oldStorage===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=oldStorage;}
});

const privateCaps={...caps,cost_privacy_contract_version:1,can_view_costs:false};
function assertNoPrivateCosts(value){
  if(Array.isArray(value)){for(const item of value)assertNoPrivateCosts(item);return;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
    assert(!/cost|profit|margin|inventory_(?:value|delta)|value_delta_satang/i.test(key),'Financial field retained: '+key);
    assertNoPrivateCosts(item);
  }
}
function managerVoid(reason,{duplicate=false,withLegacyCosts=false}={}){
  const data=response({client_void_id:ids.request,reason},{actor_role:'manager',duplicate});
  if(!withLegacyCosts)delete data.restored_items[0].inventory_delta_satang;
  return data;
}

test('Manager void accepts redacted fresh and duplicate results only with the explicit privacy gate',async()=>{
  for(const duplicate of [false,true]){
    const f=fixture({saved:managerVoid('manager reason',{duplicate})});
    f.options.allowRedactedCosts=usesRedactedCosts('manager',privateCaps);
    const result=await f.create().start(receipt(),'manager reason');
    assert(result.result);assert.equal(result.result.duplicate,duplicate);assert.equal(result.result.actor_role,'manager');
    assert.equal(result.result.restored_items[0].quantity_after_mg,10000);
    assert.equal(result.op.payload.client_void_id,ids.request);assert.equal(result.op.status,'confirmed');
    assertNoPrivateCosts(result);assertNoPrivateCosts(JSON.parse(f.storage.getItem(voidPendingKey(identity))));
    assert.equal(f.posts.length,1);
  }
  for(const allowRedactedCosts of [false,undefined,usesRedactedCosts('manager',caps),usesRedactedCosts('owner',privateCaps)]){
    const f=fixture({saved:managerVoid('strict reason')});f.options.allowRedactedCosts=allowRedactedCosts;
    const result=await f.create().start(receipt(),'strict reason');
    assert.equal(result.pending,true);assert.equal(f.create().read().status,'pending');
    await assert.rejects(f.create().acknowledge());
  }
});

test('Manager timeout and reload resolve a masked lookup without repeating the frozen void POST',async()=>{
  const f=fixture({fail:Error('synthetic response timeout')});
  f.options.allowRedactedCosts=usesRedactedCosts('manager',privateCaps);
  const first=f.create(),pending=await first.start(receipt(),'manager timeout');
  assert.equal(pending.pending,true);const frozen=first.read();assert.equal(f.posts.length,1);
  f.saved=managerVoid('manager timeout',{duplicate:true});
  const result=await f.create().retry();
  assert(result.result);assert.equal(result.result.duplicate,true);assert.equal(result.op.status,'confirmed');
  assert.deepEqual(result.op.payload,frozen.payload);assert.deepEqual(result.op.original,frozen.original);
  assertNoPrivateCosts(result);assert.equal(f.posts.length,1);
  assert((await f.create().verify()).result);assert.equal(f.posts.length,1);
});

test('Manager reload scrubs an old confirmed financial cache while preserving its receipt, actor and UUID',async()=>{
  const f=fixture();const initial=await f.create().start(receipt(),'legacy confirmed');
  const key=voidPendingKey(identity),before=JSON.parse(f.storage.getItem(key));
  assert.equal(before.result.restored_items[0].inventory_delta_satang,1000);
  before.result.cost_satang=1000;before.result.restored_items[0].nested={gross_profit_satang:28900,inventory_value_satang:9000};
  f.storage.setItem(key,JSON.stringify(before));
  f.options.allowRedactedCosts=usesRedactedCosts('manager',privateCaps);
  const controller=f.create(),clean=controller.read();
  assert.equal(clean.status,'confirmed');assert.deepEqual(clean.payload,initial.op.payload);
  assert.deepEqual(clean.original,initial.op.original);assert.deepEqual(clean.identity,initial.op.identity);
  assertNoPrivateCosts(clean);assertNoPrivateCosts(JSON.parse(f.storage.getItem(key)));
  const result=await controller.retry();assert(result.result);assertNoPrivateCosts(result);
  assert.equal(f.posts.length,1);assert.equal(f.lookups.length,0);
});

test('Manager response strips legacy private fields before validation and persistence; Owner keeps its exact cost proof',async()=>{
  const f=fixture({saved:managerVoid('legacy wire',{withLegacyCosts:true})});
  f.saved.extra={unit_cost_satang_per_gram:800,lines:[{line_cost_satang:1000,gross_profit_satang:28900}]};
  const untouched=structuredClone(f.saved);f.options.allowRedactedCosts=true;
  const result=await f.create().start(receipt(),'legacy wire');
  assert(result.result);assertNoPrivateCosts(result);assert.deepEqual(f.saved,untouched);
  assertNoPrivateCosts(JSON.parse(f.storage.getItem(voidPendingKey(identity))));
  const owner=fixture(),saved=await owner.create().start(receipt(),'owner proof');
  assert.equal(saved.result.restored_items[0].inventory_delta_satang,1000);
  const missing=structuredClone(saved.result);delete missing.restored_items[0].inventory_delta_satang;
  assert.throws(()=>validateVoid(missing,saved.op));
  assert.throws(()=>validateVoid(missing,saved.op,'true'));
});

test('Redacted-cost validation still rejects forged nonfinancial receipt, actor, payment and stock bindings',async()=>{
  const f=fixture({saved:managerVoid('bound proof')});f.options.allowRedactedCosts=true;
  const saved=await f.create().start(receipt(),'bound proof');assert(saved.result);
  for(const mutate of [x=>x.client_void_id=ids.other,x=>x.sale_id=ids.other,x=>x.client_sale_id=ids.other,
    x=>x.actor_user_id=ids.other,x=>x.actor_role='staff',x=>x.reason='forged',x=>x.created_at='bad',
    x=>x.subtotal_satang++,x=>x.total_satang++,x=>x.payment_method='cash',x=>x.payments[0].amount_satang++,
    x=>x.restored_items[0].quantity_mg++,x=>x.restored_items[0].lot_id=ids.other,
    x=>x.restored_items[0].quantity_after_mg++,x=>x.restored_items[0].stock_revision_after++,
    x=>x.restored_items[0].sale_line_id='bad',x=>x.restored_items[0].ledger_event_id='bad']){
    const bad=structuredClone(saved.result);mutate(bad);assert.throws(()=>validateVoid(bad,saved.op,true));
  }
});

test('Legacy financial cache cleanup fails closed on persistence failure without changing the frozen intent',async()=>{
  const f=fixture();await f.create().start(receipt(),'legacy storage');
  const key=voidPendingKey(identity),before=f.storage.getItem(key);f.options.allowRedactedCosts=true;
  f.storage.setItem=()=>{throw Error('synthetic cache storage unavailable');};
  assert.throws(()=>f.create().read(),/storage unavailable/);
  await assert.rejects(f.create().retry(),/storage unavailable/);
  assert.equal(f.storage.getItem(key),before);assert.equal(f.posts.length,1);
});
