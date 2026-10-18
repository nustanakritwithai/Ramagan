"""One-request automatic role PIN matching, using disposable fixture shops only."""
from concurrent.futures import ThreadPoolExecutor
import unittest

from fastapi.testclient import TestClient

import test_pin_auth as fixture
from app import connect, create_app, verify_password
from pin_auth import DeviceAuth


class AutomaticRolePinTests(unittest.TestCase):
    setUp = fixture.SharedRolePinTests.setUp
    login = fixture.SharedRolePinTests.login
    post = fixture.SharedRolePinTests.post
    enroll = fixture.SharedRolePinTests.enroll
    unlock = fixture.SharedRolePinTests.unlock
    bearer = fixture.SharedRolePinTests.bearer

    def auto(self, device, pin):
        return self.post("unlock", {"device_credential": device["device_credential"], "pin": pin})

    def role_rows(self):
        with connect(self.path) as db:
            return [tuple(row) for row in db.execute("SELECT * FROM device_auth_roles ORDER BY role")]

    def test_single_request_selects_each_actual_role_and_keeps_original_verifiers(self):
        device = self.enroll()
        before = self.role_rows()
        self.assertTrue(device["auto_role_pin"])
        self.assertEqual(device["auto_role_pin_contract_version"], 1)
        self.assertTrue(self.post("status", {"device_credential": device["device_credential"]}).json()["auto_role_pin"])
        actors = set()
        for role, pin in fixture.PINS.items():
            response = self.auto(device, pin)
            headers = self.bearer(response)
            self.assertEqual(response.json()["role"], role)
            actors.add(response.json()["user"]["id"])
            profile = self.client.get("/v1/me", headers=headers).json()
            self.assertEqual(profile["role"], role)
            self.assertTrue(profile["capabilities"]["auto_role_pin"])
            self.assertEqual(profile["capabilities"]["auto_role_pin_contract_version"], 1)
            report = self.client.get("/v1/admin/sales-report", headers=headers)
            self.assertEqual(report.status_code, 403 if role == "staff" else 200)
        self.assertEqual(len(actors), 3)
        self.assertNotIn(self.owner_id, actors)
        self.assertEqual(before, self.role_rows())
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
        # Explicit old clients still have the original request/response contract.
        self.assertEqual(self.unlock(device, "owner").status_code, 200)

    def test_strict_input_and_one_failed_guess_do_not_leak_roles_or_secrets(self):
        device = self.enroll()
        for pin in (True, 1234, 12.34, None, "１２３４", "123", "12345", "PRIVATE_WRONG_PIN"):
            response = self.auto(device, pin)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), {"detail": "Invalid device authentication request"})
        response = self.auto(device, "9999")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json(), {"detail": "Invalid role or PIN"})
        for secret in ("9999", device["device_credential"], fixture.PASSWORD):
            self.assertNotIn(secret, response.text)
        with connect(self.path) as db:
            counts = list(db.execute("SELECT kind,fail_count FROM device_auth_limits ORDER BY kind"))
            self.assertEqual([tuple(row) for row in counts], [("device", 1), ("store_role", 1)])
            self.assertEqual(db.execute("SELECT count(*) FROM device_auth_events WHERE event='PIN_FAILURE'").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 0)

    def test_auto_and_explicit_modes_share_budget_in_both_directions(self):
        device = self.enroll()
        for _ in range(4):
            self.assertEqual(self.unlock(device, "owner", "9999").status_code, 401)
        self.assertEqual(self.auto(device, "9999").status_code, 401)
        self.assertEqual(self.auto(device, fixture.PINS["staff"]).status_code, 429)
        self.assertEqual(self.unlock(device, "manager").status_code, 429)
        status = self.post("status", {"device_credential": device["device_credential"]}).json()
        self.assertTrue(all(status["role_lockouts"][role]["locked_until"] > self.now for role in fixture.PINS))
        self.assertEqual(self.post("pins", {"owner_password": fixture.PASSWORD, "pins": fixture.NEW_PINS}, self.owner).status_code, 200)
        for _ in range(4):
            self.assertEqual(self.auto(device, "9999").status_code, 401)
        self.assertEqual(self.unlock(device, "staff", "9999").status_code, 401)
        self.assertEqual(self.unlock(device, "owner", fixture.NEW_PINS["owner"]).status_code, 429)

    def test_auto_aggregate_survives_device_changes_process_restart_and_cannot_be_cleared_by_success(self):
        first, second = self.enroll(), self.enroll("Other synthetic device")
        for index in range(4):
            self.assertEqual(self.auto(first if index % 2 else second, "9999").status_code, 401)
        third = self.enroll("Enrolled after failed guesses")
        self.assertEqual(self.auto(third, fixture.PINS["staff"]).status_code, 200)
        with TestClient(create_app(self.path, pin_pepper=fixture.PEPPER), raise_server_exceptions=False) as client:
            request = {"device_credential": first["device_credential"], "pin": "9999"}
            self.assertEqual(client.post("/v1/auth/device/unlock", json=request).status_code, 401)
            request["pin"] = fixture.PINS["owner"]
            self.assertEqual(client.post("/v1/auth/device/unlock", json=request).status_code, 429)

    def test_previous_explicit_role_lockout_cannot_be_bypassed_by_auto_match(self):
        device = self.enroll()
        with connect(self.path) as db:
            db.execute("INSERT INTO device_auth_limits VALUES(?,?,?,?,?,?,?)",
                       (self.store, "store_role", self.store, "owner", 5, self.now + 900, 0))
        self.assertEqual(self.auto(device, fixture.PINS["owner"]).status_code, 429)
        self.assertEqual(self.auto(device, fixture.PINS["staff"]).status_code, 200)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT fail_count FROM device_auth_limits WHERE kind='store_role' AND role='owner'").fetchone()[0], 5)

    def test_partial_or_inactive_or_ambiguous_mapping_holds_without_issuing_session(self):
        device = self.enroll()
        with connect(self.path) as db:
            db.execute("UPDATE users SET is_active=0 WHERE id=(SELECT actor_user_id FROM device_auth_roles WHERE store_id=? AND role='manager')", (self.store,))
        self.assertEqual(self.auto(device, fixture.PINS["owner"]).status_code, 409)

        with connect(self.path) as db:
            db.execute("UPDATE users SET is_active=1 WHERE id=(SELECT actor_user_id FROM device_auth_roles WHERE store_id=? AND role='manager')", (self.store,))
            hasher = DeviceAuth(self.path, connect, verify_password, fixture.PEPPER)
            db.execute("UPDATE device_auth_roles SET pin_hash=? WHERE store_id=? AND role='staff'",
                       (hasher._pin_hash(fixture.PINS["owner"], self.store, "staff"), self.store))
        response = self.auto(device, fixture.PINS["owner"])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "Role authentication requires owner recovery"})
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 0)
            db.execute("DELETE FROM device_auth_roles WHERE store_id=? AND role='manager'", (self.store,))
        self.assertEqual(self.auto(device, fixture.PINS["owner"]).status_code, 409)

    def test_explicit_legacy_requests_also_hold_on_incomplete_or_blob_verifiers(self):
        device = self.enroll()
        with connect(self.path) as db:
            original = db.execute("SELECT pin_hash FROM device_auth_roles WHERE store_id=? AND role='manager'", (self.store,)).fetchone()[0]
            db.execute("UPDATE device_auth_roles SET pin_hash=? WHERE store_id=? AND role='manager'", (b"invalid-blob-verifier", self.store))
        for request in (self.auto(device, fixture.PINS["owner"]), self.unlock(device, "owner")):
            self.assertEqual(request.status_code, 409)
            self.assertEqual(request.json(), {"detail": "Role authentication requires owner recovery"})
        with connect(self.path) as db:
            db.execute("UPDATE device_auth_roles SET pin_hash=? WHERE store_id=? AND role='manager'", (original, self.store))
            db.execute("DELETE FROM device_auth_roles WHERE store_id=? AND role='staff'", (self.store,))
        self.assertEqual(self.unlock(device, "owner").status_code, 409)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM device_pin_sessions").fetchone()[0], 0)

    def test_concurrent_auto_guesses_persist_once_and_stop_at_five(self):
        device = self.enroll()
        def attempt(_):
            with TestClient(self.api, raise_server_exceptions=False) as client:
                return client.post("/v1/auth/device/unlock", json={
                    "device_credential": device["device_credential"], "pin": "9999"}).status_code
        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(attempt, range(8)))
        self.assertEqual(sorted(statuses), [401] * 5 + [429] * 3)
        with connect(self.path) as db:
            self.assertEqual([row[0] for row in db.execute("SELECT fail_count FROM device_auth_limits")], [5, 5])
            self.assertEqual(db.execute("SELECT count(*) FROM device_auth_events WHERE event IN ('PIN_FAILURE','LOCKED')").fetchone()[0], 5)

    def test_revoked_expired_or_unknown_device_and_missing_pepper_never_auto_unlock(self):
        device = self.enroll()
        self.assertEqual(self.post("revoke", {"owner_password": fixture.PASSWORD, "device_id": device["device_id"]}, self.owner).status_code, 200)
        self.assertEqual(self.auto(device, fixture.PINS["owner"]).status_code, 401)
        device = self.enroll("Expiry fixture")
        self.now = device["expires_at"]
        self.assertEqual(self.auto(device, fixture.PINS["owner"]).status_code, 401)
        with TestClient(create_app(self.path, pin_pepper=b""), raise_server_exceptions=False) as client:
            self.assertEqual(client.post("/v1/auth/device/unlock", json={"device_credential": device["device_credential"], "pin": fixture.PINS["owner"]}).status_code, 503)
