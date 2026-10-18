import { createClient, validateServerUrl } from './backend-api.js';
import { gramsToMilligrams, milligramsToGrams, lineTotalSatang, formatBaht, bahtToSatang, discountSatang, sumSatang } from './math.js';
import {createCheckout, supportsDiscount} from './checkout.js';
import './style.css';

const root = document.getElementById('app');
// A user can configure HTTPS endpoint directly in their Android app.
// A change of VPS/domain does not require rebuilding the APK.
const ADMIN_REPORT_URL = 'https://nustanakritwithai.github.io/Ramagan/admin/';
const ENDPOINT_STORAGE = 'ramagan.v1.server.url';
const DEFAULT_API_URL = 'https://157.85.96.139/ramagan-api';
const REQUIRED_API_VERSION = '1.1.0-vps-preview';
let savedEndpoint = '';
let endpointNotice = '';
try { savedEndpoint = localStorage.getItem(ENDPOINT_STORAGE) || ''; } catch { /* checkout will fail closed if storage is unavailable */ }
const validatedSavedEndpoint = validateServerUrl(savedEndpoint);
if (savedEndpoint && !validatedSavedEndpoint) {
  endpointNotice = 'The saved server address was invalid. Using the verified RAMAGAN server.';
  try { localStorage.removeItem(ENDPOINT_STORAGE); } catch { /* Keep running with the in-memory default. */ }
}
const buildEndpoint = validateServerUrl(import.meta.env.VITE_RAMAGAN_API_URL || '');
let apiUrl = validatedSavedEndpoint || buildEndpoint || validateServerUrl(DEFAULT_API_URL);
let endpointInput = apiUrl || '';
let configured = Boolean(apiUrl);
let api = configured ? createClient(apiUrl) : null;
let connectionReady = false;
let connectionChecking = false;
let setupError = endpointNotice;
let authSubscription = null;

const state = {
  user: null, store: null, role: null, lots: [], cart: new Map(),
  payment: 'cash', authRef: '', busy: false, message: '', error: false,
  pendingId: null, checkout: null, pendingBlocked: false, capabilities: null, discount: '0', lastSale: null, products: [], view: 'sales', settingsReturnView: 'sales'
};

function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function setMessage(message, error = false) {
  state.message = message;
  state.error = error;
  render();
}
function restorePending() {
  state.pendingBlocked = false;
  try {
    const op = state.checkout?.read();
    state.pendingId = op?.payload.client_sale_id || null;
    if (op) {
      state.cart = new Map(op.payload.items.map(x => [x.lot_id, x.quantity_mg]));
      state.payment = op.payload.payment_method;
      state.authRef = op.payload.authorization_ref || '';
      state.discount = (BigInt(op.payload.discount_satang) / 100n).toString() + '.' + String(op.payload.discount_satang % 100).padStart(2, '0');
    }
    return op;
  } catch (error) {
    state.pendingBlocked = true;
    state.pendingId = 'blocked';
    state.message = error.message;
    state.error = true;
    return null;
  }
}
function preview() {
  try {
    const subtotal = cartTotal();
    const discount = discountSatang(state.discount, subtotal);
    return {subtotal, discount, total: subtotal - discount};
  } catch (error) { return {error: error.message}; }
}
function toBangkokDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function statusChip() {
  return navigator.onLine ? '<span class="status online">ออนไลน์</span>' :
    '<span class="status offline">ออฟไลน์ · ดูข้อมูลเท่านั้น</span>';
}
function render() {
  if (state.view === 'settings') return renderSettings();
  if (!configured || !connectionReady) return renderSettings({blocking: true});
  if (!state.user) return renderLogin();
  if (!state.store) {
    root.innerHTML = '<div class="setup"><h1>RAMAGAN POS</h1><p>' +
      h(state.message || 'บัญชีนี้ยังไม่ได้รับสิทธิ์ในร้าน กรุณาให้เจ้าของร้านเพิ่มสมาชิก') +
      '</p><button id="logout">ออกจากระบบ</button></div>';
    root.querySelector('#logout').addEventListener('click', logout);
    return;
  }
  if (state.view === 'inventory' && canManage()) return renderInventory();
  renderDashboard();
}
function renderSettings({blocking = !connectionReady} = {}) {
  const pending = hasStoredPendingCheckout();
  root.innerHTML = [
    '<main class="login-wrap"><section class="login-card">',
    '<div class="brand">R<span>●</span> RAMAGAN</div>',
    '<h1>', blocking ? 'Connect to RAMAGAN' : 'Settings', '</h1>',
    '<p class="muted">Choose and verify the RAMAGAN API server. Staff credentials are entered only on the sign-in screen.</p>',
    apiUrl ? '<p class="footnote">Active server: <code>' + h(apiUrl) + '</code></p>' : '',
    connectionChecking ? '<p class="alert">Checking server health and compatibility…</p>' : '',
    setupError ? '<p class="alert danger" id="connection-error">' + h(setupError) + '</p>' : '',
    pending ? '<p class="alert danger" id="pending-server-warning">An unfinished checkout is stored on this device. Resolve it on its original server before changing endpoints.</p>' : '',
    '<form id="server-form"><label>RAMAGAN API URL (HTTPS)',
    '<input name="server" type="url" required autocomplete="url" value="', h(endpointInput), '" /></label>',
    '<button type="submit" class="primary" ', connectionChecking ? 'disabled' : '', '>Verify and use server</button></form>',
    apiUrl ? '<button class="ghost" id="retry-connection" type="button" ' + (connectionChecking ? 'disabled' : '') + '>Retry current server</button>' : '',
    !blocking ? '<button class="ghost" id="settings-back" type="button">Back to app</button>' : '',
    '</section></main>'
  ].join('');
  root.querySelector('[name="server"]').addEventListener('input', (event) => {
    endpointInput = event.currentTarget.value;
  });
  root.querySelector('#server-form').addEventListener('submit', (event) => {
    event.preventDefault();
    applyEndpoint(event.currentTarget.elements.server.value);
  });
  root.querySelector('#retry-connection')?.addEventListener('click', probeCurrentEndpoint);
  root.querySelector('#settings-back')?.addEventListener('click', () => {
    state.view = state.settingsReturnView || 'sales';
    setupError = '';
    render();
  });
}

