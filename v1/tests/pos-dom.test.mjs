import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM, VirtualConsole} from 'jsdom';
import {fakeIndexedDB} from './fake-idb.mjs';

// Offline integration of real main.js, REST bridge, math and checkout modules.
// Only browser services and HTTP responses are synthetic; this is not layout,
// Android, live-backend, or real-transaction coverage.
const API = 'https://fixture.invalid';
const store = '22222222-2222-4222-8222-222222222222';
const user = '11111111-1111-4111-8111-111111111111';
const lot = '33333333-3333-4333-8333-333333333333';
const product = '44444444-4444-4444-8444-444444444444';
const lot2 = '55555555-5555-4555-8555-555555555555';
const countId = '66666666-6666-4666-8666-666666666666';
const inventoryCaps = {discounts: true, discount_contract_version: 1, inventory_costs: true,
  cost_contract_version: 1, stocktakes: true, stocktake_contract_version: 2,
  stocktake_evidence:true,evidence_contract_version:1,split_payments:true,payment_contract_version:1,
  optional_document_references: true, document_contract_version: 1};
function inventoryFixture(changes = {}) {
  const products = [{id: product, sku: 'MOCK', name: 'Mock stock', category: 'fixture',
    price_satang_per_gram: 20000, active: true, default_cost_satang_per_gram: 0}];
  const lots = [{id: lot, product_id: product, lot_code: 'MOCK-1', name: 'Mock stock', sku: 'MOCK',
    price_satang_per_gram: 20000, quantity_mg: 10000, active: true, product_active: true,
    stock_revision: 2, cost_satang_per_gram: 0, inventory_value_satang: 0},
    {id: lot2, product_id: product, lot_code: 'EXPIRED', name: 'Unknown old lot', sku: 'MOCK',
      price_satang_per_gram: 20000, quantity_mg: 1000, active: false, product_active: true,
      expires_on: '2000-01-01', stock_revision: 0, cost_satang_per_gram: null, inventory_value_satang: null}];
  return fixture({capabilities: inventoryCaps, inventory: {products, lots, summary: {quantity_mg: 11000,
    known_inventory_value_satang: 0, inventory_value_satang: null, unknown_cost_lot_count: 1}},
    receipts: [], countPosts: [], productPosts: [], history: [], uploads:[], idb:fakeIndexedDB(), ...changes});
}
const mainURL = new URL('../src/main.js', import.meta.url);
const source = (await readFile(mainURL, 'utf8'))
  .replace(/import '\.\/[^']+\.css';/g, '')
  .replaceAll('import.meta.env.VITE_RAMAGAN_API_URL', "''")
  .replaceAll('import.meta.env.BASE_URL', "'/Ramagan/v1/'")
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, mainURL).href}'`);
let instance = 0;
const fixture = (changes = {}) => ({role: 'owner', capabilities: true, failPost: false,
  failCatalog: false, subtotal: 20000, posts: [], committed: null, ...changes});
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('DOM did not reach expected state');
}
async function boot(f, snapshot, {configured = true, signedIn = true} = {}) {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://pos.example.test/Ramagan/v1/', virtualConsole
  });
  const w = dom.window;
  Object.defineProperty(w,'indexedDB',{value:f.idb||fakeIndexedDB()});
  if (snapshot) {
    for (const [k, v] of snapshot.local) w.localStorage.setItem(k, v);
    for (const [k, v] of snapshot.session) w.sessionStorage.setItem(k, v);
  } else {
    if (configured) w.localStorage.setItem('ramagan.v1.server.url', API);
    if (signedIn) w.sessionStorage.setItem('ramagan.v1.session.' + API, 'offline-test-token');
  }
  Object.defineProperty(w.navigator, 'locks', {value: {
    async request(key, options, callback) { return callback({name: key}); }
  }});
  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, API, 'Unexpected external request');
    const path = parsed.pathname;
    let data, status = 200;
    if (path === '/health') data = {status: 'ok'};
    else if (path === '/v1/auth/login') data = {token: 'offline-test-token', user: {id: f.user || user}};
    else if (path === '/v1/auth/logout') data = {ok: true};
    else if (path === '/v1/me') data = {user: {id: f.user || user}, store_id: store, role: f.role,
      store: {name: 'OFFLINE MOCK STORE', sales_enabled: true, requires_authorization: f.requiresAuthorization ?? true},
      capabilities: typeof f.capabilities === 'object' ? f.capabilities :
        f.capabilities ? {discounts: true, discount_contract_version: 1} : undefined};
    else if (path === '/v1/catalog') {
      if (f.failCatalog) { status = 503; data = {detail: 'mock refresh failure'}; }
      else data = {products: f.inventory?.products || [], lots: [{id: lot, lot_code: 'MOCK-1', sku: 'MOCK',
        name: 'Mock stock', price_satang_per_gram: 20000, active: true,
        product_active: true, quantity_mg: f.catalogQuantity ?? 10000}]};
    } else if (path.startsWith('/v1/stocktake-evidence/') && options.method==='POST') {
      const upload=path.split('/').at(-1);f.uploads.push({id:upload,body:options.body,query:parsed.search});
      if(f.holdUpload)await f.holdUpload;
      if(f.failUpload)throw new TypeError('mock lost upload response');
      f.uploadResponses=(f.uploadResponses||0)+1;
      data={evidence_id:upload,client_upload_id:upload,client_stocktake_id:parsed.searchParams.get('client_stocktake_id'),
        lot_id:parsed.searchParams.get('lot_id'),mime:'image/jpeg',byte_size:4,width:1,height:1,sha256:'fixture',duplicate:false,created_at:'2026-10-18T01:00:00Z'};
    } else if(path.startsWith('/v1/stocktake-evidence/')&&options.method==='GET'){
      f.photoReads ||= [];f.photoReads.push({url,authorization:options.headers.Authorization});
      return new Response(new Blob(['jpeg'],{type:'image/jpeg'}),{status:200,headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store'}});
    } else if (path === '/v1/inventory') data = f.inventory;
    else if (path === '/v1/stocktakes' && options.method !== 'POST') data = {stocktakes: f.history};
    else if (path === '/v1/products' && options.method === 'POST') {
      f.productPosts.push(JSON.parse(options.body));
      if (f.failProduct) {status = 503; data = {detail: 'mock product rejected'};}
      else data = {product_id: product, created: true};
    } else if (path === '/v1/lots/receive' && options.method === 'POST') {
      const p = JSON.parse(options.body); f.receipts.push(p);
      if (f.failReceipt) throw new TypeError('mock lost receipt response');
      data = {lot_id: lot2, client_receive_id: p.client_receive_id, event_id: countId,
        quantity_mg: p.quantity_mg, ...(f.costsRedacted?{}:{cost_satang_per_gram:p.cost_satang_per_gram??0}), duplicate: false};
    } else if (path === '/v1/lots/receive/reconcile') {
      const p = JSON.parse(options.body); f.receiptReconciliations = (f.receiptReconciliations || 0) + 1;
      data = {status: 'rejected', client_receive_id: p.client_receive_id, code: 'RECEIVE_CANCELLED', message: 'Receipt cancelled', committed: false};
    } else if (path === '/v1/stocktakes' && options.method === 'POST') {
      const p = JSON.parse(options.body); f.countPosts.push(p);
      if (f.failCount) throw new TypeError('mock count response lost');
      if (f.rejectCount) {status = 409; data = {detail: 'Stock changed; reload and recount'};}
      else data = f.savedCount ||= {id: countId, client_stocktake_id: p.client_stocktake_id,
        actor_user_id: user, actor_email: 'fixture@example.test', shift_label: p.shift_label, reason: p.reason,
        duplicate: false, created_at: '2026-10-18T01:00:00Z', items: p.items.map(x => {
          const row = f.inventory.lots.find(l => l.id === x.lot_id);
          return {lot_id: x.lot_id, lot_code: row.lot_code, system_quantity_mg: row.quantity_mg,
            counted_quantity_mg: x.counted_quantity_mg, variance_mg: x.counted_quantity_mg - row.quantity_mg,
            stock_revision_before: x.expected_revision, stock_revision_after: x.expected_revision + 1,
            evidence:x.evidence_id?{evidence_id:x.evidence_id}:null};
        })};
    } else if (path.startsWith('/v1/stocktakes/by-client/')) {
      f.historyRequests = (f.historyRequests || 0) + 1;
      if (f.holdHistory) await f.holdHistory;
      data = f.savedCount || f.historyDetail;
      if (!data) {status = 404; data = {detail: 'not found'};}
    } else if (path === '/v1/stocktakes/reconcile') {
      const p = JSON.parse(options.body);
      data = f.rejectCount ? {status: 'rejected', client_stocktake_id: p.client_stocktake_id,
        code: 'STOCK_CHANGED', message: 'Stock changed; reload and recount', committed: false} :
        {status: 'pending', client_stocktake_id: p.client_stocktake_id};
    } else if (path === '/v1/sales' && options.method === 'POST') {
      const p = JSON.parse(options.body); f.posts.push(p);
      if (f.holdPost) await f.holdPost;
      if (f.failPost) throw new TypeError('Mock network interruption');
      f.committed ||= {sale_id: 'mock-sale', client_sale_id: p.client_sale_id,
        subtotal_satang: f.subtotal, discount_satang: p.discount_satang,
        total_satang: f.subtotal - p.discount_satang,
        ...(p.payment_method==='split'?{payment_method:'split',payments:p.payments}:{})};
      data = f.committed;
    } else if (path.startsWith('/v1/sales/by-client/')) {
      data = f.committed;
      if (!data) { status = 404; data = {detail: 'not found'}; }
    } else assert.fail(`Unexpected request ${options.method} ${path}`);
    return new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
  };
  const bindings = {window: w, document: w.document, navigator: w.navigator,
    localStorage: w.localStorage, sessionStorage: w.sessionStorage, FormData: w.FormData,
    CSS: {escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')},
    crypto: webcrypto, fetch: fetchMock};
  const original = new Map(Object.keys(bindings).map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const [k, value] of Object.entries(bindings)) Object.defineProperty(globalThis, k, {value, configurable: true, writable: true});
  await import('data:text/javascript;base64,' + Buffer.from(source + `\n// instance ${++instance}`).toString('base64'));
  const app = {
    q: s => w.document.querySelector(s), text: () => w.document.body.textContent,
    click(s) { const n = this.q(s); assert(n, `Missing ${s}`); n.click(); },
    menu(s) {
      if(this.q(s)){this.click(s);return;}
      const target=({'#open-inventory':'#nav-inventory','#open-stocktake':'#nav-stocktake','#open-sales':'#nav-sales','#logout':'#nav-logout'})[s]||s;
      for(let i=0;i<4&&!this.q('[data-navigation-trigger]');i++)this.click('#pos-back');
      if(!this.q('#app-navigation-drawer'))this.q('[data-navigation-trigger]').click();
      this.click(target);
    },
    eventClick(s) {this.q(s).dispatchEvent(new w.Event('click',{bubbles:true}));},
    key(value) {w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,bubbles:true}));},
    input(s, value, event = 'input') {
      const n = this.q(s); assert(n, `Missing ${s}`); n.value = value;
      n.dispatchEvent(new w.Event(event, {bubbles: true}));
    },
    submit(s) { this.q(s).dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true})); },
    check(s, checked = true) { const node = this.q(s); node.checked = checked; node.dispatchEvent(new w.Event('change', {bubbles: true})); },
    photo(s,blob=new Blob(['jpeg'],{type:'image/jpeg'})){const n=this.q(s);Object.defineProperty(n,'files',{value:[blob],configurable:true});n.dispatchEvent(new w.Event('change',{bubbles:true}));},
    snapshot: () => ({local: Object.entries(w.localStorage), session: Object.entries(w.sessionStorage)}),
    setLocal: (key, value) => w.localStorage.setItem(key, value),
    close() {
      w.close();
      for (const [k, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k];
      }
      assert.deepEqual(errors, [], 'Unhandled DOM errors');
    }
  };
  await until(() => app.q(configured ? (signedIn ? '[data-add], #checkout' : '#login-form') : '#server-form'));
  return app;
}
function fillCart(app, discount = '0') {
  if(app.q('#pos-back')&&!app.q('[data-add]'))app.click('#pos-back');
  app.click('[data-add]');app.input('#quantity-input','1');app.click('#quantity-confirm');app.click('#open-ticket');
  app.input('#discount',discount);app.click('#ticket-pay');app.input('#cash-received','1000000');app.input('#auth-ref','MOCK-DOC');
}
function assertLocked(app) {
  for (const s of ['[data-payment=cash]', '[data-payment=transfer]', '#auth-ref', '#checkout']) {
    assert.equal(app.q(s)?.disabled, true, `${s} must be locked`);
  }
}

