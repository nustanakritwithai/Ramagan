# CODEX / VPS AGENT HANDOFF — RAMAGAN POS V1

Target: existing user's Windows Server VPS with an active HTTPS gateway,
Apache/XAMPP and possibly Caddy. This is a TEST deployment and must be
non-disruptive to other sites and services.

## Guardrails

- Do NOT touch any Supabase project. Self-hosted Windows VPS backend ONLY.
- Do NOT overwrite the old Ramagan V0 GitHub Pages site or working Apache
  configs. No database resets. No migration of localStorage demo data.
- Never put passwords, signed tokens, keys, SQLite files or backups in Git.
- Bind FastAPI on localhost 127.0.0.1:8766, NEVER on 0.0.0.0.
- Reuse an existing valid TLS virtual host on 443, with a new /ramagan-api/
  reverse-proxy route and a separate /ramagan-v1/ static client directory.
- Before editing/restarting Apache or opening a public URL, inspect the
  current services and obtain the VPS operator's approval.
- Do NOT activate sales_enabled for live operation. Keep it zero.
- Prepare rollback of any reverse-proxy configuration changes and verify all
  preexisting sites after edits. Do not assume the old domain or DocumentRoot.

## Android UAT blocker (2026-10-14)

User reports public `/ramagan-api/health` returning FastAPI JSON 404,
plus a separate invalid owner-email/password response.

**Follow [STAGING_ANDROID_TRIAGE.md](STAGING_ANDROID_TRIAGE.md) first.**
Run [diagnose_staging.ps1](diagnose_staging.ps1) as a read-only probe.
Inspect the ACTIVE Caddyfile and FastAPI process database path; compare with
the exact provisioned owner's email. The new `admin.py check-login` command
verifies an owner account/password locally using getpass and never prints the
password. Do not create or reset accounts until the actual service DB is
confirmed. Do not assume a new reload is already authorized.

## Implementation path

1. git clone / git fetch repo branch feat/v1-central-web-mobile.
2. Install isolated venv per backend/vps/README.md; run Python unit tests.
3. Configure RAMAGAN_DB_PATH as a private path outside web root;
   configure RAMAGAN_CORS_ORIGINS for Android https://localhost plus actual
   web origin.
4. Provision TEST store/owner via VPS console with operator-entered password.
5. Launch FastAPI on loopback; verify local /health and owner/staff roles.
6. Configure existing HTTPS gateway route /ramagan-api/ to :8766; verify
   TLS and security headers; do not expose backend port.
7. Build Vite frontend (npm install, npm run build); copy ONLY v1/dist into
   existing Apache DocumentRoot subdirectory ramagan-v1.
8. Connect Android DEBUG APK by entering actual HTTPS API URL on first launch.
9. Validate RLS equivalent roles on API: unauthenticated denied,
   staff cannot add products, stale users revoked, API blocks oversell.
10. Verify reproducible encrypted backup and offline restore. Report
    PASS/FAIL/UNKNOWN without guessing. Do not enable real sales.

## Acceptance report

Output: API URL, website staging URL, internal port, service process
and restart method, HTTPS certificate status, TestClient/CI status,
Android device sign-in result, backup SHA256 (not content), risks and
whether rollback is ready. Never include user passwords or tokens.

If remote desktop access or VPS permission is unavailable, stop before
deployment and request the actual hostname and authorized access.
