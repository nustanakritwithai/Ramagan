# RAMAGAN Admin Reports — GitHub Pages

After this branch is merged to main and GitHub Pages deploys successfully:
https://nustanakritwithai.github.io/Ramagan/admin/

## Security model

GitHub Pages publicly serves only the HTML/CSS/JS *shell*. No SQLite file,
sales report snapshot, password or VPS service secret is committed or deployed.
The report requires a valid owner/manager login from the RAMAGAN VPS:

1. The administrator enters the HTTPS RAMAGAN API URL and their credentials.
2. The browser POSTs to the VPS /v1/auth/login.
3. The browser checks GET /v1/me and confirms owner/manager role.
4. It fetches GET /v1/admin/sales-report?from=...&to=...
   using an Authorization Bearer session, not a key in the GitHub Pages bundle.
5. The VPS again checks owner/manager role and store isolation on EVERY query.
6. Logout revokes the session and clears rendered data.

Only the endpoint URL is persisted in localStorage. Session tokens are kept in
sessionStorage. Never disable TLS validation, never paste tokens into a URL,
and never use wildcard CORS; the VPS must allow the exact origin
https://nustanakritwithai.github.io.

## Backend dependency

For real sales figures the Windows VPS needs the current V1 branch files:

- backend/vps/reports.py
- backend/vps/app.py (new authenticated admin endpoint)
- backend/vps/tests/test_sales_report.py

The existing VPS may still be running older API code until its operator safely
updates the service. The website displays "API รายงานยังไม่ติดตั้งบน VPS" if
the endpoint is absent. The site is NOT a completed live report until this
separate VPS deployment is verified.

This release must NOT modify sales_enabled, restart VPS services automatically,
delete SQLite data, or migrate V0 localStorage demo stock.

## Current report capabilities

- Daily sales revenue, sale count, average sale
- Cash and bank transfer breakdown
- Grams deducted from stock
- Top products and categories from historical recorded sale-line prices
- Low-stock alerts from *current* balances, not the historical date window
- Recent 30 sales within the requested date range
- Daily CSV export after successful authorized request

Reports use Asia/Bangkok dates, up to 93 days per request. They cannot report
previous V0 sales that were stored only in the browser. There are no fake demo
numbers: if actual sales are disabled or none exist, totals are zero.

## Legacy gaps (do not invent data)

V0 included 5+2, cart discounts, before-shift counting, photos, cash/transfer
charts and a historical "as-of" ledger. The new VPS currently has sales,
stock, payment methods and receipt records, but not 5+2 discount metadata or
shift reconciliation. Report UI names these as NOT YET MIGRATED and does not
silently treat gross vs net as if discounts were implemented.

Do not bypass licensed-store requirements just to populate a dashboard.

## Test

At repository root:

    node --check admin/dashboard.js
    node --test tests/admin-gh-pages.test.mjs

The static page does not require npm install or any third-party dependencies.
