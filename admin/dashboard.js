import {
  normalizeApiBase, isReportRole, money, grams, gramsToMgAllowZero,
  bangkokDay, verifyPeriod, dailyCsv
} from './lib.js';

const $ = (id) => document.getElementById(id);
const endpointKey = 'ramagan.admin.endpoint.v1';
let endpoint = normalizeApiBase(localStorage.getItem(endpointKey)) || '';
let token = '';
let store = null;
let report = null;
let busy = false;
let tokenStorageKey = '';
const currency = (value) => money(value);
const quantity = (value) => grams(value);

function banner(message, isError = false) {
  const target = $('login-panel').hidden ? $('report-message') : $('login-message');
  if (!target) return;
  target.textContent = message;
  target.classList.toggle('error', isError);
  target.hidden = !message;
}
function clearBanners() {
  for (const id of ['login-message', 'report-message']) {
    const node = $(id);
    if (node) { node.textContent = ''; node.hidden = true; }
  }
}
function connection(label, online = false) {
  $('connection-status').textContent = label;
  $('connection-status').classList.toggle('online', online);
}
function authPanel(show) {
  $('login-panel').hidden = !show;
  $('dashboard-panel').hidden = show;
  $('logout').hidden = show;
}
function setBusy(value) {
  busy = value;
  document.body.classList.toggle('busy', value);
  $('login-button').disabled = value;
  $('refresh').disabled = value;
}
function tokenKey(base) {
  return 'ramagan.admin.session:' + base;
}
function wipeReport() {
  report = null;
  for (const id of ['metric-sales', 'metric-orders', 'metric-cash',
    'metric-transfer', 'metric-grams', 'metric-average', 'period-label']) {
    $(id).textContent = '—';
  }
  for (const id of ['daily-chart', 'top-products', 'top-categories',
    'low-stock-rows', 'recent-sales']) $(id).replaceChildren();
  $('export-csv').disabled = true;
}
async function request(path, {method = 'GET', body, authenticated = true} = {}) {
  if (!endpoint) throw new Error('ยังไม่ได้กำหนด HTTPS API');
  const abort = AbortSignal.timeout(15000);
  const headers = {'Accept':'application/json'};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated && token) headers['Authorization'] = 'Bearer ' + token;
  let response;
  try {
    response = await fetch(endpoint + path, {
      method, headers, cache:'no-store', credentials:'omit',
      referrerPolicy:'no-referrer', signal:abort,
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
  } catch {
    throw new Error('เชื่อมต่อ VPS ไม่สำเร็จ ตรวจสอบ HTTPS, CORS และเครือข่าย');
  }
  let data = null;
  try { data = await response.json(); } catch { /* Non-JSON API response. */ }
  if (!response.ok) {
    if (response.status === 401 && authenticated) {
      token = '';
      sessionStorage.removeItem(tokenStorageKey);
      store = null;
      wipeReport();
      authPanel(true);
      connection('Session หมดอายุ', false);
    }
    if (response.status === 404 && path.startsWith('/v1/admin/')) {
      throw new Error('API รายงานยังไม่ติดตั้งบน VPS — ต้องอัปเดต backend/vps/app.py และ reports.py');
    }
    throw new Error(typeof data?.detail === 'string' ?
      data.detail : 'เซิร์ฟเวอร์ตอบ HTTP ' + response.status);
  }
  return data;
}
async function verifyRole() {
  const me = await request('/v1/me');
  if (!isReportRole(me.role)) {
    throw new Error('บัญชีนี้ไม่มีสิทธิ์ Admin: ต้องเป็น Owner หรือ Manager');
  }
  store = me.store;
  $('store-info').textContent = String(store.name) + ' · ' + String(me.role) + ' · รายงานจาก VPS';
  $('sales-gate').textContent = store.sales_enabled ?
    'ร้านเปิดรับการขายแล้ว' : 'โหมดทดสอบ · ปิดการขาย';
  $('sales-gate').classList.toggle('enabled', Boolean(store.sales_enabled));
  connection('เชื่อมต่อ VPS แล้ว', true);
  authPanel(false);
}
function addRow(tbody, columns) {
  const tr = document.createElement('tr');
  for (const col of columns) {
    const td = document.createElement('td');
    td.textContent = String(col.value ?? '');
    if (col.right) td.className = 'right';
    if (col.title) td.title = String(col.title);
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}
function rows(id, entries, projector, empty = 'ไม่มีรายการในช่วงนี้') {
  const tbody = $(id);
  tbody.replaceChildren();
  if (!entries?.length) {
    addRow(tbody, [{value:empty}]);
    return;
  }
  for (const item of entries) addRow(tbody, projector(item));
}
function showDaily(daily) {
  const node = $('daily-chart');
  node.replaceChildren();
  if (!daily?.length) {
    node.textContent = 'ยังไม่มีข้อมูล';
    return;
  }
  const max = Math.max(1, ...daily.map((row) => Number(row.total_satang) || 0));
  for (const item of daily) {
    const wrapper = document.createElement('div');
    wrapper.className = 'daily-row';
    const label = document.createElement('span');
    label.textContent = String(item.date);
    const track = document.createElement('div');
    track.className = 'daily-track';
    const bar = document.createElement('div');
    bar.className = 'daily-bar';
    const value = Number(item.total_satang) || 0;
    bar.style.width = Math.min(100, Math.max(0, (value / max) * 100)) + '%';
    track.appendChild(bar);
    const amount = document.createElement('span');
    amount.className = 'daily-amount';
    amount.textContent = currency(item.total_satang);
    wrapper.append(label, track, amount);
    node.appendChild(wrapper);
  }
}
function formatTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return String(value || '');
  return new Intl.DateTimeFormat('th-TH', {
    timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit'
  }).format(d);
}
function renderReport(value) {
  const summary = value.summary;
  $('metric-sales').textContent = currency(summary.total_satang);
  $('metric-orders').textContent = String(summary.sale_count);
  $('metric-cash').textContent = currency(summary.cash_satang);
  $('metric-transfer').textContent = currency(summary.transfer_satang);
  $('metric-grams').textContent = quantity(summary.quantity_mg);
  $('metric-average').textContent = currency(summary.average_satang);
  $('period-label').textContent = String(value.period.from) + ' ถึง ' + String(value.period.to);
  showDaily(value.daily);
  rows('top-products', value.top_products, (x) => [
    {value:String(x.name) + ' · ' + String(x.sku)},
    {value:currency(x.total_satang),right:true},
    {value:quantity(x.quantity_mg),right:true}
  ]);
  rows('top-categories', value.top_categories, (x) => [
    {value:x.category}, {value:currency(x.total_satang),right:true},
    {value:quantity(x.quantity_mg),right:true}
  ]);
  rows('low-stock-rows', value.low_stock, (x) => [
    {value:String(x.name) + ' · ' + String(x.sku)},
    {value:x.lot_code}, {value:quantity(x.quantity_mg),right:true},
    {value:x.expires_on || '—'}
  ], 'ไม่มีสินค้าเข้าเกณฑ์สต็อกต่ำ');
  rows('recent-sales', value.recent_sales, (x) => [
    {value:formatTime(x.created_at)},
    {value:String(x.id).slice(0,12), title:String(x.id)},
    {value:x.payment_method === 'cash' ? 'เงินสด':'โอน'},
    {value:String(x.line_count),right:true},
    {value:currency(x.total_satang),right:true}
  ]);
  $('export-csv').disabled = false;
}
async function loadReport() {
  if (busy || !store) return;
  const from = $('from-date').value;
  const to = $('to-date').value;
  let lowMg;
  try {
    verifyPeriod(from,to);
    lowMg = gramsToMgAllowZero($('low-stock').value);
  } catch (error) {
    banner(error.message, true);
    return;
  }
  setBusy(true);
  banner('กำลังอ่านรายงานจาก VPS...');
  try {
    const params = new URLSearchParams({
      'from':from, 'to':to, low_stock_mg:String(lowMg)
    });
    const data = await request('/v1/admin/sales-report?' + params.toString());
    report = data;
    renderReport(data);
    banner('โหลดรายงานสำเร็จ · ' + String(data.summary.sale_count) +
      ' บิล · เวลา Asia/Bangkok');
  } catch (error) {
    wipeReport();
    banner(error.message, true);
  } finally {
    setBusy(false);
  }
}
async function login(event) {
  event.preventDefault();
  if (busy) return;
  const base = normalizeApiBase($('api-base').value);
  if (!base) {
    banner('ต้องใช้ HTTPS API ที่ถูกต้อง ไม่มีชื่อผู้ใช้/รหัสผ่านใน URL', true);
    return;
  }
  endpoint = base;
  tokenStorageKey = tokenKey(endpoint);
  const email = $('email').value.trim();
  const password = $('password').value;
  setBusy(true);
  clearBanners();
  try {
    const auth = await request('/v1/auth/login',{
      method:'POST', body:{email,password}, authenticated:false
    });
    token = auth.token;
    await verifyRole(); // Always verify server role before exposing admin data.
    sessionStorage.setItem(tokenStorageKey,token);
    localStorage.setItem(endpointKey,endpoint);
    $('password').value = '';
  } catch (error) {
    if (token) {
      await request('/v1/auth/logout',{method:'POST',body:{}}).catch(() => {});
    }
    token = '';
    sessionStorage.removeItem(tokenStorageKey);
    store = null;
    wipeReport();
    authPanel(true);
    banner(error.message,true);
    connection('เชื่อมต่อไม่ได้',false);
  } finally {
    setBusy(false);
  }
  if (store) await loadReport();
}
async function logout() {
  if (busy) return;
  await request('/v1/auth/logout',{method:'POST',body:{}}).catch(() => {});
  token = '';
  sessionStorage.removeItem(tokenStorageKey);
  wipeReport();
  store = null;
  authPanel(true);
  connection('ออกจากระบบแล้ว',false);
  clearBanners();
}
function exportDaily() {
  if (!report) return;
  const csv = dailyCsv(report);
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = 'ramagan-sales-' + report.period.from + '-' + report.period.to + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
async function init() {
  $('footer-year').textContent = String(new Date().getFullYear());
  $('login-form').addEventListener('submit',login);
  $('logout').addEventListener('click',logout);
  $('filters').addEventListener('submit',(event) => {
    event.preventDefault();
    loadReport();
  });
  $('refresh').addEventListener('click',loadReport);
  $('export-csv').addEventListener('click',exportDaily);
  if (endpoint) $('api-base').value = endpoint;
  const now = bangkokDay();
  $('to-date').value = now;
  const earlier = new Date(Date.parse(now + 'T00:00:00+07:00') - 6 * 86400000);
  $('from-date').value = bangkokDay(earlier);
  tokenStorageKey = tokenKey(endpoint);
  token = endpoint ? sessionStorage.getItem(tokenStorageKey) || '' : '';
  if (token) {
    try {
      await verifyRole();
      await loadReport();
      return;
    } catch {
      token = '';
      sessionStorage.removeItem(tokenStorageKey);
      wipeReport();
    }
  }
  authPanel(true);
  connection('รอล็อกอิน',false);
}
init();
