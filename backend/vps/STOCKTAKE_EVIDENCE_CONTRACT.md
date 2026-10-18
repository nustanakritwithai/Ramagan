# Stocktake evidence and POS payment contract — schema 4

Source branch: `codex/v1-stocktake-evidence`, based on deployed `fb096830c39864c186183ade008a13312cb40083`.
This is a source contract, not evidence of live deployment. No live service restart,
database migration, Caddy change or production transaction is authorized by this file.

## Permissions and capabilities

Stocktakes continue to be Owner/Manager only. Staff is denied. The user chose
immediate adjustment under existing permissions once photos and inputs are complete;
there is no approval queue. `/v1/me` advertises `stocktakes: true`,
`stocktake_contract_version: 2`, `stocktake_evidence: true`,
`evidence_contract_version: 1`, `split_payments: true`,
`payment_contract_version: 1`. Keep cost and discount contracts at version 1.
Do not enable promotions or shift reconciliation.

## Evidence

`POST /v1/stocktake-evidence/{client_upload_id}?lot_id=UUID&client_stocktake_id=UUID`
uses Bearer authentication and a raw JPEG, PNG or WebP body, not multipart/base64.
The UUID and exact bytes must be persisted before sending. The returned metadata is
`{evidence_id, client_upload_id, client_stocktake_id, lot_id, sha256, mime,
width, height, byte_size, created_at, duplicate}`. `sha256` identifies normalized
stored bytes. The server additionally stores a source digest for upload retries.
Same upload UUID, actor, context and source bytes returns the original metadata;
changed bytes/context conflicts. Bind evidence to store, actor, lot and count UUID.

`GET /v1/stocktake-evidence/{evidence_id}` returns authenticated private JPEG bytes
to Owner/Manager in the same store, with `Cache-Control: no-store` and `nosniff`.
No public photo URL, bearer query parameter, static file or new Caddy route exists.
UI fetches a Blob and revokes object URLs. Service workers bypass authenticated and
API requests and cache only their actual application shell.

Limits: raw body 5 MiB, decoded 12 million pixels, each dimension at most 8192.
Reject unknown/forged formats, SVG, animation, truncated images and oversized streams.
One decode at a time. Verify, reopen/load, apply EXIF orientation, create fresh RGB
pixels, encode JPEG with longest edge at most 1600 and stored size at most 1 MiB;
discard EXIF, ICC and comments. Store bytes and metadata in the existing private
SQLite database, so EFS and consistent backup include the evidence atomically.
Store quota is 256 MiB of normalized bytes, checked transactionally; fail clearly
with `EVIDENCE_STORAGE_FULL` rather than discard evidence. No automatic deletion
of linked or orphan photos is introduced; maintenance requires an explicit operator
decision. A photo documents submitted evidence, not camera authenticity or actual weight.

Generate a persistent draft `client_stocktake_id` before any upload. Unsubmitted
drafts/Blobs live in IndexedDB scoped by API/store/actor and do not hold the global
submitted-mutation lock. Reload restores the original revision snapshot; stale
revisions require an explicit recount/new UUID. Changing a counted value invalidates
its selected evidence. An uncertain upload retries the same bytes/UUID.

New `/v1/stocktakes` items add required `evidence_id` per selected lot, including
count zero and zero variance. Untouched blank lots remain uncounted. One photo may
only link once to its bound count/lot/actor. Validate all revisions and photo bindings
and write stock, lines, ledger and evidence links in one BEGIN IMMEDIATE transaction.
Failure rolls everything back, including evidence consumption. The earlier upload
may remain as an unlinked draft. Completed legacy count UUIDs replay their original
response before new evidence validation; no fresh UUID may bypass evidence rules.
Preserve canonical legacy hashes for that retry path only. New hashes include the
evidence IDs. Reconcile and late POST cancellation preserve the same frozen payload.

Count history/detail retains existing fields and adds per-line `evidence` metadata
matching the upload response (without duplicate); legacy lines use null and are
visibly marked as having no historical photo. Confirmation shows missing reason,
shift, count, photo or other lock condition. Equal system/count values are valid.

## Cash, transfer and split payment

Keep legacy `payment_method: "cash" | "transfer"` requests and hashes unchanged.
New split request uses `payment_method: "split"` and
`payments: [{payment_method:"cash",amount_satang:10000},
{payment_method:"transfer",amount_satang:19900}]` for a net 29900 satang sale.
Only split accepts `payments`; require exactly one cash and one transfer entry,
each a strict positive integer, sum equal to the server-calculated net. A zero-net
sale uses cash or transfer, with one zero allocation. Reject booleans, floats,
strings, null, duplicate methods, overflow and inconsistent totals. Canonicalize
split allocations by method; include them in its request hash. Changing allocations
under the same sale UUID conflicts. Replay the original sale before current prices,
stock or flags are evaluated. One split checkout remains one bill and one stock cut.

Sale POST/lookup responses add `payment_method` and `payments` for all methods,
including historical rows (derived from their original method and recorded net).
Preserve lookup `id` and all existing subtotal/discount/net/duplicate fields.
Cash received and change are UI calculations in integer satang, not sale revenue;
cash received must cover the cash allocation before confirmation. Do not send cash
received as revenue or invent a card payment option from the reference screenshot.

An explicit user's verify/cancel action can resolve a never-recorded sale safely:
`POST /v1/sales/reconcile` takes the exact frozen SaleIn. Under BEGIN IMMEDIATE,
return `{status:"completed",result:<stored sale>}` if already committed; otherwise
persist an immutable actor/store/UUID/request-hash rejection and return
`{status:"rejected",client_sale_id,code:"SALE_CANCELLED",committed:false}`.
Every later sale POST checks this tombstone before business writes. A changed
payload/actor conflicts and a completed sale can never be cancelled. Advertise
`sale_reconciliation:true`, `sale_reconciliation_contract_version:1`.
Automatic timeouts retain the frozen intent and do not cancel it. Only a verified
rejection may be acknowledged/cleared for a corrected cart; HTTP 404 or a later
validation error alone never proves that an earlier request did not commit.

Schema 4 truthfully expands sales.payment_method's CHECK to include split and adds
immutable sale payment allocations. Rebuild only on an offline safe copy, inside
one transaction with foreign keys disabled before BEGIN and fully rechecked/enabled
afterward. Preserve IDs, old rows/hashes, foreign keys, indexes and trigger SQL.
Reports use payment allocation amounts, with exact historical fallback; cash plus
transfer equals net, split is counted as one sale. Never double count joined lines.

## Migration and release gates

Schema 3 to 4 is explicit, copy-only, repeatable and transactional. Historical
photos are not fabricated. Earlier schema migrations chain safely. Preserve all
store flags, accounts, quantities, timestamps and historical money/hashes.
Stream BLOB hashes/lengths for preservation evidence rather than materialize all
photos or log image bytes. Test first migration, repeat NOOP, injected failures,
foreign keys and restore including evidence digest integrity. New photos, links,
stocktakes, payments or rejection records block automatic restore of an old database.

POS uses the requested light green/white sales flow: catalog, quantity keypad,
order review, cash/transfer/split checkout. Preserve decimal grams, discount checks,
expiry/stock checks and durable uncertain-result handling. Synthetic fixtures only.
Run Windows/Linux backend suites, POS suites, mobile browser and exact-commit CI.
Only a later concrete approved release may change the running original service.
