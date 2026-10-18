import {
  normalizeApiBase, isReportRole, money, grams, gramsToMgAllowZero,
  bangkokDay, verifyPeriod, dailyCsv, prepareReport, profitMoney, costCoverage
} from './lib.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_API = 'https://157.85.96.139/ramagan-api';
let endpoint = normalizeApiBase(DEFAULT_API) || '';
let token = '';
let store = null;
let reportRole = '';
let authEpoch = 0;
let report = null;
let busy = false;
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
  $('api-check-button').disabled = value;
  $('refresh').disabled = value;
  $('logout').disabled = value;
  for (const id of ['from-date', 'to-date', 'low-stock']) $(id).disabled = value;
}
function wipeReport() {
  report = null;
  for (const id of ['metric-gross', 'metric-discount', 'metric-sales', 'metric-orders', 'metric-cash',
    'metric-transfer', 'metric-grams', 'metric-average', 'metric-known-cost', 'metric-cost', 'metric-profit', 'period-label']) {
    $(id).textContent = '—';
  }
  for (const id of ['daily-chart', 'daily-rows', 'top-products', 'top-categories',
    'low-stock-rows', 'recent-sales']) $(id).replaceChildren();
  $('export-csv').disabled = true;
  $('discount-status').textContent = 'ยังไม่มีรายงานที่ยืนยันจาก VPS';
  $('cost-status').textContent = 'ยังไม่มีรายงานต้นทุนที่ยืนยันจาก VPS';
}
function clearAuthenticatedState() {
  authEpoch++;
  token = '';
  store = null;
  reportRole = '';
  wipeReport();
  $('store-info').textContent = '';
  $('sales-gate').textContent = '';
  $('sales-gate').classList.remove('enabled');
  authPanel(true);
}
function setHealthLink(base) {
  const link = $('health-open-link');
  if (!link) return;
  if (!base) {
    link.removeAttribute('href');
    link.hidden = true;
    return;
  }
  link.href = base + '/health';
  link.hidden = false;
}

// Health is intentionally public/read-only. It never sends a username,
// password, Authorization header or token from memory.
async function probeHealth(base) {
  try {
    const response = await fetch(base + '/health', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(12000),
      headers: {'Accept': 'application/json'}
    });
    if (!response.ok) return {ok:false, reason:'HTTP ' + response.status};
    const body = await response.json().catch(() => null);
    if (body?.status !== 'ok') return {ok:false, reason:'ไม่พบ status: ok'};
    return {ok:true};
  } catch (err) {
    return {ok:false, reason:err?.name === 'TimeoutError' ?
      'หมดเวลารอคำตอบ' : 'เบราว์เซอร์ปฏิเสธการเชื่อมต่อ (CORS/TLS/เครือข่าย)'};
  }
}

