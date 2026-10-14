# RAMAGAN Admin on GitHub Pages — browser login CORS/TLS triage

**Status: staging/UAT. The user's screenshot shows the Admin page loaded, but
the browser failed to reach the VPS login endpoint. Keep sales_enabled=0.**

Reported origin: https://nustanakritwithai.github.io
Reported API base: https://157.85.96.139/ramagan-api
Affected page: https://nustanakritwithai.github.io/Ramagan/admin/

The Android app's successful sign-in is NOT proof that a cross-origin browser
POST succeeds. Browsers enforce CORS preflights; Android WebView may use a
different origin (https://localhost) already allowed in the running service.
The Admin JS network error is not proof of wrong credentials.

## First: diagnostics only (no config changes or restart)

From the Windows VPS terminal, in the current Ramagan code checkout:

    cd C:\Ramagan\repo\backend\vps
    powershell -NoProfile -ExecutionPolicy Bypass -File .\check_admin_cors.ps1 -ApiBase "https://157.85.96.139/ramagan-api"

This sends:
- GET loopback /health: expect HTTP 200 status ok.
- GET public /ramagan-api/health: expect HTTP 200 status ok.
- OPTIONS public /ramagan-api/v1/auth/login with:
    Origin: https://nustanakritwithai.github.io
    Access-Control-Request-Method: POST
    Access-Control-Request-Headers: content-type
  Expect HTTP 200 + Access-Control-Allow-Origin matching Origin, POST allowed
  and content-type allowed.
- OPTIONS public /ramagan-api/v1/admin/sales-report with:
    Origin: https://nustanakritwithai.github.io
    Access-Control-Request-Method: GET
    Access-Control-Request-Headers: authorization
  Expect HTTP 200 + correct Origin, GET and Authorization allowed.
- GET public report without credentials must be HTTP 401, never 200.

These tests do NOT send credentials, mutate SQLite, create accounts,
run a checkout or change Caddy/FastAPI. Report each as PASS/FAIL/UNKNOWN.

## Determine the actual root cause

1. If local /health works but public fails, inspect the ACTIVE Caddy HTTPS
   matcher/upstream route and TLS. Do not edit Apache/Caddy blindly.
2. If public /health works but OPTIONS fails, inspect the active FastAPI
   process environment, not just the interactive PowerShell window:
   RAMAGAN_CORS_ORIGINS must include EXACTLY
   https://nustanakritwithai.github.io
   (origin only: no trailing slash, /Ramagan/admin, quotes inside the value,
   or http://). Also retain https://localhost used by Android.
3. The repo FastAPI CORS default includes both origins, but an environment
   variable OVERRIDES that default. Preserve any existing explicitly
   approved origins.
4. The existing FastAPI code expects /health and /v1/auth/login, without
   /ramagan-api. In Caddy the prefix must be stripped before reverse_proxy.
   If Caddy already routes correctly, don't change it.
5. If the API is reached by GET but TLS certificate validation fails in the
   phone browser, inspect the certificate chain and the Subject Alternative
   Name for the public IP, or use a valid hostname with matching TLS.
   Do not use -k, -SkipCertificateCheck, ignore TLS errors, or disable checks.
6. FastAPI CORSMiddleware should be the sole owner of access-control
   response headers for /ramagan-api. Avoid duplicate CORS headers in Caddy
   (the prior deployment already had a duplicate-header regression).
7. If POST /login returns normal HTTP 401 with visible body after CORS is
   fixed, only then check account status and password with admin.py
   check-login in the VPS console. Do not publish passwords/tokens in logs.
8. If the new GET /v1/admin/sales-report returns authenticated HTTP 404,
   the reporting module / endpoint hasn't been rolled into the VPS service
   yet. Use ADMIN_REPORT_DEPLOY_HANDOFF.md, separately from CORS changes.

## Change gate — approval required

Before touching the running service:
- Capture original service startup/environment configuration, Caddyfile
  and imports, and a rollback plan.
- Inspect old RAMAGAN_CORS_ORIGINS value and 97-service baseline.
- Propose the SMALLEST change: add GitHub Pages origin to the service's
  existing allowlist and restart only Ramagan FastAPI (if required).
- Obtain VPS operator authorization for the specific change/restart.
- Only change Caddy if its active route is demonstrably the failing point;
  back up and validate before any Caddy reload.
- Keep sales_enabled=0, actual SQLite and legacy services untouched.
- Re-run check_admin_cors.ps1 and all previous service health probes.
- Test Android Login remains PASS and Admin Owner/Manager login passes
  from GitHub Pages, Staff role is denied (403).
- Confirm HTTPS and no duplicate Access-Control-Allow-Origin header.
- Roll back immediately on regression.

## UI follow-up

The GitHub Pages Admin frontend has a separate noncredential health probe.
If that GET works but POST login fails in browser, prioritize the JSON
login OPTIONS preflight. If the GET fails too, open /health in a separate
browser tab to distinguish page CORS from IP certificate/network rejection.
The frontend can't bypass browser CORS and should never ask users to do so.
