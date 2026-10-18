# Side menu, receipt history and remembered device / shared role PIN

This release follows the deployed schema4 stocktake-evidence release. It adds a
mobile left drawer, nested product menus, private receipt list/detail, and a
remembered-device connection with separate shared Owner/Manager/Staff PINs.

## User flow and identity

The first connection uses the existing Owner email/password. In Settings, the
Owner opts in to remembering this device, re-enters the Owner password, labels the
device and enters three different four-digit ASCII PINs twice. PIN values must
never enter source, fixtures, deployment plans, command-line arguments or logs.

Subsequent visits connect to the saved shop and show the role/PIN lock screen.
Only the device credential persists, scoped to the exact API base. An unlocked
business bearer stays in memory, expires after 300 seconds on the server, and
cannot be restored from localStorage/sessionStorage/IndexedDB. A device expires
after 90 days and can be revoked. Closing/reloading the app requires the PIN
again. Existing password login remains available for recovery and other clients.

Each role has a dedicated store actor with an unusable password verifier.
The existing ledger/cashier foreign keys identify this shared role actor.
**Shared PIN audit identifies a role, not an individual employee.** The original
Owner account, password and existing transactions are unchanged. PIN Owner cannot
enroll/revoke devices or change PINs: those actions require a real Owner password
session and reauthentication. A role switch revokes prior PIN sessions on that
device. PIN change revokes all store PIN sessions. Business authorization always
uses the server-side role/store/user checks, not the chosen UI button.

Failed attempts are counted transactionally in SQLite for store-role, device-role
and device scopes; changing IP, process restart or enrolling another device does
not reset the role budget. Five failures cause a 15-minute lock, and ten failures
require Owner password recovery. PIN hashes use salted scrypt with an HMAC pepper
kept separately from the database. `RAMAGAN_PIN_PEPPER` must contain at least 32
bytes of generated secret material. Alternatively `RAMAGAN_PIN_PEPPER_FILE` may
point to an absolute private EFS-protected file containing 32–4096 bytes, readable
by the service account. The service configuration then contains only that path.
Explicit injected pepper / nonempty pepper environment value takes precedence
over the file. Missing, unreadable, oversized or invalid pepper disables the PIN
capability and device routes while legacy password login continues to work.

## API contract

`GET /v1/me` keeps prior fields/capabilities and adds:

```json
{"receipt_history":true,"receipt_contract_version":1,
 "shared_role_pin":true,"shared_role_pin_contract_version":1}
```

`shared_role_pin` is false until the pepper is configured. Health reports version
`1.4.0-vps-preview` and schema5. There are no seeded role PINs or devices.

- `GET /v1/sales?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD&q=...&limit=30&cursor=...`
  returns `{sales,next_cursor,from_date,to_date,timezone,scope}`. A sale includes
  `id,client_sale_id,created_at,cashier_id,payment_method,payments,subtotal_satang,
  discount_satang,total_satang`. Default dates cover the last30 Bangkok dates;
  maximum366 days, limit1–100. Search treats SQL wildcard characters literally.
  The opaque signed keyset cursor is bound to store/actor/role/filters and expires
  on process restart; reload the first page after HTTP422.
- `GET /v1/sales/{sale_id}` adds `store_name` and `lines`. Each line has
  `lot_id,lot_code,product_name,quantity_mg,unit_price_satang_per_gram,
  subtotal_satang,discount_satang,total_satang`. Money comes from persisted sales
  and allocations. Names represent current records because labels were not
  snapshotted. No cost/profit, supplier document or authorization reference is
  disclosed. Owner/Manager see their store; Staff sees only its cashier actor.
- Existing `/v1/sales/by-client/{client_sale_id}` remains compatible and precedes
  the dynamic detail route. Receipt viewing never submits or reconciles checkout.
- `POST /v1/auth/device/enroll`: real Owner Bearer plus
  `{owner_password,label,pins:{owner,manager,staff}}`; returns
  `{device_credential,device_id,store:{id,name},roles,expires_at}`. A new device
  must use existing role PINs; enrollment does not silently rotate/reset them.
