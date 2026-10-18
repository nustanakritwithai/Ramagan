import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryOperation, supportsCosts, supportsStocktakes, optionalCost,
  countedMilligrams, receivedMilligrams, signedGrams, inventoryPendingKey,
  assertNoPendingMutation} from '../src/inventory.js';

const identity = {api: 'https://fixture.invalid/api', store: '22222222-2222-4222-8222-222222222222', actor: '11111111-1111-4111-8111-111111111111'};
const id = '44444444-4444-4444-8444-444444444444';
const lot = '33333333-3333-4333-8333-333333333333';
const caps = {inventory_costs: true, cost_contract_version: 1, stocktakes: true, stocktake_contract_version: 2, stocktake_evidence: true, evidence_contract_version: 1};
const payload = () => ({client_stocktake_id:id,shift_label: 'กะเช้า', reason: 'นับจริง', items: [{lot_id: lot, expected_revision: 2, counted_quantity_mg: 900,evidence_id:lot} ]});
const response = p => ({id, client_stocktake_id: p.client_stocktake_id, shift_label: p.shift_label,
  reason: p.reason, actor_user_id: identity.actor, duplicate: false, items: p.items.map(x => ({lot_id: x.lot_id,
    system_quantity_mg: 1000, counted_quantity_mg: x.counted_quantity_mg, variance_mg: x.counted_quantity_mg - 1000,
    stock_revision_before: x.expected_revision, stock_revision_after: x.expected_revision + 1,evidence:{evidence_id:x.evidence_id}}))});
