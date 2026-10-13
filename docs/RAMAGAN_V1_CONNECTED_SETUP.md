# RAMAGAN V1 — central website + Android setup

Status: 2026-10-13. READY FOR DEDICATED TEST PROJECT PROVISIONING; NOT LIVE.

## Implemented on feat/v1-central-web-mobile

- Shared responsive web and Capacitor Android client under v1/.
- Email/password sign-in, browser signup (email confirmation required), store membership check.
- Owner/manager inventory page: product creation and new lot receiving.
- Backend SQL 001: store membership, RLS, append-only ledger and atomic checkout,
  server-side idempotency and all-or-nothing transactions.
- Backend SQL 002: protected CREATE PRODUCT and RECEIVE LOT.
- Sales are disabled by default: ramagan_stores.sales_enabled = false.
- Unit test and Vite compilation GitHub Actions: PASS.
- APK generated only via manual workflow; no production deployment yet.

## Authorization blocker for new database

Only listed connected Supabase organization:
nustanakritwithai@gmail.com's Org

Existing inactive projects Aliv and ZentraAiBase are unrelated. They must not
be reused or modified to create Ramagan without explicit approval.

The owner must select a Supabase organization; provider project cost must
be checked and explicitly confirmed before project creation.

## Setup after owner confirms organization and provider cost

1. Create dedicated Ramagan-Test project, preferably ap-southeast-1
   (Singapore) for a Thailand testing deployment.
2. Get API URL and publishable API key only. Never put secret or service_role
   keys in any Vite config or APK.
3. Apply backend/sql/001_v1_central.sql and 002_v1_inventory_admin.sql
   after reviewing in the new TEST project.
4. Inspect database RLS policies, API exposure, function grants and Supabase
   security advisor results.
5. Enable Auth email/password and email confirmation. Configure allowed site
   URL and redirect URLs for the chosen staging domain. Android login uses
   email/password; signup is browser-based pending verified redirect.
6. Create TEST store and assign an owner Auth user in the database with
   privileged SQL ONLY after verified signup. Keep sales_enabled false.
   Example bootstrap SQL to adapt only after UUIDs are known:
      INSERT INTO public.ramagan_stores(name) VALUES ('Ramagan Test') RETURNING id;
      INSERT INTO public.ramagan_members(store_id,user_id,role)
        VALUES ('<STORE-UUID>','<VERIFIED-AUTH-USER-UUID>','owner');
7. Create 2 products and 2 RECEIVE lots with owner UI; verify balance/events.
8. Test staff permissions, cross-store denial, checkout with one invalid line,
   retry UUID, concurrent stock oversell and network loss in isolated TEST.
9. Provide VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY during
   website/Android build. A new APK must be rebuilt AFTER actual project config.
10. Deploy web to a SEPARATE staging URL without replacing legacy GitHub Pages.
11. Test APK installation on a physical Android phone. No sales with demo data.

## Release-gate status

UI tests & Vite build: PASS.
Supabase project creation: NOT STARTED (authorization required).
SQL DDL deployed: UNKNOWN.
RLS/security advisors: UNKNOWN.
Actual Auth login: UNKNOWN.
Store inventory RPC smoke tests: UNKNOWN.
Checkout atomicity & retries: UNKNOWN.
Android account sign-in and physical-device E2E: UNKNOWN.
Backup restore and compliance review: UNKNOWN.

Do not merge or deploy for real store operation until all relevant gates PASS.