- `POST /v1/auth/device/status`: `{device_credential}`; returns the device/store,
  roles, expiry, `locked:true` and per-role lockout metadata. No business token.
- `POST /v1/auth/device/unlock`: `{device_credential,role,pin}`; returns
  `{token,user,expires_at,device_id,role,auth_method:"shared_role_pin"}`.
- `POST /v1/auth/device/lock`: PIN Bearer, revokes that session.
- `POST /v1/auth/device/revoke`: real Owner Bearer plus
  `{owner_password,device_id}`, revokes the device and its PIN sessions.
- `POST /v1/auth/device/pins`: real Owner Bearer plus `{owner_password,pins}`,
  rotates all three role PINs, bumps versions and clears recovery limits.

Device errors:401 invalid credential/PIN/expired/revoked;403 insufficient role or
password-authenticated Owner required;409 existing PIN mismatch/configuration;
422 malformed input;429 lockout;503 PIN feature not configured. Validation errors
are generic and do not echo secret input. Authenticated responses are no-store.
No passwords/PINs/tokens go in query strings.

## Menus and safe navigation

Drawer: Sales, Receipts, Products, Settings, Backoffice (Owner/Manager), App, Help,
plus existing Intake and Stocktake for managers. Modal backdrop, Escape, focus
trap/return and inert background support both keyboard and mobile. Product menu
first opens Items / Categories / Additional options / Discounts. Categories and
stock use server catalog data; adding/receiving routes to existing manager forms.
The additional-options page describes supported lot/gram options and does not
claim a modifier/topping engine exists. Discounts open the existing order ticket.
Settings shows actual account/store/server plus device controls. App/help are
working local information pages, not invented external service integrations.

Navigation preserves cart, frozen sale UUID/payload, inventory intents and photo
drafts. A pending request restricts PIN unlock to the original role actor; an old
password-account pending request requires the original password login. No role
switch acknowledges, discards or retries an unresolved business operation.
If the sole remembered device expires or is revoked while its role has a pending
intent, the UI intentionally does not delete storage or bypass the old actor.
Use another authorized device for that same role, or have the operator inspect
the original `client_sale_id` / inventory intent and follow a reviewed recovery
procedure. Do not create a replacement transaction to escape the lock.

## Migration and deployment gate

Schema4→5 adds empty `device_auth_roles,remembered_devices,device_auth_limits,
device_pin_sessions,device_auth_events`, supporting indexes and immutable auth
audit triggers. It never seeds credentials/actors or changes shop flags. Startup
refuses an old database before writing; operators migrate an offline copy.

The prior schema3→4 installation approval does not authorize this change.
Before a service action, record the exact final commit, candidate hashes, fresh
encrypted consistent schema4 backup, tested restore, added secret configuration,
service name/127.0.0.1:8766, unchanged Caddy/public ports, and guarded rollback.
Do not modify a live database through the generic copy command.

```powershell
python migrations.py inspect --db '<encrypted-offline-copy.sqlite3>'
python migrations.py migrate-copy --db '<encrypted-offline-copy.sqlite3>' --backup-dir '<encrypted-private-backups>' --confirm OFFLINE_TEST_COPY_ONLY
python migrations.py restore-copy --backup '<verified-schema4-backup.sqlite3>' --out '<new-encrypted-restore-proof.sqlite3>' --confirm OFFLINE_TEST_COPY_ONLY
```

Keep the pepper separate from DB copies and protect/backup it for recovery. Do
not print it, put it in Git or use a new random value on each restart. Changing it
prevents existing PIN verifiers from unlocking and requires Owner recovery.
A valid-length key change alone does not revoke an already-issued PIN bearer;
explicitly revoke sessions/devices or rotate PIN versions before a key rotation,
or wait for the server-enforced 300-second expiry. Do not overwrite
new photos, counts, sales, auth enrollments or audit events during rollback.
Guarded downgrade must HOLD if any new non-session business/auth state exists.
No new public port, wildcard CORS, Caddy reload, shop test sale or Supabase change
is needed. Owner/Manager/Staff end-to-end tests use disposable synthetic data.

Security design references: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html),
[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
[Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
