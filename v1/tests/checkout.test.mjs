import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckout, pendingKey, normalizeSale, supportsDiscount, validateOperation } from '../src/checkout.js';

const SALE_UUID = '11111111-1111-4111-8111-111111111111';
const LOT_UUID = '22222222-2222-4222-8222-222222222222';
const identity = {api: 'https://pos.example.test/api', store: 'store-a', cashier: 'cashier-a'};
const payload = (discount = 0) => ({items: [{lot_id: LOT_UUID, quantity_mg: 1000}], payment_method: 'cash', discount_satang: discount, authorization_ref: null});
const capabilities = {discounts: true, discount_contract_version: 1};
const copy = value => JSON.parse(JSON.stringify(value));
function memoryStorage() {
  const data = new Map();
  return {data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key)};
}
function mutex() {
  const tails = new Map();
  return (key, task) => {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    tails.set(key, next);
    return next;
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
function error(status) { return Object.assign(new Error(`HTTP ${status}`), {status}); }
function fixture(options = {}) {
  const calls = {post: [], lookup: [], capabilities: [], uuid: 0};
  const storage = options.storage ?? memoryStorage();
  const who = options.identity ?? identity;
  const transport = {
    capabilities: async id => { calls.capabilities.push(copy(id)); return capabilities; },
    post: async body => { calls.post.push(copy(body)); throw error(504); },
    lookup: async id => { calls.lookup.push(id); return null; },
    ...options.transport
  };
  const args = {storage, identity: who, transport, lock: options.lock === undefined ? mutex() : options.lock,
    uuid: () => { calls.uuid++; return SALE_UUID; }};
  return {calls, storage, transport, args, checkout: createCheckout(args)};
}
function sale(discount = 0, subtotal = 10000) {
  return {sale_id: 'sale-a', client_sale_id: SALE_UUID, store_id: identity.store,
    subtotal_satang: subtotal, discount_satang: discount, total_satang: subtotal - discount};
}
function operation(discount = 0) {
  return {version: 2, status: 'pending', identity: {...identity}, payload: {...payload(discount), client_sale_id: SALE_UUID}, preview_subtotal_satang: 10000};
}

test('capability gate requires explicit discount contract version', () => {
  assert.equal(supportsDiscount(capabilities), true);
  for (const value of [null, {}, {discounts: true}, {discounts: 1, discount_contract_version: 1}, {discounts: true, discount_contract_version: '1'}, {discounts: true, discount_contract_version: 2}]) assert.equal(supportsDiscount(value), false);
});
test('split checkout freezes one UUID and exact positive payment allocations across restart',async()=>{
  const caps={...capabilities,split_payments:true,payment_contract_version:1};
  const f=fixture({transport:{capabilities:async()=>caps}});
  const p={...payload(100),payment_method:'split',payments:[{payment_method:'cash',amount_satang:4000},{payment_method:'transfer',amount_satang:5900}]};
  await f.checkout.start(p,10000);const original=f.checkout.read();
  p.payments[0].amount_satang=1;
  const restored=createCheckout(f.args);await restored.retry();assert.deepEqual(f.calls.post[0],f.calls.post[1]);
  assert.equal(f.calls.uuid,1);assert.equal(original.payload.payments[0].amount_satang,4000);
  const answer={...sale(100),payment_method:'split',payments:original.payload.payments};
  assert.equal(normalizeSale(answer,original).total_satang,9900);
  assert.throws(()=>normalizeSale({...answer,payments:[{payment_method:'cash',amount_satang:5900},{payment_method:'transfer',amount_satang:4000}]},original));
  const old=fixture();await assert.rejects(old.checkout.start({...p,payments:original.payload.payments},10000));assert.equal(old.checkout.read(),null);
});
test('only explicit verify may authoritatively cancel an absent sale; wrong ID cannot clear pending',async()=>{
  let cancellations=0;
  const f=fixture({transport:{capabilities:async()=>({...capabilities,sale_reconciliation:true,sale_reconciliation_contract_version:1}),
    reconcile:async p=>{cancellations++;return {status:'rejected',client_sale_id:p.client_sale_id,code:'SALE_CANCELLED',committed:false};}}});
  await f.checkout.start(payload(),10000);await f.checkout.retry();assert.equal(cancellations,0);
  const rejected=await f.checkout.verify();assert.equal(rejected.rejected,true);assert.equal(cancellations,1);
  await f.checkout.acknowledge();assert.equal(f.checkout.read(),null);
  const g=fixture({transport:{capabilities:f.transport.capabilities,reconcile:async()=>({status:'rejected',client_sale_id:'wrong',code:'SALE_CANCELLED',committed:false})}});
  await g.checkout.start(payload(),10000);await assert.rejects(g.checkout.verify());assert.equal(g.checkout.read().status,'pending');
});

test('storage exception before persistence prevents every POST', async () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const f = fixture({storage});
  await assert.rejects(f.checkout.start(payload(), 10000), /QuotaExceeded/);
  assert.equal(f.calls.post.length, 0);
});

test('silent storage failure is caught by readback before POST', async () => {
  const storage = memoryStorage();
  storage.setItem = () => {};
  const f = fixture({storage});
  await assert.rejects(f.checkout.start(payload(), 10000));
  assert.equal(f.calls.post.length, 0);
});

test('network timeout before commit retains persisted intent', async () => {
  const f = fixture();
  const result = await f.checkout.start(payload(1200), 10000);
  assert.equal(result.pending, true);
  assert.equal(f.checkout.read().status, 'pending');
  assert.deepEqual(f.calls.post, [f.checkout.read().payload]);
  assert.deepEqual(f.calls.lookup, [SALE_UUID]);
});

test('restart retry uses frozen payload and UUID despite edited original cart', async () => {
  const f = fixture();
  const cart = payload(1200);
  await f.checkout.start(cart, 10000);
  const frozen = f.checkout.read().payload;
  cart.items[0].quantity_mg = 9999;
  cart.discount_satang = 0;
  cart.payment_method = 'transfer';
  const restarted = createCheckout({...f.args, uuid: () => { throw new Error('must not regenerate UUID'); }});
  await restarted.retry();
  assert.deepEqual(f.calls.post, [frozen, frozen]);
  assert.deepEqual(restarted.read().payload, frozen);
  assert.equal(f.calls.uuid, 1);
});

test('timeout after commit recovers by lookup and persists confirmed tombstone', async () => {
  const f = fixture({transport: {lookup: async () => sale(1200)}});
  const result = await f.checkout.start(payload(1200), 10000);
  assert.equal(result.sale.total_satang, 8800);
  assert.equal(f.checkout.read().status, 'confirmed');
});

for (const status of [401, 403, 422]) {
  test(`lookup not-found then POST ${status} cannot erase a previous uncertain commit`, async () => {
    const f = fixture();
    await f.checkout.start(payload(), 10000);
    const before = f.storage.getItem(f.checkout.key);
    f.transport.post = async body => { f.calls.post.push(copy(body)); throw error(status); };
    const result = await f.checkout.retry();
    assert.equal(result.pending, true);
    assert.equal(result.error.status, status);
    assert.equal(f.storage.getItem(f.checkout.key), before);
    assert.equal(f.calls.post.length, 2);
  });
  test(`lookup ${status} retains pending and never retries POST blindly`, async () => {
    const f = fixture();
    await f.checkout.start(payload(), 10000);
    const before = f.storage.getItem(f.checkout.key);
    f.transport.lookup = async () => { throw error(status); };
    await assert.rejects(f.checkout.retry(), {status});
    assert.equal(f.storage.getItem(f.checkout.key), before);
    assert.equal(f.calls.post.length, 1);
  });
}

test('lookup transport outage retains pending without another POST', async () => {
  const f = fixture();
  await f.checkout.start(payload(), 10000);
  f.transport.lookup = async () => { throw new TypeError('network offline'); };
  await assert.rejects(f.checkout.verify(), /network offline/);
  await assert.rejects(f.checkout.retry(), /network offline/);
  assert.equal(f.checkout.read().status, 'pending');
  assert.equal(f.calls.post.length, 1);
});

test('zero discount allows validated legacy response and authoritative server price', async () => {
  const f = fixture({transport: {capabilities: async () => ({}), post: async () => ({id: 'legacy-sale', total_satang: 12345})}});
  const result = await f.checkout.start(payload(), 10000);
  assert.equal(result.sale.sale_id, 'legacy-sale');
  assert.equal(result.sale.subtotal_satang, 12345);
  assert.equal(result.sale.discount_satang, 0);
  assert.equal(result.sale.legacy_zero, true);
  assert.equal(f.checkout.read().status, 'confirmed');
});

test('discounted old-server checkout is blocked before persistence or POST', async () => {
  const f = fixture({transport: {capabilities: async () => ({})}});
  await assert.rejects(f.checkout.start(payload(100), 10000));
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.checkout.read(), null);
});

