# RAMAGAN Android UAT triage: 404 health and invalid owner password

Status: **READ-ONLY DIAGNOSTIC FIRST. No Caddy reload approved by this file.**
Staging sales MUST remain disabled (\`sales_enabled=0\`).

## Evidence from Android user acceptance testing

1. Android APK opens "เชื่อมต่อเซิร์ฟเวอร์ร้าน" -> **PASS for UI only**.
2. Setting the public API URL sometimes says "Not Found".
3. Browser visiting \`https://157.85.96.139/ramagan-api/health\` returns
   JSON \`{"detail":"Not Found"}\`.
4. On one attempt the app showed login form, then
   \`Invalid email or password\`.

The two failures must not be conflated. The current Python app has
\`GET /health\` and \`POST /v1/auth/login\` **without** the public
\`/ramagan-api\` prefix. The app appends \`/health\` and \`/v1/auth/login\`
to the API base URL configured in the Android app.

A 404 JSON response suggests an incorrectly preserved prefix, a gateway
route collision, or an unrelated FastAPI upstream; determine which on the
actual VPS. It is NOT proof that the Windows service is down. A server-side
401 \`Invalid email or password\` means that a login route was reached, but
the account/password check failed in THAT server database.

## Phase A — read-only routing diagnosis on Windows VPS

Do not edit Caddy or restart/reload any service in this phase.

1. Verify running FastAPI listener:
   \`Get-NetTCPConnection -State Listen -LocalPort 8766\` (expect loopback).
2. Inspect FastAPI locally:
   \`Invoke-RestMethod http://127.0.0.1:8766/health\`
   must return \`status: ok\`.
3. Run:
   \`powershell -NoProfile -ExecutionPolicy Bypass -File .\diagnose_staging.ps1 -PublicApiBase "https://157.85.96.139/ramagan-api"\`
4. Expected:
   - Local \`/health\`: HTTP 200, JSON \`status=ok\`.
   - Public \`/ramagan-api/health\`: HTTP 200, JSON \`status=ok\`.
   - Public \`/ramagan-api/v1/me\`: HTTP 401 without Authorization token.
   - Browser \`/ramagan-v1/\`: returns HTML via HTTPS.
5. Inspect the ACTIVE Caddy config, site matcher and imports, not a guessed
   file path. Compare the diff against the known-good backup. Confirm the
   upstream is THE Ramagan API and not another service.
6. Check response on the same external network as the phone, without
   weakening or bypassing TLS certificate verification.

### Correct Caddy pattern (insert INSIDE the existing, matching site block)

\`\`\`caddyfile
handle_path /ramagan-api/* {
    reverse_proxy 127.0.0.1:8766
}
\`\`\`

\`handle_path\` removes the matched prefix. The resulting upstream requests
are \`/health\` and \`/v1/auth/login\`, which match FastAPI.

Equivalent, useful where the surrounding config already has \`route\`:

\`\`\`caddyfile
route /ramagan-api/* {
    uri strip_prefix /ramagan-api
    reverse_proxy 127.0.0.1:8766
}
\`\`\`

**Incorrect unless a separate rewrite exists:**

\`\`\`caddyfile
handle /ramagan-api/* {
    reverse_proxy 127.0.0.1:8766
}
\`\`\`

The incorrect configuration preserves \`/ramagan-api/health\` on the
upstream, and FastAPI does not have that route.

Do not create a second conflicting HTTPS site block. Do not replace
the existing 97 services, catch-all routes, static site mapping or
global header configuration. If the existing route is already correct,
**do not reload**; inspect service/host matcher and the external URL
instead.

## Phase B — separate read-only owner-account verification

Use the actual running FastAPI process configuration to determine
\`RAMAGAN_DB_PATH\`. Do NOT infer it from the interactive terminal: a
Windows service can have a different user home and environment.

In \`backend/vps\` run:

\`\`\`powershell
$env:RAMAGAN_DB_PATH = "C:\Ramagan\data\ramagan.sqlite3"
.\.venv\Scripts\python.exe admin.py --db $env:RAMAGAN_DB_PATH check-login --email "OWNER_EMAIL_AS_PROVISIONED"
\`\`\`

Enter the password ONLY in the local hidden console prompt. The command
outputs database path, FOUND/NOT_FOUND, active/role, sales_enabled and
PASS/FAIL. It does NOT send a password to a web endpoint and does not
create or reset a database/account.

- NOT_FOUND: check exact spelling and **service database path**. Never
  create a replacement store or account before verifying the path.
- FOUND but inactive: inspect owner/staff provisioning with the operator.
- PASSWORD_MATCH FAIL: verify the password locally. If truly forgotten,
  the operator can explicitly authorize \`admin.py reset-password\` after
  confirming the correct database and identity; the reset revokes sessions.
- PASS locally but 401 from the phone: check if app is pointing at a
  different API endpoint, whether gateway routes are crossed or the
  service is using another DB path.
- If login attempts have reached throttling, wait for the configured
  10-minute window to expire; do not loop credentials blindly.

## Phase C — guarded change and QA, only after operator permission

1. Back up the actual Caddyfile/imports and record SHA256 before a change.
2. Prepare the MINIMAL existing-site routing diff.
3. Validate with the Caddy binary and the actual active config file
   (e.g. \`caddy validate --config <ACTIVE_CADDYFILE> --adapter caddyfile\`).
4. Have the VPS operator approve the specific diff and reload.
5. Reload once. Check the same local/public routes and all baseline services.
6. If regressions occur, restore the original config and reload/rollback.
7. Reopen Android: set API base to
   \`https://157.85.96.139/ramagan-api\` (no \`/health\` suffix).
   If TLS validation fails, fix the certificate for the IP or use an
   actual HTTPS hostname; **never bypass trust warnings**.
8. Login using the verified local owner account; no secrets in ChatGPT or
   GitHub logs. Confirm products/stocks are identical across website and
   Android, with \`sales_enabled=0\`.

## Acceptance gates

| Check | Expected | State after user screenshots |
| --- | --- | --- |
| Android UI renders | Login/setup screen | PASS |
| External prefixed health | 200 with \`status=ok\` | FAIL (observed 404) |
| API unauthenticated \`/v1/me\` | 401 | UNKNOWN |
| Owner account on active service DB | FOUND, PASS | UNKNOWN |
| Android authenticated login | success | FAIL (observed invalid credentials) |
| Prior 97 services preserved | no new regressions | PASS per staging report; recheck after Caddy change |
| Real sales disabled | \`sales_enabled=0\` | PASS per staging report; recheck |

Keep the 404 and login failure as separate issues. No claim of a
production-ready POS until both and the remaining Android UAT gates pass.
