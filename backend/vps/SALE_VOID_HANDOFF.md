# Completed receipt voids — contract 1

This source adds API `1.5.0-vps-preview`, schema 6 and additive capabilities
`sale_voids=true`, `sale_void_contract_version=1` in `/health`, `/v1/me` and
the sales report. Source and fixture tests do not prove an installed VPS or APK
is running this contract; verify the installed health response and actual client
separately after an explicitly approved deployment.

## Request and recovery

Only an active Owner or Manager in the sale's store may submit:

```http
POST /v1/sales/{sale_id}/void
Authorization: Bearer <memory-only session>
Content-Type: application/json

{"client_void_id":"11111111-1111-4111-8111-111111111111","reason":"Wrong completed receipt"}
```

`client_void_id` is a durable client-generated UUID. `reason` is a strict string
of 1–300 characters, trimmed and nonblank. Extra fields are rejected. Do not
generate a new UUID if the result is uncertain. Query
`GET /v1/sale-voids/by-client/{client_void_id}` or resend the same POST payload.
Lookup 404 means no committed void was visible at that read; a delayed original
POST could still commit. Retry the original UUID rather than assuming rejection.

Successful POST/lookup returns these fields:

- `id`, `client_void_id`, `sale_id`, `client_sale_id`, `status="voided"`, `duplicate`.
- `actor_user_id`, `actor_email`, `actor_role`, `created_at`, normalized `reason`.
- Original `subtotal_satang`, `discount_satang`, `total_satang`, `payment_method`,
  `payments` (`payment_method`, `amount_satang` per allocation).
- `restored_items`: `sale_line_id`, `lot_id`, `quantity_mg`, `quantity_before_mg`,
  `quantity_after_mg`, `stock_revision_before`, `stock_revision_after`,
  `inventory_delta_satang`, `ledger_event_id` per original line.

Lookup and an identical retry return `duplicate=true` and the original actor,
time, reason, amounts and restoration snapshot. Any currently authorized
Owner/Manager in that store can recover the recorded result. Changing the sale
or normalized reason for an existing UUID conflicts. A second UUID for an already
voided sale also conflicts. A correction is a separate new checkout after the
old receipt's void is confirmed; the void route never creates that checkout.

Errors use the existing `{"detail":"..."}` envelope:

| HTTP | Meaning |
| --- | --- |
| 401 | Missing, expired, revoked or invalid session, including invalid PIN binding |
| 403 | Staff or permission/identity change while waiting for the transaction |
| 404 | Sale or void UUID unavailable in this store |
| 409 | UUID payload conflict, already voided, stock/revision limit or concurrent change |
| 422 | Invalid UUID, reason or extra request field |
| 503 | Original sale money, inventory or ledger proof is unavailable/inconsistent |

## Retained proof and atomic stock reversal

`BEGIN IMMEDIATE` serializes all changes. The service rechecks the session,
user/store/role and shared-PIN device binding after acquiring the write lock.
It validates original receipt line sums, payment allocations and original SALE
ledger events, then restores the exact recorded quantities. It does not use
current product prices or alter the original sale, lines, payments, request hash
or SALE ledger events. Inactive/expired Lots can receive their original stock
back; this does not make those Lots sellable. Store activation settings do not
change and do not block correction of a previously completed receipt.

Schema 6 adds only immutable `sale_voids` and `sale_void_lines` plus their
indexes/triggers. A sale can have one void. Each original sale line has one
reversal link. The existing ledger enum remains unchanged: a positive `ADJUST`
event with the original `sale_id` is linked by the immutable void line, making
the reversal identifiable independently of its display reason. Every balance
quantity, revision, timestamp, void header, reversal event and line link commits
together or rolls back together. Existing stale stock-count revisions therefore
conflict after a void.

`inventory_delta_satang` is the integer valuation change at the Lot's immutable
cost and current pre/post reversal balances; null preserves unknown cost. It
can differ by a rounding satang from historical sale cost after intervening stock
changes. Original sale cost is retained and used when excluding that sale from
financial reports.

A void records accounting cancellation and stock return. It does not call a
payment gateway or transfer money. Original tender allocations remain evidence;
cash/transfer refunds, if needed, are handled outside this endpoint.

## Receipt and report compatibility

Receipt list/detail adds `status="completed"|"voided"` and
`void=null|{id,client_void_id,sale_id,actor_user_id,actor_email,actor_role,created_at,reason}`.
Voided receipts remain visible with their original gross/discount/net and tender
allocations. Existing checkout POST/reconcile/by-client response fields and
idempotency are unchanged: an old checkout retry still returns its recorded sale
and never reapplies stock or creates a bill. Consult receipt detail for void state.
Staff can inspect only their own receipts and cannot void or query void recovery.

All report sections share one SQLite read snapshot. Existing summary, daily,
top products/categories, recent sales, costs/profit and tender totals exclude
voided receipts. This restates the original Bangkok sale day, indicated by
`sales_basis="original_sale_created_at_excluding_voided_at_snapshot"`.

Summary and daily add `voided_sale_count`, `voided_subtotal_satang`,
`voided_discount_satang`, `voided_total_satang`, `voided_quantity_mg`, attributed
to that original sale day. A separate `voids` section (`basis="void_created_at"`)
contains the cancelled receipts' count, original gross/discount/net, quantity,
tenders and original cost/profit coverage for voids created within the requested
Bangkok date range. `recent_voids` contains up to 30 such records with `sale_id`,
`void_id`, `voided_at`, reason and actor proof. These descriptive void amounts are
not added again to active sales or treated as executed monetary refunds.

## Migration and rollback gate

The factory refuses an existing schema-5 file before DDL/journal changes. On an
explicitly confirmed offline copy only:

```powershell
python migrations.py inspect --db C:\private\offline-schema5.sqlite3
python migrations.py migrate-copy --db C:\private\offline-schema5.sqlite3 --backup-dir C:\private\backups --confirm OFFLINE_TEST_COPY_ONLY
python migrations.py restore-copy --backup C:\private\backups\ramagan-before-v6-<id>.sqlite3 --out C:\private\new-restored-schema5.sqlite3 --confirm OFFLINE_TEST_COPY_ONLY
```

Migration preserves every existing table row, ID, money/hash, foreign key,
index, trigger, operator object, PIN verifier/session/audit and evidence BLOB
digest; it seeds no voids, users or credentials. Partial/unversioned schema
adoption is refused. Repeating a complete upgrade is a no-op. The tests inject
failure after void DDL and version assignment and restore a fresh copy from a
verified backup. Never restore a pre-upgrade database over new live business or
authentication work; stop and retain both copies for review. Live database
replacement, service restart and web/APK deployment remain separately gated.

## Optional stock-count note

`POST /v1/stocktakes` and `/v1/stocktakes/reconcile` now accept omitted, empty or
whitespace-only `reason`, normalized to the non-null empty string. Null/nonstrings
and over 300 characters are rejected. The shift label and per-Lot scale evidence
remain required. Existing nonempty request hashes and historical retries remain
unchanged; omission, empty and whitespace share the same new empty-note hash.
Receiving-stock reason rules are unchanged.