test('capability downgrade on retry retains intent and blocks POST', async () => {
  const f = fixture();
  await f.checkout.start(payload(100), 10000);
  const before = f.storage.getItem(f.checkout.key);
  f.transport.capabilities = async () => ({});
  await assert.rejects(f.checkout.retry());
  assert.equal(f.calls.post.length, 1);
  assert.equal(f.storage.getItem(f.checkout.key), before);
});

test('response uses changed server price while preserving requested fixed discount', () => {
  const normalized = normalizeSale(sale(1200, 15000), operation(1200));
  assert.equal(normalized.subtotal_satang, 15000);
  assert.equal(normalized.discount_satang, 1200);
  assert.equal(normalized.total_satang, 13800);
});

test('invalid response amounts, identifiers and mismatched discounts are rejected', () => {
  const op = operation(1200);
  const invalid = [null, {}, {...sale(1200), sale_id: null}, {...sale(1200), client_sale_id: LOT_UUID},
    {...sale(1200), store_id: 'store-b'}, {...sale(1200), discount_satang: 0}, {...sale(1200), total_satang: 9999},
    {...sale(1200), subtotal_satang: 100}, {...sale(1200), total_satang: -1}, {...sale(1200), total_satang: '8800'},
    {...sale(1200), total_satang: 8800.1}, {...sale(1200), subtotal_satang: Number.MAX_SAFE_INTEGER + 1},
    {...sale(1200), discount_satang: undefined}, {...sale(1200), subtotal_satang: undefined}];
  for (const response of invalid) assert.throws(() => normalizeSale(response, op));
  for (const total of [-1, 1.1, '100', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeSale({id: 'legacy', total_satang: total}, operation()));
  }
  assert.throws(() => normalizeSale({id: 'legacy', subtotal_satang: 100, total_satang: 101}, operation()));
});