test('offline endpoint setup and login reach the real POS screen', async () => {
  const f = fixture(), app = await boot(f, null, {configured: false, signedIn: false});
  try {
    app.input('[name=server]', API); app.submit('#server-form');
    await until(() => app.q('#login-form'));
    app.input('[name=email]', 'mock@example.test'); app.input('[name=password]', 'offline');
    app.submit('#login-form'); await until(() => app.q('[data-add]'));
    assert.match(app.text(), /OFFLINE MOCK STORE/); assert.equal(f.posts.length, 0);
    assert(!JSON.stringify(app.snapshot().local).includes('offline-test-token'));
  } finally { app.close(); }
});

test('discount UI validates invalid, zero, decimal and full-bill amounts', async () => {
  const f = fixture(), app = await boot(f);
  try {
    fillCart(app);
    app.click('#pos-back');
    for (const v of ['-1', '0.001', '200.01', 'not-money', '1e2']) {
      app.input('#discount', v); assert.equal(app.q('#ticket-pay').disabled, true, v);
      assert(app.q('#preview .danger'));
    }
    for (const v of ['0', '1', '175.50', '200']) {
      app.input('#discount', v); assert.equal(app.q('#ticket-pay').disabled, false, v);
    }
    assert.match(app.q('#preview').textContent, /0\.00/);
    app.click('#ticket-pay');app.click('#checkout'); await until(() => app.q('.success'));
    assert.equal(f.posts[0].discount_satang, 20000); assert.equal(f.committed.total_satang, 0);
    assert.equal(app.q('#retry'), null);
  } finally { app.close(); }
});