function fixture(changes = {}) {
  const map = new Map();
  const f = {calls: [], saved: null, caps, ...changes};
  const storage = {getItem: k => map.get(k) ?? null, setItem: (k, v) => {map.set(k, v);}, removeItem: k => map.delete(k)};
  const transport = {capabilities: async i => {assert.deepEqual(i, identity); return f.caps;},
    lookup: async () => {if (f.lookupError) throw Error('offline'); return f.saved;},
    post: async p => {
      f.calls.push(structuredClone(p));
      assert.equal(JSON.parse(storage.getItem(inventoryPendingKey(identity, 'stocktake'))).uncertain, true, 'Persist uncertainty before IO');
      if (f.fail) throw Object.assign(Error(f.detail || 'offline'), {status: f.status || 0});
      f.saved ||= response(p);
      return f.saved;
    }};
  const options = {identity, kind: 'stocktake', storage, transport, uuid: () => id, lock: (_, task) => task()};
  return Object.assign(f, {storage, options, create: () => createInventoryOperation(options), map});
}
test('integer cost/count inputs distinguish unknown and zero, reject coercion and overflow', () => {
  assert.equal(optionalCost(''), null); assert.equal(optionalCost('0'), 0); assert.equal(optionalCost('175.50'), 17550);
  for (const x of [null, 0, true, '1.001', '1000000.01', '-1', '1e2']) assert.throws(() => optionalCost(x));
  assert.equal(countedMilligrams('0'), 0); assert.equal(countedMilligrams('1.001'), 1001);
  assert.equal(countedMilligrams('100000'), 100000000);
  assert.equal(receivedMilligrams('100000'), 100000000); assert.throws(() => receivedMilligrams('0'));
  for (const x of ['', null, 1, true, '0.0001', '-1', '100000.001', '1e3']) assert.throws(() => countedMilligrams(x));
  assert.equal(signedGrams(-1001), '−1.001'); assert.equal(signedGrams(100), '+0.1');
  assert.equal(supportsCosts(caps), true); assert.equal(supportsStocktakes(caps), true);
  for (const x of [undefined, {}, {inventory_costs: true}, {inventory_costs: true, cost_contract_version: '1'}]) assert.equal(supportsCosts(x), false);
});
test('count intent survives restart and retries identical UUID, count and original revision', async () => {
  const f = fixture({fail: true}), op = f.create();
  const first = await op.start(payload()); assert.equal(first.pending, true);
  assert.equal(f.calls.length, 1); assert.equal(op.read().uncertain, true);
  const resumed = f.create();
  f.fail = false;
  const second = await resumed.retry(); assert(second.result); assert.deepEqual(f.calls[0], f.calls[1]);
  await resumed.acknowledge(); assert.equal(resumed.read(), null);
  assert(!JSON.stringify([...f.map]).includes('token'));
});
test('stocktake reason is optional while wrong type and overlong reason fail before network',async()=>{
  for(const reason of ['', '   ', 'นับจริง']){
    const f=fixture(),p={...payload(),reason};
    const result=await f.create().start(p);assert(result.result);assert.equal(f.calls.length,1);assert.equal(f.calls[0].reason,reason);
  }
  for(const reason of [null, 1, false, 'x'.repeat(301)]){
    const f=fixture();await assert.rejects(f.create().start({...payload(),reason}));assert.equal(f.calls.length,0);
  }
});
test('lost response reconciles committed count by UUID without another POST', async () => {
  const f = fixture({fail: true}), op = f.create();
  await op.start(payload()); f.saved = response(f.calls[0]);
  const found = await f.create().retry(); assert(found.result); assert.equal(f.calls.length, 1);
});
test('first revision conflict permits recount; a conflict after uncertainty cannot erase pending intent', async () => {
  const f = fixture({fail: true, status: 409, detail: 'Stock changed; reload and recount'}), op = f.create();
  assert.equal((await op.start(payload())).rejected, true); await op.acknowledge(); assert.equal(op.read(), null);
  const g = fixture({fail: true}), retry = g.create(); await retry.start(payload());
  g.status = 409; g.detail = 'Stock changed; reload and recount';
  assert.equal((await g.create().retry()).pending, true);
  await assert.rejects(retry.acknowledge());
});
test('storage failure, changed identity, absent lock/capability and corrupt result fail closed', async () => {
  const f = fixture(), op = f.create();
  f.storage.setItem = () => {throw Error('disk full');};
  await assert.rejects(op.start(payload()), /disk full/); assert.equal(f.calls.length, 0);
  const g = fixture({caps: {}}); await assert.rejects(g.create().start(payload()), /รูปเครื่องชั่ง|ยังไม่รองรับ/); assert.equal(g.calls.length, 0);
  const noLock = fixture(); noLock.options.lock = null;
  await assert.rejects(async () => noLock.create().start(payload()), /ไม่รองรับการล็อก/);
  const h = fixture({fail: true}); await h.create().start(payload());
  const key = inventoryPendingKey(identity, 'stocktake'), stored = JSON.parse(h.map.get(key));
  stored.identity.actor = 'other'; h.map.set(key, JSON.stringify(stored)); assert.throws(() => h.create().read(), /บัญชีอื่น/);
  const j = fixture({saved: {id}}); assert.equal((await j.create().start(payload())).pending, true);
  assert.equal(j.create().read().status, 'pending');
});
test('receipt retry preserves null default cost intent and UUID when defaults later change', async () => {
  const map = new Map(), posts = []; let fail = true;
  const storage = {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)};
  const options = {kind: 'receive', identity, storage, uuid: () => id, lock: (_, task) => task(), transport: {
    capabilities: async () => caps, post: async p => {posts.push(structuredClone(p)); if (fail) throw Error('lost reply');
      return {lot_id: lot, client_receive_id: p.client_receive_id, quantity_mg: p.quantity_mg, cost_satang_per_gram: 0, duplicate: true};}
  }};
  await createInventoryOperation(options).start({product_id: lot, lot_code: 'R1', supplier_name: 'synthetic',
    supplier_document_ref: 'QA', reason: 'fixture', quantity_mg: 1000, cost_satang_per_gram: null, expires_on: null});
  fail = false; const found = await createInventoryOperation(options).retry();
  assert.equal(found.result.cost_satang_per_gram, 0); assert.deepEqual(posts[0], posts[1]);
});
test('unchanged count still confirms history and corrupt variance response remains pending', async () => {
  const f = fixture(), p = payload(); p.items[0].counted_quantity_mg = 1000;
  assert.equal((await f.create().start(p)).result.items[0].variance_mg, 0);
  const g = fixture(); g.saved = response({...payload(), client_stocktake_id: id}); g.saved.items[0].variance_mg = 0;
  assert.equal((await g.create().start(payload())).pending, true);
});
test('authoritative stale tombstone resolves a lost first POST without creating another UUID', async () => {
  const f = fixture({fail: true});
  f.options.transport.reconcile = async p => f.rejected ? {status: 'rejected', client_stocktake_id: p.client_stocktake_id,
    code: 'STOCK_CHANGED', message: 'Stock changed; reload and recount', committed: false} : {status: 'pending', client_stocktake_id: p.client_stocktake_id};
  const op = f.create(); await op.start(payload());
  assert.equal(op.read().uncertain, true); f.rejected = true;
  const found = await f.create().verify(); assert.equal(found.rejected, true); assert.equal(f.calls.length, 1);
  await f.create().acknowledge(); assert.equal(f.create().read(), null);
});
test('receipt reconciliation that can cancel is only called on explicit verify', async () => {
  const f = fixture(); let reconciliations = 0;
  const p = {product_id: lot, lot_code: 'R1', supplier_name: 'Synthetic', supplier_document_ref: '', reason: 'Fixture',
    quantity_mg: 1000, cost_satang_per_gram: null, expires_on: null};
  const options = {...f.options, kind: 'receive', transport: {
    capabilities: async () => caps, post: async () => {throw Error('lost first POST');},
    reconcile: async payload => {reconciliations++; return {status: 'rejected', client_receive_id: payload.client_receive_id,
      code: 'RECEIVE_CANCELLED', message: 'Receipt cancelled before commit', committed: false};}
  }};
  const op = createInventoryOperation(options); await op.start(p); assert.equal(reconciliations, 0);
  await createInventoryOperation(options).retry(); assert.equal(reconciliations, 0);
  const resolved = await createInventoryOperation(options).verify(); assert.equal(resolved.rejected, true); assert.equal(reconciliations, 1);
  await createInventoryOperation(options).acknowledge(); assert.equal(createInventoryOperation(options).read(), null);
});
test('fresh pending mutation check sees another actor and ignores only acknowledged completion markers', () => {
  const map = new Map(), storage = {get length() {return map.size;}, key: index => [...map.keys()][index], getItem: k => map.get(k) ?? null};
  assert.doesNotThrow(() => assertNoPendingMutation(storage, identity));
  const key = inventoryPendingKey({...identity, actor: 'another-actor'}, 'receive');
  map.set(key + '.completed', id); assert.doesNotThrow(() => assertNoPendingMutation(storage, identity));
  map.set(key, 'present'); assert.throws(() => assertNoPendingMutation(storage, identity), /ค้าง/);
});
