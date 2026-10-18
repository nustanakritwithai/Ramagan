import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM, VirtualConsole} from 'jsdom';

// Offline integration of real main.js, REST bridge, math and checkout modules.
// Only browser services and HTTP responses are synthetic; this is not layout,
// Android, live-backend, or real-transaction coverage.
const API = 'https://fixture.invalid';
const store = '22222222-2222-4222-8222-222222222222';
const user = '11111111-1111-4111-8111-111111111111';
const lot = '33333333-3333-4333-8333-333333333333';
const mainURL = new URL('../src/main.js', import.meta.url);
const source = (await readFile(mainURL, 'utf8'))
  .replace("import './style.css';", '')
  .replaceAll('https://157.85.96.139/ramagan-api', API)
  .replaceAll('import.meta.env.VITE_RAMAGAN_API_URL', "''")
  .replaceAll('import.meta.env.BASE_URL', "'/Ramagan/v1/'")
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, mainURL).href}'`);
let instance = 0;
const fixture = (changes = {}) => ({role: 'owner', capabilities: true, failPost: false,
  failCatalog: false, failHealth: false, healthVersion: '1.1.0-vps-preview', subtotal: 20000,
  posts: [], requests: [], committed: null, ...changes});
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('DOM did not reach expected state');
}
async function boot(f, snapshot, {configured = true, signedIn = true, waitFor, extraOrigins = []} = {}) {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://pos.example.test/Ramagan/v1/', virtualConsole
  });
  const w = dom.window;
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
    const allowedOrigins = [new URL(API).origin, ...extraOrigins];
    assert(allowedOrigins.includes(parsed.origin), 'Unexpected external request');
    f.requests.push({url: parsed.href, method: options.method || 'GET',
      hasAuthorization: Boolean(options.headers?.Authorization)});
    const path = parsed.pathname.replace(/^\/ramagan-api(?=\/|$)/, '') || '/';
    let data, status = 200;
    if (path === '/health') {
      status = f.failHealth ? 503 : 200;
      data = {status: f.failHealth ? 'unavailable' : 'ok', version: f.healthVersion};
    }
    else if (path === '/v1/auth/login') data = {token: 'offline-test-token', user: {id: user}};
    else if (path === '/v1/auth/logout') data = {ok: true};
    else if (path === '/v1/me') data = {user: {id: user}, store_id: store, role: f.role,
      store: {name: 'OFFLINE MOCK STORE', sales_enabled: true, requires_authorization: true},
      capabilities: f.capabilities ? {discounts: true, discount_contract_version: 1} : undefined};
    else if (path === '/v1/catalog') {
      if (f.failCatalog) { status = 503; data = {detail: 'mock refresh failure'}; }
      else data = {products: [], lots: [{id: lot, lot_code: 'MOCK-1', sku: 'MOCK',
        name: 'Mock stock', price_satang_per_gram: 20000, active: true,
        product_active: true, quantity_mg: 10000}]};
    } else if (path === '/v1/sales' && options.method === 'POST') {
      const p = JSON.parse(options.body); f.posts.push(p);
      if (f.holdPost) await f.holdPost;
      if (f.failPost) throw new TypeError('Mock network interruption');
      f.committed ||= {sale_id: 'mock-sale', client_sale_id: p.client_sale_id,
        subtotal_satang: f.subtotal, discount_satang: p.discount_satang,
        total_satang: f.subtotal - p.discount_satang};
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
    input(s, value, event = 'input') {
      const n = this.q(s); assert(n, `Missing ${s}`); n.value = value;
      n.dispatchEvent(new w.Event(event, {bubbles: true}));
    },
    submit(s) { this.q(s).dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true})); },
    snapshot: () => ({local: Object.entries(w.localStorage), session: Object.entries(w.sessionStorage)}),
    close() {
      w.close();
      for (const [k, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k];
      }
      assert.deepEqual(errors, [], 'Unhandled DOM errors');
    }
  };
  await until(() => app.q(waitFor || (signedIn ? '[data-add]' : '#login-form')));
  return app;
}
function fillCart(app, discount = '0') {
  app.click('[data-add]'); app.input('#auth-ref', 'MOCK-DOC'); app.input('#discount', discount);
}
function assertLocked(app) {
  for (const s of ['[data-add]', '[data-remove]', '#discount', '#payment', '#auth-ref', '#checkout']) {
    assert.equal(app.q(s)?.disabled, true, `${s} must be locked`);
  }
}

test('first launch verifies the default server automatically and keeps staff sign-in manual', async () => {
  const f = fixture(), app = await boot(f, null, {configured: false, signedIn: false});
  try {
    assert(app.q('#login-form'));
    assert.equal(app.snapshot().local.find(([key]) => key === 'ramagan.v1.server.url'), undefined);
    assert.equal(f.requests.filter(x => new URL(x.url).pathname.endsWith('/health')).length, 1);
    app.input('[name=email]', 'mock@example.test'); app.input('[name=password]', 'offline');
    app.submit('#login-form'); await until(() => app.q('[data-add]'));
    assert.match(app.text(), /OFFLINE MOCK STORE/); assert.equal(f.posts.length, 0);
    assert(!JSON.stringify(app.snapshot().local).includes('offline-test-token'));
  } finally { app.close(); }
});

