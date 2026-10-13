# Ramagan V1 (web + mobile)

**Experimental branch only — NOT READY FOR LIVE SALES.**

Existing V0 remains at repository root. V1 is a shared website + Android app
codebase. Supabase PostgreSQL is the source of truth; the browser is NOT.

## Run web development locally

- Node 22+ required for Capacitor 8 / Vite 8.
- In this directory: run npm install to generate a lockfile, review it and
  commit the lockfile before CI/release. Then run npm run dev.
- Copy .env.example to .env.local, setting VITE_SUPABASE_URL and
  VITE_SUPABASE_PUBLISHABLE_KEY from a **dedicated test project**.
- First apply the SQL under backend/sql in a test project (after review),
  then set up an Auth user, store and user-to-store membership.
- Do NOT insert actual customers, prescriptions or live inventory into a demo.
- Do NOT put Supabase secret or service_role keys in any VITE_ variable.

## Android

After npm install and npm run build:

  npx cap add android
  npx cap sync android
  npx cap open android

Build/sign an APK in Android Studio with an owned private signing key. This
repository does not contain a generated Android project, APK or signing keys.

## PWA

The PWA shell may be cached for display; Supabase API requests and medical or
sales data are never put in the Service Worker cache. A lost network connection
must NOT result in a "sale complete" message. Offline sales are NOT implemented.

## Safety before go-live

- Migrate legacy ledger by export + independent physical stock reconciliation,
  NOT by copying browser localStorage into a live store.
- Check availability and legal prerequisites, including permits and workflow
  around any required professional authorization or prescription.
- Review RLS, transaction SQL, release signing, backup restore and privacy.
- Never enable ramagan_stores.sales_enabled until the compliance gate is signed
  off for the actual store and real end-to-end tests pass.

See ../docs/RAMAGAN_V1_WEB_MOBILE_PLAN.md.