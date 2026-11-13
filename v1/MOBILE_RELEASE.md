# Ramagan POS 2

Android application ID: `online.ramagan.pos.mobile`.
Version name: `1.5.9`; version code: `10509`.
This is a separate installation from the legacy `online.ramagan.pos` package,
as requested by the owner. The old app and its pending local operations remain
untouched. Sign in/enroll the new app against the same production API:
`https://157.85.96.139/ramagan-api`.

The manual `v1-android-mobile-release.yml` workflow produces an unsigned release
APK and verifies its package, version, non-debuggable manifest and ZIP alignment.
It reruns the POS test suite before building. CI does not receive signing keys.

Stocktaking displays the current sale price per gram alongside each name and
Lot code. Search matches product names, SKU and Lot without removing entered
counts or evidence. Submitting includes all entered counts, including filtered
rows; a visible notice identifies hidden counted rows. Non-Owner users still
cannot see system stock balances or costs. API 1.5.6 also allows immediate PIN
retries after mistakes, including old timed/recovery locks; existing clients
receive that server policy without an APK update.

Stocktake evidence has separate Take photo and Choose from album buttons.
Android uses the pinned camera 8.2.6 `getPhoto` path with explicit CAMERA/PHOTOS
source, URI results and a 1600-pixel bound. The camera path preserves its callback
and file path for `@capacitor/app` 8.1.2 restored-Activity results, unlike the
plugin's newer Ion takePhoto path. This is a deliberate compatibility choice;
revisit when upgrading the pinned plugin.

Both sources are decoded and converted to a JPEG bounded to 1600 pixels and
1 MiB before durable storage/upload. Failed replacement keeps the prior photo.
Inline per-row progress/errors remain visible below the preview. Returned photos
retain their original actor, store, draft and row through PIN expiry/recreation;
recovery saves locally and requires renewed authentication before upload. Lost
network responses retry the same stored bytes/UUID. If the OS/picker supplies no
restored result, the draft shows an interrupted-selection message and keeps the
previous evidence. No claim of recovery is made when the native OS discards data.

Native App/Camera registration is checked in the built APK. DOM/unit and headless
browser tests are separate from physical phone acceptance, which is NOT RUN on
the reporting device. No API or business-database change is needed for 1.5.9.

Stocktake confirmation sends only ready rows (saved valid count, uploaded photo,
unchanged stock revision). Blank, invalid, missing-photo and stale rows remain in
an unfinished draft and cannot block other ready rows. The page shows the exact
ready subset and the reason each unfinished row stays behind. Exact decimal
keyboard variants are normalized without rounding or guessing comma formats.
After confirmation, remove only submitted rows and durably rotate the remainder
before acknowledging the pending operation. Preserve original unfinished image
bytes; reupload them with fresh identifiers under the new stocktake ID. Replayed
cleanup is idempotent. Rejected operations also retain the unsent draft.

Sign locally with the persistent Ramagan Mobile release key stored outside the
repository. Align before signing, use Android SDK `apksigner`, then verify the
signature and alignment of the final APK. Never commit or upload the private
keystore or its password. Retain the same key and increment versionCode for
future updates of this package. Desktop receives the signed APK only.

Data that already reached the server is shared by both apps. Device enrollment,
authentication and pending offline operations are app-specific; those local
records are not copied by installing this app. Do not uninstall or clear the
legacy app to resolve a signing problem.

References:
- https://developer.android.com/tools/apksigner
- https://developer.android.com/tools/zipalign
- https://developer.android.com/studio/publish/app-signing
