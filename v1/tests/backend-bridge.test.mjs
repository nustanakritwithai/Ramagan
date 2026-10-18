import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../src/backend-api.js';

test('shared Android/Web client talks to self-hosted REST contract', async () => {
  const sessions = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => sessions.get(k) || null,
    setItem: (k,v) => sessions.set(k,String(v)),
    removeItem: (k) => sessions.delete(k)
  };
  const requests = [];
  const base = 'https://shop.example.com/ramagan-api';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const storeId = '22222222-2222-4222-8222-222222222222';
  const lotId = '33333333-3333-4333-8333-333333333333';
  const productId = '44444444-4444-4444-8444-444444444444';
  const fakeData = {
    '/health': {status:'ok',version:'1.1.0-vps-preview'},
    '/v1/auth/login': {token:'demo-token-not-real', user:{id:ownerId,email:'owner@example.test'}},
    '/v1/me': {
      user:{id:ownerId,email:'owner@example.test'},store_id:storeId,role:'owner',
      store:{id:storeId,name:'Test Store',sales_enabled:false,requires_authorization:true}
    },
    '/v1/catalog': {
      products:[{id:productId,sku:'P1',name:'Test Stock',category:'test',
        price_satang_per_gram:10000,active:1}],
      lots:[{id:lotId,lot_code:'LOT-1',expires_on:null,active:1,
        sku:'P1',name:'Test Stock',price_satang_per_gram:10000,
        product_active:1,quantity_mg:15000}]
    },
    '/v1/products': {product_id:productId,created:true},
    '/v1/lots/receive': {lot_id:lotId,quantity_mg:15000},
    '/v1/sales': {sale_id:'abc',total_satang:10000,duplicate:false},
    '/v1/auth/logout': {ok:true}
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const route = String(url).slice(base.length);
    requests.push({route,method:options.method,body:options.body||null,
                   authorization:options.headers.Authorization});
    if (!(route in fakeData)) return new Response(JSON.stringify({detail:'Not found'}), {
      status:404,headers:{'Content-Type':'application/json'}
    });
    return new Response(JSON.stringify(fakeData[route]), {
      status:200,headers:{'Content-Type':'application/json'}
    });
  };
  try {
    const client = createClient(base);
    assert.equal((await client.health()).data.status,'ok');
    const login = await client.auth.signInWithPassword({
      email:'owner@example.test',password:'not-a-real-password'
    });
    assert.equal(login.error,null);
    assert.equal(login.data.user.id,ownerId);
    assert.equal((await client.auth.getUser()).data.user.id,ownerId);
    const members = await client.from('ramagan_members').select('store_id,role').eq('user_id',ownerId).limit(1);
    assert.equal(members.data[0].role,'owner');
    const lots = await client.from('ramagan_lots').select('id,ramagan_products').eq('store_id',storeId);
    assert.equal(lots.data[0].ramagan_lot_balances.quantity_mg,15000);
    const products = await client.from('ramagan_products').select('id,sku').eq('store_id',storeId);
    assert.equal(products.data[0].sku,'P1');
    const product = await client.rpc('ramagan_create_product',{
      p_store_id:storeId,p_sku:'P1',p_name:'Test Stock',p_category:'test',
      p_price_satang_per_gram:10000
    });
    assert.equal(product.data.created,true);
    const sale = await client.rpc('ramagan_checkout',{
      p_store_id:storeId,p_client_sale_id:'xxxx',
      p_items:[{lot_id:lotId,quantity_mg:1000}],
      p_payment_method:'cash',p_authorization_ref:'TEST-ONLY'
    });
    assert.equal(sale.data.total_satang,10000);
    const lookup = await client.from('ramagan_sales').select('id,total_satang')
      .eq('client_sale_id','not-found').maybeSingle();
    assert.equal(lookup.data,null);
    assert.ok(requests.some(x=>x.route==='/v1/sales' &&
      x.authorization==='Bearer demo-token-not-real'));
    assert.ok(requests.every(x=>x.route.startsWith('/') && !x.route.includes('supabase')));
    await client.auth.signOut();
    assert.equal(sessions.size,0);
  } finally {
    globalThis.fetch=savedFetch;
    delete globalThis.sessionStorage;
  }
});

