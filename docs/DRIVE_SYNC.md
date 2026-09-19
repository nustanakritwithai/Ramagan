# Google Drive sync / ซิงค์ Google Drive

Thai + English · Client ID only — **never commit secrets / client secrets**.

## English

### What syncs
- After OAuth connect, Ramagan creates/finds **`Ramagan/ledger.json`** on the signed-in Drive (app-owned via `drive.file`).
- Snapshot shape: `{ version, lots, events, products, meta, updated_at }`.
- **Append-only events**: never overwrite/delete existing events; merge by `event_id`.
- **Debounced auto-upload** (~3s) after local ledger changes.
- **Offline OK**: sell locally; push/merge when back online.
- **Conflict** (no auto-guess): if each side has events the other lacks, **or** same `event_id` with different payload → modal:
  - Keep local
  - Keep remote
  - Merge union + keep local on id conflicts
  - Merge union + keep remote on id conflicts
- Status badge: connected / syncing / conflict / last sync (Bangkok).

### Set OAuth Web Client ID
1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials.
2. Create **OAuth client ID** → Application type **Web application**.
3. **Authorized JavaScript origins**: your GitHub Pages URL, e.g. `https://nustanakritwithai.github.io` (and `http://localhost` / `http://127.0.0.1` for local).
4. Enable **Google Drive API** for the project.
5. Copy the **Client ID** only (not the client secret — unused for GIS token client).

### Wire Client ID into Ramagan (no secrets in git)
Option A — before app scripts (Pages / local):
```html
<script>window.RAMAGAN_GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com";</script>
```
Option B — browser console / bookmarklet:
```js
localStorage.setItem('ramagan-google-client-id', 'YOUR_CLIENT_ID.apps.googleusercontent.com');
location.reload();
```
`index.html` ships with an empty `window.RAMAGAN_GOOGLE_CLIENT_ID` placeholder — safe to commit.

### Manual sync
Header **อัป Drive** runs `syncNow` (download → merge → upload). Auto-upload pauses while a conflict modal is open.

---

## ภาษาไทย

### สิ่งที่ซิงค์
- หลังเชื่อม OAuth จะสร้าง/หาไฟล์ **`Ramagan/ledger.json`** ใน Google Drive
- ส่ง snapshot ทั้งก้อน `{ lots, events, products, meta, updated_at }`
- **เหตุการณ์ append-only**: ไม่ลบ/เขียนทับ event เดิม — รวมด้วย `event_id`
- เปลี่ยน local แล้ว **debounce ~3 วินาที** ค่อยอัป
- **ออฟไลน์ได้**: ขายบนเครื่องก่อน แล้วค่อยดันขึ้นเมื่อมีเน็ต
- **ขัดแย้ง**: ถ้าแต่ละฝั่งมี event ที่อีกฝั่งไม่มี หรือ id เดียวกันคนละเนื้อหา → **ไม่เดาเอง** เปิด modal ให้เลือก Keep local / Keep remote / Merge

### ตั้ง Client ID
1. Google Cloud Console → Credentials → สร้าง OAuth client แบบ **Web**
2. Authorized JavaScript origins = URL ของ GitHub Pages
3. เปิด Google Drive API
4. ใส่ Client ID ผ่าน `window.RAMAGAN_GOOGLE_CLIENT_ID` หรือ `localStorage['ramagan-google-client-id']`
5. **ห้าม commit** client secret

### ทดสอบโดยไม่ใช้ OAuth จริง
```bash
node tests/drive-merge.smoke.mjs
```
