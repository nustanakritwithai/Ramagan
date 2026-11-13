import {countedMilligrams} from './inventory.js';

// Only normalize exact, unambiguous representations. Never round, strip units,
// or guess whether a comma denotes a decimal point or a thousands separator.
export function stocktakeMilligrams(value) {
  if (typeof value !== 'string') return countedMilligrams(value);
  let text = value.trim().replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 0x0e50))
    .replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10)).replace(/．/g, '.');
  if (/^\.\d+$/.test(text)) text = '0' + text;
  if (/^\d+\.$/.test(text)) text = text.slice(0, -1);
  if (/^\d+\.\d+$/.test(text)) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return countedMilligrams(text);
}

export function countInputIssues(lots, counts) {
  const byId = new Map(lots.map(row => [row.id, row]));
  const issues = [];
  for (const [lotId, value] of counts) {
    if (typeof value === 'string' && !value.trim()) continue;
    try {stocktakeMilligrams(value);} catch (error) {
      const message = String(value).includes(',') ?
        'มีเครื่องหมายคอมมา: ใช้จุดสำหรับทศนิยม เช่น 12.345 และไม่ใส่เครื่องหมายคั่นหลักพัน' :
        error.message;
      issues.push({lotId, value: String(value), message, row: byId.get(lotId)});
    }
  }
  return issues;
}

// A partly finished row never prevents another ready row from being submitted.
// Keep the exact unfinished input and photo in the draft; never assume zero.
export function stocktakeSelection(counts, draft, currentLots) {
  const items = [], remaining = [];
  const savedLots = new Map((draft?.snapshot || []).map(row => [row.id, row]));
  const liveLots = new Map((currentLots || []).map(row => [row.id, row]));
  const ids = new Set([...counts.keys(), ...Object.keys(draft?.photos || {})]);
  for (const lot_id of ids) {
    const value = counts.get(lot_id) || '', photo = draft?.photos?.[lot_id], lot = savedLots.get(lot_id);
    if (!String(value).trim() && !photo) continue;
    let message = '', counted_quantity_mg;
    if (!String(value).trim()) message = 'มีรูปแล้ว ยังไม่กรอกยอดนับ';
    else {
      try { counted_quantity_mg = stocktakeMilligrams(value); }
      catch { message = 'ยอดนับยังไม่ถูกต้อง'; }
      if (!message && draft?.counts?.[lot_id] !== value) message = 'กำลังเก็บยอดนับในเครื่อง';
      if (!message && (!lot || !Number.isSafeInteger(lot.stock_revision) || lot.stock_revision < 0 ||
        liveLots.get(lot_id)?.stock_revision !== lot.stock_revision)) message = 'ยอดระบบเปลี่ยน ต้องตรวจนับรายการนี้ใหม่';
      if (!message && !photo?.metadata?.evidence_id) message = photo?.blob ? 'มีรูปแล้ว รออัปโหลด' : 'ยังไม่แนบรูปเครื่องชั่ง';
      if (!message && items.length >= 200) message = 'เก็บไว้ส่งรอบถัดไป (ครั้งละไม่เกิน 200 รายการ)';
    }
    if (message) remaining.push({lotId: lot_id, message});
    else items.push({lot_id, expected_revision: lot.stock_revision, counted_quantity_mg, evidence_id: photo.metadata.evidence_id});
  }
  return {items: items.sort((a,b) => a.lot_id.localeCompare(b.lot_id)), remaining};
}
