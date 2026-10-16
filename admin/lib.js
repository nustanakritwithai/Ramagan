// Pure formatting and validation for the public, data-free GitHub Pages UI.
// Sensitive sales records are never bundled here or written to localStorage.
export function normalizeApiBase(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password
        || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
export function isReportRole(role) {
  return role === 'owner' || role === 'manager';
}
// Refuse coercion: null, empty strings and unsafe JSON integers are unknown.
export function isAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
export function fixedUnits(value, digits = 2) {
  if (!isAmount(value)) return '—';
  const amount = BigInt(value);
  const scale = 10n ** BigInt(digits);
  return String(amount / scale) + '.' + String(amount % scale).padStart(digits, '0');
}
export function money(satang) {
  if (!isAmount(satang)) return '—';
  const [whole, fraction] = fixedUnits(satang).split('.');
  return '฿' + new Intl.NumberFormat('th-TH').format(BigInt(whole)) + '.' + fraction;
}
export function grams(mg) {
  const value = mg;
  if (!isAmount(value)) return '—';
  return new Intl.NumberFormat('th-TH', {
    maximumFractionDigits: 3
  }).format(value / 1000) + ' g';
}
export function gramsToMgAllowZero(value) {
  const s = String(value).trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(s)) {
    throw new Error('เกณฑ์สต็อกต้องเป็นจำนวนกรัม ไม่เกิน 3 ตำแหน่งทศนิยม');
  }
  const [whole, decimal = ''] = s.split('.');
  const quantity = Number(whole) * 1000 + Number(decimal.padEnd(3, '0'));
  if (!Number.isSafeInteger(quantity) || quantity > 1_000_000_000) {
    throw new Error('เกณฑ์สต็อกสูงเกินขนาดที่รองรับ');
  }
  return quantity;
}
export function bangkokDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const find = (type) => parts.find((p) => p.type === type)?.value;
  return [find('year'), find('month'), find('day')].join('-');
}
export function verifyPeriod(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('กรุณาเลือกช่วงวันที่');
  }
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0,10) !== from || new Date(b).toISOString().slice(0,10) !== to) throw new Error('วันที่ไม่ถูกต้อง');
  const days = (b - a) / 86400000 + 1;
  if (!Number.isInteger(days) || days < 1 || days > 93) {
    throw new Error('เลือกช่วงวันที่ 1–93 วันเท่านั้น');
  }
  return true;
}
export function escapeCsvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function supportsDiscounts(capabilities) {
  return capabilities?.discounts === true && capabilities?.discount_contract_version === 1;
}
function requireAmount(value) {
  if (!isAmount(value)) throw new Error('ข้อมูลรายงานไม่ครบหรือจำนวนเงินไม่ถูกต้อง กรุณาตรวจสอบ VPS');
  return value;
}
function moneyRow(row, supported, legacyGross = false) {
  if (!row || typeof row !== 'object') throw new Error('ข้อมูลรายงานไม่ครบจาก VPS');
  requireAmount(row.total_satang);
  if (supported) {
    requireAmount(row.subtotal_satang);
    requireAmount(row.discount_satang);
    if (BigInt(row.subtotal_satang) - BigInt(row.discount_satang) !== BigInt(row.total_satang)) {
      throw new Error('ยอดก่อนส่วนลด − ส่วนลด ไม่ตรงกับยอดสุทธิจาก VPS');
    }
  }
  return {...row,
    gross: supported ? row.subtotal_satang : legacyGross ? row.total_satang :
      isAmount(row.subtotal_satang) ? row.subtotal_satang : null,
    discount: supported ? row.discount_satang : null,
    net: supported ? row.total_satang : null
  };
}
// Validate an entire response before rendering anything. Never partially replace
// a previous snapshot with new totals or infer zero from absent fields.
export function prepareReport(data) {
  if (!data || data.period?.timezone !== 'Asia/Bangkok') throw new Error('เวลาในรายงาน VPS ไม่ใช่ Asia/Bangkok');
  verifyPeriod(data.period.from, data.period.to);
  for (const key of ['daily','top_products','top_categories','low_stock','recent_sales']) {
    if (!Array.isArray(data[key])) throw new Error('ข้อมูลรายงานไม่ครบจาก VPS: ' + key);
  }
  const supported = supportsDiscounts(data.capabilities);
  const summary = moneyRow(data.summary, supported);
  for (const key of ['sale_count','cash_satang','transfer_satang','quantity_mg','average_satang']) requireAmount(summary[key]);
  const daily = data.daily.map(row => {
    requireAmount(row.sale_count); requireAmount(row.quantity_mg);
    if (typeof row.date !== 'string' || row.date < data.period.from || row.date > data.period.to) throw new Error('วันที่รายงานไม่ตรงกับช่วงที่เลือก');
    return moneyRow(row, supported);
  });
  const expectedDays = (Date.parse(data.period.to) - Date.parse(data.period.from)) / 86400000 + 1;
  if (daily.length !== expectedDays || new Set(daily.map(row => row.date)).size !== expectedDays) throw new Error('รายวันไม่ครบหรือมีวันที่ซ้ำจาก VPS');
  if (supported) {
    if (BigInt(summary.cash_satang) + BigInt(summary.transfer_satang) !== BigInt(summary.net)) throw new Error('ยอดช่องทางชำระไม่ตรงกับยอดสุทธิ');
    if (BigInt(summary.average_satang) !== (summary.sale_count ? BigInt(summary.net) / BigInt(summary.sale_count) : 0n)) throw new Error('ยอดสุทธิเฉลี่ยไม่ตรงจาก VPS');
    for (const key of ['total_satang','subtotal_satang','discount_satang','sale_count','quantity_mg']) {
      if (daily.reduce((sum,row) => sum + BigInt(row[key]), 0n) !== BigInt(summary[key])) throw new Error('ยอดรายวันไม่ตรงกับยอดรวมจาก VPS');
    }
  }
  return {...data, supported, summary, daily,
    top_products: data.top_products.map(row => moneyRow(row, supported, true)),
    top_categories: data.top_categories.map(row => moneyRow(row, supported, true)),
    recent_sales: data.recent_sales.map(row => moneyRow(row, supported))
  };
}
export function dailyCsv(report) {
  const headings = ['วันที่ (Asia/Bangkok)', 'จำนวนบิล', 'ก่อนส่วนลด (บาท)', 'ส่วนลด (บาท)', 'สุทธิ (บาท)', 'ตัดสต็อก (กรัม)', 'สถานะส่วนลด'];
  const lines = [headings];
  const supported = supportsDiscounts(report?.capabilities);
  for (const d of report?.daily || []) {
    lines.push([
      d.date,
      isAmount(d.sale_count) ? d.sale_count : '—',
      fixedUnits(d.subtotal_satang),
      supported ? fixedUnits(d.discount_satang) : '—',
      supported ? fixedUnits(d.total_satang) : '—',
      fixedUnits(d.quantity_mg, 3),
      supported ? 'contract v1' : 'ไม่รองรับ / ไม่ทราบ'
    ]);
  }
  return '\ufeff' + lines.map((line) => line.map(escapeCsvCell).join(',')).join('\r\n');
}
