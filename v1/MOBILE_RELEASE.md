# Ramagan POS 2

Android application ID: `online.ramagan.pos.mobile`.
Version name: `1.5.6`; version code: `10506`.
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
Android Take photo uses `@capacitor/camera` 8.2.6 `takePhoto`, without an album
fallback. Cancellation/permission errors retain the previous evidence. A new
photo follows the existing durable draft and upload path and requires renewed
count confirmation. Web fallback uses `accept="image/*" capture="environment"`;
album selection has no capture attribute. Native registration and the camera
intent query are checked in the built APK. Physical phone testing is separate
from the simulated camera and DOM regression tests.

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
