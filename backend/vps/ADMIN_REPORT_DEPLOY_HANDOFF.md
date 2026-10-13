# RAMAGAN — GitHub Pages Admin reports: VPS deployment handoff

**Status: REVIEW / STAGING ONLY. No permission to turn on actual sales.**

The static dashboard is hosted from the public main branch at:
https://nustanakritwithai.github.io/Ramagan/admin/

GitHub Pages has NO SQLite data. All sales reports are private VPS API requests.

## What changed in the backend feature branch

- backend/vps/reports.py: pure read-only revenue, cash/transfer, sold mg,
  Bangkok day buckets, top products/categories, current low-stock and recent
  transaction summary. Input dates limited to 93 days.
- backend/vps/app.py: GET /v1/admin/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD
  &low_stock_mg=10000 (query string on a single line), with server-enforced
  owner/manager permissions and store isolation.
- backend/vps/tests/test_sales_report.py: read-only/role/tenant/time zone
  regression coverage with a DISPOSABLE temporary SQLite DB.

No SQL schema migration and no new credentials are required for this feature.
The endpoint reads already-existing sales records only.

## Codex on VPS — SAFE DEPLOYMENT SEQUENCE

1. Inspect the ACTIVE FastAPI service and its startup command/working folder;
   check actual database path, process version, health, current CORS allowlist.
   Do not assume default C:\Ramagan\data.
2. Confirm staging sales_enabled=0 (keep it unchanged) and prove the known
   baseline checks still pass. No test sales on the LIVE store database.
3. Create a timestamped backup of app.py, service environment/launcher,
   report module if already present, plus a CONSISTENT SQLite online backup.
   Record SHA256 and restore strategy; never commit backups or credentials.
4. Fetch the updated feat/v1-central-web-mobile code in a SEPARATE working
   checkout. Inspect the diff. Do not blindly replace the entire runtime or
   restart services without the operator's explicit change-window approval.
5. Install the new reports.py and updated app.py in a controlled staging
   release under the existing FastAPI service account. No Caddy reload is
   required if /ramagan-api/* already routes to the FastAPI app correctly.
6. Run python -m unittest discover -s tests -v using TEST database only.
   Check Python syntax and Windows import tzdata.
7. With operator approval, restart ONLY Ramagan FastAPI, not Caddy/Apache
   or unrelated Windows services; retain rollback to the previous files.
8. Validate:
   - GET /ramagan-api/health -> 200 {"status":"ok",...}
   - GET /ramagan-api/v1/admin/sales-report without token -> 401
   - Same with staff token -> 403
   - Owner or manager token -> 200 with period/summary/daily etc.
   - Sales totals match a **read-only manual SQL query** for the store.
   - No sales means 0, not demo sales.
   - sales_enabled still 0; old POS/stock/97 baseline services unchanged.
9. Ensure RAMAGAN_CORS_ORIGINS contains the exact origin:
   https://nustanakritwithai.github.io
   Do not use '*' and do not allow arbitrary origins.
10. Test opening https://nustanakritwithai.github.io/Ramagan/admin/
    from Android Chrome. Log in and compare figures across PC/mobile.
    Never send credentials or bearer tokens to ChatGPT or GitHub logs.
11. Roll back immediately if any regression is detected.
    Report PASS/FAIL/UNKNOWN with exact evidence and status.

## IMPORTANT: feature gaps that remain

- No promotional 5+2 or cart discount metadata in the V1 SQLite checkout
- No shift-count photos and variance in the V1 backend
- No void/refund, full receipt printing or legal verification of documents

The GitHub Pages dashboard explicitly labels these unavailable. Do not
recreate their figures from current product prices (would misstate the
historical sale price and deductions).

DO NOT enable live sales solely to demonstrate this report.