test('pending bill locks edits, restores on restart, retries frozen payload and preserves server totals after failed refresh', async () => {
  let release;
  const f = fixture({failPost: true, holdPost: new Promise(resolve => { release = resolve; })});
  let app = await boot(f);
  try {
    fillCart(app, '175.50'); app.click('[data-payment=transfer]'); app.click('#checkout');
    await until(() => f.posts.length === 1); assertLocked(app);
    release(); f.holdPost = null;
    await until(() => app.q('#retry') && !app.q('#retry').disabled); assertLocked(app);
    const saved = app.snapshot(), pending = saved.local.find(([k]) => k.startsWith('ramagan.v1.pending.v2.'));
    assert(pending); assert(!pending[1].includes('offline-test-token'));
    app.close(); app = null; app = await boot(f, saved);
    app.click('#open-ticket');assert.equal(app.q('#discount').value, '175.50');assert.equal(app.q('#discount').disabled,true);app.click('#ticket-pay'); assert(app.q('[data-payment=transfer]').classList.contains('selected'));
    assert.equal(app.q('#auth-ref').value, 'MOCK-DOC'); assertLocked(app);
    // Synthetic events bypassing disabled controls still cannot alter intent.
    app.eventClick('[data-payment=cash]'); app.input('#auth-ref', 'CHANGED');
    f.failPost = false; f.failCatalog = true; f.subtotal = 21000;
    app.click('#retry'); await until(() => app.q('.success') && !app.q('#retry'));
    assert.equal(f.posts.length, 2); assert.deepEqual(f.posts[1], f.posts[0]);
    assert.equal(f.posts[1].discount_satang, 17550);
    assert.match(app.q('.success').textContent, /210\.00/); assert.match(app.q('.success').textContent, /34\.50/);
    assert.match(app.text(), /ราคาปัจจุบันต่างจากประมาณการ/); assert.match(app.text(), /รีเฟรชสต็อกไม่สำเร็จ/);
    assert.equal(app.q('#catalog-pay').disabled, true);
    assert.equal(app.q('[data-remove]'), null);
    assert(!app.snapshot().local.some(([k]) => k.startsWith('ramagan.v1.pending.v2.') && !k.endsWith('.completed')));
    app.click('#catalog-pay'); app.click('#refresh'); await until(() => /mock refresh failure/.test(app.text()));
    assert.equal(f.posts.length, 2, 'Refresh must not resubmit a completed bill');
  } finally { app?.close(); }
});

test('legacy capability disables discount input but supports zero-discount checkout', async () => {
  const f = fixture({capabilities: false}), app = await boot(f);
  try {
    fillCart(app);app.click('#pos-back'); assert.equal(app.q('#discount').disabled, true); assert.match(app.text(), /ใช้ได้เฉพาะส่วนลด 0 บาท/);
    app.click('#ticket-pay');app.click('#checkout'); await until(() => app.q('.success')); assert.equal(f.posts[0].discount_satang, 0);
  } finally { app.close(); }
});

test('Owner alone sees Dashboard/settings/server; Manager retains inventory and other roles retain work pages', async () => {
  for (const role of ['owner', 'manager', 'cashier']) {
    const f = fixture({role}), app = await boot(f);
    try {
      app.click('#pos-back');
      assert.equal(Boolean(app.q('#nav-inventory')), role !== 'cashier', role);
      assert.equal(Boolean(app.q('.navigation-admin')), role === 'owner', role);
      assert.equal(Boolean(app.q('#nav-settings')), role === 'owner', role);
      assert.equal(Boolean(app.q('#nav-change-server')), role === 'owner', role);
      if (role !== 'cashier') {
        app.menu('#open-inventory'); assert(app.q('#new-product')); assert(app.q('#receive-lot'));
        app.click('#open-sales'); assert(app.q('[data-add]'));
      }
      assert.equal(f.posts.length, 0);
    } finally { app.close(); }
  }
});

