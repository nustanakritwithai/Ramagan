// Unsubmitted count drafts are separate from submitted mutation intents. Blobs
// and upload UUIDs are committed in IndexedDB before any network request.
const DB = 'ramagan-stocktake-drafts-v1', STORE = 'drafts';
export const supportsEvidence = c => c?.stocktakes === true && c?.stocktake_contract_version === 2 &&
  c?.stocktake_evidence === true && c?.evidence_contract_version === 1;
export const draftScope = i => JSON.stringify([i.api, i.store, i.actor]);
export function validatePhoto(blob) {
  if (!blob || !['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) ||
      !Number.isSafeInteger(blob.size) || !blob.size || blob.size > 5 * 1024 * 1024) {
    throw new Error('เลือกรูป JPEG, PNG หรือ WebP ขนาดไม่เกิน 5 MB');
  }
}
export function createEvidenceDraft({indexedDB, identity, uuid}) {
  const key = draftScope(identity);
  let opened;
  const db = () => opened ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('อุปกรณ์นี้เก็บรูปแบบร่างไม่ได้ จึงยังส่งการนับไม่ได้'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('เปิดพื้นที่เก็บรูปไม่ได้ กรุณาตรวจสอบพื้นที่ว่างและสิทธิ์เบราว์เซอร์'));
  });
  async function transact(change) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, change ? 'readwrite' : 'readonly'), store = tx.objectStore(STORE);
      const request = store.get(key); let result, failure;
      request.onsuccess = () => {
        try {
          const current = request.result || null;
          if (current && (current.version !== 1 || draftScope(current.identity) !== key)) throw new Error('ข้อมูลแบบร่างไม่ถูกต้อง ให้ผู้จัดการตรวจสอบ');
          result = change ? change(current) : current;
          if (change) {if (result === null) store.delete(key); else store.put(result, key);}
        } catch (error) {failure = error; tx.abort();}
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || new Error('บันทึกแบบร่าง/รูปไม่ได้ ยังไม่ได้ส่งการนับ'));
    });
  }
  function requireDraft(draft) {if (!draft) throw new Error('ไม่พบแบบร่าง กรุณาเริ่มนับใหม่'); return draft;}
  return {key, read: () => transact(),
    ensure: (snapshot, meta) => transact(current => current || {version: 1, identity: {...identity}, id: uuid(),
      snapshot: snapshot.map(x => ({id: x.id, lot_code: x.lot_code, name: x.name, quantity_mg: x.quantity_mg,
        stock_revision: x.stock_revision})), counts: {}, photos: {}, shift_label: meta.shift_label, reason: meta.reason}),
    setCount: (lot, value) => transact(current => {
      const draft = requireDraft(current);
      if (draft.counts[lot] !== value) delete draft.photos[lot];
      draft.counts[lot] = value; return draft;
    }),
    setMeta: (field, value) => transact(current => {const d = requireDraft(current); d[field] = value; return d;}),
    invalidate: lot => transact(current => {const d=requireDraft(current);delete d.photos[lot];return d;}),
    select: (lot, blob) => {
      validatePhoto(blob);
      return transact(current => {const draft = requireDraft(current);
        if (!draft.counts[lot]?.trim()) throw new Error('กรอกยอดนับ Lot นี้ก่อนแนบรูปเครื่องชั่ง');
        draft.photos[lot] = {client_upload_id: uuid(), blob, counted_value: draft.counts[lot], metadata: null};
        return draft;
      });
    },
    uploaded: (lot, upload, metadata) => transact(current => {
      const draft = requireDraft(current), photo = draft.photos[lot];
      if (!photo || photo.client_upload_id !== upload || photo.counted_value !== draft.counts[lot] ||
          metadata.client_upload_id !== upload || metadata.client_stocktake_id !== draft.id || metadata.lot_id !== lot ||
          typeof metadata.evidence_id !== 'string') throw new Error('รูปหรือยอดนับเปลี่ยนไป กรุณาตรวจสอบรูปของ Lot นี้ใหม่');
      photo.metadata = metadata; return draft;
    }),
    clear: id => transact(current => {if (current && current.id !== id) throw new Error('แบบร่างเปลี่ยนไป ห้ามล้างรูปจากอีกรายการ'); return null;})
  };
}
