# Schema 4 release handoff

This candidate replaces no running service by itself. The original approved API
uses `RamaganV1StagingApi`, loopback `127.0.0.1:8766`, and private database
`C:\RamaganV1Staging\data\ramagan.sqlite3`. The website is `/ramagan-v1/` and the API
is `/ramagan-api/`. There is no new server, public port, image directory or Caddy
route for this release. Preserve the actual current shop sales/document settings.

## Release contents

Deploy the reviewed bytes of `app.py`, `discounts.py`, `migrations.py`, `reports.py`,
`cost_stock.py`, `payments.py`, `schema_v4.py`, `stocktake_evidence.py`, and the pinned
requirements together. Image decoding adds Pillow 13.0.0. Prepare its verified
Windows CPython 3.12 wheel before the change. Preserve the previous runtime files
and dependency inventory for rollback. Website/APK assets must come from the same
reviewed CI commit. Debug APK signing identity may differ from an older installed
debug build; inspect pending operations before any uninstall and do not promise an
in-place signed update. Admin changes remain a separate, three-file Pages PR.

## Offline migration commands

These commands target only an explicitly created private offline copy. They are
not instructions to run migration against the service database. Windows EFS copies
must preserve the source encryption key and restricted ACL; a generic plaintext
export or public web directory is unsuitable. First obtain a consistent SQLite
online backup into that encrypted copy, not a bare WAL database file copy.

```powershell
python migrations.py inspect --db '<private-offline-copy.sqlite3>'
python migrations.py migrate-copy --db '<private-offline-copy.sqlite3>' --backup-dir '<private-backups>' --confirm OFFLINE_TEST_COPY_ONLY
python migrations.py inspect --db '<private-offline-copy.sqlite3>'
python migrations.py restore-copy --backup '<verified-backup.sqlite3>' --out '<new-private-restore-proof.sqlite3>' --confirm OFFLINE_TEST_COPY_ONLY
```

Require schema 3 to 4 PASS, repeat NOOP, all four migration fault stages rolling
back, exact old-row/ID/hash/flag/trigger/index/foreign-key preservation, and restored
photo BLOB digest integrity. Historical counts have no fabricated evidence; old
cash/transfer records use their recorded net as the historical payment fallback.
Any HOLD stops the release. Preserve consistent backup hashes and exact source SHA.

## Approved cutover and rollback

Before requesting approval, prepare the exact file/config diff, backup paths,
dependency change, rehearsals, Windows/Linux CI and built-browser evidence. The
approval must name the original service restart and schema 4 change. Stop only
that verified service, prove its loopback listener has closed, take a fresh encrypted
consistent backup, migrate a fresh copy, then replace the database and reviewed
runtime files atomically. Keep the original EFS identity, service account, bind,
CORS origins and Caddy bytes. No seeded fixture enters the original database.

On an observed new impact, stop only the changed service and retain its current
database first. Restore the original database only if every business/audit table
still matches the untouched migrated baseline. Any new receipt, sale, count,
photo, photo link, payment allocation or rejection is new user work and blocks an
automatic old-schema restore. HOLD and preserve both versions rather than erase it.
Restore prior code/dependencies/website together with a proved compatible database;
never start schema 3 code against a schema 4 database.

After startup verify normal certificate validation, `/health`, exact CORS origins
and preflights, unauthorized denials, read-only shop flags and the existing service
and URL baseline. Do not create a live transaction or stock adjustment as a smoke
test. Owner/Manager photo/count and Android camera acceptance need actual device
evidence; unit tests and a debug APK build alone cannot establish that state.

Pillow release reference: https://pillow.readthedocs.io/en/stable/releasenotes/13.0.0.html