test('invalid success response retains pending rather than treating malformed totals as confirmation', async () => {
  const f = fixture({transport: {post: async () => ({...sale(1200), total_satang: 10000})}});
  const result = await f.checkout.start(payload(1200), 10000);
  assert.equal(result.pending, true);
  assert.equal(f.checkout.read().status, 'pending');
});

test('cashier change cannot inspect/replay/acknowledge another cashier pending operation', async () => {
  const f = fixture();
  await f.checkout.start(payload(), 10000);
  const other = createCheckout({...f.args, identity: {...identity, cashier: 'cashier-b'}});
  assert.throws(() => other.read());
  await assert.rejects(other.retry());
  await assert.rejects(other.verify());
  await assert.rejects(other.start(payload(), 10000));
  await assert.rejects(other.acknowledge());
  assert.equal(f.calls.post.length, 1);
});

test('API/store namespaces are isolated, and copied operations fail identity validation', async () => {
  const f = fixture();
  await f.checkout.start(payload(), 10000);
  for (const who of [{...identity, api: 'https://other.example.test/api'}, {...identity, store: 'store-b'}]) {
    assert.notEqual(pendingKey(who), f.checkout.key);
    const other = createCheckout({...f.args, identity: who});
    assert.equal(other.read(), null);
    f.storage.setItem(other.key, f.storage.getItem(f.checkout.key));
    assert.throws(() => other.read());
    await assert.rejects(other.retry());
  }
  assert.equal(f.calls.post.length, 1);
});

