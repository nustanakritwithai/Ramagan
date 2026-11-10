# Owner stock balance visibility — 1.5.4

Only Owner sees exact stock balances. Manager and Staff retain product names,
sale prices and availability (`has_stock`), and can sell through the existing
authoritative stock check. Manager retains receiving and physical counting.

`/v1/me` advertises `stock_privacy_contract_version: 1` and an actor-bound
`can_view_stock_quantities`. Non-Owner catalog/inventory responses omit
`quantity_mg` from balance rows and totals. Stocktake responses, history,
replays and reconciliation omit `system_quantity_mg` and `variance_mg`.
Owner responses retain the original amounts.

Entered/sold/received quantities and recorded physical counts/evidence are
operational records, not current balances; those remain available under the
existing role permissions. No role permissions for mutations are expanded.
Ledger, accounting, evidence, schema (6) and PIN authentication are unchanged.

The client hides balances even when given a legacy response or stale Owner
state. Role changes clear business displays. Existing confirmed count results
are scrubbed under their operation lock, and draft snapshots are scrubbed in
the IndexedDB transaction without changing request IDs, entered counts,
revisions or photo bytes. The server remains authoritative for overselling.

## Release and rollback

This change requires updated web assets and an updated Android APK alongside
the backend. Old Android builds expect numeric balances and can disable sales
or fail inventory validation against the redacted API. Resolve pending device
operations before updating; do not uninstall or clear application data.
Android signature compatibility and physical-device acceptance must be checked
before relying on an in-place APK update.

Deployment requires the owner's explicit approval to restart
`RamaganV1StagingApi`, per the original VPS task restriction. Do not run schema
migrations, change configuration/PINs, or alter live business rows for this
release. Stage and hash backend/web/APK artifacts; retain the installed code
and web files for rollback. Deploy the matching assets, restart only this API,
and verify health version plus Owner/Manager/Staff visibility. If verification
fails, restore the prior code/assets and restart the same API; do not restore
an old database over transactions made since deployment.

## Verification

Backend tests use disposable SQLite fixtures. Privacy coverage includes role
changes, empty stock, successful Staff selling, insufficient stock, unchanged
read-only snapshots, stocktake replay/history/reconciliation and Owner math.
Frontend tests cover POS, product details, inventory, blind counting, switching
roles, durable confirmations, draft cleanup, and unchanged mutation intents.
Run `python -m unittest discover -s tests -v` from `backend/vps` with an explicit
disposable `RAMAGAN_DB_PATH`; run `npm test` and `npm run build` from `v1`.