function fillReceipt(app, document = '') {
  app.input('#receive-lot [name=lot_code]', 'QA-RECEIVE');
  app.input('#receive-lot [name=supplier_name]', 'Synthetic supplier');
  app.input('#receive-lot [name=supplier_document_ref]', document);
  app.input('#receive-lot [name=qty]', '5000.001');
}
async function fillCount(app, quantity = '0') {
  app.input('#count-reason', 'นับก่อนเข้ากะ');
  app.input('[data-count="' + lot + '"]', quantity);
  await until(()=>!/กำลังบันทึก/.test(app.q('#count-validation').textContent));
  app.photo('[data-photo="'+lot+'"]');
  await until(()=>/อัปโหลดรูปแล้ว/.test(app.text()));
  app.check('#count-confirm');
}
function managerPrivateFixture(changes={}){
  const f=inventoryFixture({role:'manager',costsRedacted:true,...changes});
  f.capabilities={...inventoryCaps,cost_privacy_contract_version:1,can_view_costs:false,can_access_dashboard:false,can_manage_settings:false};
  f.inventory.products=f.inventory.products.map(({default_cost_satang_per_gram,...row})=>row);
  f.inventory.lots=f.inventory.lots.map(({cost_satang_per_gram,inventory_value_satang,...row})=>row);
  f.inventory.summary={quantity_mg:11000};
  return f;
}
test('Manager has no cost/dashboard/settings/server UI but can create products and receive with the server default',async()=>{
  const f=managerPrivateFixture(),app=await boot(f);
  try{
    app.click('#pos-back');assert.equal(app.q('#nav-settings'),null);assert.equal(app.q('#nav-change-server'),null);assert.equal(app.q('.navigation-admin'),null);
    app.click('#nav-inventory');
    assert.equal(app.q('[name=default_cost]'),null);assert.equal(app.q('[name=cost]'),null);
    assert.equal(app.q('#receive-default-cost'),null);assert.equal(app.q('.inventory-valuation'),null);assert.equal(app.q('a.admin-link'),null);
    assert(!/ต้นทุน|มูลค่า/.test(app.text()));
    app.input('#new-product [name=sku]','MANAGER-NO-COST');app.input('#new-product [name=name]','Synthetic manager product');
    app.input('#new-product [name=price]','150');app.submit('#new-product');
    await until(()=>f.productPosts.length===1&&!app.q('#new-product button').disabled);
    assert.equal(f.productPosts[0].default_cost_satang_per_gram??null,null);
    fillReceipt(app);app.input('#receive-lot [name=qty]','1.250');app.submit('#receive-lot');
    await until(()=>f.receipts.length===1&&!app.q('#receive-lot button').disabled);
    assert.equal(f.receipts[0].cost_satang_per_gram,null);assert.equal(f.receipts[0].quantity_mg,1250);
    assert(!/ต้นทุน|มูลค่า|คำตอบรับสินค้าไม่สมบูรณ์/.test(app.text()));
  }finally{app.close();}
});
test('Manager redacted inventory still supports physical count/photo and has no server button on stocktake',async()=>{
  const f=managerPrivateFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');assert.equal(app.q('#change-server'),null);assert(app.q('[data-count]'));
    await fillCount(app,'1');app.submit('#stocktake-form');
    await until(()=>f.countPosts.length===1&&/เซิร์ฟเวอร์ยืนยันการนับและบันทึกประวัติแล้ว/.test(app.text()));
    assert.equal(f.countPosts[0].items[0].counted_quantity_mg,1000);
    assert.equal(f.uploads.length,1);assert(!/ต้นทุน|มูลค่า/.test(app.text()));
  }finally{app.close();}
});
test('Owner costs and server/settings entries do not survive logout into Manager on the same browser',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-inventory');assert(app.q('[name=default_cost]'));assert(app.q('.inventory-valuation'));
    app.input('[name=default_cost]','98765');app.menu('#logout');await until(()=>app.q('#login-form'));
    const next=managerPrivateFixture();Object.assign(f,next,{user:'77777777-7777-4777-8777-777777777777'});
    app.input('[name=email]','manager@fixture.invalid');app.input('[name=password]','synthetic-password');app.submit('#login-form');
    await until(()=>app.q('[data-add]'));app.click('#pos-back');
    assert.equal(app.q('#nav-settings'),null);assert.equal(app.q('#nav-change-server'),null);assert.equal(app.q('.navigation-admin'),null);
    app.click('#nav-inventory');assert.equal(app.q('[name=default_cost]'),null);assert.equal(app.q('.inventory-valuation'),null);assert(!app.text().includes('98765'));
  }finally{app.close();}
});
test('Owner cost/intake UI preserves unknown versus zero, optional documents and 100000g intake bound', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-inventory'); assert.match(app.text(), /ยังไม่ทราบต้นทุน/);
    assert.match(app.text(), /ส่วนที่ทราบต้นทุน/); assert.match(app.text(), /ค่าเริ่มต้นสินค้า:.*0\.00/);
    for (const [value, expected] of [['', null], ['0', 0], ['175.50', 17550]]) {
      app.input('#new-product [name=sku]', 'QA'); app.input('#new-product [name=name]', 'Synthetic');
      app.input('#new-product [name=price]', '200'); app.input('[name=default_cost]', value);
      const n = f.productPosts.length; app.submit('#new-product');
      await until(() => f.productPosts.length === n + 1 && !app.q('#new-product button').disabled);
      assert.equal(f.productPosts.at(-1).default_cost_satang_per_gram, expected);
    }
    assert.equal(app.q('[name=supplier_document_ref]').required, false);
    assert.equal(app.q('#receive-lot [name=reason]').value, 'รับสินค้าเข้าร้าน');
    fillReceipt(app); app.input('#receive-lot [name=qty]', '100000');
    app.input('#receive-lot [name=cost]', '0'); app.submit('#receive-lot');
    await until(() => /ยืนยัน Lot/.test(app.text()));
    assert.equal(f.receipts[0].quantity_mg, 100000000); assert.equal(f.receipts[0].cost_satang_per_gram, 0);
    assert.equal(f.receipts[0].supplier_document_ref, ''); assert.match(f.receipts[0].client_receive_id, /^[a-f0-9-]{36}$/);
    fillReceipt(app, 'DOC-KEEP'); app.input('#receive-lot [name=cost]', '175.50'); app.submit('#receive-lot');
    await until(() => f.receipts.length === 2 && !app.q('#receive-lot button').disabled);
    assert.equal(f.receipts[1].supplier_document_ref, 'DOC-KEEP'); assert.equal(f.receipts[1].cost_satang_per_gram, 17550);
  } finally { app.close(); }
});
test('stocktake shows inactive/expired lots, selected zero counts and original revision, then clears draft', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-stocktake'); assert.match(app.text(), /หมดอายุ/);
    assert.equal(app.q('[data-count="' + lot2 + '"]').disabled, false);
    await fillCount(app); assert.match(app.q('[data-variance="' + lot + '"]').textContent, /−10/);
    assert.equal(app.q('#confirm-count').disabled, false);
    app.submit('#stocktake-form'); await until(() => /ยืนยันการนับและบันทึกประวัติแล้ว/.test(app.text()));
    assert.equal(f.countPosts[0].items.length,1);assert.equal(f.countPosts[0].items[0].expected_revision,2);assert.equal(f.countPosts[0].items[0].counted_quantity_mg,0);assert.match(f.countPosts[0].items[0].evidence_id,/^[a-f0-9-]{36}$/);
    assert.equal(app.q('[data-count="' + lot + '"]').value, '');
    assert.equal(app.q('#confirm-count').disabled, true); assert.equal(f.posts.length, 0);
  } finally { app.close(); }
});
test('lost stocktake response blocks all new mutations and authoritative stale reconciliation permits recount', async () => {
  const f = inventoryFixture({failCount: true}), app = await boot(f);
  try {
    app.menu('#open-stocktake'); await fillCount(app, '9'); app.submit('#stocktake-form');
    await until(() => app.q('[data-inventory-verify]') && !app.q('[data-inventory-verify]').disabled);
    assert.equal(f.countPosts.length, 1);
    app.click('#open-sales'); assert.equal(app.q('[data-add]').disabled, true);
    app.click('[data-add]'); assert.equal(f.posts.length, 0);
    app.menu('#open-inventory'); assert.equal(app.q('#new-product button').disabled, true);
    assert.equal(app.q('#receive-lot button').disabled, true);
    app.submit('#new-product'); app.submit('#receive-lot'); assert.equal(f.productPosts.length, 0); assert.equal(f.receipts.length, 0);
    app.menu('#open-stocktake'); assert.equal(app.q('#confirm-count').disabled, true);
    f.rejectCount = true; app.click('[data-inventory-verify="stocktake"]');
    await until(() => /Stock changed; reload and recount/.test(app.text()) && !app.q('[data-inventory-verify]'));
    assert.equal(f.countPosts.length, 1); assert.equal(app.q('[data-count="' + lot + '"]').value, '');
    assert.equal(app.q('[data-count="' + lot + '"]').disabled, false);
  } finally { app.close(); }
});
test('lost receipt retries frozen UUID without implicit cancellation; explicit verify safely cancels absent receipt', async () => {
  const f = inventoryFixture({failReceipt: true}), app = await boot(f);
  try {
    app.menu('#open-inventory'); fillReceipt(app); app.submit('#receive-lot');
    await until(() => app.q('[data-inventory-retry="receive"]') && !app.q('[data-inventory-retry="receive"]').disabled);
    assert.equal(f.receiptReconciliations || 0, 0);
    app.click('[data-inventory-retry="receive"]');
    await until(() => f.receipts.length === 2 && !app.q('[data-inventory-retry="receive"]').disabled);
    assert.deepEqual(f.receipts[0], f.receipts[1]); assert.equal(f.receiptReconciliations || 0, 0);
    assert.match(app.q('[data-inventory-verify="receive"]').textContent, /ยกเลิกถ้ายังไม่บันทึก/);
    app.click('[data-inventory-verify="receive"]');
    await until(() => !app.q('[data-inventory-verify="receive"]')&&!app.q('#receive-lot button').disabled);
    assert.equal(f.receiptReconciliations, 1); assert.equal(app.q('#receive-lot button').disabled, false);
  } finally { app.close(); }
});
test('unresolved checkout locks intake/product/count, and fresh storage guard catches stale cross-tab UI', async () => {
  const f = inventoryFixture({failPost: true}), app = await boot(f);
  try {
    fillCart(app); app.click('#checkout'); await until(() => app.q('#retry') && !app.q('#retry').disabled);
    app.menu('#open-inventory'); assert.equal(app.q('#receive-lot button').disabled, true); assert.equal(app.q('#new-product button').disabled, true);
    app.menu('#open-stocktake'); assert.equal(app.q('[data-count="' + lot + '"]').disabled, true);
  } finally { app.close(); }
  const g = inventoryFixture(), next = await boot(g);
  try {
    fillCart(next); assert.equal(next.q('#checkout').disabled, false);
    // Another tab persisted an intent but its storage event has not arrived.
    next.setLocal('ramagan.v1.inventory.v1.' + encodeURIComponent(API) + '.' + store + '.' + user + '.receive', 'corrupt-but-present');
    next.click('#checkout'); await until(() => /ค้าง|อ่านไม่ได้|ไม่ถูกต้อง/.test(next.text()));
    assert.equal(g.posts.length, 0);
  } finally { next.close(); }
});
test('history shows per-lot offsetting variances without changing current draft or pending intent', async () => {
  const historyDetail = {id: countId, client_stocktake_id: countId, shift_label: 'Old count', reason: 'Old reason',
    actor_user_id: user, actor_email: 'counter@example.test', created_at: '2026-10-18T01:00:00Z', duplicate: true,
    items: [{lot_id: lot, lot_code: 'MOCK-1', system_quantity_mg: 10000, counted_quantity_mg: 9000, variance_mg: -1000},
      {lot_id: lot2, lot_code: 'EXPIRED', system_quantity_mg: 1000, counted_quantity_mg: 2000, variance_mg: 1000}]};
  const f = inventoryFixture({historyDetail, history: [{...historyDetail, line_count: 2, variance_mg: 0}]}), app = await boot(f);
  try {
    app.menu('#open-stocktake'); await fillCount(app, '8.001');
    const before = app.snapshot(); app.click('[data-history]');
    await until(() => app.q('.stocktake-detail'));
    assert.match(app.q('.stocktake-detail').textContent, /counter@example.test/);
    assert.match(app.q('.stocktake-detail').textContent, /−1.*\+1/s);
    assert.equal(app.q('[data-count="' + lot + '"]').value, '8.001'); assert.equal(app.q('#count-confirm').checked, true);
    assert.deepEqual(app.snapshot(), before); assert.equal(f.countPosts.length, 0);
  } finally { app.close(); }
});
test('old contract keeps intake document required; staff never receives cost/count controls; optional sale ref honors store flag', async () => {
  const old = inventoryFixture({capabilities: {...inventoryCaps, optional_document_references: false}}), app = await boot(old);
  try { app.menu('#open-inventory'); assert.equal(app.q('[name=supplier_document_ref]').required, true); }
  finally { app.close(); }
  const staff = inventoryFixture({role: 'staff'}), other = await boot(staff);
  try { other.click('#pos-back');assert.equal(other.q('#nav-stocktake'), null); assert.equal(other.q('#nav-inventory'), null); assert(!/ต้นทุน/.test(other.text())); }
  finally { other.close(); }
  const noDoc = inventoryFixture({requiresAuthorization: false}), sale = await boot(noDoc);
  try {
    fillCart(sale);
    assert.match(sale.q('#auth-ref').closest('label').textContent, /ถ้ามี/);
    sale.input('#auth-ref',''); sale.click('#checkout'); await until(() => sale.q('.success'));
    assert.equal(noDoc.posts[0].authorization_ref, null);
  } finally { sale.close(); }
});
test('history detail arriving after logout cannot render the prior tenant', async () => {
  let release;
  const f = inventoryFixture({holdHistory: new Promise(resolve => {release = resolve;}),
    history: [{id: countId, client_stocktake_id: countId, created_at: '2026-10-18T01:00:00Z', shift_label: 'OLD TENANT',
      actor_user_id: user, line_count: 1, variance_mg: 0, reason: 'old'}],
    historyDetail: {client_stocktake_id: countId, shift_label: 'PRIVATE OLD TENANT', items: []}}), app = await boot(f);
  try {
    app.menu('#open-stocktake'); app.click('[data-history]'); await until(() => f.historyRequests === 1);
    app.menu('#logout'); await until(() => app.q('#login-form'));
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(app.q('.stocktake-detail'), null); assert(!/PRIVATE OLD TENANT/.test(app.text()));
  } finally { release(); app.close(); }
});
test('equal physical/system count confirms with a photo and an optional empty reason',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');app.input('[data-count="'+lot+'"]','10');
    await until(()=>!app.q('#count-validation').textContent.includes('กำลังบันทึก'));
    app.photo('[data-photo="'+lot+'"]');await until(()=>/อัปโหลดรูปแล้ว/.test(app.text()));app.check('#count-confirm');
    assert.equal(app.q('#count-reason').required,false);assert.match(app.q('#count-reason').closest('label').textContent,/ถ้ามี/);
    assert.equal(app.q('#confirm-count').disabled,false);
    assert.equal(app.q('[data-variance="'+lot+'"]').textContent,'0 กรัม');
    app.submit('#stocktake-form');await until(()=>/เซิร์ฟเวอร์ยืนยันการนับและบันทึกประวัติแล้ว/.test(app.text()));
    assert.equal(f.countPosts[0].items[0].counted_quantity_mg,10000);assert(f.countPosts[0].items[0].evidence_id);assert.equal(f.countPosts[0].reason,'');
  }finally{app.close();}
});
test('count draft autosave keeps the same focused field and caret for digits, decimals, edits and composition',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');
    const selector='[data-count="'+lot+'"]',input=app.q(selector),document=input.ownerDocument,w=document.defaultView;
    input.focus();
    for(const value of ['1','10','100','100.','100.1','100.12','100.125']){
      app.input(selector,value);input.setSelectionRange(value.length,value.length);
      await until(()=>!app.q('#reload-count').disabled);
      assert.equal(app.q(selector),input,'Autosave must not replace the input');
      assert.equal(document.activeElement,input,'Autosave must keep focus');
      assert.equal(input.selectionStart,value.length);assert.equal(input.selectionEnd,value.length);
    }
    input.value='109.125';input.setSelectionRange(2,2);input.dispatchEvent(new w.InputEvent('input',{bubbles:true,inputType:'insertText',data:'9'}));
    await until(()=>!app.q('#reload-count').disabled);
    assert.equal(app.q(selector),input);assert.equal(document.activeElement,input);assert.equal(input.selectionStart,2);
    input.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
    input.value='10.125';input.setSelectionRange(2,2);input.dispatchEvent(new w.InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'0'}));
    await until(()=>!app.q('#reload-count').disabled);
    assert.equal(app.q(selector),input);assert.equal(document.activeElement,input);assert.equal(input.selectionStart,2);
    input.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
    for(const [selector,value] of [['#shift-label','รอบเย็น'],['#count-reason','']]){
      const field=app.q(selector);field.focus();app.input(selector,value);field.setSelectionRange(0,0);
      await until(()=>!app.q('#reload-count').disabled);
      assert.equal(app.q(selector),field);assert.equal(document.activeElement,field);assert.equal(field.selectionStart,0);
    }
    assert.equal(f.countPosts.length,0);assert.equal(f.uploads.length,0);
  }finally{app.close();}
});
test('rapid draft writes preserve the latest values without moving focus to the previous Lot',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');const first=app.q('[data-count="'+lot+'"]'),second=app.q('[data-count="'+lot2+'"]');
    first.focus();app.input('[data-count="'+lot+'"]','1');app.input('[data-count="'+lot+'"]','10');app.input('[data-count="'+lot+'"]','100');
    second.focus();app.input('[data-count="'+lot2+'"]','2.125');second.setSelectionRange(2,2);
    assert.equal(app.q('#confirm-count').disabled,true);
    await until(()=>!app.q('#reload-count').disabled);
    assert.equal(first.ownerDocument.activeElement,second);assert.equal(second.selectionStart,2);
    assert.equal(app.q('[data-count="'+lot+'"]'),first);assert.equal(first.value,'100');assert.equal(second.value,'2.125');
    app.click('#open-inventory');await new Promise(resolve=>setTimeout(resolve,20));
    app.menu('#open-stocktake');assert.equal(app.q('[data-count="'+lot+'"]').value,'100');
    assert.equal(app.q('[data-count="'+lot2+'"]').value,'2.125');assert.equal(f.countPosts.length,0);
  }finally{app.close();}
});
test('photo-first upload works with an empty count and the same evidence survives count typing and confirmation edits',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');app.photo('[data-photo="'+lot+'"]');
    await until(()=>f.uploads.length===1&&/อัปโหลดรูปแล้ว/.test(app.text()));
    assert.equal(app.q('[data-count="'+lot+'"]').value,'');assert.equal(app.q('#confirm-count').disabled,true);
    app.check('#count-confirm');app.submit('#stocktake-form');assert.equal(f.countPosts.length,0,'A photo without a numeric count is not a zero count');
    const input=app.q('[data-count="'+lot+'"]');input.focus();
    for(const value of ['1','10','100']){app.input('[data-count="'+lot+'"]',value);await until(()=>!app.q('#reload-count').disabled);assert.equal(input.ownerDocument.activeElement,input);}
    assert.equal(f.uploads.length,1);assert(app.q('.scale-preview'));assert.equal(app.q('#count-confirm').checked,false);
    app.check('#count-confirm');assert.equal(app.q('#confirm-count').disabled,false);
    app.input('[data-count="'+lot+'"]','100.125');assert.equal(app.q('#confirm-count').disabled,true);
    await until(()=>!app.q('#reload-count').disabled);assert.equal(app.q('#count-confirm').checked,false);
    app.check('#count-confirm');app.submit('#stocktake-form');
    await until(()=>f.countPosts.length===1&&/เซิร์ฟเวอร์ยืนยันการนับ/.test(app.text()));
    assert.equal(f.uploads.length,1);assert.equal(f.countPosts[0].items[0].counted_quantity_mg,100125);
    assert.equal(f.countPosts[0].items[0].expected_revision,2);assert.equal(f.countPosts[0].items[0].evidence_id,f.uploads[0].id);
    assert.equal(f.countPosts[0].reason,'');
  }finally{app.close();}
});
test('finishing an autosave after navigation or logout does not redraw the previous stocktake screen',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');app.input('[data-count="'+lot+'"]','100');app.click('#open-inventory');
    const form=app.q('#receive-lot');await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(app.q('#receive-lot'),form);assert.equal(app.q('#stocktake-form'),null);
    app.menu('#open-stocktake');app.input('[data-count="'+lot+'"]','90');app.menu('#logout');
    // Logout remains blocked until in-flight local storage work is durable.
    await until(()=>!app.q('#reload-count').disabled);app.menu('#logout');
    await until(()=>app.q('#login-form'));await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(app.q('#stocktake-form'),null);assert.equal(f.countPosts.length,0);assert.equal(f.uploads.length,0);
  }finally{app.close();}
});
test('late photo upload completion preserves the intake form edited after navigation',async()=>{
  let release;
  const f=inventoryFixture({holdUpload:new Promise(resolve=>{release=resolve;})}),app=await boot(f);
  try{
    app.menu('#open-stocktake');app.photo('[data-photo="'+lot+'"]');await until(()=>f.uploads.length===1);
    app.click('#open-inventory');app.input('#receive-lot [name=lot_code]','UNSENT-INTAKE');
    const form=app.q('#receive-lot');release();await until(()=>f.uploadResponses===1);await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(app.q('#receive-lot'),form);assert.equal(app.q('#receive-lot [name=lot_code]').value,'UNSENT-INTAKE');
    assert.equal(f.countPosts.length,0);assert.equal(f.receipts.length,0);
  }finally{release();app.close();}
});
test('photo draft restores across restart, retries exact upload UUID/bytes and does not block unsent sales',async()=>{
  const f=inventoryFixture({failUpload:true});let app=await boot(f);
  try{
    app.menu('#open-stocktake');app.input('#count-reason','fixture');app.input('[data-count="'+lot+'"]','10');
    await until(()=>!app.q('#count-validation').textContent.includes('กำลังบันทึก'));
    app.photo('[data-photo="'+lot+'"]');await until(()=>app.q('[data-photo-upload]')&&!app.q('[data-photo-upload]').disabled);
    const id=f.uploads[0].id,bytes=await f.uploads[0].body.text(),snapshot=app.snapshot();
    assert(!snapshot.local.some(([key])=>key.startsWith('ramagan.v1.inventory.v1.')));
    app.close();app=null;app=await boot(f,snapshot);app.menu('#open-stocktake');
    assert.equal(app.q('[data-count="'+lot+'"]').value,'10');f.failUpload=false;
    app.click('[data-photo-upload]');await until(()=>/อัปโหลดรูปแล้ว/.test(app.text()));
    assert.equal(f.uploads[1].id,id);assert.equal(await f.uploads[1].body.text(),bytes);
    app.check('#count-confirm');assert.equal(app.q('#confirm-count').disabled,false);
    app.input('[data-count="'+lot+'"]','9');await until(()=>!app.q('#reload-count').disabled);
    assert(app.q('.scale-preview'));assert.equal(f.uploads.length,2,'Editing count must retain the uploaded evidence without another upload');
    assert.equal(app.q('#count-confirm').checked,false);assert.equal(app.q('#confirm-count').disabled,true);
    app.check('#count-confirm');assert.equal(app.q('#confirm-count').disabled,false);
    app.click('#open-sales');fillCart(app);assert.equal(app.q('#checkout').disabled,false);
  }finally{app?.close();}
});
test('four POS views support blank-first decimal keypad, cancel, edit/remove and one atomic split bill',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    assert.equal(app.q('#app-navigation-drawer'),null);assert.equal(app.q('#pos-back').getAttribute('aria-expanded'),'false');
    app.click('#pos-back');assert(app.q('#app-navigation-drawer'));assert.equal(app.q('#pos-back').getAttribute('aria-expanded'),'true');
    app.click('#close-navigation');app.click('[data-add]');assert.equal(app.q('#app-navigation-drawer'),null);assert.equal(app.q('.pos-bottom'),null);assert.equal(app.q('#quantity-input').value,'');
    app.click('[data-key="2"]');assert.equal(app.q('#quantity-input').value,'2');app.click('#quantity-cancel');
    assert.match(app.q('#open-ticket').textContent,/0/);
    app.click('[data-add]');for(const key of ['.','1','2','5'])app.click('[data-key="'+key+'"]');
    assert.equal(app.q('#quantity-input').value,'0.125');app.click('#quantity-confirm');assert.match(app.q('#catalog-pay').textContent,/25\.00/);
    app.click('#open-ticket');app.click('[data-edit]');app.click('[data-key="2"]');assert.equal(app.q('#quantity-input').value,'2');
    app.click('#quantity-confirm');app.click('#open-ticket');app.click('[data-remove]');assert.match(app.q('#open-ticket').textContent,/0/);
    app.click('#ticket-more');fillCart(app,'1');app.click('[data-payment=split]');
    assert.equal(app.q('#payment'),null);assert.equal(app.q('#app-navigation-drawer'),null);
    app.input('#split-cash','100');app.input('#split-transfer','99');
    assert.equal(app.q('#cash-received'),null);assert.equal(app.q('#change'),null);assert.equal(app.q('#checkout').disabled,false);
    app.click('#checkout');await until(()=>app.q('.success'));
    assert.equal(f.posts.length,1);assert.equal(f.posts[0].payment_method,'split');
    assert.deepEqual(f.posts[0].payments,[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:9900}]);
    assert.equal(f.posts[0].cash_received,undefined);assert.equal(f.posts[0].items.length,1);
  }finally{app.close();}
});
test('replacing a valid photo immediately blocks confirm before IndexedDB work and requires a new confirmation',async()=>{
  const f=inventoryFixture(),app=await boot(f);
  try{
    app.menu('#open-stocktake');await fillCount(app,'10');assert.equal(app.q('#confirm-count').disabled,false);
    app.photo('[data-photo="'+lot+'"]',new Blob(['replacement'],{type:'image/jpeg'}));
    assert.equal(app.q('#confirm-count').disabled,true);app.submit('#stocktake-form');assert.equal(f.countPosts.length,0);
    await until(()=>f.uploads.length===2&&!app.q('[data-photo="'+lot+'"]').disabled);
    assert.equal(app.q('#count-confirm').checked,false);assert.equal(app.q('#confirm-count').disabled,true);
  }finally{app.close();}
});
test('history photos use authenticated private Blob requests and legacy lines are visibly marked',async()=>{
  const f=inventoryFixture({history:[{id:countId,client_stocktake_id:countId,created_at:'2026-10-18T01:00:00Z',shift_label:'Fixture',actor_user_id:user,line_count:2,variance_mg:0,reason:'Count'}],
    historyDetail:{id:countId,client_stocktake_id:countId,created_at:'2026-10-18T01:00:00Z',shift_label:'Fixture',actor_user_id:user,reason:'Count',items:[
      {lot_code:'MOCK-1',system_quantity_mg:1000,counted_quantity_mg:1000,variance_mg:0,evidence:{evidence_id:countId}},
      {lot_code:'LEGACY',system_quantity_mg:1000,counted_quantity_mg:1000,variance_mg:0,evidence:null}]}}),app=await boot(f);
  try{
    app.menu('#open-stocktake');app.click('[data-history]');await until(()=>app.q('[data-history-photo]'));
    assert.match(app.text(),/ไม่มีรูปย้อนหลัง/);app.click('[data-history-photo]');await until(()=>app.q('.stocktake-detail img'));
    assert.equal(f.photoReads.length,1);assert.equal(f.photoReads[0].authorization,'Bearer offline-test-token');
    assert(!f.photoReads[0].url.includes('?'));assert.match(app.q('.stocktake-detail img').src,/^blob:/);
    const blob=app.q('.stocktake-detail img').src;
    app.click('[data-photo-view]');assert.equal(app.q('#evidence-viewer').getAttribute('aria-modal'),'true');
    assert.equal(app.q('#evidence-viewer img').src,blob);app.key('Escape');assert.equal(app.q('#evidence-viewer'),null);
    app.click('[data-photo-view]');app.click('#close-evidence-viewer');assert.equal(app.q('#evidence-viewer'),null);
    assert.equal(f.photoReads.length,1,'Opening an already-fetched photo must not create another API request');
    assert(!JSON.stringify(app.snapshot().local).includes('offline-test-token'));
  }finally{app.close();}
});
test('cumulative same-Lot quantity cannot exceed 1000 grams before creating a checkout intent',async()=>{
  const f=inventoryFixture({catalogQuantity:2000000}),app=await boot(f);
  try{
    app.click('[data-add]');app.input('#quantity-input','1000');assert.equal(app.q('#quantity-confirm').disabled,false);
    app.click('#quantity-confirm');app.click('[data-add]');app.input('#quantity-input','0.001');
    assert.equal(app.q('#quantity-confirm').disabled,true);assert.match(app.q('#quantity-error').textContent,/1,000/);
    app.click('#quantity-confirm');assert.equal(f.posts.length,0);
    assert(!app.snapshot().local.some(([key])=>key.startsWith('ramagan.v1.pending.v2.')));
  }finally{app.close();}
});

