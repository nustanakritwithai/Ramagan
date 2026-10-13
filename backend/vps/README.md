# Ramagan V1 Central API — Windows VPS deployment

**TEST / DRAFT only. Not cleared for live regulated retail.**

Architecture: Python FastAPI, single-authoritative SQLite WAL database, HTTPS
reverse proxy, shared Vite website and Android Capacitor app. No Supabase.

## 1. Install on Windows Server (PowerShell)

Install Python 3.12+ and Git. Use a restricted service account, not a public
web directory, for the database and API process.

    git clone https://github.com/nustanakritwithai/Ramagan.git C:\Ramagan\repo
    cd C:\Ramagan\repo
    git switch feat/v1-central-web-mobile
    cd backend\vps
    py -3.12 -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt

Set process environment variables (these need to persist for your service):

    New-Item -ItemType Directory -Force C:\Ramagan\data
    $env:RAMAGAN_DB_PATH = "C:\Ramagan\data\ramagan.sqlite3"
    $env:RAMAGAN_CORS_ORIGINS = "https://localhost,https://nustanakritwithai.github.io"

C:\Ramagan\data MUST be outside Apache/XAMPP htdocs and on a restricted,
encrypted volume. Only the API service account and a backup operator should
have database access.

## 2. Bootstrap owner and staff ON THE VPS (never inside a browser)

    .\.venv\Scripts\python.exe admin.py init-store --store "Ramagan TEST" --owner-email "owner@example.com"

Use a real email and enter strong password via the hidden console prompt.
The command prints the Store UUID.

    .\.venv\Scripts\python.exe admin.py add-user --store-id "<STORE_UUID>" --email "staff@example.com" --role staff

Roles: owner, manager, staff. To revoke a staff account and its sessions:

    .\.venv\Scripts\python.exe admin.py disable-user --email "staff@example.com"

## 3. Start on loopback only

    .\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8766 --workers 1
    Invoke-RestMethod http://127.0.0.1:8766/health

Do NOT allow public connections to port 8766. For auto-start configure a
Windows service or Task Scheduler using start.ps1 under a non-admin account.

## 4. Connect HTTPS using existing Apache/Caddy gateway

Add a dedicated path to the EXISTING SSL virtual host on port 443. Apache
example directives (requires mod_proxy + mod_proxy_http enabled):

    ProxyPreserveHost On
    ProxyPass        "/ramagan-api/" "http://127.0.0.1:8766/"
    ProxyPassReverse "/ramagan-api/" "http://127.0.0.1:8766/"

Do not create a conflicting second VirtualHost without inspecting the current
Apache configuration. Ensure the actual domain has a valid TLS certificate.

The Android and website API configuration should be:
https://YOUR-ACTUAL-HTTPS-HOST/ramagan-api

Android WebView origin is https://localhost. GitHub Pages origin is
https://nustanakritwithai.github.io. Keep a strict CORS allowlist; no wildcard.

## 4b. Host the central website on the same HTTPS VPS

Install Node.js 22+ for the one-time frontend build. From your project root:

    cd C:\Ramagan\repo\v1
    npm install
    npm run build

Vite uses relative URLs so dist/ can be served from a subdirectory.
Inspect the existing Apache DocumentRoot first; if it is the usual XAMPP
C:\xampp\htdocs and HTTPS already serves that root:

    New-Item -ItemType Directory -Force C:\xampp\htdocs\ramagan-v1
    Copy-Item -Path .\dist\* -Destination C:\xampp\htdocs\ramagan-v1 -Recurse -Force

The staging website will be at:
https://YOUR-ACTUAL-HTTPS-HOST/ramagan-v1/

On first visit, enter exactly the same API URL as Android:
https://YOUR-ACTUAL-HTTPS-HOST/ramagan-api

Never copy backend/vps/, .sqlite3, .env, credentials or backup files into
Apache DocumentRoot. Keep old website V0 untouched, and verify existing
Apache paths before editing its configuration.

## 5. Use website / Android

On first launch the app shows "เชื่อมต่อเซิร์ฟเวอร์ร้าน".
Enter HTTPS API base, press "ตรวจสอบและเชื่อมต่อ" then sign in using the
owner account provisioned in Step 2. All roles access one shared server.
No keys or admin passwords belong in the APK or GitHub.

## 6. Backups and safety

    .\.venv\Scripts\python.exe admin.py status
    .\.venv\Scripts\python.exe admin.py backup --out "D:\SecureBackups\ramagan-YYYYMMDD.sqlite3"

The backup uses SQLite online backup API. SHA256 is printed. Keep multiple
encrypted copies and perform a separate test restoration before operating.

Emergency disable new sales on VPS:

    .\.venv\Scripts\python.exe admin.py disable-sales --store-id "<STORE_UUID>"

Database sales_enabled defaults to FALSE. Do not enable it until actual
licenses, required authorization workflow, recordkeeping, security,
backup/restore and device checks are independently verified.

## Local tests

    .\.venv\Scripts\python.exe -m unittest discover -s tests -v

These tests create only isolated throwaway databases. CI proof does not
substitute for testing the API on the real VPS or installing the APK on a phone.

## Current limitations

- No completed offline sales. The app will not mark unknown sale requests
  successful before server confirmation.
- No full printer/receipt, refunds, regulated medical validation or shift-close.
- Single VPS (not automatic active-active failover); needs encrypted backups.
- Server login rate limiting is per one worker; gateway throttling recommended.
- Browser tokens are stored in sessionStorage and expire after 8 hours.
- This app does not establish legality or verify a prescription.

DO NOT migrate V0 localStorage or its demo items into a real shop until
a separate physical stock reconciliation and owner sign-off.
