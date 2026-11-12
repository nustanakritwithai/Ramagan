# PIN retry policy — API 1.5.6

The owner requested immediate retries after PIN entry mistakes. Both automatic
role matching and explicit-role unlocks reject an incorrect PIN with HTTP 401,
record the failed attempt, and never impose a timed lock or a recovery threshold.
Existing PIN-related limit rows are retained for history but ignored. Device
status keeps the compatible role_lockouts fields with zero/false values.

Registered, unexpired, non-revoked device credentials and a valid role PIN are
still required. Invalid or ambiguous role configuration still fails closed.
Role permissions, PIN hashing, session expiry, explicit locking, PIN rotation,
device revocation and password-authenticated owner administration are unchanged.
The owner-password limiter remains active. No database migration or PIN reset
is needed; existing Android clients receive the policy from the server.

Regression coverage includes more than ten wrong attempts, concurrent attempts,
automatic/explicit clients, different devices, process restart, historical timed
locks and recovery flags, unchanged historical records, and all existing role,
session and owner-password authorization tests. Tests use disposable shops only.