function setManagementForm(app, id, values) {
  for (const [name, value] of Object.entries(values)) {
    const selector = '#' + id + ' [name="' + name + '"]';
    app.input(selector, value, app.q(selector).tagName === 'SELECT' ? 'change' : 'input');
  }
}
function assertManagementValues(app, id, values) {
  for (const [name, value] of Object.entries(values)) {
    assert.equal(app.q('#' + id + ' [name="' + name + '"]').value, value, id + '.' + name);
  }
}
const productRawDraft = {sku: 'UNSENT PRIVATE SKU', name: 'UNSENT PRIVATE PRODUCT', category: 'fixture',
  price: '100.', default_cost: '0.'};
const intakeRawDraft = {product_id: product, lot_code: 'UNSENT PRIVATE LOT', supplier_name: 'Fixture supplier',
  supplier_document_ref: 'OPTIONAL-REF', qty: '1.250', cost: '10.', expires: '2027-12-31', reason: 'Fixture intake'};

test('compact management starts with visible stock and closed task, count metadata, photo and history panels', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-inventory');
    const stock = app.q('.inventory-stock-list');
    assert(stock?.querySelector('.inventory-stock-row'), 'Stock overview is visible without opening a task form');
    assert.equal(stock.closest('details'), null);
    for (const id of ['new-product-panel', 'receive-lot-panel']) {
      const panel = app.q('details.inventory-task#' + id);
      assert(panel, id + ' is a native expandable task');
      assert.equal(panel.open, false, id + ' is compact on first entry');
      assert(panel.querySelector('summary'));
    }
    app.click('#receive-lot-panel > summary');
    assert.equal(app.q('#receive-lot-panel').open, true);
    assert.equal(app.q('#new-product-panel').open, false);
    assert(app.q('#receive-lot [name=qty]'));
    app.click('#open-stocktake');
    assert.equal(app.q('details.count-session-details').open, false);
    assert.equal(app.q('details.stocktake-history').open, false);
    for (const id of [lot, lot2]) {
      const panel = app.q('details[data-evidence-panel="' + id + '"]');
      assert(panel?.querySelector('.count-evidence-summary'));
      assert.equal(panel.open, false, 'Each photo selector starts collapsed');
      assert.match(app.q('[data-evidence-status="' + id + '"]').textContent, /ยังไม่แนบรูป/);
      assert(app.q('[data-count="' + id + '"]'));
      assert(app.q('[data-variance="' + id + '"]'));
    }
    assert.equal(f.productPosts.length + f.receipts.length + f.countPosts.length, 0);
  } finally { app.close(); }
});

