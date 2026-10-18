// Integer-only inventory inputs and durable intent. Server roles and revisions
// remain authoritative; local storage never grants authority or stores tokens.
import {bahtToSatang} from './math.js';
import {supportsEvidence} from './evidence-draft.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (x, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x >= 0 && x <= max;
const fail = message => { throw new Error(message); };
export const supportsCosts = c => c?.inventory_costs === true && c?.cost_contract_version === 1;
export const supportsStocktakes = c => c?.stocktakes === true && [1, 2].includes(c?.stocktake_contract_version);
export const optionalDocuments = c => c?.optional_document_references === true && c?.document_contract_version === 1;
export function optionalCost(value) {
  if (typeof value !== 'string') fail('ระบุต้นทุนเป็นบาท');
  return value.trim() === '' ? null : bahtToSatang(value);
}
export function countedMilligrams(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(value.trim())) {
    fail('ยอดนับต้องเป็นกรัม 0–100,000 และไม่เกิน 3 ตำแหน่งทศนิยม');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const quantity = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (quantity > 100000000n) fail('ยอดนับต้องไม่เกิน 100,000 กรัม');
  return Number(quantity);
}
export function receivedMilligrams(value) {
  const quantity = countedMilligrams(value);
  if (!quantity) fail('จำนวนรับเข้าต้องมากกว่า 0 กรัม');
  return quantity;
}
export function signedGrams(value) {
  if (!Number.isSafeInteger(value)) fail('Invalid variance');
  const abs = BigInt(value < 0 ? -value : value);
  return (value > 0 ? '+' : value < 0 ? '−' : '') + (abs / 1000n).toString() +
    (abs % 1000n ? '.' + String(abs % 1000n).padStart(3, '0').replace(/0+$/, '') : '');
}
export const inventoryPendingKey = (identity, kind) => 'ramagan.v1.inventory.v1.' +
  encodeURIComponent(identity.api) + '.' + identity.store + '.' + identity.actor + '.' + kind;
export const mutationScopeKey = identity => 'ramagan.v1.mutation.v1.' + encodeURIComponent(identity.api) + '.' + identity.store;
export function assertNoPendingMutation(storage, identity) {
  const sale = 'ramagan.v1.pending.v2.' + encodeURIComponent(identity.api) + '.' + identity.store;
  const prefix = 'ramagan.v1.inventory.v1.' + encodeURIComponent(identity.api) + '.' + identity.store + '.';
  if (storage.getItem(sale) !== null || storage.getItem('ramagan.v1.pending.' + identity.store) !== null) {
    fail('มีรายการขายค้าง ต้องตรวจสอบรายการเดิมก่อนทำรายการใหม่');
  }
  if (!Number.isSafeInteger(storage.length) || storage.length < 0) fail('อ่านรายการสต็อกค้างในอุปกรณ์ไม่ได้');
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix) && !key.endsWith('.completed') && storage.getItem(key) !== null) {
      fail('มีรายการสต็อกค้างในร้านนี้ ต้องตรวจสอบด้วยบัญชีเดิมก่อนทำรายการใหม่');
    }
  }
}

