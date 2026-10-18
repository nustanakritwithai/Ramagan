import { createClient, validateServerUrl } from './backend-api.js';
import { gramsToMilligrams, milligramsToGrams, lineTotalSatang, formatBaht, bahtToSatang, discountSatang, sumSatang } from './math.js';
import {createCheckout, supportsDiscount} from './checkout.js';
import {createInventoryOperation, supportsCosts, supportsStocktakes, optionalCost,
  countedMilligrams, receivedMilligrams, signedGrams, optionalDocuments,
  assertNoPendingMutation, mutationScopeKey} from './inventory.js';
import './style.css';

const root = document.getElementById('app');
// A user can configure HTTPS endpoint directly in their Android app.
// A change of VPS/domain does not require rebuilding the APK.
const ADMIN_REPORT_URL = 'https://nustanakritwithai.github.io/Ramagan/admin/';
const ENDPOINT_STORAGE = 'ramagan.v1.server.url';
let savedEndpoint = '';
try { savedEndpoint = localStorage.getItem(ENDPOINT_STORAGE) || ''; } catch { /* checkout will fail closed if storage is unavailable */ }
let apiUrl = validateServerUrl(savedEndpoint || import.meta.env.VITE_RAMAGAN_API_URL || '');
let configured = Boolean(apiUrl);
let api = configured ? createClient(apiUrl) : null;
let setupError = '';

const state = {
  user: null, store: null, role: null, lots: [], cart: new Map(),
  payment: 'cash', authRef: '', busy: false, message: '', error: false,
  pendingId: null, checkout: null, pendingBlocked: false, capabilities: null, discount: '0', lastSale: null, products: [], view: 'sales',
  inventory: null, inventoryError: '', stocktakes: [], stocktakeError: '',
  stocktake: null, receive: null, inventoryPending: {}, inventoryBlocked: false,
  counts: new Map(), shiftLabel: 'กะเช้า', countReason: '', countConfirmed: false, inventoryLoad: 0,
  historyDetail: null, historyError: '', historyRequest: 0
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
  if (!configured) return renderSetup();
  if (!state.user) return renderLogin();
  if (!state.store) {
    root.innerHTML = '<div class="setup"><h1>RAMAGAN POS</h1><p>' +
      h(state.message || 'บัญชีนี้ยังไม่ได้รับสิทธิ์ในร้าน กรุณาให้เจ้าของร้านเพิ่มสมาชิก') +
      '</p><button id="logout">ออกจากระบบ</button></div>';
    root.querySelector('#logout').addEventListener('click', logout);
    return;
  }
  if (state.view === 'inventory' && canManage()) return renderInventory();
  if (state.view === 'stocktake' && canManage()) return renderStocktake();
  renderDashboard();
}
function renderSetup() {
  root.innerHTML = [
    '<main class="login-wrap"><section class="login-card">',
    '<div class="brand">R<span>●</span> RAMAGAN</div>',
    '<div class="muted">ระบบหน้าร้าน · เว็บไซต์ + Android</div>',
    '<h1>เชื่อมต่อเซิร์ฟเวอร์ร้าน</h1>',
    '<p class="muted">ใช้ URL HTTPS ของ Ramagan API บน VPS ที่ผู้ดูแลร้านตั้งค่าไว้</p>',
    '<form id="server-form"><label>ที่อยู่เซิร์ฟเวอร์ HTTPS',
    '<input name="server" type="url" required autocomplete="url" ',
    'placeholder="https://your-domain.com/ramagan-api" value="',
    h(apiUrl || ''), '" /></label>',
    '<button type="submit" class="primary">ตรวจสอบและเชื่อมต่อ</button></form>',
    setupError ? '<p class="alert danger">' + h(setupError) + '</p>' : '',
    '<p class="footnote">ไม่จำเป็นต้องมี Supabase และไม่ต้องใส่ API secret',
    ' · เซิร์ฟเวอร์ของร้านจะเก็บข้อมูลสินค้าและบัญชีพนักงาน</p>',
    '<p class="footnote">ก่อนใช้งานจริงต้องเปิด HTTPS, ตั้งบัญชี Owner และทดสอบระบบบน VPS</p>',
    '</section></main>'
  ].join('');
  root.querySelector('#server-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = root.querySelector('#server-form button');
    const endpoint = validateServerUrl(event.currentTarget.elements.server.value);
    if (!endpoint) {
      setupError = 'กรุณาระบุ URL HTTPS ที่ถูกต้อง ไม่มีช่องว่างหรืออักขระแฝง ลบแล้วพิมพ์ URL ใหม่ (HTTP ใช้ได้เฉพาะ localhost สำหรับทดสอบ)';
      return renderSetup();
    }
    button.disabled = true;
    setupError = '';
    const candidate = createClient(endpoint);
    const result = await candidate.health();
    button.disabled = false;
    if (result.error || result.data?.status !== 'ok') {
      setupError = 'ยังติดต่อ Ramagan API ไม่ได้: ' +
        (result.error?.message || 'ปลายทางไม่ใช่ Ramagan API');
      return renderSetup();
    }
    apiUrl = endpoint;
    configured = true;
    api = candidate;
    localStorage.setItem(ENDPOINT_STORAGE, endpoint);
    await startSession();
  });
}

