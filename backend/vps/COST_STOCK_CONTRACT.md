# V1 cost and stocktake implementation contract (schema 3)

Working branch: `codex/v1-cost-stocktake`. The live original API remains schema 2
until an explicitly approved, backed-up deployment. No new business transactions
will be created on the live database for testing this change.

## Shared rules

Money is integer satang, quantities integer milligrams. Inputs reject booleans,
floats, strings for integer fields. Costs are optional for old-client compatibility;
unknown historical costs remain null, never guessed from selling price. Explicit
zero is a known zero cost. Product/lot cost fields and inventory valuation are
Owner/Manager only; Staff catalog remains free of costs. Existing discount contract
and checkout retries are preserved. Authentication determines the actor.

Add to `/v1/me` and report capabilities: `inventory_costs: true`,
`cost_contract_version: 1`, `stocktakes: true`, `stocktake_contract_version: 1`.
Keep discounts/version 1; do not enable promotions or shift reconciliation.
User subsequently approved optional references at both sale and intake. Add
`optional_document_references: true`, `document_contract_version: 1` to `/v1/me`.
Intake `supplier_document_ref` defaults to an empty string and may be omitted or
blank; a supplied reference is retained. UI required state follows this capability
on intake. Sales continue to honor the store's `requires_authorization` flag; the
existing owner's store is separately approved to set this flag to 0. Migrations
must preserve whatever store flags exist, never silently change them.

## Product and intake

`POST /v1/products`: optional `default_cost_satang_per_gram` (null or strict integer
0..100000000). Existing request/response fields remain. Owner/Manager catalog can
include this field; Staff must not receive it.

`POST /v1/lots/receive`: optional `cost_satang_per_gram` (same bounds) and
`client_receive_id` UUID. An omitted/null cost uses the product default when known;
otherwise records unknown. Actual lot cost is fixed at intake. The response retains
existing fields and adds cost plus `duplicate`. If UUID is supplied, request hash
and original response are persisted atomically: same UUID/payload returns original
result before evaluating current product/defaults, changed payload is HTTP 409.
Old clients without this UUID continue to work. No cost editing of existing lots
or historical sales in this scope.

`POST /v1/lots/receive/reconcile` takes the frozen ReceiveIn with its required
`client_receive_id`. Under BEGIN IMMEDIATE it returns `{status:"completed",
result:<original saved receipt>}` if committed. If absent, it records an immutable
cancellation tombstone and returns `{status:"rejected",client_receive_id,
code:"RECEIVE_CANCELLED",message:"Receipt cancelled before commit",committed:false}`.
Every later receive POST checks the same saved UUID/hash before any business write.
Only the user's explicit "verify/cancel if not recorded" action invokes this
cancellation. Automatic network-failure handling preserves the request; retry
posts the same UUID/payload. A completed result is never cancelled. This resolves
lost-before-arrival requests that later encounter a duplicate Lot or expiry.

`GET /v1/inventory` Owner/Manager: `{products: [...], lots: [...], summary: {...}}`.
Product rows preserve catalog fields plus default cost. Lot rows include existing
catalog fields plus `cost_satang_per_gram`, `stock_revision`, `inventory_value_satang`
(null if unknown). Summary: `quantity_mg`, `known_inventory_value_satang`,
`inventory_value_satang` (null if any positive-stock lot has unknown cost),
`unknown_cost_lot_count`. Inactive/expired lots remain visible to counters.

For fixed lot cost c and balance q, valuation V(q)=(c*q+500)//1000. Store immutable
sale line `unit_cost_satang_per_gram` and `line_cost_satang` snapshots; a sale costs
V(balance_before)-V(balance_after). Null stays unknown. No floating point.
All balance mutations advance a monotonic `stock_revision`; timestamps are not
concurrency tokens. Add revision with default 0 to original balances.

## Stocktake modeled on the prototype before-shift count

Owner/Manager sees system/count/variance by lot, shift label, authenticated counter,
reason and confirmation; no local PIN grants server authority. Snapshot comes from
`GET /v1/inventory`. User may count selected lots; untouched lots are not reset.

