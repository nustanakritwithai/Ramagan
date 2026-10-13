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
export function money(satang) {
  const value = Number(satang);
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('th-TH', {
    style: 'currency', currency: 'THB'
  }).format(value / 100);
}
export function grams(mg) {
  const value = Number(mg);
  if (!Number.isFinite(value)) return '—';
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
export function dailyCsv(report) {
  const headings = ['วันที่', 'จำนวนบิล', 'ยอดขาย (บาท)', 'ตัดสต็อก (กรัม)'];
  const lines = [headings];
  for (const d of report?.daily || []) {
    lines.push([
      d.date,
      Number(d.sale_count),
      (Number(d.total_satang) / 100).toFixed(2),
      (Number(d.quantity_mg) / 1000).toFixed(3)
    ]);
  }
  return '\ufeff' + lines.map((line) => line.map(escapeCsvCell).join(',')).join('\r\n');
}
