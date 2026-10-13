# Ramagan V1: Central Website + Android Application

Status: **Architecture approved for implementation, NOT APPROVED FOR LIVE SALES** (2026-10-13).

## Objective

One centrally authoritative back end for one retail location, with a responsive
website for the owner/manager and an Android app for staff. Share the SAME
frontend codebase (Vite + Capacitor), authentication and PostgreSQL data.

Keep the previous static prototype at the repository root until a safe migration
and cutover have passed all acceptance gates.

## Read-only audit of legacy V0 (main @ 693425f)

- V0 persists stock in browser localStorage. It cannot safely coordinate more
  than one device and browser data may disappear.
- The application init performs a demo seed migration. Its condition treating
  lots.length <= 5 as old demo data can clear and reseed real inventory.
- Cart checkout validates each line and then appends SALE events individually;
  failure mid-checkout may leave a partial sale.
- Local PIN roles are client-side UI controls, not server-enforced security.
- The legacy Google Drive merge is not a transactional inventory database.

**Do not use V0 as the production record of truth. No automatic migration of
real inventory without reconcile/sign-off.**

## Architecture

- apps/pos: responsive web app / installable PWA / Capacitor Android wrapper.
- Supabase project dedicated to Ramagan: PostgreSQL, Auth, row-level security.
- SQL checkout RPC is the only way to finalize a sale. The server authenticates
  the cashier, verifies store, stock, active lots and compliance gates; it writes
  sale, lines, decrement and append-only ledger inside one database transaction.
- Money is stored in satang integers; stock in milligrams (1 gram = 1000 mg).
- Client-generated UUID per checkout provides server idempotency across retries.
- Authenticated store membership is enforced in SQL, not merely in the UI.
- V1 initial scope: one store, online checkout, mobile-first, owner/manager/staff.
- Network loss: cached shell/read-only only. Never mark an offline sale as
  completed until central server acknowledges. Future offline mode needs a
  designed stock-allocation and conflict-resolution protocol.

## Regulatory and privacy gate

Before enabling live sales, verify current Thai cannabis business requirements
for THIS licensed location and product scope with the competent authority /
qualified legal professional. Store activation defaults to sales_enabled=false.
An authorization reference is **not validation** of a medical authorization.
The app must not claim legal compliance merely by collecting a text field.
Keep personally identifiable clinical information out of product and sale notes;
design proper retention, consent/access, encryption and deletion controls before
adding any patient records.

## Milestones and acceptance criteria

### M0 — Safe foundations
- [x] Preserve V0 on main; start V1 in a separate branch.
- [x] Architecture and safety constraints documented.
- [ ] Dedicated database project and environment configuration.
- [ ] Inventory migration plan: export, count, reconcile, sign off.
- [ ] Legal assessment of store operation and required source documents.

### M1 — Central data and access
- [ ] Apply and audit database schema, RLS policies and RPCs in a TEST project.
- [ ] Create real owner/staff accounts; verify staff cannot access manager data.
- [ ] Create products, receive lots, check availability in both clients.
- [ ] Test unauthorized access and cross-store isolation.

### M2 — Reliable checkout
- [ ] Atomic checkout tests: duplicate UUID, multi-line failure, concurrent sale.
- [ ] Network error/timeout and retry with same UUID.
- [ ] Receipt number, payment reconciliation and void/refund via compensating
      entries (never mutate history).
- [ ] End-of-shift cash count and inventory reconciliation.

### M3 — Mobile application
- [ ] Installable PWA with authenticated shell and explicit online status.
- [ ] Capacitor Android project generated and tested on physical devices.
- [ ] Secure native token storage and controlled automatic logout.
- [ ] Camera barcode and printer integration only after core reliability.

### M4 — Pilot and release
- [ ] Export/backup/restore rehearsal; privacy and role-authorization review.
- [ ] Test 100+ realistic checkouts and device/network failures.
- [ ] Parallel shadow trial with independently reconciled inventory.
- [ ] Disable sample/demo reset and seed in production.
- [ ] Signed Android APK/AAB and deployment process.

## Non-negotiable release gates

1. No unresolved production-data migration issue.
2. Multi-line checkout always all-or-nothing; no negative stock possible.
3. Identical retry ID cannot charge/decrement stock twice.
4. RLS denies cross-tenant access and revoked personnel.
5. At least one verified restore from backup, with retained audit history.
6. Applicable legal operating and recordkeeping requirements signed off.
7. Real Android device end-to-end install/sign-in/sale/receipt testing.

Status labels: PASS only with evidence, FAIL when broken, UNKNOWN until tested.