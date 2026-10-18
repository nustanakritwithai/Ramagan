// Durable checkout intent only. Never a local sales ledger or an auth-token store.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const amount = x => Number.isSafeInteger(x) && x >= 0;
const fail = message => { throw new Error(message); };
export const pendingKey = identity => 'ramagan.v1.pending.v2.' + encodeURIComponent(identity.api) + '.' + identity.store;
export function supportsDiscount(capabilities) {
  return capabilities?.discounts === true && capabilities?.discount_contract_version === 1;
}
export const supportsSplitPayments = c => c?.split_payments === true && c?.payment_contract_version === 1;
export const supportsSaleReconciliation = c => c?.sale_reconciliation === true && c?.sale_reconciliation_contract_version === 1;
export function validatePayments(payments, total, split) {
  if (!Array.isArray(payments) || payments.length !== (split ? 2 : 1) ||
      payments.some(x => !['cash', 'transfer'].includes(x.payment_method) || !amount(x.amount_satang) || (split && !x.amount_satang)) ||
      new Set(payments.map(x => x.payment_method)).size !== payments.length ||
      payments.reduce((n,x)=>n+BigInt(x.amount_satang),0n) !== BigInt(total)) fail('ยอดชำระเงินไม่ตรงกับยอดสุทธิ');
  return [...payments].sort((a,b)=>a.payment_method.localeCompare(b.payment_method));
}
export function validateOperation(op, identity) {
  if (!op || op.version !== 2 || !['pending', 'confirmed', 'rejected'].includes(op.status) ||
      !op.identity || op.identity.api !== identity.api || op.identity.store !== identity.store ||
      op.identity.cashier !== identity.cashier) fail('รายการค้างเป็นของบัญชีหรือเซิร์ฟเวอร์อื่น ต้องให้ผู้จัดการตรวจสอบ');
  const p = op.payload;
  if (!p || !UUID.test(p.client_sale_id) || !Array.isArray(p.items) || !p.items.length ||
      !['cash', 'transfer', 'split'].includes(p.payment_method) || !amount(p.discount_satang) ||
      !(p.authorization_ref === null || (typeof p.authorization_ref === 'string' && p.authorization_ref.length <= 120)) ||
      !amount(op.preview_subtotal_satang) || p.discount_satang > op.preview_subtotal_satang ||
      p.items.some(x => !UUID.test(x.lot_id) || !Number.isSafeInteger(x.quantity_mg) || x.quantity_mg <= 0 || x.quantity_mg > 1000000) ||
      new Set(p.items.map(x => x.lot_id)).size !== p.items.length) fail('ข้อมูลรายการค้างไม่ถูกต้อง ห้ามส่งซ้ำ กรุณาให้ผู้จัดการตรวจสอบ');
  if (p.payment_method === 'split') validatePayments(p.payments, op.preview_subtotal_satang-p.discount_satang, true);
  else if (p.payments !== undefined) fail('ข้อมูลการชำระเงินของรายการค้างไม่ถูกต้อง');
  if (op.status === 'confirmed') normalizeSale(op.sale, op);
  return op;
}
export function normalizeSale(data, op) {
  if (!data || typeof (data.sale_id || data.id) !== 'string' || !(data.sale_id || data.id)) fail('คำตอบขายไม่สมบูรณ์ ต้องตรวจสอบรายการเดิม');
  if (data.client_sale_id !== undefined && data.client_sale_id !== op.payload.client_sale_id) fail('เลขอ้างอิงคำตอบไม่ตรงกับรายการ');
  if (data.store_id !== undefined && data.store_id !== op.identity.store) fail('ร้านในคำตอบไม่ตรงกับรายการ');
  const requested = op.payload.discount_satang;
  const legacy = data.discount_satang === undefined && requested === 0;
  const total = data.total_satang;
  // Explicit old-server zero-discount compatibility; never infer a discounted bill.
  const subtotal = legacy ? (data.subtotal_satang ?? total) : data.subtotal_satang;
  const discount = legacy ? 0 : data.discount_satang;
  if (![subtotal, discount, total].every(amount) || discount !== requested || discount > subtotal || subtotal - discount !== total) fail('ยอดยืนยันจากเซิร์ฟเวอร์ไม่ถูกต้อง ต้องตรวจสอบรายการเดิม');
  if (op.payload.payment_method === 'split') {
    if (data.payment_method !== 'split' || JSON.stringify(validatePayments(data.payments,total,true)) !==
        JSON.stringify(validatePayments(op.payload.payments,total,true))) fail('ส่วนแบ่งเงินสดและโอนที่เซิร์ฟเวอร์ยืนยันไม่ตรงกับรายการ');
  } else if (data.payments !== undefined) {
    const payments = validatePayments(data.payments,total,false);
    if (data.payment_method !== op.payload.payment_method || payments[0].payment_method !== op.payload.payment_method) fail('วิธีชำระเงินที่ยืนยันไม่ตรงกับรายการ');
  }
  return {...data, sale_id: data.sale_id || data.id, subtotal_satang: subtotal, discount_satang: discount, total_satang: total, legacy_zero: legacy || data.legacy_zero === true};
}
export function createCheckout({storage, identity, transport, lock, uuid}) {
  const key = pendingKey(identity);
  const revisionKey = key + '.completed';
  let observedRevision;
  try { observedRevision = storage.getItem(revisionKey); } catch { /* read/start reports unavailable storage */ }
  function read() {
    const raw = storage.getItem(key);
    if (!raw) {
      const legacy = storage.getItem('ramagan.v1.pending.' + identity.store);
      if (legacy) fail('พบเลขรายการค้างรุ่นเก่า ' + (UUID.test(legacy) ? legacy : '(รูปแบบเลขอ้างอิงไม่ถูกต้อง)') + ' ที่ไม่ทราบเซิร์ฟเวอร์/บัญชี ห้ามส่งใหม่ ให้ผู้จัดการตรวจสอบกับระบบเดิมและปิดรายการด้วยตนเอง');
      return null;
    }
    return validateOperation(JSON.parse(raw), identity);
  }
  function persist(op) {
    validateOperation(op, identity);
    const text = JSON.stringify(op);
    storage.setItem(key, text);
    if (storage.getItem(key) !== text) fail('บันทึกรายการค้างไม่สำเร็จ จึงยังไม่ส่งขาย');
    return JSON.parse(text);
  }
  const exclusive = task => {
    if (!lock) fail('เบราว์เซอร์นี้ไม่มีระบบล็อกรายการอย่างปลอดภัย กรุณาใช้รุ่นที่รองรับ Web Locks');
    return lock(key, task);
  };
  async function confirmed(data, op) {
    const sale = normalizeSale(data, op);
    persist({...op, status: 'confirmed', sale});
    return {sale, op};
  }
  async function lookup(op) {
    if (op.status === 'confirmed') return {sale: normalizeSale(op.sale, op), op};
    if(op.status==='rejected')return {rejected:true,op,error:new Error(op.rejection)};
    const data = await transport.lookup(op.payload.client_sale_id);
    return data ? confirmed(data, op) : {pending: true, op};
  }
  async function post(op) {
    const capabilities = await transport.capabilities(identity);
    if (op.payload.discount_satang > 0 && !supportsDiscount(capabilities)) fail('เซิร์ฟเวอร์ยังไม่รองรับส่วนลดรุ่นนี้ ยังไม่ได้ส่งขาย');
    if (op.payload.payment_method === 'split' && !supportsSplitPayments(capabilities)) fail('เซิร์ฟเวอร์ยังไม่รองรับการชำระเงินสดร่วมกับเงินโอน');
    // Recheck durable bytes and ownership immediately before transmitting.
    if (JSON.stringify(read()) !== JSON.stringify(op)) fail('รายการค้างเปลี่ยนไป กรุณาตรวจสอบก่อน');
    try { return await confirmed(await transport.post(op.payload), op); }
    catch (error) {
      // A later rejection says nothing about an earlier timed-out commit.
      try { const result = await lookup(op); if (result.sale) return result; } catch { /* retain intent */ }
      return {pending: true, op, error};
    }
  }
  return {
    key, read: () => { const op = read(); observedRevision = storage.getItem(revisionKey); return op; },
    start: (payload, preview) => exclusive(async () => {
      if (storage.getItem(revisionKey) !== observedRevision) fail('มีรายการเสร็จจากอีกหน้าต่าง กรุณารีเฟรชก่อนสร้างรายการใหม่');
      if (read()) fail('มีรายการค้าง ต้องตรวจสอบรายการเดิมก่อน');
      if (payload.discount_satang > 0 && !supportsDiscount(await transport.capabilities(identity))) fail('เซิร์ฟเวอร์ยังไม่รองรับส่วนลดรุ่นนี้ ยังไม่ได้ส่งขาย');
      if (payload.payment_method === 'split' && !supportsSplitPayments(await transport.capabilities(identity))) fail('เซิร์ฟเวอร์ยังไม่รองรับการชำระเงินสดร่วมกับเงินโอน');
      const op = persist({version: 2, status: 'pending', identity: {...identity},
        payload: {...payload, client_sale_id: uuid()}, preview_subtotal_satang: preview});
      return post(op);
    }),
    retry: () => exclusive(async () => {
      const op = read(); if (!op) fail('ไม่พบรายการค้าง');
      const found = await lookup(op); return found.sale || found.rejected ? found : post(op);
    }),
    verify: () => exclusive(async () => {
      const op=read(); if(!op)return null;
      if(op.status==='rejected')return {rejected:true,op,error:new Error(op.rejection)};
      const found=await lookup(op); if(found.sale)return found;
      const caps=await transport.capabilities(identity);
      if(!transport.reconcile||!supportsSaleReconciliation(caps))return found;
      const answer=await transport.reconcile(op.payload);
      if(answer?.status==='completed')return confirmed(answer.result,op);
      if(answer?.status==='rejected'&&answer.client_sale_id===op.payload.client_sale_id&&
          answer.code==='SALE_CANCELLED'&&answer.committed===false){
        persist({...op,status:'rejected',rejection:answer.message||'ยกเลิกรายการที่ยังไม่บันทึกแล้ว'});
        return {rejected:true,op,error:new Error(answer.message||'ยกเลิกรายการที่ยังไม่บันทึกแล้ว')};
      }
      fail('ผลตรวจสอบรายการขายไม่สมบูรณ์ เก็บรายการเดิมไว้');
    }),
    acknowledge: () => exclusive(async () => {
      const op = read(); if (!op || !['confirmed','rejected'].includes(op.status)) fail('ยังไม่มีผลยืนยันให้ปิดรายการ');
      storage.setItem(revisionKey, op.payload.client_sale_id);
      if (storage.getItem(revisionKey) !== op.payload.client_sale_id) fail('บันทึกสถานะจบรายการไม่ได้');
      storage.removeItem(key);
      if (storage.getItem(key) !== null) fail('ล้างรายการยืนยันไม่ได้ ห้ามสร้างรายการใหม่');
      observedRevision = op.payload.client_sale_id;
    })
  };
}