function hasStoredPendingCheckout() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || '';
      if (key.startsWith('ramagan.v1.pending.v2.') && !key.endsWith('.completed')) return true;
      if (key.startsWith('ramagan.v1.pending.') && !key.startsWith('ramagan.v1.pending.v2.')) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function hasPendingCheckoutForDifferentEndpoint(endpoint) {
  try {
    const endpointPrefix = 'ramagan.v1.pending.v2.' + encodeURIComponent(endpoint) + '.';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || '';
      if (key.startsWith('ramagan.v1.pending.v2.') && !key.endsWith('.completed') &&
          !key.startsWith(endpointPrefix)) return true;
      if (key.startsWith('ramagan.v1.pending.') && !key.startsWith('ramagan.v1.pending.v2.')) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function endpointHealthError(result) {
  if (result.error) return 'Could not reach the RAMAGAN API: ' + result.error.message;
  if (result.data?.status !== 'ok') return 'The server health check did not return status ok.';
  if (result.data?.version !== REQUIRED_API_VERSION) {
    return 'Incompatible server version. Expected ' + REQUIRED_API_VERSION +
      ' but received ' + String(result.data?.version || 'no version') + '.';
  }
  return '';
}

async function probeCurrentEndpoint() {
  if (!api) return;
  const wasReady = connectionReady;
  connectionChecking = true;
  setupError = '';
  render();
  const result = await api.health();
  connectionChecking = false;
  const problem = endpointHealthError(result);
  if (problem) {
    connectionReady = false;
    setupError = problem;
    return render();
  }
  connectionReady = true;
  setupError = '';
  if (!wasReady) {
    if (endpointNotice) state.message = endpointNotice;
    await startSession();
  } else render();
}

async function applyEndpoint(raw) {
  endpointInput = String(raw || '').trim();
  const endpoint = validateServerUrl(raw);
  if (!endpoint) {
    setupError = 'Enter a valid HTTPS URL without credentials, query parameters, or a fragment.';
    return render();
  }
  if (endpoint !== apiUrl && (state.pendingId || state.pendingBlocked || state.busy ||
      hasPendingCheckoutForDifferentEndpoint(endpoint))) {
    setupError = 'Endpoint change blocked because an unfinished checkout is stored. Resolve it on its original server first.';
    return render();
  }
  const wasReady = connectionReady;
  const candidate = endpoint === apiUrl && api ? api : createClient(endpoint);
  connectionChecking = true;
  setupError = '';
  render();
  const result = await candidate.health();
  connectionChecking = false;
  const problem = endpointHealthError(result);
  if (problem) {
    if (endpoint === apiUrl) connectionReady = false;
    setupError = problem;
    return render();
  }
  if (endpoint === apiUrl) {
    api = candidate;
    endpointInput = endpoint;
    configured = true;
    connectionReady = true;
    try {
      localStorage.setItem(ENDPOINT_STORAGE, endpoint);
      setupError = '';
    } catch {
      setupError = 'The server is active for this session, but the selected address could not be saved.';
      state.message = setupError;
      state.error = true;
    }
    if (!wasReady) await startSession();
    else render();
    return;
  }

  if (authSubscription?.unsubscribe) authSubscription.unsubscribe();
  if (api) await api.auth.signOut();
  apiUrl = endpoint;
  endpointInput = endpoint;
  api = candidate;
  configured = true;
  connectionReady = true;
  state.user = null;
  state.store = null;
  state.role = null;
  state.capabilities = null;
  state.products = [];
  state.lots = [];
  state.cart.clear();
  state.lastSale = null;
  state.pendingId = null;
  state.checkout = null;
  state.pendingBlocked = false;
  state.view = 'sales';
  state.message = '';
  state.error = false;
  try {
    localStorage.setItem(ENDPOINT_STORAGE, endpoint);
    setupError = '';
  } catch {
    setupError = 'The server is active for this session, but the selected address could not be saved.';
    state.message = setupError;
    state.error = true;
  }
  await startSession();
}

function openSettings() {
  if (state.busy) return setMessage('Wait for the current operation to finish before opening settings.', true);
  state.settingsReturnView = state.view;
  state.view = 'settings';
  setupError = '';
  render();
}

async function startSession() {
  if (authSubscription?.unsubscribe) authSubscription.unsubscribe();
  const subscription = api.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.store = null;
      state.role = null;
      render();
    }
  });
  authSubscription = subscription?.data?.subscription || null;
  const {data, error} = await api.auth.getUser();
  if (!error && data?.user) await loadProfile(data.user);
  else render();
}
function canManage() {
  return state.role === 'owner' || state.role === 'manager';
}
function renderLogin() {
  root.innerHTML = [
    '<main class="login-wrap"><section class="login-card">',
    '<div class="brand">R<span>●</span> RAMAGAN</div>',
    '<div class="muted">ศูนย์กลางร้าน · Web / Android</div>',
    '<h1>เข้าสู่ระบบพนักงาน</h1>',
    '<p class="muted">ใช้บัญชีที่ได้รับอนุญาตจากเจ้าของร้าน</p>',
    '<form id="login-form">',
    '<label>อีเมล <input name="email" type="email" autocomplete="username" required /></label>',
    '<label>รหัสผ่าน <input name="password" type="password" autocomplete="current-password" required /></label>',
    '<button class="primary" type="submit" ', state.busy ? 'disabled' : '', '>เข้าสู่ระบบ</button>',
    '</form>',
    '<button class="ghost" id="signup" type="button">วิธีขอบัญชีพนักงาน</button>',
    '<button class="ghost" id="open-settings" type="button">Settings</button>',
    '<p class="footnote">บัญชีพนักงานสร้างโดยเจ้าของร้านผ่านเครื่อง VPS เท่านั้น</p>',
    state.message ? '<p class="alert ' + (state.error ? 'danger' : '') + '">' + h(state.message) + '</p>' : '',
    '<p class="footnote">ข้อมูลขายจะถูกบันทึกในฐานข้อมูลกลางเท่านั้น</p>',
    '</section></main>'
  ].join('');
  root.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const form = new FormData(event.currentTarget);
    state.busy = true;
    const { data, error } = await api.auth.signInWithPassword({
      email: String(form.get('email')), password: String(form.get('password'))
    });
    state.busy = false;
    if (error) return setMessage('เข้าสู่ระบบไม่สำเร็จ: ' + error.message, true);
    await loadProfile(data.user);
  });
  root.querySelector('#signup').addEventListener('click', () => {
    setMessage('ให้เจ้าของร้านเพิ่มบัญชีผ่านคำสั่ง VPS: python admin.py add-user', false);
  });
  root.querySelector('#open-settings').addEventListener('click', openSettings);
}
function cartItems() {
  return [...state.cart.entries()].map(([lot_id, quantity_mg]) => ({ lot_id, quantity_mg }))
    .sort((a, b) => a.lot_id.localeCompare(b.lot_id));
}
function cartTotal() {
  return sumSatang(cartItems().map((item) => {
    const lot = state.lots.find((l) => l.id === item.lot_id);
    if (!lot) throw new Error('ข้อมูล Lot ในรายการค้างไม่ครบ กรุณาตรวจสอบกับเซิร์ฟเวอร์');
    return lineTotalSatang(lot.price, item.quantity_mg);
  }));
}
function renderDashboard() {
  const live = Boolean(state.store.sales_enabled);
  const totals = preview();
  const today = toBangkokDay(new Date());
  const cards = state.lots.map((lot) => {
    const expired = Boolean(lot.expires_on && lot.expires_on < today);
    const available = lot.quantity_mg > 0 && !expired;
    return [
      '<article class="product">',
      '<div><div class="sku">', h(lot.sku), ' · ', h(lot.lot_code), '</div>',
      '<h3>', h(lot.name), '</h3>',
      '<div class="price">', h(formatBaht(lot.price)), ' / กรัม</div>',
      '<div class="muted">คงเหลือ ', h(milligramsToGrams(lot.quantity_mg)), ' กรัม',
      expired ? ' · <span class="danger-text">หมดอายุ</span>' : '', '</div></div>',
      '<div class="product-actions">',
      '<input aria-label="จำนวนกรัม" inputmode="decimal" type="text" value="1" data-qty="', h(lot.id), '" />',
      '<button data-add="', h(lot.id), '" ', available && !state.busy && !state.pendingId ? '' : 'disabled', '>เพิ่ม</button>',
      '</div></article>'
    ].join('');
  }).join('') || '<p class="empty">ยังไม่มี Lot พร้อมขายในร้านนี้</p>';

  const rows = cartItems().map((item) => {
    const lot = state.lots.find((l) => l.id === item.lot_id);
    if (!lot) return '';
    return [
      '<div class="cart-row"><div><strong>', h(lot.name), '</strong>',
      '<small>', h(milligramsToGrams(item.quantity_mg)), ' กรัม × ',
      h(formatBaht(lot.price)), '</small></div>',
      '<div class="row-right"><strong>', h(formatBaht(lineTotalSatang(lot.price, item.quantity_mg))), '</strong>',
      '<button class="remove" data-remove="', h(item.lot_id), '" aria-label="ลบสินค้า" ', (state.busy || state.pendingId) ? 'disabled' : '', '>×</button></div></div>'
    ].join('');
  }).join('') || '<p class="empty">ยังไม่ได้เลือกสินค้า</p>';

  root.innerHTML = [
    '<header class="topbar"><div class="brand">R<span>●</span> RAMAGAN <small>V1</small></div>',
    '<div class="top-actions">', statusChip(),
    '<button id="open-settings" class="ghost" type="button">Settings</button>',
    '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="layout"><section class="main-panel">',
    '<div class="view-links"><strong>หน้าขาย</strong>',
    canManage() ? '<button id="open-inventory" class="ghost" type="button">จัดการสินค้า / รับเข้า</button>' : '',
    canManage() ? '<a class="ghost admin-link" href="' + ADMIN_REPORT_URL + '" target="_blank" rel="noopener noreferrer">รายงานหลังบ้าน ↗</a>' : '',
    '</div>',
    '<div class="heading"><div><div class="eyebrow">หน้าร้าน / SALES</div><h1>ขายสินค้า</h1>',
    '<p class="muted">', h(state.store.name), ' · ', h(state.role), '</p></div>',
    '<button id="refresh" class="ghost">รีเฟรชสต็อก</button></div>',
    !live ? '<div class="alert danger">ร้านยังไม่เปิดใช้งานระบบขายจริง ต้องผ่านการทดสอบและอนุมัติเงื่อนไขร้านก่อน</div>' : '',
    !navigator.onLine ? '<div class="alert danger">ออฟไลน์: ยืนยันการขายไม่ได้ ข้อมูลสต็อกอาจไม่ล่าสุด</div>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') + '">' + h(state.message) + '</div>' : '',
    state.lastSale ? '<div class="alert success">รายการล่าสุด ' + h(state.lastSale.sale_id) +
      ' · ยอดก่อนลด ' + h(formatBaht(state.lastSale.subtotal_satang)) +
      ' · ส่วนลด ' + h(formatBaht(state.lastSale.discount_satang)) + ' · สุทธิยืนยันจากเซิร์ฟเวอร์ ' + h(formatBaht(state.lastSale.total_satang)) +
      (state.lastSale.legacy_zero ? ' (เซิร์ฟเวอร์รุ่นเดิม: ไม่มีส่วนลด)' : '') + '</div>' : '',
    '<div class="section-title"><h2>สินค้าในสต็อก</h2><span class="muted">', state.lots.length, ' Lot</span></div>',
    '<div class="products">', cards, '</div></section>',
    '<aside class="cart-panel"><div class="section-title"><h2>ตะกร้าขาย</h2>',
    '<span>', cartItems().length, ' รายการ</span></div>',
    '<div class="cart-items">', rows, '</div>',
    '<label>ส่วนลดทั้งบิล (บาท) <input id="discount" type="text" inputmode="decimal" value="', h(state.discount), '" ', (state.busy || state.pendingId || !supportsDiscount(state.capabilities)) ? 'disabled' : '', ' /></label>',
    !supportsDiscount(state.capabilities) ? '<p class="footnote">เซิร์ฟเวอร์ยังไม่ประกาศรองรับส่วนลด ใช้ได้เฉพาะส่วนลด 0 บาท</p>' : '',
    '<div id="preview">', previewHtml(totals), '</div>',
    '<p class="footnote">ยอดนี้เป็นประมาณการ ราคาบนเซิร์ฟเวอร์อาจเปลี่ยน ยอดสุดท้ายใช้ค่าที่เซิร์ฟเวอร์ยืนยันเท่านั้น</p>',
    '<label>การชำระเงิน <select id="payment" ', (state.busy || state.pendingId) ? 'disabled' : '', '>',
    '<option value="cash" ', state.payment === 'cash' ? 'selected' : '', '>เงินสด</option>',
    '<option value="transfer" ', state.payment === 'transfer' ? 'selected' : '', '>โอนเงิน</option></select></label>',
    '<label>รหัสอ้างอิงเอกสารที่ได้รับอนุญาต',
    '<input id="auth-ref" maxlength="120" value="', h(state.authRef), '" placeholder="รหัสเอกสาร (ไม่ใส่ชื่อผู้ป่วย)" ', (state.busy || state.pendingId) ? 'disabled' : '', ' /></label>',
    '<p class="footnote">การกรอกรหัสเอกสารไม่ใช่การตรวจสอบความถูกต้องของเอกสาร ต้องตรวจตามกระบวนการร้านที่ได้รับอนุญาต</p>',
    state.pendingId ? '<div class="alert danger">มีรายการส่งขายที่ยังไม่ทราบผล ห้ามสร้างรายการใหม่จนกว่าจะตรวจสอบ' + (state.pendingBlocked ? '' : '<br />เลขอ้างอิง: ' + h(state.pendingId)) + '</div>' : '',
    '<div class="checkout-actions">',
    '<button id="checkout" class="primary" ', (!live || !navigator.onLine || state.busy ||
      state.pendingId || !state.cart.size || totals.error) ? 'disabled' : '', '>ยืนยันรายการผ่านเซิร์ฟเวอร์</button>',
    state.pendingId && !state.pendingBlocked ? '<button id="verify" class="ghost" ' + (state.busy ? 'disabled' : '') + '>ตรวจสอบรายการค้าง</button>' : '',
    state.pendingId && !state.pendingBlocked ? '<button id="retry" class="ghost" ' + (state.busy ? 'disabled' : '') + '>ส่งรายการเดิมซ้ำด้วย ID เดิม</button>' : '',
    '</div>',
    '<p class="footnote">ระบบจะถือว่าขายสำเร็จหลังเซิร์ฟเวอร์ยืนยันเท่านั้น</p>',
    '</aside></main>'
  ].join('');

  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#open-settings')?.addEventListener('click', openSettings);
  root.querySelector('#open-inventory')?.addEventListener('click', () => {
    state.view = 'inventory';
    state.message = '';
    render();
  });
  root.querySelector('#refresh').addEventListener('click', refreshLots);
  root.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.busy || state.pendingId) return;
      try {
        const id = button.dataset.add;
        const input = root.querySelector('[data-qty="' + CSS.escape(id) + '"]');
        const quantity = gramsToMilligrams(input.value);
        const lot = state.lots.find((l) => l.id === id);
        const next = (state.cart.get(id) || 0) + quantity;
        if (!lot || next > lot.quantity_mg) throw new Error('จำนวนมากกว่าสต็อกที่แสดง กรุณารีเฟรช');
        state.cart.set(id, next);
        state.message = '';
        render();
      } catch (e) { setMessage(e.message, true); }
    });
  });
  root.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.busy || state.pendingId) return;
      state.cart.delete(button.dataset.remove);
      render();
    });
  });
  root.querySelector('#payment').addEventListener('change', (event) => {
    if (!state.busy && !state.pendingId) state.payment = event.target.value;
  });
  root.querySelector('#auth-ref').addEventListener('input', (event) => {
    if (!state.busy && !state.pendingId) state.authRef = event.target.value;
  });
  root.querySelector('#discount').addEventListener('input', event => {
    if (state.busy || state.pendingId) return;
    state.discount = event.target.value;
    const totals = preview();
    root.querySelector('#preview').innerHTML = previewHtml(totals);
    root.querySelector('#checkout').disabled = !live || !navigator.onLine || !state.cart.size || Boolean(totals.error);
  });
  root.querySelector('#checkout').addEventListener('click', startCheckout);
  root.querySelector('#verify')?.addEventListener('click', verifyPending);
  root.querySelector('#retry')?.addEventListener('click', () => runCheckout('retry'));
}
function previewHtml(totals) {
  if (totals.error) return '<p class="alert danger">' + h(totals.error) + '</p>';
  return '<div class="cart-total"><span>ยอดก่อนลด (ประมาณ)</span><strong>' + h(formatBaht(totals.subtotal)) +
    '</strong></div><div class="cart-total"><span>ส่วนลด</span><strong>' + h(formatBaht(totals.discount)) +
    '</strong></div><div class="cart-total"><span>สุทธิ (ประมาณ)</span><strong>' + h(formatBaht(totals.total)) + '</strong></div>';
}
function renderInventory() {
  const options = state.products.filter((p) => p.active).map((p) =>
    '<option value="' + h(p.id) + '">' + h(p.sku) + ' — ' +
    h(p.name) + '</option>').join('');
  const rows = state.lots.map((lot) =>
    '<tr><td>' + h(lot.name) + '</td><td>' + h(lot.lot_code) +
    '</td><td>' + h(milligramsToGrams(lot.quantity_mg)) +
    ' กรัม</td></tr>').join('') || '<tr><td colspan="3">ไม่มีสินค้า</td></tr>';
  root.innerHTML = [
    '<header class="topbar"><div class="brand">R<span>●</span> RAMAGAN <small>V1</small></div>',
    '<div class="top-actions">', statusChip(),
    '<button id="open-settings" class="ghost" type="button">Settings</button>',
    '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="manager-layout"><div class="view-links">',
    '<button id="open-sales" class="ghost">หน้าขาย</button><strong>จัดการสต็อก</strong>',
    '<a class="ghost admin-link" href="' + ADMIN_REPORT_URL + '" target="_blank" rel="noopener noreferrer">รายงานหลังบ้าน ↗</a></div>',
    '<div class="heading"><div><div class="eyebrow">INVENTORY</div><h1>รับเข้าและตั้งค่าสินค้า</h1>',
    '<p class="muted">', h(state.store.name), ' · ', h(state.role),
    ' · การรับของทุกครั้งมีประวัติผู้บันทึก</p></div>',
    '<button id="refresh" class="ghost">รีเฟรช</button></div>',
    !navigator.onLine ? '<p class="alert danger">ออฟไลน์: ไม่สามารถสร้าง/รับสินค้าได้</p>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') +
    '">' + h(state.message) + '</div>' : '',
    '<div class="admin-grid"><section class="main-panel">',
    '<h2>1 · เพิ่มสินค้าใหม่</h2><form id="new-product">',
    '<label>SKU <input name="sku" maxlength="60" required placeholder="เช่น SKU-01" /></label>',
    '<label>ชื่อสินค้า <input name="name" maxlength="200" required /></label>',
    '<label>หมวดสินค้า <input name="category" maxlength="60" required value="other" /></label>',
    '<label>ราคาต่อกรัม (บาท) <input name="price" inputmode="decimal" required placeholder="100.00" /></label>',
    '<button class="primary" ', state.busy || !navigator.onLine ? 'disabled' : '',
    '>บันทึกสินค้า</button></form></section>',
    '<section class="main-panel"><h2>2 · รับสินค้าเข้า Lot</h2>',
    '<form id="receive-lot"><label>สินค้า <select name="product_id" required>',
    options || '<option value="">ยังไม่มีสินค้า</option>', '</select></label>',
    '<label>รหัส Lot (ห้ามซ้ำ) <input name="lot_code" maxlength="100" required /></label>',
    '<label>ผู้ส่งมอบ <input name="supplier_name" maxlength="200" required /></label>',
    '<label>เลขที่เอกสารผู้ส่งมอบ <input name="supplier_document_ref" maxlength="200" required /></label>',
    '<label>จำนวนรับเข้า (กรัม) <input name="qty" inputmode="decimal" required placeholder="30.000" /></label>',
    '<label>วันหมดอายุ (ถ้ามี) <input name="expires" type="date" /></label>',
    '<label>เหตุผลการรับสินค้า <input name="reason" maxlength="500" required value="รับสินค้าตามเอกสาร" /></label>',
    '<button class="primary" ', state.busy || !navigator.onLine || !options ? 'disabled' : '',
    '>ยืนยันการรับเข้าผ่านเซิร์ฟเวอร์</button></form></section></div>',
    '<section class="main-panel inventory-table"><h2>สต็อกปัจจุบัน</h2>',
    '<table><thead><tr><th>สินค้า</th><th>Lot</th><th>คงเหลือ</th></tr></thead>',
    '<tbody>', rows, '</tbody></table></section>',
    '<p class="footnote">จำนวนในตารางอาจเปลี่ยนจากการขายบนอุปกรณ์อื่น',
    ' — เซิร์ฟเวอร์เป็นผู้ยืนยันยอดจริงทุกครั้ง</p>',
    '</main>'
  ].join('');
  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#open-settings')?.addEventListener('click', openSettings);
  root.querySelector('#refresh').addEventListener('click', refreshLots);
  root.querySelector('#open-sales').addEventListener('click', () => {
    state.view = 'sales';
    state.message = '';
    render();
  });
  root.querySelector('#new-product').addEventListener('submit', createProduct);
  root.querySelector('#receive-lot').addEventListener('submit', receiveLot);
}
async function createProduct(event) {
  event.preventDefault();
  if (!canManage() || state.busy || !navigator.onLine) return;
  const form = new FormData(event.currentTarget);
  let price;
  try { price = bahtToSatang(form.get('price')); }
  catch (e) { return setMessage(e.message, true); }
  state.busy = true;
  render();
  const { error } = await api.rpc('ramagan_create_product', {
    p_store_id: state.store.id,
    p_sku: String(form.get('sku')).trim(),
    p_name: String(form.get('name')).trim(),
    p_category: String(form.get('category')).trim(),
    p_price_satang_per_gram: price
  });
  state.busy = false;
  if (error) return setMessage('สร้างสินค้าไม่สำเร็จ: ' + error.message, true);
  await refreshLots();
  setMessage('บันทึกสินค้าในฐานข้อมูลกลางแล้ว');
}
async function receiveLot(event) {
  event.preventDefault();
  if (!canManage() || state.busy || !navigator.onLine) return;
  const form = new FormData(event.currentTarget);
  let qty;
  try { qty = gramsToMilligrams(form.get('qty')); }
  catch (e) { return setMessage(e.message, true); }
  state.busy = true;
  render();
  const { error } = await api.rpc('ramagan_receive_lot', {
    p_store_id: state.store.id,
    p_product_id: String(form.get('product_id')),
    p_lot_code: String(form.get('lot_code')).trim(),
    p_supplier_name: String(form.get('supplier_name')).trim(),
    p_supplier_document_ref: String(form.get('supplier_document_ref')).trim(),
    p_quantity_mg: qty,
    p_expires_on: form.get('expires') || null,
    p_reason: String(form.get('reason')).trim()
  });
  state.busy = false;
  if (error) return setMessage('รับสินค้าไม่สำเร็จ: ' + error.message, true);
  await refreshLots();
  setMessage('บันทึก Lot พร้อมรายการรับเข้าฐานข้อมูลกลางแล้ว');
}

