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
