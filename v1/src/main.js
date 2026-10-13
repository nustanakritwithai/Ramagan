import { createClient } from '@supabase/supabase-js';
import { gramsToMilligrams, milligramsToGrams, lineTotalSatang, formatBaht, bahtToSatang } from './math.js';
import './style.css';

const root = document.getElementById('app');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(
  url && key && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)
  && (/^sb_publishable_[a-zA-Z0-9]+$/.test(key) || /^eyJ[a-zA-Z0-9_.-]+$/.test(key))
  && !key.includes('REPLACE_ME')
);
const api = configured ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
}) : null;

const state = {
  user: null, store: null, role: null, lots: [], cart: new Map(),
  payment: 'cash', authRef: '', busy: false, message: '', error: false,
  pendingId: null, lastSale: null, products: [], view: 'sales'
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
  if (state.view === 'inventory' && canManage()) return renderInventory();
  renderDashboard();
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
    '<button class="ghost" id="signup" type="button" ', state.busy ? 'disabled' : '',
    '>ขอสร้างบัญชีใหม่ (ยืนยันอีเมล)</button>',
    '<p class="footnote">บัญชีใหม่ต้องได้รับสิทธิ์ร้านจากเจ้าของร้านก่อนเข้าใช้งาน</p>',
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
  root.querySelector('#signup').addEventListener('click', async () => {
    if (state.busy) return;
    if (window.Capacitor?.isNativePlatform?.()) {
      return setMessage('กรุณาสมัครและยืนยันอีเมลผ่านเว็บไซต์ Ramagan ก่อน แล้วจึงกลับมาเข้าแอป', true);
    }
    const form = root.querySelector('#login-form');
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!email || password.length < 12) {
      return setMessage('กรอกอีเมล และตั้งรหัสผ่านอย่างน้อย 12 ตัวอักษร', true);
    }
    state.busy = true;
    const redirect = new URL(import.meta.env.BASE_URL, window.location.origin).href;
    const { error } = await api.auth.signUp({
      email, password, options: { emailRedirectTo: redirect }
    });
    state.busy = false;
    if (error) return setMessage('สมัครบัญชีไม่สำเร็จ: ' + error.message, true);
    setMessage('ส่งคำขอสมัครแล้ว กรุณาตรวจอีเมลเพื่อยืนยัน และให้เจ้าของร้านกำหนดสิทธิ์');
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
    '<div class="view-links"><strong>หน้าขาย</strong>',
    canManage() ? '<button id="open-inventory" class="ghost" type="button">จัดการสินค้า / รับเข้า</button>' : '',
    '</div>',
    '<div class="heading"><div><div class="eyebrow">หน้าร้าน / SALES</div><h1>ขายสินค้า</h1>',
    '<p class="muted">', h(state.store.name), ' · ', h(state.role), '</p></div>',
    '<button id="refresh" class="ghost">รีเฟรชสต็อก</button></div>',
    !live ? '<div class="alert danger">ร้านยังไม่เปิดใช้งานระบบขายจริง ต้องผ่านการทดสอบและอนุมัติเงื่อนไขร้านก่อน</div>' : '',
    !navigator.onLine ? '<div class="alert danger">ออฟไลน์: ยืนยันการขายไม่ได้ ข้อมูลสต็อกอาจไม่ล่าสุด</div>' : '',
    state.message ? '<div class="alert ' + (state.error ? 'danger' : '') + '">' + h(state.message) + '</div>' : '',
    state.lastSale ? '<div class="alert success">รายการล่าสุด ' + h(state.lastSale.sale_id) +
      ' · รวม ' + h(formatBaht(Number(state.lastSale.total_satang))) + '</div>' : '',
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
  root.querySelector('#open-inventory')?.addEventListener('click', () => {
    state.view = 'inventory';
    state.message = '';
    render();
  });
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
    '<button id="logout" class="ghost">ออกจากระบบ</button></div></header>',
    '<main class="manager-layout"><div class="view-links">',
    '<button id="open-sales" class="ghost">หน้าขาย</button><strong>จัดการสต็อก</strong></div>',
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
  state.pendingId = localStorage.getItem(storageKey());
  state.message = '';
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
  state.products = [];
  state.view = 'sales';
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