test('relaunch uses a valid saved custom endpoint', async () => {
  const endpoint = 'https://custom.invalid/ramagan-api';
  const f = fixture(), app = await boot(f, {
    local: [['ramagan.v1.server.url', endpoint]], session: []
  }, {signedIn: false, extraOrigins: ['https://custom.invalid']});
  try {
    assert(app.q('#login-form'));
    assert(f.requests.length > 0);
    assert(f.requests.every(x => new URL(x.url).origin === 'https://custom.invalid'));
    assert.equal(app.snapshot().local.find(([key]) => key === 'ramagan.v1.server.url')?.[1], endpoint);
  } finally { app.close(); }
});

test('invalid saved endpoint falls back to the verified default with a visible notice', async () => {
  const f = fixture(), app = await boot(f, {
    local: [['ramagan.v1.server.url', 'http://untrusted.invalid/ramagan-api']], session: []
  }, {signedIn: false});
  try {
    assert(app.q('#login-form'));
    assert.match(app.text(), /saved server address was invalid/i);
    assert.equal(app.snapshot().local.find(([key]) => key === 'ramagan.v1.server.url'), undefined);
    assert(f.requests.every(x => new URL(x.url).origin === new URL(API).origin));
  } finally { app.close(); }
});

test('Settings verifies and remembers a selected endpoint without signing in staff', async () => {
  const endpoint = 'https://selected.invalid/ramagan-api';
  const f = fixture(), app = await boot(f, null, {
    extraOrigins: ['https://selected.invalid']
  });
  try {
    app.click('#open-settings');
    app.input('[name=server]', endpoint);
    app.submit('#server-form');
    await until(() => app.q('#login-form'));
    assert.equal(app.q('[data-add]'), null);
    assert.equal(app.snapshot().local.find(([key]) => key === 'ramagan.v1.server.url')?.[1], endpoint);
    assert(!JSON.stringify(app.snapshot().local).includes('offline-test-token'));
    assert(f.requests.some(x => x.url.startsWith(endpoint)));
    assert(f.requests.filter(x => new URL(x.url).origin === 'https://selected.invalid')
      .every(x => !x.hasAuthorization), 'The previous server session must not reach the selected endpoint');
  } finally { app.close(); }
});

test('failed endpoint check keeps the attempted URL for retry and never probes the placeholder', async () => {
  const endpoint = 'https://attempted.invalid/ramagan-api';
  const f = fixture(), app = await boot(f, null, {
    extraOrigins: ['https://attempted.invalid']
  });
  try {
    app.click('#open-settings');
    app.input('[name=server]', endpoint);
    f.failHealth = true;
    app.submit('#server-form');
    await until(() => app.q('#connection-error'));
    assert.equal(app.q('[name=server]').value, endpoint);
    assert.match(app.text(), /Active server: https:\/\/fixture\.invalid/);
    assert(f.requests.some(x => x.url.startsWith(endpoint)));
    assert(!f.requests.some(x => x.url.includes('your-domain.com')));
    f.failHealth = false;
    app.submit('#server-form');
    await until(() => app.q('#login-form'));
    assert.equal(app.snapshot().local.find(([key]) => key === 'ramagan.v1.server.url')?.[1], endpoint);
    assert.equal(f.posts.length, 0);
  } finally { app.close(); }
});

test('unreachable server stays on connection settings and retry can recover', async () => {
  const f = fixture({failHealth: true});
  const app = await boot(f, null, {configured: false, signedIn: false, waitFor: '#connection-error'});
  try {
    assert.equal(app.q('#login-form'), null);
    assert.match(app.text(), /Could not reach the RAMAGAN API/);
    f.failHealth = false;
    app.click('#retry-connection');
    await until(() => app.q('#login-form'));
    assert.equal(f.posts.length, 0);
    assert(!f.requests.some(x => new URL(x.url).pathname.includes('/v1/sales')));
  } finally { app.close(); }
});

test('incompatible server version is rejected before sign-in', async () => {
  const f = fixture({healthVersion: '0.9.0'});
  const app = await boot(f, null, {configured: false, signedIn: false, waitFor: '#connection-error'});
  try {
    assert.equal(app.q('#login-form'), null);
    assert.match(app.text(), /Incompatible server version/);
    assert.match(app.text(), /0\.9\.0/);
    assert.equal(f.posts.length, 0);
  } finally { app.close(); }
});