test('malformed JSON and invalid persisted operations block transmission and remain untouched', async () => {
  const invalid = ['{', 'null', '[]', ...[
    {...operation(), version: 1}, {...operation(), status: 'garbage'},
    {...operation(), preview_subtotal_satang: -1},
    {...operation(), payload: {...operation().payload, client_sale_id: 'old-id'}},
    {...operation(), payload: {...operation().payload, items: []}},
    {...operation(), payload: {...operation().payload, items: [{lot_id: LOT_UUID, quantity_mg: 0}]}},
    {...operation(), payload: {...operation().payload, items: [{lot_id: LOT_UUID, quantity_mg: 1000001}]}},
    {...operation(), payload: {...operation().payload, items: [payload().items[0], payload().items[0]]}},
    {...operation(), payload: {...operation().payload, payment_method: 'bitcoin'}},
    {...operation(), payload: {...operation().payload, discount_satang: 10001}},
    {...operation(), payload: {...operation().payload, authorization_ref: 'x'.repeat(121)}}
  ].map(JSON.stringify)];
  for (const raw of invalid) {
    const f = fixture();
    f.storage.setItem(f.checkout.key, raw);
    assert.throws(() => f.checkout.read());
    await assert.rejects(f.checkout.start(payload(), 10000));
    await assert.rejects(f.checkout.retry());
    assert.equal(f.calls.post.length, 0);
    assert.equal(f.storage.getItem(f.checkout.key), raw);
  }
});

test('legacy bare UUID requires manual resolution and is never automatically removed or replayed', async () => {
  const f = fixture();
  const oldKey = 'ramagan.v1.pending.' + identity.store;
  f.storage.setItem(oldKey, SALE_UUID);
  assert.throws(() => f.checkout.read());
  await assert.rejects(f.checkout.start(payload(), 10000));
  await assert.rejects(f.checkout.retry());
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.storage.getItem(oldKey), SALE_UUID);
});

test('missing lock fails closed without storage or network mutations', () => {
  const f = fixture({lock: null});
  assert.throws(() => f.checkout.start(payload(), 10000));
  assert.throws(() => f.checkout.retry());
  assert.equal(f.storage.data.size, 0);
  assert.equal(f.calls.post.length, 0);
});

