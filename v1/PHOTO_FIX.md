# Photo return and upload repair — 1.5.7

Reported: camera/album photo does not appear, sometimes returning to the old screen.
Reporting device reproduction: NOT RUN; screenshot alone does not identify a
single device failure. The following failure paths are reproduced independently.

- Album input passed original files to a 5 MiB validator and a backend capped at
  12 million pixels. A common 4032 x 3024 image exceeds that pixel limit. The
  frontend now converts both sources to JPEG, max 1600 pixels / 1 MiB before saving.
- Replacement deleted previous durable evidence before validating the new file.
  Replacement now commits atomically after preparation; failure preserves old bytes.
- PIN expiry clears the screen and invalidates the capture callback. Returned
  bytes now save under the original actor/store/draft/row/request, without network
  authorization. Reauthentication restores the draft and requires explicit upload.
- Android Activity recreation had no restored-result handler. The pinned native
  camera callback path plus App listener now recovers results where Android
  delivers them. Missing OS results show interrupted selection, never invented proof.
- Photo completion could render unlocked controls before its final local write.
  Automatic upload keeps controls locked until the entire selection finishes.
- Errors appeared only at the top, far from a scrolled photo row. Row-level status,
  errors and preserved previews now show progress and retry information in place.

No API, database, quantity, business ledger or authorization-policy changes.
Existing pending upload UUID/bytes remain unchanged on retries. New selection
gets one ID, and stale/duplicate results cannot replace another selection/draft.
Cancellation, denied access, invalid images and network failure have regression
coverage. Owner-only quantity visibility and existing application tests remain.

Validation: 252 Node tests passed. Real headless Edge: 12.2 MP downsize, a
10,488,263-byte synthetic PNG compressed to 849,316 bytes, actual IndexedDB Blob
roundtrip, count preservation and invalid-image rejection passed (7 checks).
No live/customer images or transactions used. Physical Android camera/album and
low-memory device acceptance remain NOT RUN. Build/signing proof is recorded
separately against the final commit. Rollback uses prior static assets/APK; no
schema or server restart is required.

Pinned API references:
https://capacitorjs.com/docs/apis/camera
https://capacitorjs.com/docs/apis/app#addlistenerapprestoredresult-
