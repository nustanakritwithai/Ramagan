import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM, VirtualConsole} from 'jsdom';
import * as lib from '../../admin/lib.js';

// Real Dashboard controller and DOM, intercepted synthetic HTTP only.
// No real accounts, VPS connections or business data are used here.
const html = await readFile(new URL('../../admin/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../../admin/dashboard.js', import.meta.url), 'utf8'))
  .replace(/^import\s*\{[\s\S]*?\}\s*from '\.\/lib\.js';/, '');

function response(from, to) {
  const amount = {subtotal_satang:10000, discount_satang:0, total_satang:10000,
    known_cost_satang:3000, cost_satang:3000, gross_profit_satang:7000,
    unknown_cost_line_count:0, cost_complete:true};
  const zero = Object.fromEntries(Object.keys(amount).map(key => [key, key === 'cost_complete' ? true : 0]));
  const daily = [];
  for (let date = from; date <= to; date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)) {
    daily.push({date, ...(date === from ? amount : zero), sale_count:date === from ? 1 : 0,
      quantity_mg:date === from ? 1000 : 0});
  }
  return {period:{from, to, timezone:'Asia/Bangkok'},
    capabilities:{discounts:true, discount_contract_version:1, inventory_costs:true, cost_contract_version:1},
    summary:{...amount, sale_count:1, cash_satang:10000, transfer_satang:0,
      average_satang:10000, quantity_mg:1000}, daily,
    top_products:[], top_categories:[], recent_sales:[], low_stock:[]};
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Dashboard did not reach expected state');
}
function boot(role = 'owner') {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, {url:'https://dashboard.example.invalid/admin/', runScripts:'outside-only', virtualConsole:vc});
  const w = dom.window;
  Object.assign(w, lib, {AbortSignal});
  const state = {role, reportStatus:200, paths:[], logoutCount:0, pendingReport:null, hold:false};
  w.fetch = async (url) => {
    const u = new URL(url);
    state.paths.push(u.pathname);
    let status = 200, data;
    if (u.pathname === '/v1/auth/login') data = {token:'offline-owner-test-only'};
    else if (u.pathname === '/v1/me') data = {role:state.role, store:{name:'SYNTHETIC DASHBOARD', sales_enabled:false}};
    else if (u.pathname === '/v1/auth/logout') {state.logoutCount++; data = {ok:true};}
    else if (u.pathname === '/v1/admin/sales-report') {
      if (state.hold) await new Promise(resolve => {state.pendingReport = resolve;});
      status = state.reportStatus;
      data = status === 200 ? response(u.searchParams.get('from'), u.searchParams.get('to')) : {detail:'Owner only'};
    } else throw new Error('Unexpected synthetic request: ' + u.pathname);
    return {ok:status >= 200 && status < 300, status, json:async () => data};
  };
  w.eval(source);
  const node = id => w.document.getElementById(id);
  async function login() {
    node('api-base').value = 'https://fixture.invalid';
    node('email').value = 'offline@example.invalid';
    node('password').value = 'synthetic-only';
    node('login-form').dispatchEvent(new w.Event('submit', {cancelable:true, bubbles:true}));
    await until(() => !w.document.body.classList.contains('busy'));
  }
  function assertCleared() {
    assert.equal(node('dashboard-panel').hidden, true);
    assert.equal(node('login-panel').hidden, false);
    for (const id of ['metric-known-cost', 'metric-cost', 'metric-profit', 'metric-sales']) assert.equal(node(id).textContent, '—');
    assert.equal(node('export-csv').disabled, true);
    assert.equal(node('store-info').textContent, '');
    for (const id of ['daily-rows', 'top-products', 'recent-sales']) assert.equal(node(id).children.length, 0);
    assert.equal(w.localStorage.length + w.sessionStorage.length, 0);
    assert.deepEqual(errors, []);
  }
  return {dom, w, node, state, login, assertCleared};
}

test('Dashboard denies Manager and Staff before sending any report request', async () => {
  for (const role of ['manager', 'staff', 'OWNER', null]) {
    const f = boot(role);
    try {
      await f.login(); f.assertCleared();
      assert.match(f.node('login-message').textContent, /เฉพาะเจ้าของร้าน/);
      assert.equal(f.state.paths.includes('/v1/admin/sales-report'), false);
      assert.equal(f.state.logoutCount, 1);
    } finally {f.dom.window.close();}
  }
});

test('Dashboard loads Owner costs and rechecks Owner before every refresh', async () => {
  const f = boot();
  try {
    await f.login();
    assert.equal(f.node('metric-cost').textContent, '฿30.00');
    assert.equal(f.node('metric-profit').textContent, '฿70.00');
    assert.equal(f.node('dashboard-panel').hidden, false);
    assert.equal(f.node('export-csv').disabled, false);
    f.state.role = 'manager';
    f.node('refresh').click();
    await until(() => !f.w.document.body.classList.contains('busy'));
    f.assertCleared();
    assert.equal(f.state.paths.filter(path => path === '/v1/admin/sales-report').length, 1);
    assert.equal(f.state.logoutCount, 1);
  } finally {f.dom.window.close();}
});

test('Dashboard clears Owner costs and CSV on authenticated 401 or 403', async () => {
  for (const status of [401, 403]) {
    const f = boot();
    try {
      await f.login();
      f.state.reportStatus = status;
      f.node('refresh').click();
      await until(() => !f.w.document.body.classList.contains('busy'));
      f.assertCleared();
    } finally {f.dom.window.close();}
  }
});

test('Dashboard logout clears costs before revocation finishes and blocks later nonOwner login', async () => {
  const f = boot();
  try {
    await f.login();
    f.node('logout').click();
    f.assertCleared();
    await until(() => !f.w.document.body.classList.contains('busy'));
    f.state.role = 'staff';
    await f.login(); f.assertCleared();
    assert.equal(f.state.paths.filter(path => path === '/v1/admin/sales-report').length, 1);
  } finally {f.dom.window.close();}
});

test('Dashboard page cache clearing prevents an in-flight Owner report from restoring costs', async () => {
  const f = boot();
  try {
    await f.login();
    f.state.hold = true;
    f.node('refresh').click();
    await until(() => f.state.pendingReport);
    f.w.dispatchEvent(new f.w.Event('pagehide'));
    f.assertCleared();
    f.state.pendingReport();
    await until(() => !f.w.document.body.classList.contains('busy'));
    f.assertCleared();
  } finally {f.dom.window.close();}
});
