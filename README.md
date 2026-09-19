# Cannabis Stock Ledger V0 / สมุดสต็อกกัญชา V0

Local-only prototype for Thai cannabis **retail stock ledger** with retrospective (as-of) balance checks.  
โปรโตไทป์ใช้ในเครื่องเท่านั้น — ไม่มีเซิร์ฟเวอร์ ไม่มี GitHub deploy

**Owners:** Tanakrit (lead) · Ai CPU WEB (stock rules/audit) · New Bot (UI later) · aaa01 (schema)

---

## How to open / วิธีเปิด

### English

1. On the box, files live at: `/workspace/cannabis-pos-v0/`
2. Copy the folder to your Desktop (or open it from the shared box path if your Desktop can reach it).
3. Double-click **`index.html`** — it opens in your browser via `file://`.
4. Or from a terminal:
   ```bash
   # Linux / macOS example
   xdg-open /workspace/cannabis-pos-v0/index.html
   # or
   open /workspace/cannabis-pos-v0/index.html
   ```
5. No install, no build, no server. Scripts are plain `<script src>` (not ES modules) so `file://` works.

### ภาษาไทย

1. ไฟล์อยู่ที่ `/workspace/cannabis-pos-v0/` บนเครื่อง box
2. คัดลอกโฟลเดอร์ไปที่ **Desktop** (หรือเปิดจาก path ที่ Desktop เข้าถึงได้)
3. ดับเบิลคลิก **`index.html`** ให้เปิดในเบราว์เซอร์ (`file://`)
4. หรือเปิดจากเทอร์มินัลด้วยคำสั่งด้านบน
5. ไม่ต้องติดตั้ง ไม่ต้อง build — ใช้ได้ทันทีออฟไลน์

ข้อมูลเก็บใน `localStorage` ของเบราว์เซอร์ (คีย์ `cannabis-pos-v0`)

---

## What’s included / สิ่งที่มาด้วย

| File | Role |
|------|------|
| `index.html` | UI shell |
| `styles.css` | Dark retail admin theme |
| `schema.md` | Data model for aaa01 |
| `js/store.js` | localStorage load/save |
| `js/ledger.js` | `createLot`, `appendEvent`, `balanceAt`, `balanceAllAt`, `validateSale` |
| `js/app.js` | Forms + **sales cashier** + as-of report + event log |
| `js/drive.js` | Google Drive OAuth + append-only auto-sync / conflict UI |
| `docs/DRIVE_SYNC.md` | How to set OAuth Client ID (Thai + EN) |
| `README.md` | This file |

---

## Sales cashier / หน้าพนักงานขาย

Thin storefront UI for staff sales — wraps the existing immutable ledger (`validateSale` → `appendEvent` type `SALE`).  
หน้าขายหน้าร้านแบบบาง ๆ — ไม่ใช่ POS เต็ม / ไม่มีชำระเงิน / CRM / พิมพ์ใบเสร็จ

1. Open tab **หน้าพนักงานขาย / Sales**
2. Pick a lot with **remaining > 0**, enter qty, `actor_user_id` (default `cashier`), optional note
3. Press the big **ขาย / Sell** button
4. Oversell is blocked with a clear Thai error (`ขายเกินคงเหลือ …`)
5. After a sale, lots / event log refresh; **As-of** remains the primary audit view

Locked event fields: `occurred_at` · `qty_delta` · `actor_user_id`

```bash
node tests/ledger.smoke.mjs
```

---

## Seed demo / ข้อมูลตัวอย่าง

On first open, 3 lots + events are seeded:

| Lot | Product | After seed (approx now) |
|-----|---------|-------------------------|
| LOT-OGK-001 | ดอก OG Kush | 87 g (100 − 15 sale + 2 adjust) |
| LOT-CBD-002 | น้ำมัน CBD 10% | 22 pcs |
| LOT-GEL-003 | กัมมี่เจลลี่ THC | 47 pcs |

**As-of tip:** set report time to **2026-09-13 12:00** → OG Kush should show **85 g** (before the Sep 16 +2 adjust).

Use **รีเซ็ต / Re-seed** in the header to clear and reload sample data.

---

## Invariants (locked)

- Events are **immutable** (no edit/delete in UI — compensate with new events)
- Balance at T = sum of `qty_delta` with `occurred_at <= T` per lot
- Never sell more than remaining
- Every event: `actor_user_id`, `reason`, `occurred_at` (SQL field standard; also `qty_delta`)
- Types: `RECEIVE`, `SALE`, `ADJUST`, `DESTROY`, `TRANSFER_IN`, `TRANSFER_OUT`

---

## Path when done

```
/workspace/cannabis-pos-v0/
```
