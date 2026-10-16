# RAMAGAN V1 — Backend Phase 2: Flexible Discount

Review branch: `codex/v1-flexible-discount`
Base: `feat/v1-central-web-mobile` at `9c59899c1ec74c66e89a2dbd2c83445634e9418e`
SQLite schema version: **2** (`PRAGMA user_version`). Discount contract version: **1**.

This branch is a review candidate. It has not been merged or installed on the
Windows VPS. The installed API must continue to be treated as the old backend
until a separately approved migration/release and authenticated runtime checks
prove the capability. No VPS restart, Caddy reload, shop database mutation or
sales activation is part of this change. No `v1/src/` or `admin/` files change.

## Release files

A future approved release must include app.py, discounts.py, migrations.py and
reports.py as one compatible release, plus a verified schema-version-2 database.
The pinned requirements are unchanged. Installing only the former two-file
CORS/report patch is insufficient. Use the final reviewed commit, not an
intermediate commit in this branch.

## Client contract

The client must hide discounts unless authenticated `GET /v1/me` returns:

```json
{"capabilities":{"discounts":true,"discount_contract_version":1}}
```

This is a top-level object alongside the existing `user`, `store_id`, `role`
and `store`. Store sales activation and authorization requirements still apply.

`POST /v1/sales` accepts the existing fields plus optional `discount_satang`.
Omission means integer zero. A supplied value must be a JSON integer;
boolean, decimal, string and null are rejected with HTTP 422. Its supported
range is 0–5,000,000,000,000 satang, and it must not exceed the server subtotal.
Prices, rounding and stock quantities remain server-authoritative.

Example synthetic request (the IDs refer only to a disposable test fixture):

```json
{
  "client_sale_id": "11111111-1111-4111-8111-111111111111",
  "items": [
    {"lot_id": "22222222-2222-4222-8222-222222222222", "quantity_mg": 1000},
    {"lot_id": "33333333-3333-4333-8333-333333333333", "quantity_mg": 1000}
  ],
  "payment_method": "transfer",
  "authorization_ref": "FIXTURE-ONLY",
  "discount_satang": 17550
}
```

For server prices of 10,000 and 20,000 satang per gram, the new response is:

```json
{
  "sale_id": "44444444-4444-4444-8444-444444444444",
  "client_sale_id": "11111111-1111-4111-8111-111111111111",
  "subtotal_satang": 30000,
  "discount_satang": 17550,
  "total_satang": 12450,
  "duplicate": false
}
```

An identical retry returns those **stored** IDs/amounts with `duplicate: true`;
it does not recalculate current price, stock, product activity or the sales gate.
Item order and trimmed authorization references are normalized. Omitted discount
and explicit zero have identical meaning. Reusing the UUID with a changed
discount, quantity, payment method or document reference conflicts.

`GET /v1/sales/by-client/{client_sale_id}` preserves the old `id` field:

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "client_sale_id": "11111111-1111-4111-8111-111111111111",
  "subtotal_satang": 30000,
  "discount_satang": 17550,
  "total_satang": 12450
}
```

The original hash is preserved by migration. A zero-discount retry may match
that exact original fingerprint, with the original cashier and payload.
A nonzero discount cannot use the legacy-hash fallback.

## Stored allocation and transaction

Existing duplicate lot IDs are consistently rejected with HTTP 422. Unique
lots are sorted by canonical lot ID. Each line's gross amount uses the existing
integer half-up rule `(price_satang_per_gram * quantity_mg + 500) // 1000`.

For subtotal S, bill discount D and line gross G, allocate `(D * G) // S`.
Distribute the remaining satang by descending `(D * G) % S`, then ascending
lot ID for ties. No floating-point money is used. A zero-gross receipt accepts
only discount zero; zero-price lines receive no discount. Full discounts work.

Storage:

| Table | Field | Meaning |
|---|---|---|
| sales | subtotal_satang | Receipt gross |
| sales | discount_satang | Receipt discount, default 0 |
| sales | total_satang | Receipt net |
| sale_lines | line_subtotal_satang | Line gross |
| sale_lines | line_discount_satang | Allocated line discount, default 0 |
| sale_lines | line_total_satang | Allocated line net |

Bill/line CHECK constraints enforce nonnegative discounts and gross =
discount + net. The sum of line discounts equals the bill discount; the sum of
line net amounts equals the bill net. Stock deductions always use quantity_mg.

The existing `BEGIN IMMEDIATE`, store/cashier/document/stock checks,
conditional balance deduction, receipt, lines and ledger remain one transaction.
Injected failures after the first deduction, first line and first ledger event
must restore every row and the previous balance timestamp.

## Report contract and permissions

`GET /v1/admin/sales-report` retains `period`, `summary`, `daily`,
`recent_sales`, `top_products`, `top_categories`, `low_stock` and
`capabilities`. All existing `total_satang` values are net.

- `summary`: subtotal_satang, discount_satang, total_satang; cash_satang and
  transfer_satang are net. Existing sale_count, quantity_mg and average_satang
  remain.
- `daily`: date, subtotal_satang, discount_satang, total_satang, sale_count,
  quantity_mg.
- `recent_sales`: id, created_at, subtotal_satang, discount_satang,
  total_satang, payment_method, line_count, quantity_mg.
- `top_products`: sku, name, category, quantity_mg, subtotal_satang,
  discount_satang, total_satang, sale_count.
- `top_categories`: category, quantity_mg, subtotal_satang, discount_satang,
  total_satang.