test('native compact stocktake toggles keep the same numeric field, caret, raw count and optional reason', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-stocktake');
    const selector = '[data-count="' + lot + '"]', input = app.q(selector);
    const document = input.ownerDocument;
    for (const value of ['1', '10', '100', '100.', '100.125']) {
      input.focus(); app.input(selector, value); input.setSelectionRange(value.length, value.length);
      // Expanding a native disclosure does not require re-rendering the form.
      const panel = app.q('details[data-evidence-panel="' + lot + '"]');
      panel.open = !panel.open;
      app.q('details.count-session-details').open = !app.q('details.count-session-details').open;
      await until(() => !app.q('#reload-count').disabled);
      assert.equal(app.q(selector), input);
      assert.equal(document.activeElement, input);
      assert.equal(input.selectionStart, value.length);
      assert.equal(input.value, value);
    }
    app.q('details.count-session-details').open = true;
    app.input('#shift-label', 'กะเย็น'); app.input('#count-reason', '');
    await until(() => !app.q('#reload-count').disabled);
    assert.equal(app.q('#count-reason').required, false);
    app.click('#open-inventory'); app.click('#open-stocktake');
    assert.equal(app.q(selector).value, '100.125');
    assert.equal(app.q('#shift-label').value, 'กะเย็น');
    assert.equal(app.q('#count-reason').value, '');
    assert.equal(f.countPosts.length, 0);
  } finally { app.close(); }
});