test('two concurrent starts sharing a lock permit only one sale intent', async () => {
  const storage = memoryStorage();
  const lock = mutex();
  const a = fixture({storage, lock});
  const b = fixture({storage, lock});
  const results = await Promise.allSettled([a.checkout.start(payload(), 10000), b.checkout.start(payload(), 10000)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(a.calls.post.length + b.calls.post.length, 1);
  assert.equal(a.calls.uuid + b.calls.uuid, 1);
});

test('two concurrent retries serialize, with the second reading the first confirmed tombstone', async () => {
  const f = fixture();
  await f.checkout.start(payload(), 10000);
  let retryPosts = 0;
  f.transport.post = async () => { retryPosts++; return sale(); };
  const other = createCheckout(f.args);
  const results = await Promise.all([f.checkout.retry(), other.retry()]);
  assert.equal(retryPosts, 1);
  assert.ok(results.every(result => result.sale.sale_id === 'sale-a'));
  assert.equal(f.checkout.read().status, 'confirmed');
});

test('durable intent changed while awaiting capabilities blocks POST', async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture({transport: {capabilities: async () => { entered.resolve(); await gate.promise; return capabilities; }}});
  const pending = f.checkout.start(payload(), 10000);
  await entered.promise;
  const changed = f.checkout.read();
  changed.payload.items[0].quantity_mg = 2000;
  f.storage.setItem(f.checkout.key, JSON.stringify(changed));
  gate.resolve();
  await assert.rejects(pending);
  assert.equal(f.calls.post.length, 0);
});

test('confirmed tombstone survives restart, prevents repost and is independent of refresh success', async () => {
  const f = fixture({transport: {post: async () => sale(1200)}});
  const result = await f.checkout.start(payload(1200), 10000);
  assert.equal(result.sale.total_satang, 8800);
  // A UI stock/report refresh is outside checkout and must not remove its durable outcome.
  await assert.rejects(Promise.reject(new Error('stock refresh unavailable')));
  const restarted = createCheckout({...f.args, transport: {
    capabilities: async () => { throw new Error('no capability request expected'); },
    lookup: async () => { throw new Error('no lookup expected'); },
    post: async () => { throw new Error('must not repost confirmed sale'); }
  }});
  assert.equal((await restarted.verify()).sale.total_satang, 8800);
  assert.equal((await restarted.retry()).sale.total_satang, 8800);
  await assert.rejects(restarted.start(payload(), 10000));
  assert.equal(restarted.read().status, 'confirmed');
  await restarted.acknowledge();
  assert.equal(restarted.read(), null);
});

test('pending cannot be acknowledged and failed confirmed removal leaves tombstone intact', async () => {
  const f = fixture();
  await f.checkout.start(payload(), 10000);
  await assert.rejects(f.checkout.acknowledge());
  assert.equal(f.checkout.read().status, 'pending');
  f.transport.lookup = async () => sale();
  await f.checkout.verify();
  f.storage.removeItem = () => {};
  await assert.rejects(f.checkout.acknowledge());
  assert.equal(f.checkout.read().status, 'confirmed');
});

test('failed tombstone write retains original pending intent for reconciliation', async () => {
  const f = fixture({transport: {post: async () => sale(), lookup: async () => sale()}});
  const set = f.storage.setItem;
  f.storage.setItem = (key, raw) => { if (JSON.parse(raw).status === 'confirmed') throw new Error('disk full'); set(key, raw); };
  const result = await f.checkout.start(payload(), 10000);
  assert.equal(result.pending, true);
  assert.equal(f.checkout.read().status, 'pending');
  f.storage.setItem = set;
  assert.equal((await f.checkout.verify()).sale.sale_id, 'sale-a');
  assert.equal(f.checkout.read().status, 'confirmed');
});

test('tampered confirmed tombstone is rejected rather than acknowledged as a completed sale', () => {
  assert.throws(() => validateOperation({...operation(), status: 'confirmed', sale: {...sale(), total_satang: 0}}, identity));
});

test('stale second tab cannot start after first tab confirms and acknowledges its sale', async () => {
  const storage = memoryStorage();
  const lock = mutex();
  const a = fixture({storage, lock, transport: {post: async () => sale()}});
  const b = fixture({storage, lock});
  assert.equal(b.checkout.read(), null);
  await a.checkout.start(payload(), 10000);
  await a.checkout.acknowledge();
  assert.equal(storage.getItem(a.checkout.key), null);
  assert.equal(storage.getItem(a.checkout.key + '.completed'), SALE_UUID);
  await assert.rejects(b.checkout.start(payload(), 10000));
  assert.equal(b.calls.post.length, 0);
  assert.equal(b.calls.uuid, 0);
  // Explicit public reconciliation synchronizes the new completion generation.
  assert.equal(b.checkout.read(), null);
  await b.checkout.start(payload(), 10000);
  assert.equal(b.calls.post.length, 1);
});

test('failed completion revision write preserves confirmed tombstone', async () => {
  const f = fixture({transport: {post: async () => sale()}});
  await f.checkout.start(payload(), 10000);
  const set = f.storage.setItem;
  f.storage.setItem = (key, text) => { if (key.endsWith('.completed')) return; set(key, text); };
  await assert.rejects(f.checkout.acknowledge());
  assert.equal(f.checkout.read().status, 'confirmed');
});

test('zero-discount checkout identity handshake failure prevents POST and retains durable intent', async () => {
  const f = fixture({transport: {capabilities: async () => { throw error(401); }}});
  await assert.rejects(f.checkout.start(payload(), 10000), {status: 401});
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.checkout.read().status, 'pending');
  assert.equal(f.checkout.read().payload.client_sale_id, SALE_UUID);
});

test('discount handshake downgrade between preflight and POST preserves durable intent', async () => {
  let checks = 0;
  const f = fixture({transport: {capabilities: async () => (++checks === 1 ? capabilities : {})}});
  await assert.rejects(f.checkout.start(payload(100), 10000));
  assert.equal(f.calls.post.length, 0);
  assert.equal(f.checkout.read().status, 'pending');
});