- `capabilities`: discounts=true, discount_contract_version=1,
  promotions=false, shift_reconciliation=false.

Rankings use stored allocation, ordered by net total. Top lists retain their
limit of ten and recent sales retain their limit of thirty; limited lists need
not sum to the complete receipt summary. Dates use Asia/Bangkok with a maximum
inclusive range of 93 days. All report queries share one SQLite read snapshot.
Low stock remains a current-stock query independent of the receipt date range.
Owner/Manager can read reports for their store; Staff gets 403, anonymous gets
401. Another tenant cannot see this store's sales or stock.

## Error contract

No new machine-readable error-code property is introduced. Handled/business
errors retain `{"detail":"..."}`; Pydantic validation returns its usual detail
list. An unhandled 500 may have the framework plain-text body, so clients must
keep a generic status-based fallback.

| HTTP | Trigger / existing detail |
|---|---|
| 401 | Missing, invalid or expired authentication |
| 403 | Sales are not activated for this store |
| 403 | Checkout belongs to another cashier |
| 403 | Staff report access / prohibited sale lookup |
| 404 | Sale not found in actor's store |
| 409 | Checkout ID reused with different payload |
| 409 | Insufficient stock / Concurrent stock change |
| 422 | Invalid discount type/range; Discount exceeds sale subtotal |
| 422 | Duplicate lot in one checkout |
| 422 | Missing document; unavailable/expired lot; invalid server price |
| 500 | Unexpected database failure; complete checkout rollback |

Clients should use the HTTP status and existing detail structure. They must not
assume every 422 response has the same shape.

## Offline migration and rollback rehearsal

The application factory initializes a **fresh** database atomically. An existing
legacy/partial/unproved database raises `SchemaUpgradeRequired` before DDL.
It does not silently upgrade a store at import or service startup.

Migration accepts verified legacy schemas with user_version 0 or 1. Before DDL,
under `BEGIN IMMEDIATE`, it proves every old subtotal equals total and every
line sum equals subtotal. Any mismatch produces HOLD with counts/reasons;
it never guesses or rewrites the old receipt amounts. It adds the fields,
backfills only new line gross values from old line totals, restores the exact
line immutability trigger, verifies old fields/IDs/hashes/FKs/indexes/triggers,
then sets user_version 2. A second execution is NOOP.

The following commands are for a **previously prepared offline/test copy only**.
Choose a private directory outside the repository, web root and known service
directories. Do not copy an active SQLite file with plain Copy-Item; use a
consistent SQLite backup under a separately approved operations plan.
These commands require Python with the candidate dependencies, run from
`backend/vps`, and do not import the app or use its default database path.

```powershell
python migrations.py inspect --db "D:\PrivateRamaganRehearsal\shop-copy.sqlite3"
python migrations.py migrate-copy --db "D:\PrivateRamaganRehearsal\shop-copy.sqlite3" --backup-dir "D:\PrivateRamaganRehearsal\backups" --confirm OFFLINE_TEST_COPY_ONLY
python migrations.py inspect --db "D:\PrivateRamaganRehearsal\shop-copy.sqlite3"
python migrations.py restore-copy --backup "D:\PrivateRamaganRehearsal\backups\ramagan-before-v2-REPLACE_WITH_REPORTED_ID.sqlite3" --out "D:\PrivateRamaganRehearsal\restored-before-v2.sqlite3" --confirm OFFLINE_TEST_COPY_ONLY
```

The migration command records a consistent backup SHA256 and proves an offline
restore matches all schema objects and rows before the migration. Restore
always writes a **new** target and refuses overwrite. Backups contain account
and session hashes; retain private ACLs/encryption and never commit or publish
them. The command does not claim off-host backup or production recovery.

JSON statuses: READY/FRESH/PASS/NOOP exit 0; HOLD/UPGRADE_REQUIRED exit 2.
UPGRADE_REQUIRED from inspect is expected for a valid legacy copy.
If migration fails, its entire DDL/data/version transaction rolls back. If
rehearsal must be discarded, use the new restored-before-v2 copy with the old
backend code. There is no automatic down-migration or live database overwrite.

Actual migration, release-file installation, FastAPI restart or any Caddy
configuration change requires a new reviewed diff, backup/recovery plan and
explicit owner approval. Keep actual/default sales_enabled=0. Production sales
activation requires its own Release Gate and explicit sales_enabled=1 approval.

## Verification evidence

The backend suite includes integer allocation, strict input boundaries, API
idempotency/concurrency/fault rollback, migrated legacy retries, report SQL/day/
tenant/snapshot reconciliation, migration first/second/fault/HOLD/restore, and
real Uvicorn TCP acceptance. CI runs the suite on Windows and Linux.

Real HTTP acceptance runs on an ephemeral 127.0.0.1 listener and a disposable
SQLite fixture, with Owner/Manager/Staff accounts generated only for that
fixture. The fixture proves /me capability, sales/lookup/duplicate wire values,
SQL gross/discount/net, report roles and exact allowed-origin/preflight headers.
The fixture UTC clock is fixed so the wire test cannot race midnight.
Optional RAMAGAN_DISCOUNT_HTTP_EVIDENCE writes only nonsecret response evidence.

Candidate runtime readiness and CI results are reported with the final commit
and Draft PR. Unit tests alone do not establish installed capability readiness.
The current VPS remains unchanged and needs separately approved live acceptance.
Android/Admin discount UI acceptance is UNKNOWN until the other team's client
and an approved backend release are tested together.