function validatePayload(kind, p) {
  if (kind === 'stocktake') {
    if (!UUID.test(p?.client_stocktake_id) || typeof p.shift_label !== 'string' ||
        !p.shift_label.trim() || p.shift_label.length > 80 || typeof p.reason !== 'string' ||
        !p.reason.trim() || p.reason.length > 300 || !Array.isArray(p.items) ||
        p.items.length < 1 || p.items.length > 200 ||
        new Set(p.items.map(x => x.lot_id)).size !== p.items.length ||
        p.items.some(x => !UUID.test(x.lot_id) || !integer(x.expected_revision) ||
          !integer(x.counted_quantity_mg, 100000000))) fail('ข้อมูลนับสต็อกไม่ถูกต้อง กรุณาตรวจสอบก่อนส่ง');
  } else if (kind === 'receive') {
    if (!UUID.test(p?.client_receive_id) || !UUID.test(p.product_id) ||
        !integer(p.quantity_mg, 100000000) || !p.quantity_mg ||
        ![p.lot_code, p.supplier_name, p.reason].every(x => typeof x === 'string' && x.trim()) ||
        typeof p.supplier_document_ref !== 'string' || p.supplier_document_ref.length > 200 ||
        !(p.cost_satang_per_gram === null || integer(p.cost_satang_per_gram, 100000000))) {
      fail('ข้อมูลรับสินค้าไม่ถูกต้อง กรุณาตรวจสอบก่อนส่ง');
    }
  } else fail('Unknown inventory action');
}
function validateResult(kind, data, op) {
  const p = op.payload;
  if (kind === 'receive') {
    if (!UUID.test(data?.lot_id) || data.client_receive_id !== p.client_receive_id ||
        data.quantity_mg !== p.quantity_mg || typeof data.duplicate !== 'boolean' ||
        (p.cost_satang_per_gram !== null && data.cost_satang_per_gram !== p.cost_satang_per_gram) ||
        !(data.cost_satang_per_gram === null || integer(data.cost_satang_per_gram, 100000000))) {
      fail('คำตอบรับสินค้าไม่สมบูรณ์ ต้องตรวจสอบรายการเดิม');
    }
  } else {
    if (!UUID.test(data?.id) || data.client_stocktake_id !== p.client_stocktake_id ||
        data.actor_user_id !== op.identity.actor || data.shift_label !== p.shift_label || data.reason !== p.reason ||
        typeof data.duplicate !== 'boolean' || !Array.isArray(data.items) || data.items.length !== p.items.length ||
        new Set(data.items.map(x => x.lot_id)).size !== p.items.length) fail('คำตอบนับสต็อกไม่สมบูรณ์ ต้องตรวจสอบรายการเดิม');
    for (const item of data.items) {
      const requested = p.items.find(x => x.lot_id === item.lot_id);
      if (!requested || item.counted_quantity_mg !== requested.counted_quantity_mg ||
          (requested.evidence_id && item.evidence?.evidence_id !== requested.evidence_id) ||
          item.stock_revision_before !== requested.expected_revision ||
          item.stock_revision_after !== item.stock_revision_before + 1 ||
          !integer(item.system_quantity_mg) ||
          item.variance_mg !== item.counted_quantity_mg - item.system_quantity_mg) fail('ยอดนับยืนยันไม่ตรงกับรายการ ต้องตรวจสอบรายการเดิม');
    }
  }
  return data;
}

