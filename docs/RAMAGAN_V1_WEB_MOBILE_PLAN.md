# Ramagan V1 — Shared Website + Android, self-hosted

Status: TEST ONLY (2026-10-13).

Supabase was explicitly removed from this design.

## Topology

Website on GitHub Pages (staging yet to deploy) and Android Capacitor APK
share one API, authenticated on an owned Windows VPS.

Windows VPS -> HTTPS Apache/Caddy reverse proxy (:443)
            -> FastAPI (127.0.0.1:8766)
            -> SQLite WAL (private C:\Ramagan\data\ramagan.sqlite3)

The mobile app's initial setup accepts the HTTPS URL at runtime; users
do not rebuild the APK to change VPS host names. Browser state is NOT the
inventory source of truth.

Security: operator-provisioned accounts, server-side role checks, scrypt
password hashing, opaque revocable sessions, UUID idempotency, append-only
audit ledger, atomic stock and sale transactions.

The sales-enabled gate starts OFF. Offline checkout is not implemented.
Independent legal requirements review is needed for regulated operation.

## Current QA

PASS: GitHub Actions Vite compilation and unit tests.
PASS: FastAPI SQLite tests for login, RBAC, receipt, atomic mult-line
sale failure, concurrent stock, immutable audit and idempotent retry.
UNKNOWN: actually deployed HTTPS Windows VPS API.
UNKNOWN: physical Android installation and real two-device QA.
UNKNOWN: offsite backup restore and regulated business compliance review.

## Next

- VPS operator deploys backend using backend/vps/README.md.
- Confirm public HTTPS API /ramagan-api/health responds.
- Create owner account through VPS console (no credentials in GitHub).
- Enter URL in Android and log in, test product creation/receipts.
- QA reconcile ledger and inventory across multiple devices.
- Add receipt/refund, shift reporting, encrypted backups and operations audit.
- Only when all release gates are approved may sales_enabled be activated.

Legacy V0 remains on main unchanged.