async function changeServer() {
  if (state.pendingId || hasInventoryPending() || state.busy) {
    return setMessage('ต้องตรวจสอบรายการขายหรือสต็อกค้างก่อนเปลี่ยนเซิร์ฟเวอร์', true);
  }
  if (api) await api.auth.signOut();
  localStorage.removeItem(ENDPOINT_STORAGE);
  apiUrl = null;
  api = null;
  configured = false;
  state.user = null;
  state.store = null;
  state.role = null;
  state.products = [];
  state.lots = [];
  state.cart.clear();
  state.lastSale = null;
  resetInventoryState();
  setupError = '';
  render();
}

async function startSession() {
  api.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.store = null;
      state.role = null;
      render();
    }
  });
  const {data, error} = await api.auth.getUser();
  if (!error && data?.user) await loadProfile(data.user);
  else render();
}

function canManage() {
  return state.role === 'owner' || state.role === 'manager';
}
function hasInventoryPending() {
  return state.inventoryBlocked || Object.values(state.inventoryPending).some(Boolean);
}
function hasPendingMutation() {
  return state.pendingBlocked || Boolean(state.pendingId) || hasInventoryPending();
}
async function withNewMutation(task) {
  if (state.busy) return;
  try {
    if (!navigator.locks) throw new Error('เบราว์เซอร์นี้ไม่รองรับการล็อกรายการอย่างปลอดภัย');
    const identity = {api: api.base, store: state.store.id, actor: state.user.id};
    return await navigator.locks.request(mutationScopeKey(identity), {ifAvailable: true}, async current => {
      if (!current) throw new Error('มีรายการกำลังทำงานในอีกหน้าต่าง กรุณารอสักครู่');
      restorePending(); restoreInventoryPending();
      assertNoPendingMutation(localStorage, identity);
      if (hasPendingMutation()) throw new Error('มีรายการค้าง ต้องตรวจสอบรายการเดิมก่อน');
      return task();
    });
  } catch (error) { setMessage(error.message, true); }
}
function resetInventoryState() {
  state.inventoryLoad++;
  state.inventory = null; state.inventoryError = ''; state.stocktakes = [];
  state.stocktakeError = ''; state.stocktake = null; state.receive = null;
  state.inventoryPending = {}; state.inventoryBlocked = false;
  state.counts.clear(); state.countConfirmed = false; state.countReason = '';
  state.shiftLabel = 'กะเช้า';
  state.historyDetail = null; state.historyError = ''; state.historyRequest++;
}
function restoreInventoryPending() {
  state.inventoryBlocked = false;
  for (const kind of ['stocktake', 'receive']) {
    try { state.inventoryPending[kind] = state[kind]?.read() || null; }
    catch (error) { state.inventoryBlocked = true; state.message = error.message; state.error = true; }
  }
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
    '<button class="ghost" id="server-change" type="button">เปลี่ยนเซิร์ฟเวอร์</button>',
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
  root.querySelector('#server-change').addEventListener('click', changeServer);
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
    '<button id="change-server" class="ghost">เซิร์ฟเวอร์</button>',
    '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="layout"><section class="main-panel">',
    '<div class="view-links"><strong>หน้าขาย</strong>',
    canManage() ? '<button id="open-inventory" class="ghost" type="button">จัดการสินค้า / รับเข้า</button>' : '',
    canManage() ? '<button id="open-stocktake" class="ghost" type="button">นับสต็อกก่อนเข้ากะ</button>' : '',
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
    '<label>รหัสอ้างอิงเอกสารที่ได้รับอนุญาต', state.store.requires_authorization ? '' : ' (ถ้ามี)',
    '<input id="auth-ref" maxlength="120" value="', h(state.authRef), '" placeholder="รหัสเอกสาร (ไม่ใส่ชื่อผู้ป่วย)" ', (state.busy || state.pendingId) ? 'disabled' : '', ' /></label>',
    '<p class="footnote">การกรอกรหัสเอกสารไม่ใช่การตรวจสอบความถูกต้องของเอกสาร ต้องตรวจตามกระบวนการร้านที่ได้รับอนุญาต</p>',
    state.pendingId ? '<div class="alert danger">มีรายการส่งขายที่ยังไม่ทราบผล ห้ามสร้างรายการใหม่จนกว่าจะตรวจสอบ' + (state.pendingBlocked ? '' : '<br />เลขอ้างอิง: ' + h(state.pendingId)) + '</div>' : '',
    '<div class="checkout-actions">',
    '<button id="checkout" class="primary" ', (!live || !navigator.onLine || state.busy ||
      hasPendingMutation() || !state.cart.size || totals.error) ? 'disabled' : '', '>ยืนยันรายการผ่านเซิร์ฟเวอร์</button>',
    hasInventoryPending() ? '<p class="alert danger">มีรายการสต็อกค้าง ให้เปิดจัดการสินค้า / นับสต็อกเพื่อตรวจสอบก่อนขาย</p>' : '',
    state.pendingId && !state.pendingBlocked ? '<button id="verify" class="ghost" ' + (state.busy ? 'disabled' : '') + '>ตรวจสอบรายการค้าง</button>' : '',
    state.pendingId && !state.pendingBlocked ? '<button id="retry" class="ghost" ' + (state.busy ? 'disabled' : '') + '>ส่งรายการเดิมซ้ำด้วย ID เดิม</button>' : '',
    '</div>',
    '<p class="footnote">ระบบจะถือว่าขายสำเร็จหลังเซิร์ฟเวอร์ยืนยันเท่านั้น</p>',
    '</aside></main>'
  ].join('');

  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#change-server')?.addEventListener('click', changeServer);
  root.querySelector('#open-inventory')?.addEventListener('click', () => {
    state.view = 'inventory';
    state.message = '';
    render();
  });
  root.querySelector('#open-stocktake')?.addEventListener('click', () => { state.view = 'stocktake'; render(); });
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
    root.querySelector('#checkout').disabled = !live || !navigator.onLine || hasPendingMutation() || !state.cart.size || Boolean(totals.error);
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
  const costs = supportsCosts(state.capabilities);
  const locked = state.busy || hasPendingMutation() || !navigator.onLine;
  const options = state.products.filter((p) => p.active).map((p) =>
    '<option value="' + h(p.id) + '">' + h(p.sku) + ' — ' +
    h(p.name) + '</option>').join('');
  const rows = (state.inventory?.lots || state.lots).map((lot) =>
    '<tr><td>' + h(lot.name) + '</td><td>' + h(lot.lot_code) +
    '</td><td>' + h(milligramsToGrams(lot.quantity_mg)) +
    ' กรัม</td>' + (costs ? '<td>' + costHtml(lot.cost_satang_per_gram) + '</td><td>' +
      costHtml(lot.inventory_value_satang) + '</td>' : '') + '</tr>').join('') || '<tr><td colspan="5">ไม่มีสินค้า</td></tr>';
  root.innerHTML = [
    '<header class="topbar"><div class="brand">R<span>●</span> RAMAGAN <small>V1</small></div>',
    '<div class="top-actions">', statusChip(),
    '<button id="change-server" class="ghost">เซิร์ฟเวอร์</button>',
    '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="manager-layout"><div class="view-links">',
    '<button id="open-sales" class="ghost">หน้าขาย</button><strong>จัดการสต็อก</strong>',
    '<button id="open-stocktake" class="ghost">นับสต็อกก่อนเข้ากะ</button>',
    '<a class="ghost admin-link" href="' + ADMIN_REPORT_URL + '" target="_blank" rel="noopener noreferrer">รายงานหลังบ้าน ↗</a></div>',
    '<div class="heading"><div><div class="eyebrow">INVENTORY</div><h1>รับเข้าและตั้งค่าสินค้า</h1>',
    '<p class="muted">', h(state.store.name), ' · ', h(state.role),
    ' · การรับของทุกครั้งมีประวัติผู้บันทึก</p></div>',
    '<button id="refresh" class="ghost">รีเฟรช</button></div>',
    !navigator.onLine ? '<p class="alert danger">ออฟไลน์: ไม่สามารถสร้าง/รับสินค้าได้</p>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') +
    '">' + h(state.message) + '</div>' : '',
    !costs ? '<div class="alert">เซิร์ฟเวอร์ยังไม่รองรับต้นทุนรุ่น 1 ดูยอดคงเหลือและเพิ่มสินค้าได้ การรับเข้าพร้อมต้นทุนและเลขอ้างอิงป้องกันซ้ำต้องรออัปเกรด Backend</div>' : '',
    state.inventoryError ? '<div class="alert danger">' + h(state.inventoryError) + '</div>' : '',
    inventoryPendingHtml(),
    '<div class="admin-grid"><section class="main-panel">',
    '<h2>1 · เพิ่มสินค้าใหม่</h2><form id="new-product">',
    '<label>SKU <input name="sku" maxlength="60" required placeholder="เช่น SKU-01" /></label>',
    '<label>ชื่อสินค้า <input name="name" maxlength="200" required /></label>',
    '<label>หมวดสินค้า <input name="category" maxlength="60" required value="other" /></label>',
    '<label>ราคาต่อกรัม (บาท) <input name="price" inputmode="decimal" required placeholder="100.00" /></label>',
    costs ? '<label>ต้นทุนเริ่มต้นต่อกรัม (บาท, ไม่บังคับ) <input name="default_cost" inputmode="decimal" placeholder="ว่าง = ยังไม่ทราบต้นทุน / 0 = ต้นทุนศูนย์" /></label><p class="footnote">เป็นค่าเริ่มต้นตอนรับเข้า แก้ต้นทุนจริงแยกได้ในแต่ละ Lot</p>' : '',
    '<button class="primary" ', locked ? 'disabled' : '',
    '>บันทึกสินค้า</button></form></section>',
    '<section class="main-panel"><h2>2 · รับสินค้าเข้า Lot</h2>',
    '<form id="receive-lot"><label>สินค้า <select name="product_id" required>',
    options || '<option value="">ยังไม่มีสินค้า</option>', '</select></label>',
    '<label>รหัส Lot (ห้ามซ้ำ) <input name="lot_code" maxlength="100" required /></label>',
    '<label>ผู้ส่งมอบ <input name="supplier_name" maxlength="200" required /></label>',
    '<label>เลขที่เอกสารผู้ส่งมอบ', optionalDocuments(state.capabilities) ? ' (ถ้ามี)' : '',
    ' <input name="supplier_document_ref" maxlength="200" ', optionalDocuments(state.capabilities) ? '' : 'required ', '/></label>',
    '<label>จำนวนรับเข้า (กรัม) <input name="qty" inputmode="decimal" required placeholder="30.000" /></label>',
    costs ? '<label>ต้นทุน Lot ต่อกรัม (บาท) <input name="cost" inputmode="decimal" placeholder="ว่าง = ใช้ค่าเริ่มต้นของสินค้า" /></label><p id="receive-default-cost" class="footnote"></p>' : '',
    '<label>วันหมดอายุ (ถ้ามี) <input name="expires" type="date" /></label>',
    '<label>เหตุผลการรับสินค้า <input name="reason" maxlength="500" required value="รับสินค้าเข้าร้าน" /></label>',
    '<button class="primary" ', locked || !options || !costs ? 'disabled' : '',
    '>ยืนยันการรับเข้าผ่านเซิร์ฟเวอร์</button></form></section></div>',
    '<section class="main-panel inventory-table"><h2>สต็อกปัจจุบัน</h2>',
    costs && state.inventory ? valuationHtml(state.inventory.summary) : '',
    '<table><thead><tr><th>สินค้า</th><th>Lot</th><th>คงเหลือ</th>',
    costs ? '<th>ต้นทุน/กรัม</th><th>มูลค่าคงเหลือ</th>' : '', '</tr></thead>',
    '<tbody>', rows, '</tbody></table></section>',
    '<p class="footnote">จำนวนในตารางอาจเปลี่ยนจากการขายบนอุปกรณ์อื่น',
    ' — เซิร์ฟเวอร์เป็นผู้ยืนยันยอดจริงทุกครั้ง</p>',
    '</main>'
  ].join('');
  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#change-server')?.addEventListener('click', changeServer);
  root.querySelector('#refresh').addEventListener('click', refreshLots);
  root.querySelector('#open-stocktake').addEventListener('click', () => { state.view = 'stocktake'; render(); });
  root.querySelector('#open-sales').addEventListener('click', () => {
    state.view = 'sales';
    state.message = '';
    render();
  });
  root.querySelector('#new-product').addEventListener('submit', createProduct);
  root.querySelector('#receive-lot').addEventListener('submit', receiveLot);
  bindInventoryPending();
  const productSelect = root.querySelector('#receive-lot [name=product_id]');
  const showDefault = () => {
    const node = root.querySelector('#receive-default-cost');
    if (!node) return;
    const product = state.products.find(p => p.id === productSelect.value);
    node.textContent = 'ค่าเริ่มต้นสินค้า: ' + (product?.default_cost_satang_per_gram == null ?
      'ยังไม่ทราบต้นทุน' : formatBaht(product.default_cost_satang_per_gram) + ' / กรัม') +
      ' · ช่องว่างไม่เท่ากับ 0 บาท · ต้นทุน Lot บันทึกถาวรเมื่อรับเข้า';
  };
  productSelect.addEventListener('change', showDefault); showDefault();
  if (locked) root.querySelectorAll('#new-product input, #receive-lot input, #receive-lot select').forEach(n => { n.disabled = true; });
}
function costHtml(value) {
  return value == null ? '<span class="unknown-cost">ยังไม่ทราบต้นทุน</span>' : h(formatBaht(value));
}
function valuationHtml(summary) {
  return '<div class="inventory-valuation"><p>มูลค่าสต็อกรวม <strong>' + costHtml(summary.inventory_value_satang) +
    '</strong></p><p class="muted">ส่วนที่ทราบต้นทุน ' + h(formatBaht(summary.known_inventory_value_satang)) +
    ' · Lot ที่ยังไม่ทราบต้นทุน ' + h(summary.unknown_cost_lot_count) + '</p></div>';
}
function inventoryPendingHtml() {
  let html = state.inventoryBlocked ? '<div class="alert danger">ข้อมูลรายการสต็อกค้างอ่านไม่ได้ ห้ามสร้างรายการใหม่ ให้ผู้จัดการตรวจสอบอุปกรณ์นี้</div>' : '';
  for (const kind of ['receive', 'stocktake']) {
    const op = state.inventoryPending[kind];
    if (!op) continue;
    const name = kind === 'receive' ? 'รับสินค้า' : 'นับสต็อก';
    const id = op.payload.client_receive_id || op.payload.client_stocktake_id;
    html += '<div class="alert danger pending-inventory">รายการ' + name + 'ค้าง · ' + h(id) +
      '<p>' + (op.status === 'rejected' ? 'เซิร์ฟเวอร์ปฏิเสธ: ' + h(op.rejection) :
        op.status === 'confirmed' ? 'บันทึกสำเร็จแล้ว กดตรวจสอบเพื่อปิดรายการค้าง' :
        'ยังไม่ทราบผล ห้ามเริ่มรายการใหม่ ใช้เลขอ้างอิงและข้อมูลเดิมเท่านั้น') + '</p>' +
      (kind === 'receive' && op.status === 'pending' ? '<p>ตรวจสอบผลจะคืนรายการเดิมถ้าบันทึกแล้ว หรือยกเลิกเลขอ้างอิงนี้อย่างถาวรถ้ายังไม่บันทึก เพื่อให้เริ่มรับเข้าใหม่ได้อย่างปลอดภัย</p>' : '') +
      '<div class="checkout-actions">' +
      '<button class="ghost" data-inventory-verify="' + kind + '" ' + (state.busy ? 'disabled' : '') + '>' +
      (kind === 'receive' && op.status === 'pending' ? 'ตรวจสอบผล / ยกเลิกถ้ายังไม่บันทึก' : 'ตรวจสอบรายการเดิม') + '</button>' +
      (op.status === 'pending' ? '<button class="ghost" data-inventory-retry="' + kind + '" ' + (state.busy || !navigator.onLine ? 'disabled' : '') + '>ส่งรายการเดิมซ้ำด้วย ID เดิม</button>' : '') +
      '</div></div>';
  }
  return html;
}
function bindInventoryPending() {
  root.querySelectorAll('[data-inventory-verify]').forEach(button => button.addEventListener('click', () => runInventory(button.dataset.inventoryVerify, 'verify')));
  root.querySelectorAll('[data-inventory-retry]').forEach(button => button.addEventListener('click', () => runInventory(button.dataset.inventoryRetry, 'retry')));
}

