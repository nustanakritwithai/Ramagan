"""Shared-role device auth uses disposable databases and synthetic secrets only."""
import atexit
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

_bootstrap = tempfile.TemporaryDirectory(prefix="pin-auth-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

from fastapi.testclient import TestClient
from app import connect, create_app, create_store, create_user, verify_password
from pin_auth import DEVICE_SECONDS, SESSION_SECONDS, resolve_pepper

PEPPER = b"synthetic-test-pepper-not-for-runtime-123456789"
PASSWORD = "Synthetic owner password only 123!"
PINS = {"owner": "0123", "manager": "4567", "staff": "8901"}
NEW_PINS = {"owner": "1112", "manager": "2223", "staff": "3334"}


class SharedRolePinTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="pin-auth-test-")
        self.addCleanup(self.folder.cleanup)
        self.path = str(Path(self.folder.name) / "fixture.sqlite3")
        self.now = 1_800_000_000
        self.clock = patch("pin_auth.time.time", side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.api = create_app(self.path, origins=["https://localhost"], pin_pepper=PEPPER)
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "Synthetic shared shop")
        self.owner_id = create_user(self.path, self.store, "owner@pin-fixture.invalid", PASSWORD, "owner")
        self.owner = self.login("owner@pin-fixture.invalid")

    def login(self, email):
        response = self.client.post("/v1/auth/login", json={"email": email, "password": PASSWORD})
        self.assertEqual(response.status_code, 200)
        return {"Authorization": "Bearer " + response.json()["token"]}

    def post(self, route, payload=None, headers=None):
        return self.client.post("/v1/auth/device/" + route, json=payload, headers=headers)

    def enroll(self, label="Synthetic shop device"):
        response = self.post("enroll", {"owner_password": PASSWORD, "label": label, "pins": PINS}, self.owner)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def unlock(self, device, role="staff", pin=None):
        return self.post("unlock", {"device_credential": device["device_credential"],
                                    "role": role, "pin": pin if pin is not None else PINS[role]})

    def bearer(self, response):
        self.assertEqual(response.status_code, 200)
        return {"Authorization": "Bearer " + response.json()["token"]}

    def test_enrollment_hashes_only_creates_role_actors_and_preserves_old_account_and_store(self):
        with connect(self.path) as db:
            before_user = tuple(db.execute("SELECT * FROM users WHERE id=?", (self.owner_id,)).fetchone())
            before_store = tuple(db.execute("SELECT * FROM stores").fetchone())
        device = self.enroll()
        self.assertEqual(device["roles"], ["owner", "manager", "staff"])
        self.assertEqual(device["store"], {"id": self.store, "name": "Synthetic shared shop"})
        self.assertEqual(device["expires_at"], self.now + DEVICE_SECONDS)
        with connect(self.path) as db:
            self.assertEqual(tuple(db.execute("SELECT * FROM users WHERE id=?", (self.owner_id,)).fetchone()), before_user)
            self.assertEqual(tuple(db.execute("SELECT * FROM stores").fetchone()), before_store)
            stored = db.execute("SELECT credential_hash FROM remembered_devices").fetchone()[0]
            self.assertEqual(stored, hashlib.sha256(device["device_credential"].encode()).hexdigest())
            records = db.execute("SELECT u.*,r.pin_hash FROM device_auth_roles r JOIN users u ON u.id=r.actor_user_id").fetchall()
            self.assertEqual(len(records), 3)
            for row in records:
                self.assertTrue(row["email"].endswith("@pin-role.ramagan.invalid"))
                self.assertFalse(verify_password(PASSWORD, row["password_hash"]))
                self.assertTrue(row["password_hash"].startswith("unusable-pin-role-v1$"))
                self.assertRegex(row["pin_hash"], r"^pin-scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$")
                self.assertNotEqual(row["pin_hash"], PINS[row["role"]])
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        status = self.post("status", {"device_credential": device["device_credential"]})
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.json()["locked"])
        self.assertNotIn("token", status.json())
        self.assertNotIn("device_credential", status.json())
        self.assertEqual(status.headers["cache-control"], "no-store")

    def test_each_shared_role_has_distinct_actor_and_server_permissions(self):
        device = self.enroll()
        actors = set()
        for role in PINS:
            response = self.unlock(device, role)
            headers = self.bearer(response)
            self.assertEqual(response.json()["expires_at"], self.now + SESSION_SECONDS)
            self.assertEqual(response.json()["auth_method"], "shared_role_pin")
            me = self.client.get("/v1/me", headers=headers)
            self.assertEqual(me.status_code, 200)
            self.assertEqual(me.json()["role"], role)
            self.assertEqual(me.json()["store_id"], self.store)
            self.assertTrue(me.json()["capabilities"]["shared_role_pin"])
            actors.add(me.json()["user"]["id"])
            report = self.client.get("/v1/admin/sales-report", headers=headers)
            self.assertEqual(report.status_code, 403 if role == "staff" else 200)
            self.assertEqual(self.client.get("/v1/catalog", headers=headers).status_code, 200)
        self.assertEqual(len(actors), 3)
        self.assertNotIn(self.owner_id, actors)
        device_headers = {"Authorization": "Bearer " + device["device_credential"]}
        for route in ("/v1/me", "/v1/catalog", "/v1/admin/sales-report"):
            self.assertEqual(self.client.get(route, headers=device_headers).status_code, 401)

    def test_pin_owner_never_authorizes_device_administration_or_password_login(self):
        device = self.enroll()
        owner_pin = self.unlock(device, "owner")
        headers = self.bearer(owner_pin)
        for route, payload in (
            ("enroll", {"owner_password": PASSWORD, "label": "Other", "pins": PINS}),
            ("pins", {"owner_password": PASSWORD, "pins": NEW_PINS}),
            ("revoke", {"owner_password": PASSWORD, "device_id": device["device_id"]}),
        ):
            self.assertEqual(self.post(route, payload, headers).status_code, 403)
        bad_login = self.client.post("/v1/auth/login", json={"email": owner_pin.json()["user"]["email"], "password": PASSWORD})
        self.assertEqual(bad_login.status_code, 401)
        self.assertEqual(self.post("enroll", {"owner_password": "Wrong owner password", "label": "No", "pins": PINS}, self.owner).status_code, 401)

    def test_server_expiry_cannot_be_extended_by_frontend_or_session_row(self):
        device = self.enroll()
        unlocked = self.unlock(device, "owner")
        headers = self.bearer(unlocked)
        with connect(self.path) as db:
            db.execute("UPDATE sessions SET expires_at=? WHERE user_id=?", (self.now + 86400, unlocked.json()["user"]["id"]))
        self.now += 299
        self.assertEqual(self.client.get("/v1/me", headers=headers).status_code, 200)
        self.now += 1
        self.assertEqual(self.client.get("/v1/me", headers=headers).status_code, 401)
        self.assertEqual(self.client.get("/v1/me", headers=self.owner).status_code, 200)

    def test_switching_role_and_lock_revokes_only_same_device_pin_sessions(self):
        first, second = self.enroll(), self.enroll("Second device")
        first_owner = self.bearer(self.unlock(first, "owner"))
        second_manager = self.bearer(self.unlock(second, "manager"))
        first_staff = self.bearer(self.unlock(first, "staff"))
        self.assertEqual(self.client.get("/v1/me", headers=first_owner).status_code, 401)
        self.assertEqual(self.client.get("/v1/me", headers=second_manager).status_code, 200)
        self.assertEqual(self.post("lock", headers=first_staff).status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=first_staff).status_code, 401)
        self.assertEqual(self.client.get("/v1/me", headers=second_manager).status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=self.owner).status_code, 200)
        self.assertEqual(self.post("lock", headers=self.owner).status_code, 403)

    def test_pin_rotation_and_device_revoke_invalidate_issued_sessions_immediately(self):
        first, second = self.enroll(), self.enroll("Other device")
        headers = self.bearer(self.unlock(first, "owner"))
        self.assertEqual(self.post("pins", {"owner_password": PASSWORD, "pins": NEW_PINS}, self.owner).status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=headers).status_code, 401)
        self.assertEqual(self.unlock(first, "owner").status_code, 401)
        fresh = self.bearer(self.unlock(first, "owner", NEW_PINS["owner"]))
        other = self.bearer(self.unlock(second, "staff", NEW_PINS["staff"]))
        self.assertEqual(self.post("revoke", {"owner_password": PASSWORD, "device_id": first["device_id"]}, self.owner).status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=fresh).status_code, 401)
        self.assertEqual(self.post("status", {"device_credential": first["device_credential"]}).status_code, 401)
        self.assertEqual(self.client.get("/v1/me", headers=other).status_code, 200)

    def test_global_role_lock_survives_restart_reenrollment_and_alternate_devices(self):
        first = self.enroll()
        for _ in range(5):
            self.assertEqual(self.unlock(first, "owner", "9999").status_code, 401)
        self.assertEqual(self.unlock(first, "owner").status_code, 429)
        second = self.enroll("Reenrolled device")
        self.assertEqual(self.unlock(second, "owner").status_code, 429)
        restarted = TestClient(create_app(self.path, pin_pepper=PEPPER), raise_server_exceptions=False)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.post("/v1/auth/device/unlock", json={
            "device_credential": second["device_credential"], "role": "owner", "pin": PINS["owner"]}).status_code, 429)
        for _ in range(5):
            self.now += 901
            self.assertEqual(self.unlock(second, "owner", "9999").status_code, 401)
        self.now += 901
        self.assertEqual(self.unlock(second, "owner").status_code, 429)
        status = self.post("status", {"device_credential": second["device_credential"]}).json()
        self.assertTrue(status["role_lockouts"]["owner"]["recovery_required"])
        # Password recovery explicitly rotates PINs and clears persistent limits.
        self.assertEqual(self.post("pins", {"owner_password": PASSWORD, "pins": NEW_PINS}, self.owner).status_code, 200)
        self.assertEqual(self.unlock(second, "owner", NEW_PINS["owner"]).status_code, 200)

    def test_concurrent_failures_are_atomic_and_never_exceed_guess_budget(self):
        device = self.enroll()
        def attempt(_):
            with TestClient(self.api, raise_server_exceptions=False) as client:
                return client.post("/v1/auth/device/unlock", json={
                    "device_credential": device["device_credential"], "role": "staff", "pin": "9999"}).status_code
        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(attempt, range(8)))
        self.assertEqual(sorted(statuses), [401] * 5 + [429] * 3)
        with connect(self.path) as db:
            self.assertEqual([r[0] for r in db.execute("SELECT fail_count FROM device_auth_limits WHERE (kind='store_role' AND role<>'') OR kind IN ('device_role','device')")], [5, 5, 5])

    def test_success_for_another_role_cannot_reset_owner_guessing_budget(self):
        first, second = self.enroll(), self.enroll("Second")
        for _ in range(4):
            self.assertEqual(self.unlock(first, "owner", "9999").status_code, 401)
        self.assertEqual(self.unlock(second, "staff").status_code, 200)
        self.assertEqual(self.unlock(second, "owner", "9999").status_code, 401)
        self.assertEqual(self.unlock(second, "owner").status_code, 429)

    def test_strict_four_ascii_digits_distinct_pins_and_sanitized_errors(self):
        for value in (1234, True, 12.34, None, "１２３４", "123", "12345", "SECRET_BAD_PIN"):
            response = self.post("enroll", {"owner_password": PASSWORD, "label": "Invalid", "pins": {**PINS, "staff": value}}, self.owner)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), {"detail": "Invalid device authentication request"})
            self.assertNotIn(PASSWORD, response.text)
        self.assertEqual(self.post("enroll", {"owner_password": PASSWORD, "label": "Same", "pins": {"owner": "1234", "manager": "1234", "staff": "1234"}}, self.owner).status_code, 422)
        device = self.enroll()
        self.assertEqual(self.unlock(device, "owner", "0123").status_code, 200)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM remembered_devices").fetchone()[0], 1)

    def test_missing_pepper_disables_pin_sessions_changed_pepper_blocks_new_unlock(self):
        device = self.enroll()
        headers = self.bearer(self.unlock(device))
        for pepper in (b"", b"short"):
            with TestClient(create_app(self.path, pin_pepper=pepper)) as client:
                health = client.get("/health").json()
                self.assertFalse(health["shared_role_pin"])
                self.assertEqual(client.post("/v1/auth/device/status", json={"device_credential": device["device_credential"]}).status_code, 503)
                self.assertEqual(client.get("/v1/me", headers=headers).status_code, 401)
                self.assertEqual(client.get("/v1/me", headers=self.owner).status_code, 200)
        with TestClient(create_app(self.path, pin_pepper=b"a-different-synthetic-pepper-123456789")) as client:
            self.assertEqual(client.post("/v1/auth/device/unlock", json={"device_credential": device["device_credential"], "role": "staff", "pin": PINS["staff"]}).status_code, 401)
            # Key rotation is not revocation: operators must revoke sessions and
            # reset PINs explicitly. An existing token remains bounded to 300s.
            self.assertEqual(client.get("/v1/me", headers=headers).status_code, 200)

    def test_role_mapping_tamper_and_unbound_synthetic_session_never_gain_access(self):
        device = self.enroll()
        response = self.unlock(device, "staff")
        headers = self.bearer(response)
        uid = response.json()["user"]["id"]
        forged = secrets.token_urlsafe(48)
        with connect(self.path) as db:
            db.execute("INSERT INTO sessions VALUES(?,?,?,0)", (hashlib.sha256(forged.encode()).hexdigest(), uid, self.now + 300))
        self.assertEqual(self.client.get("/v1/me", headers={"Authorization": "Bearer " + forged}).status_code, 401)
        with connect(self.path) as db:
            db.execute("UPDATE users SET role='owner' WHERE id=?", (uid,))
        self.assertEqual(self.client.get("/v1/me", headers=headers).status_code, 401)
        self.assertEqual(self.unlock(device, "staff").status_code, 409)

    def test_other_store_owner_cannot_revoke_device_and_credential_expires_at_ninety_days(self):
        device = self.enroll()
        other_store = create_store(self.path, "Other synthetic shop")
        create_user(self.path, other_store, "other@pin-fixture.invalid", PASSWORD, "owner")
        other = self.login("other@pin-fixture.invalid")
        self.assertEqual(self.post("revoke", {"owner_password": PASSWORD, "device_id": device["device_id"]}, other).status_code, 404)
        self.now = device["expires_at"]
        self.assertEqual(self.post("status", {"device_credential": device["device_credential"]}).status_code, 401)
        self.assertEqual(self.unlock(device).status_code, 401)

    def test_partial_role_enrollment_failure_leaves_no_actor_device_or_pin(self):
        with connect(self.path) as db:
            db.execute("""CREATE TRIGGER synthetic_enroll_failure BEFORE INSERT ON users
                WHEN NEW.email LIKE '%@pin-role.ramagan.invalid' AND NEW.role='manager'
                BEGIN SELECT RAISE(ABORT,'Synthetic enrollment fault'); END""")
        response = self.post("enroll", {"owner_password": PASSWORD, "label": "Fault", "pins": PINS}, self.owner)
        self.assertEqual(response.status_code, 500)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM users").fetchone()[0], 1)
            for table in ("device_auth_roles", "remembered_devices", "device_auth_events"):
                self.assertEqual(db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)

    def test_failed_role_switch_rolls_back_revocation_and_session_insert(self):
        device = self.enroll()
        prior = self.bearer(self.unlock(device, "staff"))
        with connect(self.path) as db:
            old_count = db.execute("SELECT count(*) FROM sessions").fetchone()[0]
            db.execute("""CREATE TRIGGER synthetic_binding_failure BEFORE INSERT ON device_pin_sessions
                BEGIN SELECT RAISE(ABORT,'Synthetic binding fault'); END""")
        self.assertEqual(self.unlock(device, "owner").status_code, 500)
        self.assertEqual(self.client.get("/v1/me", headers=prior).status_code, 200)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sessions").fetchone()[0], old_count)
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 1)

    def test_real_owner_password_failures_are_persistent_and_cannot_use_new_session_to_bypass(self):
        for _ in range(5):
            self.assertEqual(self.post("enroll", {"owner_password": "Incorrect synthetic password", "label": "No", "pins": PINS}, self.owner).status_code, 401)
        replacement = self.login("owner@pin-fixture.invalid")
        self.assertEqual(self.post("enroll", {"owner_password": PASSWORD, "label": "Locked", "pins": PINS}, replacement).status_code, 429)
        self.now += 901
        self.assertEqual(self.post("enroll", {"owner_password": PASSWORD, "label": "Recovered", "pins": PINS}, replacement).status_code, 200)

    def test_deleting_expired_pin_sessions_does_not_break_legacy_login_cleanup(self):
        device = self.enroll()
        self.bearer(self.unlock(device))
        self.now += SESSION_SECONDS + 1
        headers = self.login("owner@pin-fixture.invalid")
        self.assertEqual(self.client.get("/v1/me", headers=headers).status_code, 200)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 0)
            # Immutable authentication events survive session cleanup.
            self.assertGreater(db.execute("SELECT count(*) FROM device_auth_events").fetchone()[0], 0)

    def test_blocked_requests_do_not_grow_audit_or_change_persistent_counters(self):
        device = self.enroll()
        for _ in range(5):
            self.assertEqual(self.unlock(device, "staff", "9999").status_code, 401)
        def snapshot():
            with connect(self.path) as db:
                return {table: sorted(tuple(r) for r in db.execute("SELECT * FROM " + table))
                        for table in ("device_auth_limits", "device_auth_events", "sessions", "device_pin_sessions", "remembered_devices")}
        before = snapshot()
        for _ in range(20):
            self.assertEqual(self.unlock(device, "staff", "9999").status_code, 429)
        self.assertTrue(snapshot() == before, "Blocked attempts mutated authentication state")

    def test_operator_pepper_file_is_bounded_absolute_and_never_overrides_explicit_value(self):
        key_file = Path(self.folder.name) / "synthetic-pepper.key"
        key_file.write_bytes(PEPPER)
        with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER": "", "RAMAGAN_PIN_PEPPER_FILE": str(key_file)}):
            self.assertEqual(resolve_pepper(), PEPPER)
            self.assertEqual(resolve_pepper(b"explicit-synthetic-pepper-123456789"), b"explicit-synthetic-pepper-123456789")
            self.assertIsNone(resolve_pepper(b"short"))
            with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER": "short"}):
                self.assertIsNone(resolve_pepper())
            with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER": "explicit-environment-synthetic-pepper-12345"}):
                self.assertEqual(resolve_pepper(), b"explicit-environment-synthetic-pepper-12345")
            for data in (b"short", b"x" * 4097):
                key_file.write_bytes(data)
                self.assertIsNone(resolve_pepper())
            key_file.write_bytes(PEPPER)
            with patch("pin_auth.Path.open", side_effect=PermissionError("Synthetic denial")):
                self.assertIsNone(resolve_pepper())
            with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER_FILE": "relative-key-not-allowed"}):
                self.assertIsNone(resolve_pepper())
            with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER_FILE": str(key_file) + ".missing"}):
                self.assertIsNone(resolve_pepper())
            with TestClient(create_app(self.path)) as client:
                self.assertTrue(client.get("/health").json()["shared_role_pin"])


if __name__ == "__main__":
    unittest.main()
