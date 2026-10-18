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

No bearer token or API URL is stored in localStorage/sessionStorage. The
known HTTPS VPS address is prefilled; admins may change it in the login form.
Refreshing the page requires logging in again. GitHub Pages projects share
one github.io origin; for production, configure a dedicated custom Admin domain. Never disable TLS validation, never paste tokens into a URL,
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

- Daily gross, discount and net sales, sale count, net average (contract v1)
- Cash and bank transfer net breakdown (contract v1)
- Grams deducted from stock
- Top products and categories with gross and server-allocated net (contract v1)
- Low-stock alerts from *current* balances, not the historical date window
- Recent 30 sales within the requested date range
- Daily CSV export after successful authorized request

Reports use Asia/Bangkok dates, up to 93 days per request. They cannot report
previous V0 sales that were stored only in the browser. There are no fake demo
numbers: zero is shown only when returned explicitly by a supported, valid API response.
A disabled sales gate does not imply historical sales are zero.

## Legacy gaps (do not invent data)

V0 included 5+2, cart discounts, before-shift counting, photos, cash/transfer
charts and a historical "as-of" ledger. The existing VPS has sales, stock, payment methods and receipt records.
Phase 2 bill discounts require the separately deployed contract below; 5+2
promotion metadata and shift reconciliation are not covered. The UI never
silently treats gross vs net as if discounts or allocations were implemented.

Do not bypass licensed-store requirements just to populate a dashboard.

## Test

At repository root:

    node --check admin/dashboard.js
    node --test tests/admin-gh-pages.test.mjs

The static page does not require npm install or any third-party dependencies.

## Phase 2 discount contract (prepared; backend deployment required)

This UI requires report `capabilities.discounts === true` and
`capabilities.discount_contract_version === 1` before displaying any net or
discount values. Missing, false, or unknown versions display `—`, meaning
unsupported/unknown, never zero. `/v1/me` still verifies Owner/Manager; the
report's own capability is authoritative for its data. Staff cannot open reports.

Contract v1 money is nonnegative safe integer satang:

- `summary`: existing `subtotal_satang` (gross), `total_satang` (net),
  `cash_satang` and `transfer_satang` (net), `average_satang` (floor net/count),
  plus `discount_satang`.
- `daily`, `recent_sales`: `subtotal_satang`, `discount_satang`, `total_satang`.
- `top_products`, `top_categories`: `subtotal_satang` (gross),
  `discount_satang` (server-allocated discount), `total_satang` (allocated net).
  These rankings are net in v1; legacy `total_satang` remains labeled gross.
  The server owns deterministic allocation; the client never allocates money.
- Daily payment-channel breakdown is not part of this contract and is not invented.
- Top ten rankings and recent thirty sales are subsets, so their totals are not
  incorrectly checked against the whole report.

All daily rows must cover the requested Bangkok period without duplicates.
Gross minus discount must equal net, daily totals must match the summary, and
payment totals/average must reconcile before the response is rendered. Missing,
unsafe, inconsistent, wrong-period or wrong-timezone responses fail closed.
At refresh start, old figures and CSV access are cleared. Network/partial failures
cannot leave old figures presented as a fresh successful report.

Money display and CSV use integer/BigInt formatting without floating money
arithmetic. CSV includes gross, discount, net and explicit capability status.
No data, token or user-entered API destination is persisted.

## Cost and gross profit contract (schema 3 branch; deployment required)

Cost reporting requires `capabilities.inventory_costs === true` and
`capabilities.cost_contract_version === 1`, together with the supported discount
contract for authoritative net revenue. The report capability governs its own
snapshot. Older schema 2 reports continue to show gross/discount/net; cost and
profit stay `—` without assuming a zero cost.

Every summary, daily, product/category ranking and recent-sale row supplies
`known_cost_satang`, `cost_satang`, `gross_profit_satang`,
`unknown_cost_line_count`, and boolean `cost_complete`. Known costs come from
immutable sale-line snapshots, not a product's current default cost. Complete
costs equal the known subtotal; gross profit equals net revenue minus cost and
may be negative after a discount. Explicit zero cost is known zero.

If any included line has unknown historical cost, total cost and gross profit
must both be null. The page shows the number of unknown lines and the known
cost subtotal separately; it never presents partial cost as full profit. Empty
groups have explicit zero cost/profit. Daily known costs and unknown-line counts
must reconcile with the summary before anything is rendered. Missing or invalid
fields in a claimed supported contract fail closed and clear stale figures/CSV.

Daily CSV includes known cost, complete cost, signed gross profit, unknown-line
count and coverage status. Profit excludes other operating expenses and stocktake
inventory gains/losses. This branch does not enable promotions, restart services,
migrate a live database or deploy GitHub Pages by itself.

    node --test tests/admin-gh-pages.test.mjs tests/admin-costs.test.mjs

### Offline QA

    node --check admin/lib.js
    node --check admin/dashboard.js
    node --test tests/*.test.mjs

Optional browser QA requires an existing Playwright installation and Chromium:

    ADMIN_QA_OUTPUT=/tmp/ramagan-admin-qa node tests/admin-browser-qa.cjs

This script uses localhost and intercepted synthetic fixtures only, checks desktop
and mobile viewport layout, roles, refresh/repeated clicks, unsupported/partial/
network responses, logout/reload, and writes screenshots outside the repository.
It is not a real Android, backend, TLS/CORS, transaction or production acceptance test.
Do not publish this branch, open the Admin-to-main PR, or deploy until backend
readiness and API integration have been separately confirmed by the operator.
