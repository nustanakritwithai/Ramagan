# RAMAGAN V1 — Website + Android on Windows VPS backend

**Preview, NOT APPROVED FOR LIVE SALES.** Existing V0 remains at repo root.

## Architecture

Shared Vite frontend and Capacitor Android app at v1/. Frontend connects to
HTTPS REST on the user's own Windows VPS. Python FastAPI + local SQLite WAL
is the ONE central source of truth. No Supabase account or keys.

- Frontend uses only one runtime-configurable API URL.
- First open Android app -> set HTTPS URL (e.g. https://shop.example.com/ramagan-api)
  -> check /health -> sign in with owner-created email/password.
- Auth tokens are ephemeral opaque server sessions stored in sessionStorage.
- Owner/manager can create products and receive stock. Staff may sell only
  when the server's sales_enabled gate is explicitly active.
- No offline checkout; no local browser ledger is treated as authoritative.
- The server checks every item and applies one SQLite transaction (all-or-nothing).

## Develop locally

Backend: see ../backend/vps/README.md. In one terminal, start the Python
backend on 127.0.0.1:8766 and provision a TEST store with admin.py.

Frontend (Node 22+):
  cd v1
  npm install
  npm run dev

Open the Vite URL and enter http://localhost:8766 as the test endpoint.
Only localhost may use HTTP. Real Android devices and GitHub Pages require HTTPS.

## Android

  cd v1
  npm install
  npm run build
  npx cap add android
  npx cap sync android
  npx cap open android

GitHub Actions has a manually dispatched Android debug build. APK files
are demonstration artifacts and MUST NOT be used for live retail until
backend tests, regulated-business checks, and device checks all pass.

No credentials or databases should be committed into GitHub.

## Before production

- Secure HTTPS gateway and strict firewall, reverse proxy local API only.
- Use an encrypted Windows volume and restricted service account for SQLite.
- Verify SQLite backup/restore and audit event preservation.
- Verify staff revocation, online checkout atomics and stock concurrency.
- Obtain independent regulatory/legal review of actual store operations.
- Never enable the sale gate merely to test a device; use test stock instead.

Docs: ../docs/RAMAGAN_V1_WEB_MOBILE_PLAN.md
