# Ramagan POS 2

Android application ID: `online.ramagan.pos.mobile`.
Version name: `1.5.8`; version code: `10508`.
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

Both sources are decoded and checked against 1600 pixels / 1 MiB before
durable storage/upload. Already-bounded JPEGs retain their exact bytes without
another canvas encode; larger images and other formats are converted as before. Failed replacement keeps the prior photo.
Inline per-row progress/errors remain visible below the preview. Returned photos
retain their original actor, store, draft and row through PIN expiry/recreation;
recovery saves locally and requires renewed authentication before upload. Lost
network responses retry the same stored bytes/UUID. If the OS/picker supplies no
restored result, the draft shows an interrupted-selection message and keeps the
previous evidence. No claim of recovery is made when the native OS discards data.

Native App/Camera registration is checked in the built APK. DOM/unit and headless
browser tests are separate from physical phone acceptance, which is NOT RUN on
the reporting device. No API or business-database change is needed for 1.5.8.

Version 1.5.8 also reuses the active draft connection, avoids rewriting an
existing draft during ensure/read, and commits upload metadata plus return
acknowledgement together. No IndexedDB schema change or migration is needed.
Progress distinguishes preparation, network upload and final local persistence.
On headless Edge with 20 synthetic photos, median persistence time fell from
633 ms to 346 ms; bounded-JPEG preparation fell from 41 ms to 2.4 ms. These
measurements exclude the phone camera and mobile network; physical-phone timing
is NOT RUN. Large-image conversion uses the unchanged bounded path.

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
