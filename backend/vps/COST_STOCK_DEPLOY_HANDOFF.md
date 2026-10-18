# Product cost, stocktake and optional-document release handoff

This branch combines the reviewed discount backend (PR7, `6f66128`), the installed
Android baseline (`3d42d54`) and Admin discount baseline (`3289b53`) before adding
these features. Nothing in this document authorizes a merge, service change or
deployment. The original VPS currently runs schema2; this release targets schema3
and API `1.2.0-vps-preview`. The existing original API URL remains:

`https://157.85.96.139/ramagan-api`

The separate Android lab was stopped and its route removed. Do not recreate it or
copy its synthetic stock/sales into the original database.
The release APK and website build default to this original API; the server button
still allows an explicit change. No password or token is embedded in the build.

## Behavior and prototype

The root prototype's before-shift count (`index.html`, `js/app.js`) is the model:
system quantity, physical count, variance, shift label and counter. The VPS uses
the authenticated account, integer quantities and one transaction, instead of a
local PIN or separate per-row writes. Blank count means skip that Lot; explicit0
means physically empty. Expired/inactive Lots remain countable. Owner/Manager may
count and adjust; Staff cannot read costs, count history or profit reports.

Products may have a default cost in baht/g. Each intake saves the actual cost for
that Lot; blank uses the product default if known. A known zero is different from
unknown. Costs on old Lots and historical sale lines remain unknown. This release
does not guess50% of price, edit old lot costs or recalculate old sales from current
prices/defaults. Supplier references may be blank, omitted or supplied. Sales
references follow the current store's `requires_authorization` setting.

The original owner explicitly approved optional references for BOTH workflows.
Their original store setting was separately changed to `requires_authorization=0`
with an encrypted backup; migrations preserve that setting and sales_enabled=1.
Other stores/settings are preserved. The installed old APK still requires the
intake field until the new APK is installed and the new API advertises the feature.

Reports show gross, discount, net, stored cost of goods sold and gross profit after
discount. Missing historical costs produce null cost/profit, with known cost and
missing-line coverage visible. A full discount can legitimately create a negative
gross profit. Inventory adjustment gain/loss is separate from sale profit.

No optional stock-count photo upload is included; the required count/variance/audit
workflow is implemented. No local photo is presented as server evidence.

## API and numeric examples

See `COST_STOCK_CONTRACT.md` for the exact request/response contract, strict integer
limits, capabilities and reconciliation rules. The examples below are synthetic
documentation, never instructions to create live transactions.

Create a product:
```json
{"sku":"EXAMPLE-A","name":"Example","category":"top","price_satang_per_gram":15000,"default_cost_satang_per_gram":8000}
```
Response preserves `product_id`. Intake50g at80baht/g, with an optional blank
reference:
```json
{"client_receive_id":"00000000-0000-4000-8000-000000000001","product_id":"00000000-0000-4000-8000-000000000002","lot_code":"EXAMPLE-LOT","supplier_name":"Example supplier","supplier_document_ref":"","quantity_mg":50000,"cost_satang_per_gram":8000,"reason":"Example intake"}
```
Intake responds with `lot_id`, original `event_id`, `ledger_event_id`,
`client_receive_id`, `quantity_mg`, resolved `cost_satang_per_gram` and `duplicate`.
Same UUID/request returns those original values even if the product default changes.

Selling1g at150baht with a1baht discount gives gross15000, discount100, net14900,
stored cost8000, gross_profit6900satang. The remaining49g is valued at392000satang.
If a physical count then finds48.5g, the variance is-500mg and inventory value
delta-4000satang; it does not create another sale or change historical profit.

Stocktake uses the inventory response's revision:
```json
{"client_stocktake_id":"00000000-0000-4000-8000-000000000003","shift_label":"Morning","reason":"Physical count","items":[{"lot_id":"00000000-0000-4000-8000-000000000004","expected_revision":1,"counted_quantity_mg":48500}]}
```
Every counted Lot advances its revision, even at zero variance. A stale revision
returns409 and applies no partial adjustment. Duplicate UUID/request returns the
saved result. A changed payload with the same UUID conflicts. Uncertain operations
remain frozen, and stocktake reconciliation serializes completion/rejection with
writers; persisted rejection prevents delayed original requests from committing.

Errors:401 authentication;403 role/store-sale gate;404 missing scoped lookup;
409 duplicate/conflicting UUID, duplicate Lot/SKU, insufficient stock or stale
revision;422 invalid strict types/bounds, expired intake, missing required reason
or invalid foreign-tenant Lot. Supplied references are retained, never invented.
The application shows server errors and retains uncertain UUIDs.

## Copy-only migration and backup

Do not run migration against the installed DB path. Keep the original service,
port8766 and original database location. With the API offline, make a fresh
consistent encrypted copy, migrate that copy, prove preservation/restore, then
install it atomically at the original path. The module refuses known service paths.
Never weaken the guard or add another service/port as a workaround.

For an actual offline copy outside protected service roots:
```powershell
python -B migrations.py inspect --db C:\private\offline-copy.sqlite3
python -B migrations.py migrate-copy --db C:\private\offline-copy.sqlite3 --backup-dir C:\private\migration-backups --confirm OFFLINE_TEST_COPY_ONLY
python -B migrations.py restore-copy --backup C:\private\migration-backups\REVIEWED-BACKUP.sqlite3 --out C:\private\new-restore-proof.sqlite3 --confirm OFFLINE_TEST_COPY_ONLY
```
On this VPS EFS and service-account key access must be retained. A generic new
SQLite copy can inherit a different encryption certificate; use the reviewed
Win32 CopyFile seed plus consistent SQLite backup and verified atomic replacement
workflow. Store backups outside public web/repository roots with private ACLs.

Schema2->3 preserves every old field/ID/hash/amount/index/FK/immutable trigger and
adds nullable costs, stock revisions and immutable intake/count/rejection records.
Schema0/1 upgrades first prove gross/net/line reconciliation then chain in one
transaction. An inconsistent or partial schema must HOLD. Second migration is
NOOP. Historical costs remain null; store sales/document flags are preserved.

Rollback requires stopping only the original API, retaining the failed DB and
restoring code and DB consistently from the fresh pre-release backup. Refuse a
blind DB restore if business/account data changed after cutover; reconcile first.
Restore preserves all user work and never replaces the shop with the lab database.

## Review before deployment

The deliverable is a branch, DraftPR, exact commit, Windows/Linux CI, APK artifact,
test evidence and a concrete backup/rollback diff. Required next approval covers
schema2->3 at the original DB, the six backend source files and restart of only
RamaganV1StagingApi. No Caddy change or public port is required. Dashboard publishing
and any merge need their own explicit scope. Keep the original owner's current
sales_enabled/document settings. No extra live checkout tests are planned.

After approval verify actual health1.2/schema3, capabilities, HTTPS, browser-origin
preflight, existing-site/service baseline and Owner/Manager/Staff permissions.
Only the user's Android/device check can complete the APK acceptance. Tests and
fixture HTTP/browser evidence must not be labeled as actual live readiness.
