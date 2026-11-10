# Ramagan POS 2

Android application ID: `online.ramagan.pos.mobile`.
Version name: `1.5.4`; version code: `10504`.
This is a separate installation from the legacy `online.ramagan.pos` package,
as requested by the owner. The old app and its pending local operations remain
untouched. Sign in/enroll the new app against the same production API:
`https://157.85.96.139/ramagan-api`.

The manual `v1-android-mobile-release.yml` workflow produces an unsigned release
APK and verifies its package, version, non-debuggable manifest and ZIP alignment.
It reruns the POS test suite before building. CI does not receive signing keys.

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
