// A private local return address, never a credential or an upload queue. A
// returned photo can only replace the exact draft/row/request that launched it.
export const PHOTO_RETURN_KEY = 'ramagan.v1.photo-return.v1';
export function createPhotoReturn({storage, openDraft, prepare, readNative, uuid, runtime = uuid()}) {
  function read() {
    const raw = storage.getItem(PHOTO_RETURN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !['api', 'store', 'actor'].every(k => typeof value.identity?.[k] === 'string' && value.identity[k]) ||
        !['draftId', 'lot', 'request', 'runtime'].every(k => typeof value[k] === 'string' && value[k])) throw new Error('อ่านข้อมูลรูปที่กำลังกลับเข้าแอปไม่ได้');
    return value;
  }
  function clear(context) {
    if (read()?.request === context.request) storage.removeItem(PHOTO_RETURN_KEY);
  }
  async function complete(context, file, message = '') {
    let blob = null, problem = message;
    if (file) {
      try {blob = await prepare(file);} catch (error) {problem = error.message || 'เตรียมรูปไม่สำเร็จ กรุณาเลือกใหม่';}
    }
    const draft = await openDraft(context.identity).finishPhoto(context.lot, context.draftId, context.request, blob, problem);
    clear(context);
    return {context, draft, problem, selected: Boolean(blob)};
  }
  return {
    async begin({identity, draftId, lot, native = false}) {
      const context = {version: 1, identity: {...identity}, draftId, lot, request: uuid(), runtime};
      await openDraft(identity).beginPhoto(lot, context.request);
      if (native) {
        const value = JSON.stringify(context); storage.setItem(PHOTO_RETURN_KEY, value);
        if (storage.getItem(PHOTO_RETURN_KEY) !== value) throw new Error('บันทึกจุดกลับจากกล้องไม่ได้ กรุณาตรวจพื้นที่ว่าง');
      }
      return context;
    },
    complete,
    async restore(result) {
      if (result?.pluginId !== 'Camera' || result.methodName !== 'getPhoto') return null;
      const context = read();
      // Normal callbacks are handled by their original promise. Only a previous
      // runtime's return address may be used after Android recreates the app.
      if (!context || context.runtime === runtime) return null;
      if (!result.success) return complete(context, null, 'ไม่ได้รับรูปหลังกลับเข้าแอป กรุณาถ่ายหรือเลือกใหม่ รูปเดิมยังอยู่');
      let file;
      try {file = await readNative(result.data);} catch {return complete(context, null, 'อ่านรูปที่กลับเข้าแอปไม่ได้ กรุณาถ่ายหรือเลือกใหม่ รูปเดิมยังอยู่');}
      return complete(context, file);
    }
  };
}