export function createInventoryOperation({storage, identity, kind, transport, uuid, lock}) {
  const key = inventoryPendingKey(identity, kind), completedKey = key + '.completed';
  let observed;
  try { observed = storage.getItem(completedKey); } catch { /* fail closed on read/start */ }
  function validate(op) {
    if (!op || op.version !== 1 || op.kind !== kind ||
        !['pending', 'confirmed', 'rejected'].includes(op.status) ||
        op.identity?.api !== identity.api || op.identity?.store !== identity.store ||
        op.identity?.actor !== identity.actor || typeof op.uncertain !== 'boolean') {
      fail('รายการสต็อกค้างไม่ถูกต้องหรือเป็นของบัญชีอื่น ให้ผู้จัดการตรวจสอบ');
    }
    validatePayload(kind, op.payload);
    if (op.status === 'confirmed') validateResult(kind, op.result, op);
    return op;
  }
  function read() {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return validate(JSON.parse(raw));
  }
  function persist(op) {
    validate(op);
    const text = JSON.stringify(op);
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) fail('บันทึกเลขอ้างอิงสต็อกไม่ได้ จึงยังไม่ส่งรายการ');
    return JSON.parse(text);
  }
  function exclusive(task) {
    if (!lock) fail('เบราว์เซอร์นี้ไม่รองรับการล็อกรายการอย่างปลอดภัย');
    return lock(key, task);
  }
  async function capabilities() {
    const c = await transport.capabilities(identity);
    if (!(kind === 'stocktake' ? supportsStocktakes(c) : supportsCosts(c))) {
      fail('เซิร์ฟเวอร์ยังไม่รองรับรายการสต็อกรุ่นนี้ ยังไม่ได้ส่งรายการ');
    }
  }
  function confirmed(data, op) {
    const result = validateResult(kind, data, op);
    return {result, op: persist({...op, status: 'confirmed', result})};
  }
  async function lookup(op, explicitReceiveVerification = false) {
    if (op.status === 'confirmed') return {result: validateResult(kind, op.result, op), op};
    if (op.status === 'rejected') return {rejected: true, op, error: new Error(op.rejection)};
    if (transport.lookup) {
      const found = await transport.lookup(op.payload.client_stocktake_id);
      if (found) return confirmed(found, op);
    }
    if (transport.reconcile && (kind === 'stocktake' || explicitReceiveVerification)) {
      const reconciliation = await transport.reconcile(op.payload);
      if (reconciliation?.status === 'completed') return confirmed(reconciliation.result, op);
      const field = kind === 'stocktake' ? 'client_stocktake_id' : 'client_receive_id';
      if (reconciliation?.[field] !== op.payload[field]) fail('เลขอ้างอิงผลตรวจสอบสต็อกไม่ตรงกับรายการ');
      if (reconciliation.status === 'rejected' && reconciliation.committed === false &&
          reconciliation.code === (kind === 'stocktake' ? 'STOCK_CHANGED' : 'RECEIVE_CANCELLED') &&
          typeof reconciliation.message === 'string') {
        const rejected = persist({...op, status: 'rejected', rejection: reconciliation.message});
        return {rejected: true, op: rejected, error: new Error(reconciliation.message)};
      }
      if (reconciliation.status !== 'pending') fail('ผลตรวจสอบรายการสต็อกไม่สมบูรณ์');
    }
    return {pending: true, op};
  }
  async function post(op) {
    await capabilities();
    if (JSON.stringify(read()) !== JSON.stringify(op)) fail('รายการสต็อกค้างเปลี่ยนไป ให้ตรวจสอบรายการเดิม');
    // Persist uncertainty before network IO, including process/browser crashes.
    const sending = persist({...op, uncertain: true});
    try { return confirmed(await transport.post(sending.payload), sending); }
    catch (error) {
      try { const found = await lookup(sending); if (found.result || found.rejected) return found; } catch { /* retain frozen intent */ }
      // A definitive first 4xx rejects this request. After any uncertain attempt,
      // keep the original UUID: a later rejection cannot erase an earlier commit.
      if (!op.uncertain && [400, 401, 403, 404, 409, 422].includes(error.status)) {
        return {rejected: true, error, op: persist({...sending, status: 'rejected', rejection: error.message})};
      }
      return {pending: true, error, op: sending};
    }
  }
  return {key,
    read: () => { const op = read(); observed = storage.getItem(completedKey); return op; },
    start: payload => exclusive(async () => {
      if (storage.getItem(completedKey) !== observed) fail('อีกหน้าต่างบันทึกสต็อกแล้ว กรุณารีโหลดยอดระบบ');
      if (read()) fail('มีรายการสต็อกค้าง ต้องตรวจสอบรายการเดิมก่อน');
      const c = await transport.capabilities(identity);
      if (kind === 'stocktake' && (!supportsEvidence(c) || !UUID.test(payload.client_stocktake_id) ||
          payload.items.some(x => !UUID.test(x.evidence_id)))) fail('ต้องมีรูปเครื่องชั่งครบทุก Lot และเซิร์ฟเวอร์รองรับหลักฐานรุ่น 2 ก่อนส่งการนับ');
      await capabilities();
      const idField = kind === 'stocktake' ? 'client_stocktake_id' : 'client_receive_id';
      const op = persist({version: 1, kind, status: 'pending', uncertain: false, identity: {...identity},
        payload: {...payload, [idField]: kind === 'stocktake' ? payload.client_stocktake_id : uuid()}});
      return post(op);
    }),
    retry: () => exclusive(async () => {
      const op = read(); if (!op) fail('ไม่พบรายการสต็อกค้าง');
      const found = await lookup(op);
      return found.result || found.rejected ? found : post(op);
    }),
    verify: () => exclusive(async () => { const op = read(); return op ? lookup(op, true) : null; }),
    acknowledge: () => exclusive(async () => {
      const op = read();
      if (!op || !['confirmed', 'rejected'].includes(op.status)) fail('ยังไม่มีผลยืนยัน ห้ามล้างรายการค้าง');
      const id = op.payload.client_stocktake_id || op.payload.client_receive_id;
      storage.setItem(completedKey, id);
      if (storage.getItem(completedKey) !== id) fail('บันทึกสถานะสต็อกไม่ได้');
      storage.removeItem(key);
      if (storage.getItem(key) !== null) fail('ล้างรายการสต็อกไม่ได้ ห้ามสร้างซ้ำ');
      observed = id;
    })
  };
}