test('discount UI validates invalid, zero, decimal and full-bill amounts', async () => {
  const f = fixture(), app = await boot(f);
  try {
    fillCart(app);
    for (const v of ['-1', '0.001', '200.01', 'not-money', '1e2']) {
      app.input('#discount', v); assert.equal(app.q('#checkout').disabled, true, v);
      assert(app.q('#preview .danger'));
    }
    for (const v of ['0', '1', '175.50', '200']) {
      app.input('#discount', v); assert.equal(app.q('#checkout').disabled, false, v);
    }
    assert.match(app.q('#preview').textContent, /0\.00/);
    app.click('#checkout'); await until(() => app.q('.success'));
    assert.equal(f.posts[0].discount_satang, 20000); assert.equal(f.committed.total_satang, 0);
    assert.equal(app.q('#retry'), null);
  } finally { app.close(); }
});

test('pending bill locks edits, restores on restart, retries frozen payload and preserves server totals after failed refresh', async () => {
  let release;
  const f = fixture({failPost: true, holdPost: new Promise(resolve => { release = resolve; })});
  let app = await boot(f);
  try {
    fillCart(app, '175.50'); app.input('#payment', 'transfer', 'change'); app.click('#checkout');
    await until(() => f.posts.length === 1); assertLocked(app);
    release(); f.holdPost = null;
    await until(() => app.q('#retry') && !app.q('#retry').disabled); assertLocked(app);
    const pending = app.snapshot().local.find(([k]) => k.startsWith('ramagan.v1.pending.v2.'));
    assert(pending); assert(!pending[1].includes('offline-test-token'));
    const pendingText = pending[1];
    app.click('#open-settings');
    assert(app.q('#pending-server-warning'));
    app.input('[name=server]', 'https://other.invalid/ramagan-api');
    app.submit('#server-form');
    await until(() => app.q('#connection-error'));
    assert.match(app.q('#connection-error').textContent, /Endpoint change blocked/);
    assert.equal(app.snapshot().local.find(([k]) => k === pending[0])?.[1], pendingText);
    assert.equal(app.snapshot().local.find(([k]) => k === 'ramagan.v1.server.url')?.[1], API);
    assert(!f.requests.some(x => new URL(x.url).origin === 'https://other.invalid'));
    app.click('#settings-back'); assertLocked(app);
    const saved = app.snapshot();
    app.close(); app = null; app = await boot(f, saved);
    assert.equal(app.q('#discount').value, '175.50'); assert.equal(app.q('#payment').value, 'transfer');
    assert.equal(app.q('#auth-ref').value, 'MOCK-DOC'); assertLocked(app);
    // Synthetic events bypassing disabled controls still cannot alter intent.
    app.input('#discount', '0'); app.input('#payment', 'cash', 'change'); app.input('#auth-ref', 'CHANGED');
    f.failPost = false; f.failCatalog = true; f.subtotal = 21000;
    app.click('#retry'); await until(() => app.q('.success') && !app.q('#retry'));
    assert.equal(f.posts.length, 2); assert.deepEqual(f.posts[1], f.posts[0]);
    assert.equal(f.posts[1].discount_satang, 17550);
    assert.match(app.q('.success').textContent, /210\.00/); assert.match(app.q('.success').textContent, /34\.50/);
    assert.match(app.text(), /ราคาปัจจุบันต่างจากประมาณการ/); assert.match(app.text(), /รีเฟรชสต็อกไม่สำเร็จ/);
    assert.equal(app.q('#discount').value, '0'); assert.equal(app.q('#checkout').disabled, true);
    assert.equal(app.q('[data-remove]'), null);
    assert(!app.snapshot().local.some(([k]) => k.startsWith('ramagan.v1.pending.v2.') && !k.endsWith('.completed')));
    app.click('#checkout'); app.click('#refresh'); await until(() => /mock refresh failure/.test(app.text()));
    assert.equal(f.posts.length, 2, 'Refresh must not resubmit a completed bill');
  } finally { app?.close(); }
});

test('legacy capability disables discount input but supports zero-discount checkout', async () => {
  const f = fixture({capabilities: false}), app = await boot(f);
  try {
    fillCart(app); assert.equal(app.q('#discount').disabled, true); assert.match(app.text(), /ใช้ได้เฉพาะส่วนลด 0 บาท/);
    app.click('#checkout'); await until(() => app.q('.success')); assert.equal(f.posts[0].discount_satang, 0);
  } finally { app.close(); }
});

test('owner and manager see inventory and reports; cashier sees sales only', async () => {
  for (const role of ['owner', 'manager', 'cashier']) {
    const f = fixture({role}), app = await boot(f);
    try {
      assert.equal(Boolean(app.q('#open-inventory')), role !== 'cashier', role);
      assert.equal(Boolean(app.q('.admin-link')), role !== 'cashier', role);
      if (role !== 'cashier') {
        app.click('#open-inventory'); assert(app.q('#new-product')); assert(app.q('#receive-lot'));
        app.click('#open-sales'); assert(app.q('#discount'));
      }
      assert.equal(f.posts.length, 0);
    } finally { app.close(); }
  }
});
