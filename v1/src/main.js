import { createClient } from '@supabase/supabase-js';
import { gramsToMilligrams, milligramsToGrams, lineTotalSatang, formatBaht } from './math.js';
import './style.css';

const root = document.getElementById('app');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(url && key && /^https:\/\//.test(url) && !url.includes('YOUR-PROJECT'));
const api = configured ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
}) : null;

const state = {
  user: null, store: null, role: null, lots: [], cart: new Map(),
  payment: 'cash', authRef: '', busy: false, message: '', error: false,
  pendingId: null, lastSale: null
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
function storageKey() {
  return 'ramagan.v1.pending.' + (state.store?.id || 'unassigned');
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
  if (!configured) {
    root.innerHTML = '<div class="setup"><h1>RAMAGAN POS V1</h1>' +
      '<p>ยังไม่ได้ตั้งค่าฐานข้อมูลกลาง</p>' +
      '<p>สร้างไฟล์ .env.local ตาม .env.example และใช้ Supabase TEST project ก่อน</p>' +
      '<strong>ระบบขายจริงยังไม่เปิดใช้งาน</strong></div>';
    return;
  }
  if (!state.user) return renderLogin();
  if (!state.store) {
    root.innerHTML = '<div class="setup"><h1>RAMAGAN POS</h1><p>' +
      h(state.message || 'บัญชีนี้ยังไม่ได้รับสิทธิ์ในร้าน กรุณาให้เจ้าของร้านเพิ่มสมาชิก') +
      '</p><button id="logout">ออกจากระบบ</button></div>';
    root.querySelector('#logout').addEventListener('click', logout);
    return;
  }
  renderDashboard();
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
}
function cartItems() {
  return [...state.cart.entries()].map(([lot_id, quantity_mg]) => ({ lot_id, quantity_mg }))
    .sort((a, b) => a.lot_id.localeCompare(b.lot_id));
}
function cartTotal() {
  return cartItems().reduce((sum, item) => {
    const lot = state.lots.find((l) => l.id === item.lot_id);
    return sum + (lot ? lineTotalSatang(lot.price, item.quantity_mg) : 0);
  }, 0);
}
function renderDashboard() {
  const live = Boolean(state.store.sales_enabled);
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
    '<div class="top-actions">', statusChip(), '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="layout"><section class="main-panel">',
    '<div class="heading"><div><div class="eyebrow">หน้าร้าน / SALES</div><h1>ขายสินค้า</h1>',
    '<p class="muted">', h(state.store.name), ' · ', h(state.role), '</p></div>',
    '<button id="refresh" class="ghost">รีเฟรชสต็อก</button></div>',
    !live ? '<div class="alert danger">ร้านยังไม่เปิดใช้งานระบบขายจริง ต้องผ่านการทดสอบและอนุมัติเงื่อนไขร้านก่อน</div>' : '',
    !navigator.onLine ? '<div class="alert danger">ออฟไลน์: ยืนยันการขายไม่ได้ ข้อมูลสต็อกอาจไม่ล่าสุด</div>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') + '">' + h(state.message) + '</div>' : '',
    state.lastSale ? '<div class="alert success">รายการล่าสุด ', h(state.lastSale.sale_id),
      ' · รวม ', h(formatBaht(Number(state.lastSale.total_satang))), '</div>' : '',
    '<div class="section-title"><h2>สินค้าในสต็อก</h2><span class="muted">', state.lots.length, ' Lot</span></div>',
    '<div class="products">', cards, '</div></section>',
    '<aside class="cart-panel"><div class="section-title"><h2>ตะกร้าขาย</h2>',
    '<span>', cartItems().length, ' รายการ</span></div>',
    '<div class="cart-items">', rows, '</div>',
    '<div class="cart-total"><span>ยอดประมาณ</span><strong>', h(formatBaht(cartTotal())), '</strong></div>',
    '<label>การชำระเงิน <select id="payment" ', (state.busy || state.pendingId) ? 'disabled' : '', '>',
    '<option value="cash" ', state.payment === 'cash' ? 'selected' : '', '>เงินสด</option>',
    '<option value="transfer" ', state.payment === 'transfer' ? 'selected' : '', '>โอนเงิน</option></select></label>',
    '<label>รหัสอ้างอิงเอกสารที่ได้รับอนุญาต',
    '<input id="auth-ref" maxlength="120" value="', h(state.authRef), '" placeholder="รหัสเอกสาร (ไม่ใส่ชื่อผู้ป่วย)" ', (state.busy || state.pendingId) ? 'disabled' : '', ' /></label>',
    '<p class="footnote">การกรอกรหัสเอกสารไม่ใช่การตรวจสอบความถูกต้องของเอกสาร ต้องตรวจตามกระบวนการร้านที่ได้รับอนุญาต</p>',
    state.pendingId ? '<div class="alert danger">มีรายการส่งขายที่ยังไม่ทราบผล ห้ามสร้างรายการใหม่จนกว่าจะตรวจสอบ</div>' : '',
    '<div class="checkout-actions">',
    '<button id="checkout" class="primary" ', (!live || !navigator.onLine || state.busy ||
      state.pendingId || !state.cart.size) ? 'disabled' : '', '>ยืนยันรายการผ่านเซิร์ฟเวอร์</button>',
    state.pendingId ? '<button id="verify" class="ghost">ตรวจสอบรายการค้าง</button>' : '',
    state.pendingId && state.cart.size ? '<button id="retry" class="ghost">ส่งรายการเดิมซ้ำด้วย ID เดิม</button>' : '',
    '</div>',
    '<p class="footnote">ระบบจะถือว่าขายสำเร็จหลังเซิร์ฟเวอร์ยืนยันเท่านั้น</p>',
    '</aside></main>'
  ].join('');

  root.querySelector('#logout').addEventListener('click', logout);
  root.querySelector('#refresh').addEventListener('click', refreshLots);
  root.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
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
      state.cart.delete(button.dataset.remove);
      render();
    });
  });
  root.querySelector('#payment').addEventListener('change', (event) => {
    state.payment = event.target.value;
  });
  root.querySelector('#auth-ref').addEventListener('input', (event) => {
    state.authRef = event.target.value;
  });
  root.querySelector('#checkout').addEventListener('click', startCheckout);
  root.querySelector('#verify')?.addEventListener('click', verifyPending);
  root.querySelector('#retry')?.addEventListener('click', () => sendCheckout(state.pendingId));
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
  state.pendingId = localStorage.getItem(storageKey());
  state.message = '';
  await refreshLots();
}
async function refreshLots() {
  if (!state.store) return;
  if (!navigator.onLine) return setMessage('ออฟไลน์: ไม่สามารถตรวจสอบสต็อกล่าสุดได้', true);
  const { data, error } = await api.from('ramagan_lots')
    .select('id, lot_code, expires_on, active, ramagan_products!inner(name,sku,price_satang_per_gram,active), ramagan_lot_balances(quantity_mg)')
    .eq('store_id', state.store.id).eq('active', true);
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
  state.message = '';
  render();
}
async function startCheckout() {
  if (state.pendingId || state.busy || !state.cart.size) return;
  if (!state.store.sales_enabled || !navigator.onLine) {
    return setMessage('ไม่สามารถยืนยันการขายในสถานะนี้', true);
  }
  if (state.store.requires_authorization && !state.authRef.trim()) {
    return setMessage('ต้องระบุรหัสเอกสารที่ได้รับอนุญาต และตรวจสอบเอกสารจริงก่อน', true);
  }
  state.pendingId = crypto.randomUUID();
  localStorage.setItem(storageKey(), state.pendingId);
  await sendCheckout(state.pendingId);
}
async function sendCheckout(id) {
  if (!id || !state.cart.size || !navigator.onLine || state.busy) return;
  state.busy = true;
  render();
  const { data, error } = await api.rpc('ramagan_checkout', {
    p_store_id: state.store.id,
    p_client_sale_id: id,
    p_items: cartItems(),
    p_payment_method: state.payment,
    p_authorization_ref: state.authRef.trim() || null
  });
  state.busy = false;
  if (error) {
    return setMessage('ยังไม่ยืนยันผลการขาย: ' + error.message +
      ' — กรุณากดตรวจสอบรายการค้างก่อนเริ่มขายใหม่', true);
  }
  state.lastSale = data;
  localStorage.removeItem(storageKey());
  state.pendingId = null;
  state.cart.clear();
  state.authRef = '';
  await refreshLots();
  setMessage('เซิร์ฟเวอร์ยืนยันรายการขายเรียบร้อย', false);
}
async function verifyPending() {
  if (!state.pendingId || !navigator.onLine) return;
  state.busy = true;
  render();
  const { data, error } = await api.from('ramagan_sales')
    .select('id, total_satang').eq('store_id', state.store.id)
    .eq('client_sale_id', state.pendingId).maybeSingle();
  state.busy = false;
  if (error) return setMessage('ตรวจสอบรายการค้างไม่สำเร็จ: ' + error.message, true);
  if (data) {
    state.lastSale = { sale_id: data.id, total_satang: data.total_satang };
    state.cart.clear();
    state.authRef = '';
    state.message = 'พบรายการที่เซิร์ฟเวอร์ยืนยันแล้ว ไม่ได้ตัดสต็อกซ้ำ';
    state.pendingId = null;
    localStorage.removeItem(storageKey());
    state.error = false;
    await refreshLots();
    return setMessage('ตรวจพบรายการที่บันทึกสำเร็จแล้ว: ไม่ตัดสต็อกซ้ำ', false);
  }
  state.error = true;
  // A timed-out request could still be committing. Never clear the idempotency
  // key merely because a single read did not find a sale yet.
  setMessage('ยังไม่พบผลรายการ อาจกำลังประมวลผล ห้ามสร้างรายการใหม่: ส่งซ้ำด้วย ID เดิม หรือติดต่อผู้จัดการตรวจสอบ', true);
}
async function logout() {
  await api.auth.signOut();
  state.user = null;
  state.store = null;
  state.role = null;
  state.cart.clear();
  state.lots = [];
  state.message = '';
  state.lastSale = null;
  state.pendingId = null;
  render();
}
window.addEventListener('online', () => {
  if (state.store) refreshLots();
  else render();
});
window.addEventListener('offline', render);
api?.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    state.user = null;
    state.store = null;
    render();
  }
});
if (api) {
  api.auth.getUser().then(({ data, error }) => {
    if (!error && data?.user) loadProfile(data.user);
    else render();
  });
} else render();

if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(() => {});
  });
}