function stocktakePayload() {
  if (!state.inventory) throw new Error('ต้องโหลดยอดระบบล่าสุดก่อนนับสต็อก');
  const shift = state.shiftLabel.trim(), reason = state.countReason.trim();
  if (!shift || shift.length > 80 || !reason || reason.length > 300) throw new Error('ระบุกะ / รอบ และเหตุผลการนับสต็อกให้ครบ');
  const items = [...state.counts.entries()].filter(([, value]) => value.trim() !== '').map(([lot_id, value]) => {
    const lot = state.inventory.lots.find(x => x.id === lot_id);
    if (!lot || !Number.isSafeInteger(lot.stock_revision) || lot.stock_revision < 0) throw new Error('ข้อมูลรุ่นสต็อกไม่ครบ กรุณารีโหลดยอดระบบ');
    return {lot_id, expected_revision: lot.stock_revision, counted_quantity_mg: countedMilligrams(value)};
  }).sort((a, b) => a.lot_id.localeCompare(b.lot_id));
  if (!items.length || items.length > 200) throw new Error('กรอกยอดนับอย่างน้อย 1 Lot และไม่เกิน 200 Lot');
  return {shift_label: shift, reason, items};
}
function renderStocktake() {
  const supported = supportsStocktakes(state.capabilities);
  const locked = state.busy || hasPendingMutation() || !navigator.onLine || !supported || !state.inventory;
  const today = toBangkokDay(new Date());
  const rows = (state.inventory?.lots || []).map(lot => {
    const value = state.counts.get(lot.id) || '';
    let variance = '—';
    if (value.trim() !== '') {
      try { variance = signedGrams(countedMilligrams(value) - lot.quantity_mg) + ' กรัม'; }
      catch { variance = 'ยอดนับไม่ถูกต้อง'; }
    }
    return '<tr><td data-label="สินค้า / Lot"><strong>' + h(lot.name) + '</strong><small>' + h(lot.lot_code) +
      (lot.expires_on && lot.expires_on < today ? ' · หมดอายุ' : '') +
      (!lot.active || !lot.product_active ? ' · ไม่ใช้งาน' : '') + '</small></td><td data-label="ยอดระบบ">' +
      h(milligramsToGrams(lot.quantity_mg)) + ' กรัม</td><td data-label="ยอดนับจริง (กรัม)"><input data-count="' + h(lot.id) +
      '" aria-label="ยอดนับจริง ' + h(lot.lot_code) + ' (กรัม)" inputmode="decimal" value="' + h(value) +
      '" placeholder="ว่าง = ไม่นับ Lot นี้" ' + (locked ? 'disabled' : '') + ' /></td><td data-label="ส่วนต่าง" data-variance="' + h(lot.id) + '">' + h(variance) + '</td></tr>';
  }).join('') || '<tr><td colspan="4">ยังไม่มียอดระบบสำหรับตรวจนับ</td></tr>';
  const history = state.stocktakes.map(x => '<tr><td>' + h(new Date(x.created_at).toLocaleString('th-TH', {timeZone: 'Asia/Bangkok'})) +
    '<small>' + h(x.id) + '</small></td><td>' + h(x.shift_label) + '<small>' + h(x.reason) + '</small></td><td>' +
    h(x.actor_email || x.actor_user_id) + '</td><td>' + h(x.line_count) + '</td><td>' + h(signedGrams(x.variance_mg)) +
    ' กรัม</td><td><button type="button" class="ghost" data-history="' + h(x.client_stocktake_id) + '">ดูรายการ</button></td></tr>').join('') || '<tr><td colspan="6">ยังไม่มีประวัติการนับ</td></tr>';
  root.innerHTML = [
    '<header class="topbar"><div class="brand">R<span>●</span> RAMAGAN <small>V1</small></div><div class="top-actions">', statusChip(),
    '<button id="change-server" class="ghost">เซิร์ฟเวอร์</button><button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="manager-layout"><div class="view-links"><button id="open-sales" class="ghost">หน้าขาย</button>',
    '<button id="open-inventory" class="ghost">จัดการสินค้า / รับเข้า</button><strong>นับสต็อกก่อนเข้ากะ</strong></div>',
    '<section class="main-panel"><h1>นับสต็อกก่อนเข้ากะ</h1><p class="muted">', h(state.store.name),
    ' · เปรียบเทียบยอดระบบกับยอดนับจริง ยืนยันแล้วบันทึกส่วนต่างพร้อมประวัติ</p>',
    !supported ? '<div class="alert">เซิร์ฟเวอร์ยังไม่รองรับการนับสต็อกรุ่น 1 ดูยอดคงเหลือได้ที่หน้าจัดการสินค้า การปรับยอดยังไม่เปิดให้ใช้</div>' : '',
    state.inventoryError ? '<div class="alert danger">' + h(state.inventoryError) + '</div>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') + '">' + h(state.message) + '</div>' : '',
    inventoryPendingHtml(),
    '<form id="stocktake-form"><div class="admin-grid"><label>กะ / รอบ <input id="shift-label" maxlength="80" required value="', h(state.shiftLabel), '" ', locked ? 'disabled' : '', ' /></label>',
    '<label>ผู้ตรวจนับ (บัญชีที่เข้าสู่ระบบ) <input value="', h(state.user.email || state.user.id), '" readonly /></label></div>',
    '<label>เหตุผลการตรวจนับและปรับยอด <input id="count-reason" maxlength="300" required value="', h(state.countReason), '" ', locked ? 'disabled' : '', ' /></label>',
    '<p class="footnote">กรอก 0 เมื่อนับแล้วไม่มีสินค้า ช่องว่างหมายถึงไม่นับ Lot นั้น · รวม Lot หมดอายุและไม่ใช้งาน · ยอดอาจเปลี่ยนจากอุปกรณ์อื่น หากเปลี่ยนต้องโหลดและนับใหม่</p>',
    '<div class="inventory-table count-table"><table><thead><tr><th>สินค้า / Lot</th><th>ยอดระบบ</th><th>ยอดนับจริง (กรัม)</th><th>ส่วนต่าง</th></tr></thead><tbody>', rows, '</tbody></table></div>',
    '<label class="count-confirm"><input id="count-confirm" type="checkbox" ', state.countConfirmed ? 'checked ' : '', locked ? 'disabled ' : '',
    '/> ตรวจนับจริงและตรวจสอบส่วนต่างแล้ว ยืนยันให้บันทึกการปรับยอดตามรายการที่กรอก</label>',
    '<div class="stocktake-actions"><button type="button" id="reload-count" class="ghost" ', state.busy || hasInventoryPending() ? 'disabled' : '',
    '>รีโหลดยอดระบบ / เริ่มนับใหม่</button><button id="confirm-count" type="submit" class="primary" disabled>ยืนยันการนับและปรับยอดผ่านเซิร์ฟเวอร์</button></div></form></section>',
    '<section class="main-panel inventory-table stocktake-history"><h2>ประวัติการนับและปรับยอดล่าสุด</h2>',
    '<p class="footnote">บนหน้าจอเล็ก เลื่อนตารางซ้าย / ขวาเพื่อดูผู้บันทึกและรายละเอียดแต่ละ Lot</p>',
    state.stocktakeError ? '<p class="alert danger">' + h(state.stocktakeError) + '</p>' : '',
    '<table><thead><tr><th>วันเวลา (ไทย) / เลขรายการ</th><th>กะ / เหตุผล</th><th>ผู้บันทึก</th><th>จำนวน Lot</th><th>ส่วนต่างรวม</th><th>รายละเอียด</th></tr></thead><tbody>', history, '</tbody></table>',
    state.historyError ? '<p class="alert danger">' + h(state.historyError) + '</p>' : '',
    historyDetailHtml(), '</section></main>'
  ].join('');
  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#change-server').addEventListener('click', changeServer);
  root.querySelector('#open-sales').addEventListener('click', () => { state.view = 'sales'; render(); });
  root.querySelector('#open-inventory').addEventListener('click', () => { state.view = 'inventory'; render(); });
  root.querySelector('#reload-count').addEventListener('click', async () => {
    if (state.busy || hasInventoryPending()) return;
    state.counts.clear(); state.countConfirmed = false; await refreshLots();
  });
  const update = () => {
    let valid = false;
    try { stocktakePayload(); valid = true; } catch { /* keep button disabled */ }
    root.querySelector('#confirm-count').disabled = locked || !state.countConfirmed || !valid;
  };
  root.querySelectorAll('[data-count]').forEach(input => input.addEventListener('input', () => {
    if (locked) return;
    state.counts.set(input.dataset.count, input.value);
    state.countConfirmed = false; root.querySelector('#count-confirm').checked = false;
    const lot = state.inventory.lots.find(x => x.id === input.dataset.count);
    const node = root.querySelector('[data-variance="' + CSS.escape(input.dataset.count) + '"]');
    try { node.textContent = input.value.trim() === '' ? '—' : signedGrams(countedMilligrams(input.value) - lot.quantity_mg) + ' กรัม'; }
    catch (error) { node.textContent = error.message; }
    update();
  }));
  root.querySelector('#shift-label').addEventListener('input', event => { if (!locked) { state.shiftLabel = event.target.value; update(); } });
  root.querySelector('#count-reason').addEventListener('input', event => { if (!locked) { state.countReason = event.target.value; update(); } });
  root.querySelector('#count-confirm').addEventListener('change', event => { if (!locked) { state.countConfirmed = event.target.checked; update(); } });
  root.querySelector('#stocktake-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (locked || !state.countConfirmed) return;
    try { await runInventory('stocktake', 'start', stocktakePayload()); }
    catch (error) { setMessage(error.message, true); }
  });
  bindInventoryPending(); update();
  root.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => loadHistoryDetail(button.dataset.history)));
}
function historyDetailHtml() {
  const detail = state.historyDetail;
  if (!detail) return '';
  return '<section class="stocktake-detail"><h3>รายละเอียดการนับ ' + h(detail.shift_label) + '</h3><p class="muted">' +
    h(detail.actor_email || detail.actor_user_id) + ' · ' + h(detail.reason) + ' · ' +
    h(new Date(detail.created_at).toLocaleString('th-TH', {timeZone: 'Asia/Bangkok'})) + '</p><table><thead><tr><th>Lot</th><th>ยอดระบบ</th><th>ยอดนับ</th><th>ส่วนต่าง</th></tr></thead><tbody>' +
    detail.items.map(x => '<tr><td>' + h(x.lot_code) + '</td><td>' + h(milligramsToGrams(x.system_quantity_mg)) +
      '</td><td>' + h(milligramsToGrams(x.counted_quantity_mg)) + '</td><td>' + h(signedGrams(x.variance_mg)) + ' กรัม</td></tr>').join('') + '</tbody></table></section>';
}
async function loadHistoryDetail(id) {
  const request = ++state.historyRequest, actor = state.user?.id, store = state.store?.id, generation = state.inventoryLoad;
  const {data, error} = await api.stocktake(id);
  if (request !== state.historyRequest || state.user?.id !== actor || state.store?.id !== store ||
      generation !== state.inventoryLoad || !canManage()) return;
  state.historyError = error ? 'อ่านรายละเอียดการนับไม่สำเร็จ: ' + error.message : '';
  if (!error && data?.client_stocktake_id === id && Array.isArray(data.items)) state.historyDetail = data;
  else if (!error) state.historyError = 'คำตอบรายละเอียดการนับไม่ครบ';
  render();
}
async function createProduct(event) {
  event.preventDefault();
  if (!canManage() || state.busy || hasPendingMutation() || !navigator.onLine) return;
  const form = new FormData(event.currentTarget);
  let price, cost;
  try {
    price = bahtToSatang(form.get('price'));
    if (supportsCosts(state.capabilities)) cost = optionalCost(form.get('default_cost'));
  }
  catch (e) { return setMessage(e.message, true); }
  return withNewMutation(async () => {
  state.busy = true;
  render();
  const { error } = await api.rpc('ramagan_create_product', {
    p_store_id: state.store.id,
    p_sku: String(form.get('sku')).trim(),
    p_name: String(form.get('name')).trim(),
    p_category: String(form.get('category')).trim(),
    p_price_satang_per_gram: price,
    ...(cost === undefined ? {} : {p_default_cost_satang_per_gram: cost})
  });
  state.busy = false;
  if (error) return setMessage('สร้างสินค้าไม่สำเร็จ: ' + error.message, true);
  await refreshLots();
  setMessage('บันทึกสินค้าในฐานข้อมูลกลางแล้ว');
  });
}
async function receiveLot(event) {
  event.preventDefault();
  if (!canManage() || state.busy || hasPendingMutation() || !navigator.onLine || !supportsCosts(state.capabilities)) return;
  const form = new FormData(event.currentTarget);
  let qty, cost;
  try { qty = receivedMilligrams(form.get('qty')); cost = optionalCost(form.get('cost')); }
  catch (e) { return setMessage(e.message, true); }
  if (!optionalDocuments(state.capabilities) && !String(form.get('supplier_document_ref') || '').trim()) {
    return setMessage('เซิร์ฟเวอร์รุ่นนี้ยังต้องระบุเลขที่เอกสารผู้ส่งมอบ', true);
  }
  await runInventory('receive', 'start', {
    product_id: String(form.get('product_id')),
    lot_code: String(form.get('lot_code')).trim(),
    supplier_name: String(form.get('supplier_name')).trim(),
    supplier_document_ref: String(form.get('supplier_document_ref')).trim(),
    quantity_mg: qty, cost_satang_per_gram: cost,
    expires_on: form.get('expires') || null,
    reason: String(form.get('reason')).trim()
  });
}
async function runInventory(kind, action, payload) {
  if (action === 'start') {
    if (state.busy || hasPendingMutation()) return;
    return withNewMutation(() => performInventory(kind, action, payload));
  }
  return performInventory(kind, action, payload);
}
async function performInventory(kind, action, payload) {
  if (!canManage() || state.busy || state.inventoryBlocked || !navigator.onLine || !state[kind]) return;
  state.busy = true;
  render();
  try {
    const result = await state[kind][action](payload);
    restoreInventoryPending();
    if (result?.result || result?.rejected) {
      await state[kind].acknowledge();
      restoreInventoryPending();
      // Any accepted/rejected count consumes the frozen snapshot. Recount after
      // a conflict; never update revisions under previously entered counts.
      if (kind === 'stocktake') { state.counts.clear(); state.countConfirmed = false; }
      const fresh = await refreshLots();
      state.message = result.rejected ? 'ไม่ได้บันทึก: ' + result.error.message +
        (kind === 'stocktake' ? ' · รีโหลดยอดระบบแล้ว กรุณานับใหม่ก่อนยืนยัน' : '') :
        (kind === 'stocktake' ? 'เซิร์ฟเวอร์ยืนยันการนับและบันทึกประวัติแล้ว' : 'เซิร์ฟเวอร์ยืนยัน Lot พร้อมต้นทุนและรายการรับเข้าแล้ว') +
        ' · เลขอ้างอิง ' + (result.op.payload.client_stocktake_id || result.op.payload.client_receive_id);
      if (!fresh) state.message += ' · รีเฟรชสต็อกไม่สำเร็จ กรุณารีเฟรชก่อนทำรายการต่อ';
      state.error = Boolean(result.rejected || !fresh);
    } else {
      state.message = 'ยังไม่ทราบผลรายการสต็อก เก็บเลขอ้างอิงเดิมไว้ ห้ามสร้างรายการใหม่' +
        (result?.error ? ': ' + result.error.message : '');
      state.error = true;
    }
  } catch (error) {
    restoreInventoryPending(); state.message = error.message; state.error = true;
  } finally { state.busy = false; render(); }
}

