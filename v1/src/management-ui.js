// Shared presentation for the compact stocktake and receiving screens.
// Values are escaped here so names, Lot codes and statuses stay plain text.
export function managementEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

export function inventoryTaskSummary({title, subtitle = '', badge = '+'}) {
  return '<span class="management-task-icon" aria-hidden="true">' + managementEscape(badge) + '</span>' +
    '<span class="management-task-copy"><strong>' + managementEscape(title) + '</strong>' +
    (subtitle ? '<small>' + managementEscape(subtitle) + '</small>' : '') + '</span>';
}

export function countEvidenceSummary({lotId, hasPhoto = false, uploaded = false, counted = false}) {
  const status = uploaded ? 'พร้อมส่ง' : hasPhoto ? 'มีรูป · รออัปโหลด' : counted ? 'ต้องแนบรูป' : 'ยังไม่แนบรูป';
  return '<span class="count-evidence-title">รูปตราชั่ง</span><span class="count-evidence-status' +
    (uploaded ? ' ready' : '') + '" data-evidence-status="' + managementEscape(lotId) + '">' +
    managementEscape(status) + '</span>';
}

// Quantity is a plain number of grams; cost/value are formatted plain text, never HTML.
export function inventoryStockRow({name, lotCode, quantity, cost = '', value = '', expired = false, inactive = false}) {
  const flags = [expired ? 'หมดอายุ' : '', inactive ? 'ไม่ใช้งาน' : ''].filter(Boolean);
  return '<article class="inventory-stock-row"><span class="inventory-stock-icon" aria-hidden="true">' +
    managementEscape(Array.from(String(name || '?'))[0].toLocaleUpperCase('th-TH')) + '</span>' +
    '<div class="inventory-stock-copy"><strong>' + managementEscape(name) + '</strong><small>Lot ' +
    managementEscape(lotCode) + '</small>' +
    (flags.length ? '<small class="inventory-stock-flags">' + flags.map(flag => '<span>' + managementEscape(flag) + '</span>').join('') + '</small>' : '') +
    (cost !== '' ? '<small class="inventory-stock-cost">ต้นทุน/กรัม ' + managementEscape(cost) + '</small>' : '') +
    '</div><div class="inventory-stock-quantity"><strong>' + managementEscape(quantity) +
    '</strong><small>กรัม</small>' + (value !== '' ? '<small>มูลค่า ' + managementEscape(value) + '</small>' : '') +
    '</div></article>';
}