`POST /v1/stocktakes` Owner/Manager:
```
{
  "client_stocktake_id": "UUID",
  "shift_label": "morning",
  "reason": "physical stock count",
  "items": [{"lot_id": "UUID", "expected_revision": 0, "counted_quantity_mg": 1000}]
}
```
1..200 unique lot IDs, shift 1..80 characters, reason 1..300. Strict integers,
count 0..100000000, nonnegative revision. One BEGIN IMMEDIATE transaction checks
all lot ownership/revisions then stores immutable stocktake header/lines and
nonzero ADJUST deltas with the authenticated actor. No partial application. Zero
variance still creates count history, without a zero-delta ledger event. Advance
revision for every counted lot to invalidate stale parallel snapshots even when
quantity did not change. Cost adjustment is inventory gain/loss, never sale profit.

Response `{id, client_stocktake_id, shift_label, reason, actor_user_id, created_at,
duplicate, items:[{lot_id, lot_code, system_quantity_mg, counted_quantity_mg,
variance_mg, stock_revision_before, stock_revision_after, inventory_delta_satang}]}`.
Same UUID/canonical payload returns stored result regardless of current balances;
changed payload is 409 `Stocktake UUID already used with different payload`.
Revision mismatch is 409 `Stock changed; reload and recount` with no side effects.

`GET /v1/stocktakes` Owner/Manager: `{stocktakes:[...]}` latest 50 headers, with
`id, client_stocktake_id, shift_label, reason, actor_user_id, created_at, line_count,
variance_mg`. `GET /v1/stocktakes/by-client/{uuid}` returns full saved response;
404 if absent. Client persists pending UUID/payload before submitting and reconciles
uncertain results with the same UUID; never automatically creates a new count UUID.

`POST /v1/stocktakes/reconcile` takes the exact frozen stocktake payload. Under
BEGIN IMMEDIATE it returns `{status:"completed", result:<original saved response>}`
if committed; `{status:"pending",client_stocktake_id}` if absent and the revisions
still permit it; or `{status:"rejected",client_stocktake_id,code:"STOCK_CHANGED",
message:"Stock changed; reload and recount",committed:false}` if absent and stale.
Rejection is an immutable persisted UUID/request-hash tombstone, checked by every
later POST before any stock write, so a delayed original request cannot apply
after the user starts a new count. Changed payload for a saved/rejected UUID is
409. Reconciliation never changes stock, sales or ledger. An absent GET lookup
alone does not authorize clearing an uncertain request.

Client blocks NEW sales, products, receipts and counts while ANY sale/inventory
intent is unresolved. It still permits verification/retry of the frozen intent.
Completed or authoritatively rejected reconciliation may be acknowledged; all
ambiguous network failures retain the original UUID and block new mutations.

## Reports (Owner/Manager)

Preserve gross/discount/net and field structures. On summary, daily, recent_sales,
top_products, top_categories add `known_cost_satang`, `cost_satang`,
`gross_profit_satang`, `unknown_cost_line_count`, `cost_complete`.
`cost_satang` and `gross_profit_satang` are null if any included sale line has
unknown cost; otherwise cost is sum of stored immutable line costs and profit is
net `total_satang - cost_satang`. Empty groups have known zero cost/profit.
Show unknown coverage visibly; never display an incomplete subtotal as full profit.
All groups use the same SQLite report snapshot and Asia/Bangkok boundaries.
Report values remain authoritative after product/default-cost changes.

## Migration and acceptance

Extend copy-only versioned migrations to schema 3, including schema2->3, repeated
NOOP, injected failure rollback, restore, original field/ID/hash/trigger/index/FK
preservation. Historical lot/sale costs stay unknown, existing sales flags remain.
Use disposable fixtures only for checkout/count mutation QA. Verify integer money,
fractional mg rounding, unknown/zero, net profit after discount, privacy, tenant
boundaries, duplicate UUIDs, revision/ABA conflict, concurrent sale/count and full
rollback. Tests/CI are evidence for the branch, not live readiness.