test('compact photo disclosures preserve open state and evidence whether the photo or count is entered first', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-stocktake');
    app.click('details[data-evidence-panel="' + lot + '"] > summary');
    app.click('details.count-session-details > summary');
    app.input('#shift-label', 'Photo-first fixture');
    await until(() => !app.q('#reload-count').disabled);
    app.photo('[data-photo="' + lot + '"]');
    await until(() => f.uploads.length === 1 && /อัปโหลดรูปแล้ว/.test(app.text()));
    assert.equal(app.q('details[data-evidence-panel="' + lot + '"]').open, true);
    assert.equal(app.q('details.count-session-details').open, true);
    assert.equal(app.q('[data-count="' + lot + '"]').value, '');
    assert.equal(app.q('#confirm-count').disabled, true, 'A photo does not imply a numeric zero count');
    app.input('[data-count="' + lot + '"]', '10.000');
    app.input('[data-count="' + lot2 + '"]', '0');
    await until(() => !app.q('#reload-count').disabled);
    assert.match(app.q('[data-evidence-status="' + lot2 + '"]').textContent, /ต้องแนบรูป/);
    app.click('details[data-evidence-panel="' + lot2 + '"] > summary');
    app.photo('[data-photo="' + lot2 + '"]');
    await until(() => f.uploads.length === 2 && app.q('[data-photo-note="' + lot2 + '"]')?.textContent.includes('อัปโหลดรูปแล้ว'));
    for (const id of [lot, lot2]) {
      assert.equal(app.q('details[data-evidence-panel="' + id + '"]').open, true);
      assert.match(app.q('[data-evidence-status="' + id + '"]').textContent, /พร้อมส่ง/);
      assert(app.q('[data-photo="' + id + '"]').closest('details').querySelector('.scale-preview'));
    }
    assert.equal(app.q('[data-count="' + lot + '"]').value, '10.000');
    assert.equal(app.q('[data-count="' + lot2 + '"]').value, '0');
    assert.equal(app.q('#shift-label').value, 'Photo-first fixture');
    app.check('#count-confirm'); assert.equal(app.q('#confirm-count').disabled, false);
    assert.equal(f.countPosts.length, 0, 'This regression test never submits a stocktake');
  } finally { app.close(); }
});