async function loadProfile(user) {
  state.user = user;
  state.message = 'กำลังตรวจสิทธิ์ร้าน';
  const { data, error } = await api.from('ramagan_members')
    .select('store_id, role, ramagan_stores(name, sales_enabled, requires_authorization)')
    .eq('user_id', user.id).eq('is_active', true).limit(1);
  if (error || !data?.length || !data[0].ramagan_stores) {
    state.store = null;
    state.message = error ? error.message : 'ไม่พบบัญชีพนักงานที่เปิดใช้งาน';
    return render();
  }
  state.store = { id: data[0].store_id, ...data[0].ramagan_stores };
  state.role = data[0].role;
  state.capabilities = data[0].capabilities;
  state.cart.clear();
  state.discount = '0';
  state.authRef = '';
  state.payment = 'cash';
  state.checkout = createCheckout({storage: localStorage,
    identity: {api: api.base, store: state.store.id, cashier: user.id},
    transport: api.checkoutTransport, uuid: () => crypto.randomUUID(),
    lock: navigator.locks ? (key, task) => navigator.locks.request(key, {ifAvailable: true}, lock => {
      if (!lock) throw new Error('รายการนี้กำลังตรวจสอบในอีกหน้าต่าง กรุณารอสักครู่');
      return task();
    }) : null
  });
  state.message = '';
  restorePending();
  await refreshLots();
}
async function refreshLots() {
  if (!state.store) return;
  if (!navigator.onLine) return setMessage('ออฟไลน์: ไม่สามารถตรวจสอบสต็อกล่าสุดได้', true);
  const [lotsResult, productsResult] = await Promise.all([
    api.from('ramagan_lots')
      .select('id, lot_code, expires_on, active, ramagan_products!inner(name,sku,price_satang_per_gram,active), ramagan_lot_balances(quantity_mg)')
      .eq('store_id', state.store.id).eq('active', true),
    api.from('ramagan_products')
      .select('id,sku,name,category,price_satang_per_gram,active')
      .eq('store_id', state.store.id).order('name')
  ]);
  const { data, error } = lotsResult;
  if (productsResult.error) return setMessage('อ่านรายการสินค้าไม่สำเร็จ: ' +
    productsResult.error.message, true);
  state.products = productsResult.data || [];
  if (error) return setMessage('โหลดสต็อกไม่สำเร็จ: ' + error.message, true);
  state.lots = (data || []).filter((row) => row.ramagan_products?.active).map((row) => {
    const balance = row.ramagan_lot_balances;
    const quantity = Array.isArray(balance) ? balance[0]?.quantity_mg : balance?.quantity_mg;
    return {
      id: row.id, lot_code: row.lot_code, expires_on: row.expires_on,
      sku: row.ramagan_products.sku, name: row.ramagan_products.name,
      price: Number(row.ramagan_products.price_satang_per_gram),
      quantity_mg: Number(quantity || 0)
    };
  });
  if (!state.pendingBlocked) state.message = '';
  render();
  return true;
}
async function startCheckout() {
  if (state.pendingId || state.busy || !state.cart.size) return;
  if (!state.store.sales_enabled || !navigator.onLine) {
    return setMessage('ไม่สามารถยืนยันการขายในสถานะนี้', true);
  }
  if (state.store.requires_authorization && !state.authRef.trim()) {
    return setMessage('ต้องระบุรหัสเอกสารที่ได้รับอนุญาต และตรวจสอบเอกสารจริงก่อน', true);
  }
  const totals = preview();
  if (totals.error) return setMessage(totals.error, true);
  await runCheckout('start', {items: cartItems(), payment_method: state.payment,
    authorization_ref: state.authRef.trim() || null, discount_satang: totals.discount}, totals.subtotal);
}
async function runCheckout(action, payload, subtotal) {
  if (state.busy || state.pendingBlocked || !navigator.onLine || !state.checkout) return;
  state.busy = true;
  render();
  try {
    const result = await state.checkout[action](payload, subtotal);
    restorePending();
    if (result?.sale) {
      state.lastSale = result.sale;
      // Clear the cart before any fallible refresh, never re-submit a completed bill.
      state.cart.clear();
      state.authRef = '';
      state.discount = '0';
      await state.checkout.acknowledge();
      state.pendingId = null;
      const fresh = await refreshLots();
      const changed = result.sale.subtotal_satang !== result.op.preview_subtotal_satang;
      state.message = 'เซิร์ฟเวอร์ยืนยันรายการแล้ว ไม่ตัดสต็อกซ้ำ' +
        (changed ? ' · ราคาปัจจุบันต่างจากประมาณการ ใช้ยอดยืนยันที่แสดง' : '') +
        (!fresh ? ' · รีเฟรชสต็อกไม่สำเร็จ กรุณารีเฟรชก่อนขายครั้งถัดไป' : '');
      state.error = !fresh;
    } else {
      state.message = 'ยังไม่ทราบผลรายการ เก็บเลขอ้างอิงเดิมไว้ ตรวจสอบหรือส่งรายการเดิมซ้ำเท่านั้น' +
        (result?.error ? ': ' + result.error.message : '');
      state.error = true;
    }
  } catch (error) {
    restorePending();
    state.message = error.message;
    state.error = true;
  } finally { state.busy = false; render(); }
}
async function verifyPending() { await runCheckout('verify'); }
async function logout() {
  if (state.busy) return;
  await api.auth.signOut();
  state.user = null;
  state.store = null;
  state.role = null;
  state.cart.clear();
  state.lots = [];
  state.products = [];
  state.view = 'sales';
  state.message = '';
  state.lastSale = null;
  state.pendingId = null;
  state.checkout = null;
  state.pendingBlocked = false;
  state.discount = '0';
  render();
}
window.addEventListener('storage', event => {
  if (state.checkout && (event.key?.startsWith(state.checkout.key) || event.key === null)) {
    const hadPending = state.pendingId;
    const op = restorePending();
    if (!op && (hadPending || event.key?.endsWith('.completed'))) {
      state.cart.clear(); state.discount = '0'; state.authRef = '';
    }
    render();
  }
});
window.addEventListener('online', () => {
  if (state.store) refreshLots();
  else render();
});
window.addEventListener('offline', render);
if (api) {
  render();
  probeCurrentEndpoint();
} else render();

if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