async function loadProfile(user) {
  resetInventoryState();
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
  if (canManage()) {
    const lock = navigator.locks ? (key, task) => navigator.locks.request(key, {ifAvailable: true}, current => {
      if (!current) throw new Error('รายการสต็อกกำลังตรวจสอบในอีกหน้าต่าง กรุณารอสักครู่');
      return task();
    }) : null;
    for (const kind of ['stocktake', 'receive']) state[kind] = createInventoryOperation({
      storage: localStorage, identity: {api: api.base, store: state.store.id, actor: user.id},
      kind, transport: api.inventoryTransport(kind), uuid: () => crypto.randomUUID(), lock
    });
    restoreInventoryPending();
  }
  state.message = '';
  restorePending();
  await refreshLots();
}
async function refreshLots() {
  if (!state.store) return;
  if (!navigator.onLine) return setMessage('ออฟไลน์: ไม่สามารถตรวจสอบสต็อกล่าสุดได้', true);
  const enhanced = canManage() && (supportsCosts(state.capabilities) || supportsStocktakes(state.capabilities));
  const load = ++state.inventoryLoad, userId = state.user.id, storeId = state.store.id;
  // A count draft belongs to one revision snapshot. Refresh never rebases old
  // physical counts onto new revisions without the counter entering them again.
  state.inventory = null; state.counts.clear(); state.countConfirmed = false;
  render();
  const [lotsResult, productsResult, inventoryResult, historyResult] = await Promise.all([
    api.from('ramagan_lots')
      .select('id, lot_code, expires_on, active, ramagan_products!inner(name,sku,price_satang_per_gram,active), ramagan_lot_balances(quantity_mg)')
      .eq('store_id', state.store.id).eq('active', true),
    api.from('ramagan_products')
      .select('id,sku,name,category,price_satang_per_gram,active')
      .eq('store_id', state.store.id).order('name'),
    enhanced ? api.inventory() : Promise.resolve(null),
    canManage() && supportsStocktakes(state.capabilities) ? api.stocktakes() : Promise.resolve(null)
  ]);
  if (load !== state.inventoryLoad || state.user?.id !== userId || state.store?.id !== storeId) return false;
  const { data, error } = lotsResult;
  if (productsResult.error) return setMessage('อ่านรายการสินค้าไม่สำเร็จ: ' +
    productsResult.error.message, true);
  state.products = productsResult.data || [];
  state.inventoryError = '';
  if (inventoryResult?.error) state.inventoryError = 'อ่านสต็อกสำหรับตรวจนับ/ต้นทุนไม่สำเร็จ: ' + inventoryResult.error.message;
  else if (inventoryResult) {
    try {
      validateInventory(inventoryResult.data);
      state.inventory = inventoryResult.data;
      state.products = inventoryResult.data.products;
    } catch (error) { state.inventoryError = error.message; }
  }
  state.stocktakeError = historyResult?.error ? 'อ่านประวัติการนับไม่สำเร็จ: ' + historyResult.error.message : '';
  state.stocktakes = Array.isArray(historyResult?.data?.stocktakes) ? historyResult.data.stocktakes : [];
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
  if (!state.pendingBlocked && !state.inventoryBlocked) state.message = '';
  render();
  return !enhanced || Boolean(state.inventory);
}
function validateInventory(data) {
  const quantity = x => Number.isSafeInteger(x) && x >= 0;
  const cost = x => x === null || quantity(x);
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.lots) || !data.summary ||
      data.lots.some(x => typeof x.id !== 'string' || !quantity(x.quantity_mg) ||
        (supportsStocktakes(state.capabilities) && !quantity(x.stock_revision)) ||
        (supportsCosts(state.capabilities) && (!cost(x.cost_satang_per_gram) || !cost(x.inventory_value_satang)))) ||
      (supportsCosts(state.capabilities) && (data.products.some(x => !cost(x.default_cost_satang_per_gram)) ||
        !cost(data.summary.inventory_value_satang) || !quantity(data.summary.known_inventory_value_satang) ||
        !quantity(data.summary.unknown_cost_lot_count)))) {
    throw new Error('ข้อมูลสต็อก/ต้นทุนหรือ stock revision จากเซิร์ฟเวอร์ไม่ครบ กรุณาอัปเกรด Backend ให้ตรงสัญญา');
  }
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
  if (action === 'start') {
    if (state.busy || hasPendingMutation()) return;
    return withNewMutation(() => performCheckout(action, payload, subtotal));
  }
  return performCheckout(action, payload, subtotal);
}
async function performCheckout(action, payload, subtotal) {
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
  resetInventoryState();
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
  if (['stocktake', 'receive'].some(kind => state[kind] &&
      (event.key?.startsWith(state[kind].key) || event.key === null))) {
    restoreInventoryPending(); state.counts.clear(); state.countConfirmed = false; render();
  }
});
window.addEventListener('online', () => {
  if (state.store) refreshLots();
  else render();
});
window.addEventListener('offline', render);
if (api) startSession();
else render();

if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}
