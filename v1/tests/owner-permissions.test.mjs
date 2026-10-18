import test from 'node:test';
import assert from 'node:assert/strict';
import {canViewCosts,canAccessDashboard,canManageSettings,withoutPrivateCosts} from '../src/permissions.js';
import {createInventoryOperation,inventoryPendingKey} from '../src/inventory.js';

test('Only Owner can expose private screens even if a non-Owner receives forged permissive flags',()=>{
  const caps={cost_privacy_contract_version:1,can_view_costs:true,can_access_dashboard:true,can_manage_settings:true};
  for(const role of ['manager','staff','cashier',null,undefined]){
    assert.equal(canViewCosts(role,caps),false);assert.equal(canAccessDashboard(role,caps),false);assert.equal(canManageSettings(role,caps),false);
  }
  for(const check of [canViewCosts,canAccessDashboard,canManageSettings]){
    assert.equal(check('owner',caps),true);assert.equal(check('owner',{}),true);
    assert.equal(check('owner',{...caps,cost_privacy_contract_version:2}),false);
  }
  assert.equal(canViewCosts('owner',{...caps,can_view_costs:false}),false);
});

test('Non-Owner display projection removes nested cost/profit/value data without changing money or count evidence',()=>{
  const source={price_satang_per_gram:15000,total_satang:30000,quantity_mg:2000,
    default_cost_satang_per_gram:4000,summary:{quantity_mg:2000,inventory_value_satang:8000,unknown_cost_lot_count:0},
    items:[{stock_revision:3,variance_mg:-100,inventory_value_delta_satang:-400,inventory_delta_satang:-400,cost_satang:8000,profit_satang:22000,
      evidence:{evidence_id:'photo',sha256:'hash'},payments:[{payment_method:'cash',amount_satang:30000}]}]};
  const out=withoutPrivateCosts(source);
  assert.deepEqual(out,{price_satang_per_gram:15000,total_satang:30000,quantity_mg:2000,summary:{quantity_mg:2000},
    items:[{stock_revision:3,variance_mg:-100,evidence:{evidence_id:'photo',sha256:'hash'},payments:[{payment_method:'cash',amount_satang:30000}]}]});
  assert.equal(source.items[0].profit_satang,22000,'Projection must not edit frozen evidence or source responses');
});

function intake({redacted=true,fail=false,legacyCost=null}={}){
  const identity={api:'https://fixture.invalid',store:'22222222-2222-4222-8222-222222222222',actor:'11111111-1111-4111-8111-111111111111'};
  const id='33333333-3333-4333-8333-333333333333',lot='44444444-4444-4444-8444-444444444444',map=new Map(),posts=[];
  const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const payload={product_id:lot,lot_code:'COPY-ONLY',supplier_name:'synthetic',supplier_document_ref:'',reason:'synthetic',quantity_mg:1000,cost_satang_per_gram:legacyCost,expires_on:null};
  let sendingFails=fail;
  const response=p=>({lot_id:lot,client_receive_id:p.client_receive_id,quantity_mg:p.quantity_mg,duplicate:true});
  const transport={capabilities:async()=>({inventory_costs:true,cost_contract_version:1,cost_privacy_contract_version:1,can_view_costs:false}),
    post:async p=>{posts.push(structuredClone(p));if(sendingFails)throw Error('synthetic lost response');return response(p);},
    reconcile:async p=>({status:'completed',result:response(p)})};
  const op=()=>createInventoryOperation({storage,identity,kind:'receive',transport,uuid:()=>id,lock:(_,task)=>task(),allowRedactedCosts:redacted});
  return {op,map,posts,payload,identity,key:inventoryPendingKey(identity,'receive'),response,transport,release:()=>{sendingFails=false;}};
}

test('Manager redacted intake confirms and persists no cost while Owner validation still requires authoritative cost',async()=>{
  const f=intake(),result=await f.op().start(f.payload);
  assert(result.result);assert.equal(Object.hasOwn(result.result,'cost_satang_per_gram'),false);
  assert.equal(f.op().read().status,'confirmed');await f.op().acknowledge();assert.equal(f.op().read(),null);
  const owner=intake({redacted:false}),bad=await owner.op().start(owner.payload);
  assert.equal(bad.pending,true);assert.equal(owner.op().read().status,'pending','Missing Owner cost must not silently confirm');
});

test('Lost Manager intake resolves exact UUID with redacted duplicate; original frozen cost intent can reconcile without re-keying',async()=>{
  for(const legacyCost of [null,1234]){
    const f=intake({fail:true,legacyCost});const pending=await f.op().start(f.payload);
    assert.equal(pending.pending,true);const frozen=JSON.parse(f.map.get(f.key)).payload;
    const found=await f.op().verify();assert(found.result);assert.deepEqual(f.op().read().payload,frozen);
    assert.equal(f.posts.length,1);assert.equal(Object.hasOwn(found.result,'cost_satang_per_gram'),false);
  }
});

test('Redacted intake still rejects wrong UUID or quantity and preserves the pending operation',async()=>{
  const f=intake();f.transport.post=async p=>({...f.response(p),quantity_mg:999});
  f.transport.reconcile=async p=>({status:'completed',result:{...f.response(p),client_receive_id:'wrong'}});
  const result=await f.op().start(f.payload);assert(result.pending);assert.equal(f.op().read().status,'pending');
});

test('Manager reload purges legacy confirmed intake and count result costs while preserving exact frozen intents',async()=>{
  const f=intake({legacyCost:1234});await f.op().start(f.payload);
  const stored=JSON.parse(f.map.get(f.key));stored.result.cost_satang_per_gram=1234;
  stored.result.inventory_value_satang=1234;f.map.set(f.key,JSON.stringify(stored));
  const frozen=structuredClone(stored.payload),read=f.op().read();
  assert.deepEqual(read.payload,frozen);assert.deepEqual(read.result,withoutPrivateCosts(stored.result));
  assert.deepEqual(JSON.parse(f.map.get(f.key)),read);
  const lookup=await f.op().verify();assert.deepEqual(lookup.op.result,read.result);
  assert.deepEqual(lookup.result,read.result);await f.op().acknowledge();assert.equal(f.op().read(),null);

  const id='55555555-5555-4555-8555-555555555555',lot='44444444-4444-4444-8444-444444444444';
  const payload={client_stocktake_id:id,shift_label:'synthetic',reason:'',
    items:[{lot_id:lot,expected_revision:3,counted_quantity_mg:1000}]};
  const result={id,client_stocktake_id:id,actor_user_id:f.identity.actor,shift_label:'synthetic',reason:'',duplicate:false,
    items:[{lot_id:lot,counted_quantity_mg:1000,system_quantity_mg:2000,variance_mg:-1000,
      stock_revision_before:3,stock_revision_after:4,inventory_delta_satang:-1234,cost_satang_per_gram:1234}]};
  const key=inventoryPendingKey(f.identity,'stocktake');
  f.map.set(key,JSON.stringify({version:1,kind:'stocktake',status:'confirmed',uncertain:true,
    identity:f.identity,payload,result}));
  const op=createInventoryOperation({storage:{getItem:k=>f.map.get(k)??null,setItem:(k,v)=>f.map.set(k,v),removeItem:k=>f.map.delete(k)},
    identity:f.identity,kind:'stocktake',transport:{},lock:(_,task)=>task(),allowRedactedCosts:true});
  const count=op.read();assert.deepEqual(count.payload,payload);assert.deepEqual(count.result,withoutPrivateCosts(result));
  assert.deepEqual(JSON.parse(f.map.get(key)),count);assert.deepEqual((await op.verify()).op.result,count.result);
});