test('both compact inventory forms retain raw unsent values through toggles, navigation, refresh and photo rendering', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-inventory');
    app.click('#new-product-panel > summary'); app.click('#receive-lot-panel > summary');
    setManagementForm(app, 'new-product', productRawDraft);
    setManagementForm(app, 'receive-lot', intakeRawDraft);
    const productForm = app.q('#new-product'), receiptForm = app.q('#receive-lot');
    app.click('#new-product-panel > summary'); app.click('#new-product-panel > summary');
    app.click('#receive-lot-panel > summary'); app.click('#receive-lot-panel > summary');
    assert.equal(app.q('#new-product'), productForm); assert.equal(app.q('#receive-lot'), receiptForm);
    assertManagementValues(app, 'new-product', productRawDraft); assertManagementValues(app, 'receive-lot', intakeRawDraft);
    app.click('#refresh');
    await until(() => app.q('#new-product') !== productForm && !app.q('#new-product button').disabled);
    assertManagementValues(app, 'new-product', productRawDraft); assertManagementValues(app, 'receive-lot', intakeRawDraft);
    app.click('#open-stocktake');
    // Refresh clears the current inventory snapshot before the HTTP requests
    // settle. Navigation may finish first; wait for the fresh Lot controls.
    await until(() => app.q('details[data-evidence-panel="' + lot + '"] > summary'));
    app.click('details[data-evidence-panel="' + lot + '"] > summary'); app.photo('[data-photo="' + lot + '"]');
    await until(() => /อัปโหลดรูปแล้ว/.test(app.text()));
    app.click('#open-inventory');
    assertManagementValues(app, 'new-product', productRawDraft); assertManagementValues(app, 'receive-lot', intakeRawDraft);
    assert(!JSON.stringify(app.snapshot()).includes('UNSENT PRIVATE'), 'Unsent form text remains in actor-scoped memory');
    assert.equal(f.productPosts.length + f.receipts.length + f.countPosts.length, 0);
  } finally { app.close(); }
});

test('successful compact task clears only its own form, and a rejected product leaves both drafts intact', async () => {
  const f = inventoryFixture({failProduct: true}), app = await boot(f);
  try {
    app.menu('#open-inventory');
    app.click('#new-product-panel > summary'); app.click('#receive-lot-panel > summary');
    const validProduct = {...productRawDraft, price: '100.00', default_cost: '0.00'};
    const validIntake = {...intakeRawDraft, qty: '1.250', cost: '10.00'};
    setManagementForm(app, 'new-product', validProduct); setManagementForm(app, 'receive-lot', validIntake);
    app.submit('#new-product'); await until(() => /mock product rejected/.test(app.text()) && !app.q('#new-product button').disabled);
    assertManagementValues(app, 'new-product', validProduct); assertManagementValues(app, 'receive-lot', validIntake);
    f.failProduct = false; app.submit('#new-product');
    await until(() => f.productPosts.length === 2 && !app.q('#new-product button').disabled);
    assert.equal(app.q('#new-product [name=sku]').value, '');
    assert.equal(app.q('#new-product [name=name]').value, '');
    assertManagementValues(app, 'receive-lot', validIntake);
    if (!app.q('#new-product-panel').open) app.click('#new-product-panel > summary');
    setManagementForm(app, 'new-product', productRawDraft);
    app.submit('#receive-lot'); await until(() => f.receipts.length === 1 && !app.q('#receive-lot button').disabled);
    assert.equal(f.receipts[0].quantity_mg, 1250); assert.equal(f.receipts[0].cost_satang_per_gram, 1000);
    assert.equal(app.q('#receive-lot [name=lot_code]').value, '');
    assert.equal(app.q('#receive-lot [name=qty]').value, '');
    assertManagementValues(app, 'new-product', productRawDraft);
  } finally { app.close(); }
});

test('management drafts cannot leak to a new actor after logout while old count evidence remains actor-scoped', async () => {
  const f = inventoryFixture(), app = await boot(f);
  try {
    app.menu('#open-inventory');
    app.click('#new-product-panel > summary'); app.click('#receive-lot-panel > summary');
    setManagementForm(app, 'new-product', productRawDraft); setManagementForm(app, 'receive-lot', intakeRawDraft);
    app.click('#open-stocktake'); app.input('[data-count="' + lot + '"]', '9.125');
    await until(() => !app.q('#reload-count').disabled);
    app.click('details[data-evidence-panel="' + lot + '"] > summary'); app.photo('[data-photo="' + lot + '"]');
    await until(() => /อัปโหลดรูปแล้ว/.test(app.text()));
    app.menu('#logout'); await until(() => app.q('#login-form'));
    f.user = '77777777-7777-4777-8777-777777777777';
    app.input('[name=email]', 'second-fixture@example.test'); app.input('[name=password]', 'fixture-password');
    app.submit('#login-form'); await until(() => app.q('[data-add]'));
    app.menu('#open-inventory');
    assert.equal(app.q('#new-product [name=sku]').value, '');
    assert.equal(app.q('#receive-lot [name=lot_code]').value, '');
    assert(!app.text().includes('UNSENT PRIVATE'));
    app.click('#open-stocktake');
    assert.equal(app.q('[data-count="' + lot + '"]').value, ''); assert.equal(app.q('.scale-preview'), null);
    assert.equal(f.countPosts.length + f.receipts.length + f.productPosts.length, 0);
    assert.equal(f.uploads.length, 1);
  } finally { app.close(); }
});