const checkoutBase = 'https://checkout.example.test/ramagan-api';
const checkoutCashier = '11111111-1111-4111-8111-111111111111';
const checkoutStore = '22222222-2222-4222-8222-222222222222';
const checkoutLot = '33333333-3333-4333-8333-333333333333';
const checkoutId = '44444444-4444-4444-8444-444444444444';
const checkoutCaps = {discounts: true, discount_contract_version: 1};
const checkoutIdentity = {api: checkoutBase, store: checkoutStore, cashier: checkoutCashier};
const meResponse = caps => ({user: {id: checkoutCashier}, store_id: checkoutStore, role: 'cashier',
  store: {name: 'Test Store', sales_enabled: true, requires_authorization: false}, capabilities: caps});
const checkoutPayload = discount => ({client_sale_id: checkoutId,
  items: [{lot_id: checkoutLot, quantity_mg: 1500}], payment_method: 'cash',
  authorization_ref: null, discount_satang: discount});
const checkoutSale = {id: 'server-sale', client_sale_id: checkoutId, store_id: checkoutStore,
  subtotal_satang: 15000, discount_satang: 1200, total_satang: 13800};

async function withMockClient(routes, task) {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.sessionStorage;
  const sessions = new Map([['ramagan.v1.session.' + checkoutBase, 'fixture-session-token']]);
  const requests = [];
  globalThis.sessionStorage = {getItem: key => sessions.get(key) ?? null,
    setItem: (key, value) => sessions.set(key, String(value)), removeItem: key => sessions.delete(key)};
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith(checkoutBase + '/'), 'all requests must use mock API base');
    const route = String(url).slice(checkoutBase.length);
    const request = {route, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, options};
    requests.push(request);
    const entry = routes[route];
    assert.notEqual(entry, undefined, `unexpected mock route: ${route}`);
    const response = typeof entry === 'function' ? await entry(request) : entry;
    return new Response(JSON.stringify(response.data), {status: response.status ?? 200, headers: {'Content-Type': 'application/json'}});
  };
  try { await task(createClient(checkoutBase), requests); }
  finally { globalThis.fetch = originalFetch; if (originalStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = originalStorage; }
}

test('checkout capabilities always re-fetch /v1/me and verify exact cashier/store identity', async () => {
  let currentMe = meResponse(checkoutCaps);
  await withMockClient({'/v1/me': () => ({data: currentMe})}, async (client, requests) => {
    assert.deepEqual(await client.checkoutTransport.capabilities(checkoutIdentity), checkoutCaps);
    currentMe = {...meResponse(checkoutCaps), user: {id: 'different-cashier'}};
    await assert.rejects(client.checkoutTransport.capabilities(checkoutIdentity));
    currentMe = {...meResponse(checkoutCaps), store_id: 'different-store'};
    await assert.rejects(client.checkoutTransport.capabilities(checkoutIdentity));
    currentMe = {...meResponse(checkoutCaps), user: null};
    await assert.rejects(client.checkoutTransport.capabilities(checkoutIdentity));
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.options.cache, 'no-store');
      assert.equal(request.options.headers.Authorization, 'Bearer fixture-session-token');
    }
  });
});

test('member mapping preserves discount capability and contract version fields without coercion', async () => {
  const caps = {...checkoutCaps, future_contract: {version: 3}};
  await withMockClient({'/v1/me': {data: meResponse(caps)}}, async client => {
    const result = await client.from('ramagan_members').select('store_id,role,capabilities').eq('user_id', checkoutCashier).limit(1);
    assert.equal(result.error, null);
    assert.deepEqual(result.data[0].capabilities, caps);
    assert.equal(result.data[0].store_id, checkoutStore);
    assert.equal(result.data[0].role, 'cashier');
  });
});