async function diagnoseApi() {
  if (busy) return;
  const base = normalizeApiBase($('api-base').value);
  if (!base) {
    setHealthLink(null);
    banner('โปรดกรอก HTTPS API Base ที่ถูกต้องก่อน', true);
    return;
  }
  setHealthLink(base);
  setBusy(true);
  clearBanners();
  try {
    const result = await probeHealth(base);
    if (result.ok) {
      banner('GET /health ผ่านแล้ว (200/status: ok) แต่การเข้าสู่ระบบยังต้องผ่าน CORS preflight สำหรับ POST JSON และการตรวจสิทธิ์บน VPS');
    } else {
      banner('GET /health ผ่านเบราว์เซอร์ไม่สำเร็จ: ' + result.reason +
        ' — เปิดลิงก์ Health Check ด้านล่าง หากเปิดได้แต่ตรวจจากหน้านี้ไม่ได้ ให้ตรวจ CORS ที่ VPS', true);
    }
  } finally {
    setBusy(false);
  }
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
  } catch (cause) {
    const err = new Error('เชื่อมต่อ VPS ไม่สำเร็จ ตรวจสอบ HTTPS, CORS และเครือข่าย');
    err.kind = 'transport';
    err.endpoint = path.split('?')[0];
    err.timeout = cause?.name === 'TimeoutError';
    throw err;
  }
  let data = null;
  try { data = await response.json(); } catch { /* Non-JSON API response. */ }
  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && authenticated) {
      clearAuthenticatedState();
      connection(response.status === 401 ? 'Session หมดอายุ' : 'เฉพาะเจ้าของร้านเท่านั้น', false);
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
  const epoch = authEpoch;
  const me = await request('/v1/me');
  if (epoch !== authEpoch) throw new Error('กรุณาเข้าสู่ระบบ Owner ใหม่');
  if (!isReportRole(me.role)) {
    const error = new Error('บัญชีนี้ไม่มีสิทธิ์ Admin: เฉพาะเจ้าของร้าน (Owner) เท่านั้น');
    error.kind = 'authorization';
    throw error;
  }
  reportRole = me.role;
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
  if (daily.some(row => row.net === null)) {
    node.textContent = 'กราฟสุทธิยังไม่รองรับ: VPS ไม่ได้ยืนยัน discount contract v1';
    return;
  }
  const max = Math.max(1, ...daily.map((row) => Number(row.net) || 0));
  for (const item of daily) {
    const wrapper = document.createElement('div');
    wrapper.className = 'daily-row';
    const label = document.createElement('span');
    label.textContent = String(item.date);
    const track = document.createElement('div');
    track.className = 'daily-track';
    const bar = document.createElement('div');
    bar.className = 'daily-bar';
    const value = Number(item.net) || 0;
    bar.style.width = Math.min(100, Math.max(0, (value / max) * 100)) + '%';
    track.appendChild(bar);
    const amount = document.createElement('span');
    amount.className = 'daily-amount';
    amount.textContent = currency(item.net);
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
function costColumns(row) {
  return [
    {value:currency(row.cost),right:true},
    {value:profitMoney(row.profit),right:true},
    {value:costCoverage(row)}
  ];
}
function renderReport(value) {
  const summary = value.summary;
  $('metric-gross').textContent = currency(summary.gross);
  $('metric-discount').textContent = currency(summary.discount);
  $('metric-sales').textContent = currency(summary.net);
  $('discount-status').textContent = value.supported ?
    'VPS รองรับส่วนลด contract v1 · ยอดสุทธิ = ก่อนส่วนลด − ส่วนลด · สุทธิรายสินค้ากระจายโดย VPS' :
    'VPS ยังไม่ยืนยันส่วนลด contract v1 · ช่องส่วนลดและสุทธิแสดง — (ไม่ทราบ ไม่ใช่ศูนย์) · สินค้า API เดิมเป็นยอดก่อนส่วนลด';
  $('metric-orders').textContent = String(summary.sale_count);
  $('metric-cash').textContent = currency(value.supported ? summary.cash_satang : null);
  $('metric-transfer').textContent = currency(value.supported ? summary.transfer_satang : null);
  $('metric-grams').textContent = quantity(summary.quantity_mg);
  $('metric-average').textContent = currency(value.supported ? summary.average_satang : null);
  $('metric-known-cost').textContent = currency(summary.knownCost);
  $('metric-cost').textContent = currency(summary.cost);
  $('metric-profit').textContent = profitMoney(summary.profit);
  $('cost-status').textContent = !value.costsSupported ?
    'VPS ยังไม่ยืนยัน inventory_costs / cost contract v1 พร้อมยอดสุทธิ discount contract v1 · ต้นทุนและกำไรแสดง —' :
    summary.costComplete ?
      'ต้นทุนครบ · กำไรขั้นต้นหลังส่วนลด = ยอดสุทธิ − ต้นทุนขายที่บันทึกตอนขาย · ไม่รวมค่าใช้จ่ายอื่นหรือผลปรับยอดนับสต็อก' :
      costCoverage(summary) + ' · ต้นทุนขายรวมและกำไรแสดง — เพราะข้อมูลประวัติไม่ครบ';
  $('period-label').textContent = String(value.period.from) + ' ถึง ' + String(value.period.to);
  showDaily(value.daily);
  rows('daily-rows', value.daily, x => [
    {value:x.date}, {value:x.sale_count,right:true},
    {value:currency(x.gross),right:true}, {value:currency(x.discount),right:true},
    {value:currency(x.net),right:true}, ...costColumns(x)
  ]);
  rows('top-products', value.top_products, (x) => [
    {value:String(x.name) + ' · ' + String(x.sku)},
    {value:currency(x.gross),right:true},
    {value:currency(x.discount),right:true},
    {value:currency(x.net),right:true},
    {value:quantity(x.quantity_mg),right:true}, ...costColumns(x)
  ]);
  rows('top-categories', value.top_categories, (x) => [
    {value:x.category}, {value:currency(x.gross),right:true},
    {value:currency(x.discount),right:true},
    {value:currency(x.net),right:true},
    {value:quantity(x.quantity_mg),right:true}, ...costColumns(x)
  ]);
  rows('low-stock-rows', value.low_stock, (x) => [
    {value:String(x.name) + ' · ' + String(x.sku)},
    {value:x.lot_code}, {value:quantity(x.quantity_mg),right:true},
    {value:x.expires_on || '—'}
  ], 'ไม่มีสินค้าเข้าเกณฑ์สต็อกต่ำ');
  rows('recent-sales', value.recent_sales, (x) => [
    {value:formatTime(x.created_at)},
    {value:String(x.id).slice(0,12), title:String(x.id)},
    {value:x.payment_method === 'cash' ? 'เงินสด' : x.payment_method === 'transfer' ? 'โอน' : x.payment_method === 'split' ? 'เงินสด + โอน' : 'ไม่ทราบ'},
    {value:String(x.line_count),right:true},
    {value:currency(x.gross),right:true},
    {value:currency(x.discount),right:true},
    {value:currency(x.net),right:true}, ...costColumns(x)
  ]);
  $('export-csv').disabled = false;
}
async function loadReport() {
  if (busy || !store || !isReportRole(reportRole)) return;
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
  wipeReport();
  connection('กำลังอัปเดตรายงาน', false);
  banner('กำลังอ่านรายงานจาก VPS...');
  const epoch = authEpoch;
  try {
    // A previous Owner check does not authorize a later refresh or role change.
    // The report endpoint also enforces Owner access independently on the VPS.
    await verifyRole();
    const params = new URLSearchParams({
      'from':from, 'to':to, low_stock_mg:String(lowMg)
    });
    const data = await request('/v1/admin/sales-report?' + params.toString());
    if (epoch !== authEpoch || !isReportRole(reportRole)) return;
    const prepared = prepareReport(data);
    if (prepared.period.from !== from || prepared.period.to !== to) throw new Error('ช่วงวันที่จาก VPS ไม่ตรงกับคำขอ');
    renderReport(prepared);
    report = prepared;
    connection('รายงานยืนยันจาก VPS แล้ว', true);
    banner('โหลดรายงานสำเร็จ · ' + String(data.summary.sale_count) +
      ' บิล · เวลา Asia/Bangkok');
  } catch (error) {
    if (error.kind === 'authorization') {
      const revoke = request('/v1/auth/logout', {method:'POST', body:{}}).catch(() => {});
      clearAuthenticatedState();
      await revoke;
    }
    wipeReport();
    connection('รายงานไม่พร้อมใช้งาน', false);
    banner(error.message, true);
  } finally {
    setBusy(false);
  }
}
async function login(event) {
  event.preventDefault();
  if (busy) return;
  clearAuthenticatedState();
  const base = normalizeApiBase($('api-base').value);
  if (!base) {
    banner('ต้องใช้ HTTPS API ที่ถูกต้อง ไม่มีชื่อผู้ใช้/รหัสผ่านใน URL', true);
    return;
  }
  endpoint = base;
  setHealthLink(endpoint);
  const email = $('email').value.trim();
  const password = $('password').value;
  setBusy(true);
  clearBanners();
  const epoch = authEpoch;
  try {
    const auth = await request('/v1/auth/login',{
      method:'POST', body:{email,password}, authenticated:false
    });
    if (epoch !== authEpoch) return;
    token = auth.token;
    await verifyRole(); // Always verify server role before exposing admin data.
    $('password').value = '';
  } catch (error) {
    if (token) {
      await request('/v1/auth/logout',{method:'POST',body:{}}).catch(() => {});
    }
    clearAuthenticatedState();
    if (error.kind === 'transport') {
      const probe = await probeHealth(endpoint);
      const operation = error.endpoint === '/v1/me' ?
        'GET /v1/me (Authorization)' :
        error.endpoint === '/v1/auth/login' ?
          'POST /v1/auth/login (JSON)' : 'คำขอ API';
      const preflight = error.endpoint === '/v1/me' ?
        'OPTIONS /v1/me (Authorization)' :
        'OPTIONS /v1/auth/login (Content-Type)';
      banner(probe.ok ?
        'GET /health ผ่าน แต่ ' + operation + ' ยังไม่สำเร็จ: ให้ VPS ตรวจ ' +
          preflight + ' และ CORS Origin https://nustanakritwithai.github.io' :
        'เชื่อมต่อ VPS ไม่สำเร็จ: ' + probe.reason +
        ' — ลองเปิด Health Check ในแท็บใหม่เพื่อตรวจใบรับรอง HTTPS จากนั้นให้ VPS ตรวจ CORS', true);
    } else {
      banner(error.message, true);
    }
    connection('เชื่อมต่อไม่ได้',false);
  } finally {
    setBusy(false);
  }
  if (store) await loadReport();
}
async function logout() {
  if (busy) return;
  setBusy(true);
  const revoke = request('/v1/auth/logout',{method:'POST',body:{}}).catch(() => {});
  clearAuthenticatedState();
  await revoke;
  connection('ออกจากระบบแล้ว',false);
  clearBanners();
  setBusy(false);
}
function exportDaily() {
  if (!report || !isReportRole(reportRole)) return;
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
  $('api-check-button').addEventListener('click', diagnoseApi);
  $('logout').addEventListener('click',logout);
  $('filters').addEventListener('submit',(event) => {
    event.preventDefault();
    loadReport();
  });
  $('refresh').addEventListener('click',loadReport);
  for (const id of ['from-date', 'to-date', 'low-stock']) {
    $(id).addEventListener('input', () => {
      if (!store || busy) return;
      wipeReport();
      connection('เปลี่ยนตัวกรองแล้ว · รออัปเดต', false);
      banner('ตัวกรองเปลี่ยนแล้ว กรุณาแสดงรายงานใหม่');
    });
  }
  $('export-csv').addEventListener('click',exportDaily);
  // Do not retain Owner reports in the back/forward page cache.
  window.addEventListener('pagehide', () => {
    clearAuthenticatedState();
    clearBanners();
    connection('รอล็อกอิน', false);
  });
  if (endpoint) {
    $('api-base').value = endpoint;
    setHealthLink(endpoint);
  }
  $('api-base').addEventListener('input', () =>
    setHealthLink(normalizeApiBase($('api-base').value)));
  const now = bangkokDay();
  $('to-date').value = now;
  const earlier = new Date(Date.parse(now + 'T00:00:00+07:00') - 6 * 86400000);
  $('from-date').value = bangkokDay(earlier);
  // GitHub Pages project paths share a site origin; never persist bearer tokens.
  // Every new page load requires a fresh login to this in-memory session.

  authPanel(true);
  connection('รอล็อกอิน',false);
}
init();
