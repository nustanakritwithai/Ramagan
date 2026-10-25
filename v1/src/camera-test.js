// Isolated, synthetic-only camera test page. Deliberately has no API imports,
// network client, sale controls, stock controls, or upload implementation.
export const TEST_DB_NAME = 'ramagan-camera-test-v1';
export const TEST_DB_STORE = 'photos';
export const TEST_PHOTO_KEY = 'latest';
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateTestPhoto(file) {
  if (!file || !allowedTypes.has(file.type) || !Number.isSafeInteger(file.size) ||
      file.size <= 0 || file.size > 5 * 1024 * 1024) {
    throw new Error('เลือกภาพ JPEG, PNG หรือ WebP ขนาดไม่เกิน 5 MB');
  }
}

export function createTestPhotoStore(indexedDB) {
  let opening;
  const database = () => opening ||= new Promise((resolve, reject) => {
    if (!indexedDB) return reject(new Error('อุปกรณ์นี้ไม่มี IndexedDB สำหรับเก็บรูปทดสอบ'));
    const request = indexedDB.open(TEST_DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(TEST_DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('เปิดที่เก็บรูปทดสอบไม่ได้'));
  });
  return {
    async read() {
      const db = await database();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TEST_DB_STORE, 'readonly');
        const request = tx.objectStore(TEST_DB_STORE).get(TEST_PHOTO_KEY);
        let value;
        request.onsuccess = () => { value = request.result || null; };
        request.onerror = () => reject(new Error('อ่านรูปทดสอบไม่ได้'));
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(new Error('อ่านรูปทดสอบไม่ได้'));
      });
    },
    async save(file) {
      validateTestPhoto(file);
      const db = await database();
      const value = {version: 1, blob: file, mime: file.type, size: file.size, savedAt: Date.now()};
      return new Promise((resolve, reject) => {
        const tx = db.transaction(TEST_DB_STORE, 'readwrite');
        const photos = tx.objectStore(TEST_DB_STORE);
        photos.put(value, TEST_PHOTO_KEY);
        const verify = photos.get(TEST_PHOTO_KEY);
        verify.onsuccess = () => {
          if (verify.result?.version !== value.version || verify.result?.blob?.size !== value.size ||
              verify.result?.mime !== value.mime) {
            reject(new Error('ยืนยันรูปทดสอบที่บันทึกไม่ได้'));
            tx.abort();
          }
        };
        verify.onerror = () => reject(new Error('ยืนยันรูปทดสอบที่บันทึกไม่ได้'));
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(new Error('บันทึกรูปทดสอบในเครื่องไม่ได้'));
      });
    }
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export async function mountCameraTest({root, indexedDB, URL: urlApi}) {
  if (!root) throw new Error('ไม่พบพื้นที่แสดงโหมดทดสอบ');
  const store = createTestPhotoStore(indexedDB);
  let previewUrl = '';
  root.innerHTML = `<main class="camera-test-shell">
    <header class="camera-test-header">
      <span class="camera-test-mark">TEST ONLY</span>
      <h1>ทดสอบกล้อง Ramagan</h1>
      <p>โหมดสังเคราะห์สำหรับตรวจกล้องและการเก็บรูปในเครื่องนี้</p>
    </header>
    <section class="camera-test-warning" role="note">ไม่เชื่อมต่อ API ของร้าน ไม่มีข้อมูลลูกค้าหรือรายการขาย และไม่ส่งรูปขึ้นเซิร์ฟเวอร์ รูปทดสอบจะอยู่ในแอป TEST นี้เท่านั้น</section>
    <div class="camera-test-actions">
      <button type="button" data-test-photo-trigger="camera">ถ่ายรูปทดสอบ</button>
      <button type="button" data-test-photo-trigger="file">เลือกไฟล์ทดสอบ</button>
    </div>
    <input class="visually-hidden" type="file" data-test-photo-source="camera" accept="image/*" capture="environment" aria-label="ถ่ายรูปทดสอบ" />
    <input class="visually-hidden" type="file" data-test-photo-source="file" accept="image/jpeg,image/png,image/webp" aria-label="เลือกไฟล์ทดสอบ" />
    <section class="camera-test-preview" data-test-preview aria-label="ตัวอย่างรูปทดสอบ"><span>ยังไม่มีรูปทดสอบที่บันทึกไว้</span></section>
    <p class="camera-test-status" data-test-status role="status" aria-live="polite">กำลังอ่านรูปทดสอบที่บันทึกในแอปนี้…</p>
    <p class="camera-test-footnote">ใช้วัตถุทดสอบที่ไม่มีข้อมูลลูกค้าหรือข้อมูลร้านจริง การยกเลิกหรือปฏิเสธสิทธิ์จะไม่ลบรูปเดิม</p>
  </main>`;
  const preview = root.querySelector('[data-test-preview]');
  const status = root.querySelector('[data-test-status]');
  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.dataset.error = String(isError);
  };
  const show = async record => {
    if (previewUrl) urlApi.revokeObjectURL?.(previewUrl);
    previewUrl = '';
    if (!record?.blob) {
      preview.innerHTML = '<span>ยังไม่มีรูปทดสอบที่บันทึกไว้</span>';
      return;
    }
    previewUrl = urlApi.createObjectURL(record.blob);
    preview.innerHTML = `<img src="${escapeHtml(previewUrl)}" alt="รูปทดสอบที่บันทึกในเครื่อง โดยไม่ส่งไปเซิร์ฟเวอร์" />`;
    const when = new Date(record.savedAt).toLocaleString();
    preview.insertAdjacentHTML('beforeend', `<span class="camera-test-meta">เก็บในแอป TEST นี้ · ${escapeHtml(record.mime)} · ${record.size} bytes · ${escapeHtml(when)}</span>`);
  };
  try {
    const saved = await store.read();
    await show(saved);
    setStatus(saved ? 'โหลดรูปทดสอบเดิมจากที่เก็บในเครื่องแล้ว' : 'พร้อมทดสอบ; ยังไม่มีการเชื่อมต่อเซิร์ฟเวอร์');
  } catch (error) {
    setStatus(error.message, true);
  }
  for (const button of root.querySelectorAll('[data-test-photo-trigger]')) {
    button.addEventListener('click', () => {
      const input = root.querySelector(`[data-test-photo-source="${button.dataset.testPhotoTrigger}"]`);
      input.value = '';
      try { input.click(); } catch { setStatus('เปิดกล้องหรือเลือกไฟล์ไม่ได้; รูปเดิมยังอยู่', true); }
    });
  }
  for (const input of root.querySelectorAll('[data-test-photo-source]')) {
    const cancelled = () => setStatus('ยกเลิกหรือไม่ได้เลือกไฟล์; เก็บรูปเดิมไว้');
    input.addEventListener('cancel', cancelled);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return cancelled();
      try {
        validateTestPhoto(file);
        const saved = await store.save(file);
        await show(saved);
        setStatus('บันทึกรูปทดสอบไว้ในแอป TEST แล้ว; ไม่ได้ส่งไปเซิร์ฟเวอร์');
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }
  return {store, dispose() { if (previewUrl) urlApi.revokeObjectURL?.(previewUrl); }};
}

if (typeof document !== 'undefined' && document.getElementById('camera-test-root')) {
  mountCameraTest({root: document.getElementById('camera-test-root'), indexedDB: window.indexedDB, URL: window.URL})
    .catch(error => {
      const root = document.getElementById('camera-test-root');
      if (root) root.textContent = `เปิดโหมดทดสอบไม่ได้: ${error.message}`;
    });
}