test('checkout POST sends exact frozen discount payload and returns authoritative response fields', async () => {
  await withMockClient({'/v1/sales': {data: checkoutSale}}, async (client, requests) => {
    const response = await client.checkoutTransport.post(checkoutPayload(1200));
    assert.deepEqual(response, checkoutSale);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(requests[0].body, checkoutPayload(1200));
    assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
    assert.equal(requests[0].options.credentials, 'omit');
  });
});

test('sale lookup preserves id, client ID, subtotal, discount and total for transport and query callers', async () => {
  const route = '/v1/sales/by-client/' + checkoutId;
  await withMockClient({[route]: {data: checkoutSale}}, async (client, requests) => {
    assert.deepEqual(await client.checkoutTransport.lookup(checkoutId), checkoutSale);
    const query = await client.from('ramagan_sales').select('id,client_sale_id,total_satang').eq('client_sale_id', checkoutId).maybeSingle();
    assert.equal(query.error, null);
    assert.deepEqual(query.data, checkoutSale);
    assert.ok(requests.every(request => request.method === 'GET' && request.route === route));
  });
});

test('only lookup 404 means absence; 401, 403 and 422 propagate errors', async () => {
  for (const status of [404, 401, 403, 422]) {
    const route = '/v1/sales/by-client/' + checkoutId;
    await withMockClient({[route]: {status, data: {detail: 'mock failure'}}}, async client => {
      if (status === 404) assert.equal(await client.checkoutTransport.lookup(checkoutId), null);
      else await assert.rejects(client.checkoutTransport.lookup(checkoutId), {status});
      const query = await client.from('ramagan_sales').select('id').eq('client_sale_id', checkoutId).maybeSingle();
      assert.equal(query.data, null);
      if (status === 404) assert.equal(query.error, null);
      else assert.equal(query.error.status, status);
    });
  }
});

test('lookup client identifier is URL encoded rather than interpreted as route or query', async () => {
  const id = 'fixture/with?query=unsafe&x=1';
  const route = '/v1/sales/by-client/' + encodeURIComponent(id);
  await withMockClient({[route]: {status: 404, data: {detail: 'not found'}}}, async (client, requests) => {
    assert.equal(await client.checkoutTransport.lookup(id), null);
    assert.equal(requests[0].route, route);
  });
});

function checkoutRpcArgs(discount) {
  return {p_store_id: checkoutStore, p_client_sale_id: checkoutId,
    p_items: checkoutPayload(0).items, p_payment_method: 'cash', p_authorization_ref: null,
    ...(discount === undefined ? {} : {p_discount_satang: discount})};
}

test('compatibility checkout RPC defaults omitted discount to exact zero payload', async () => {
  await withMockClient({'/v1/sales': {data: {sale_id: 'legacy', total_satang: 15000}}}, async (client, requests) => {
    const response = await client.rpc('ramagan_checkout', checkoutRpcArgs());
    assert.equal(response.error, null);
    assert.deepEqual(requests.find(request => request.method === 'POST').body, checkoutPayload(0));
  });
});

test('compatibility checkout RPC blocks nonzero discount on absent or mismatched capability before POST', async () => {
  for (const caps of [undefined, {}, {discounts: true}, {discounts: true, discount_contract_version: 2}, {discounts: true, discount_contract_version: '1'}]) {
    await withMockClient({'/v1/me': {data: meResponse(caps)}, '/v1/sales': {data: checkoutSale}}, async (client, requests) => {
      const response = await client.rpc('ramagan_checkout', checkoutRpcArgs(1200));
      assert.ok(response.error);
      assert.equal(response.data, null);
      assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    });
  }
});

test('compatibility checkout RPC passes approved version-one discount without changing its amount', async () => {
  await withMockClient({'/v1/me': {data: meResponse(checkoutCaps)}, '/v1/sales': {data: checkoutSale}}, async (client, requests) => {
    const response = await client.rpc('ramagan_checkout', checkoutRpcArgs(1200));
    assert.equal(response.error, null);
    assert.deepEqual(response.data, checkoutSale);
    assert.deepEqual(requests.find(request => request.method === 'POST').body, checkoutPayload(1200));
  });
});
