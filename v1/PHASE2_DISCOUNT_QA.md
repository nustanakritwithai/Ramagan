# Phase 2 application: fixed bill discount and durable checkout

TEST/PREVIEW ONLY. No backend, production data, sale-gate setting, service restart,
merge, or deployment is included. The VPS backend is a separate workstream.

## API contract required before enabling discounts

- Authenticated `GET /v1/me` adds top-level `capabilities: {discounts: true,
  discount_contract_version: 1}`. Absent, false, or unknown versions block every
  nonzero discount before POST. Identity is rechecked immediately before POST.
- `POST /v1/sales` preserves existing fields and adds integer `discount_satang`
  (zero by default). A replay must use exactly the same UUID and payload.
- New/replayed responses and `GET /v1/sales/by-client/{uuid}` must return server
  `subtotal_satang`, `discount_satang`, `total_satang`; net equals gross minus
  the requested discount. Lookup may retain existing `id`; POST uses `sale_id`.
- `client_sale_id` and `store_id`, when returned, must match the saved operation.
- Explicit old-server compatibility is limited to saved zero-discount operations:
  validated integer total implies zero discount, and a supplied subtotal must
  equal that total. Nonzero operations never accept a total-only response.
- Backend must remain authoritative over current prices, roles, document gates,
  stock/lot validity, `sales_enabled`, transaction atomicity and idempotency.
  Backend request-hash migration for old zero-discount sales must be tested there.

## Durable checkout and recovery

A versioned operation is persisted and read back before sending: API base, store,
cashier, UUID, full frozen items/payment/document reference/discount payload,
and preview subtotal. No auth token is included. Keys are API/store-scoped;
other cashiers cannot replay a stored operation. Tokens retain sessionStorage.

Cart, payment, reference and discount editing lock during transmission/pending.
Web Locks serialize same-origin tabs; unavailable Web Locks fails closed.
Completed-operation revision detects a stale tab that tries to start a new bill
before receiving the other tab's storage event.

Network/timeout/HTTP errors keep the operation. Reconciliation uses by-client
lookup, including after POST failure. A later 401/403/422 or 404 lookup cannot
prove an earlier request did not commit, so none erases the saved UUID. Retry
first looks up, then sends the saved payload, never the current cart. Confirmed
results are persisted before acknowledgement; failures during storage cleanup or
stock refresh cannot cause a resubmission of the completed sale.

Corrupt records, wrong identity, or old UUID-only records fail closed. A legacy
UUID alone cannot establish its API/account provenance, so it is never sent to
an assumed server. The manager must independently investigate the original
system and reconcile it; this preview deliberately has no unsafe "discard" UI.
The same manual path applies when an operation cannot ever be accepted and no
server-side final cancellation/negative acknowledgement exists.

This guards cooperative same-origin tabs, not malicious storage tampering or
localStorage being cleared by a user/OS. There is no offline-sale mode. A fixed
discount is not automatically adjusted when authoritative server prices change.
Server-confirmed amounts are displayed separately from the preview.

## Local verification

From `v1/`: `npm ci --ignore-scripts`, `npm run check`, `npm run build`.
All automated sale requests in tests use in-memory/mock transports only. Tests
do not contact any live store. See tests for exact covered cases.

Browser rendering/real Android-device end-to-end testing is a separate gate.
Local Chromium was attempted but could not start because this execution
sandbox forbids its process socket; the approved escalation also failed during
sandbox setup. No screenshots or browser-render pass are claimed.
Java 21 is present locally, but Android SDK/sdkmanager/Gradle/adb are absent.
No local APK is claimed, and no production signing credentials were created.

### Verified cloud-workspace results

- Node 24.19.0: syntax checks, 66/66 offline tests and Vite production build pass.
- Five jsdom integration scenarios exercise actual setup/login, discount field,
  locks, restart/retry, server-price changes, failed post-success refresh,
  capability fallback and role visibility. jsdom is not a rendered-browser test.
- Android workflow now has a normal `pull_request` build-only trigger for V1
  changes; it checks out the exact head SHA and includes BUILD_COMMIT.txt and
  a test-only notice in its debug artifact. Contents permission remains read-only.
  A workflow run/artifact must be independently verified before claiming an APK.
