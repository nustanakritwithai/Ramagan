"""First-use PIN policy and preserving enrollment, on disposable fixtures only."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import secrets
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

import test_pin_auth as fixture
from app import connect, create_app, create_user
from evidence_fixture import upload_photo
from fastapi.testclient import TestClient
from migrations import _snapshot
from pin_auth import DeviceAuth, SESSION_SECONDS
import stocktake_evidence


def uid():
    return str(uuid.uuid4())


class FirstUsePinTests(unittest.TestCase):
    setUp = fixture.SharedRolePinTests.setUp
    login = fixture.SharedRolePinTests.login
    post = fixture.SharedRolePinTests.post
    enroll = fixture.SharedRolePinTests.enroll
    unlock = fixture.SharedRolePinTests.unlock
    bearer = fixture.SharedRolePinTests.bearer

    def state(self):
        with connect(self.path) as db:
            db.row_factory = None
            return _snapshot(db)

    def unchanged(self, before):
        self.assertTrue(before == self.state(), "Rejected/read-only PIN request changed fixture state")

    def configuration(self, headers=None, client=None):
        return (client or self.client).get("/v1/auth/device/configuration", headers=self.owner if headers is None else headers)

    def preserving_enroll(self, *, client=None, headers=None, password=fixture.PASSWORD):
        return (client or self.client).post("/v1/auth/device/enroll", headers=self.owner if headers is None else headers,
            json={"owner_password": password, "label": "Synthetic replacement APK device"})

    def product_payload(self):
        return {"sku": uid(), "name": "SYNTHETIC PIN POLICY", "price_satang_per_gram": 10000}

    def seed_inventory(self):
        product, lot = uid(), uid()
        with connect(self.path) as db:
            db.execute("INSERT INTO products(id,store_id,sku,name,price_satang_per_gram,created_at) VALUES(?,?,?,?,10000,'fixture')",
                       (product, self.store, product, "SYNTHETIC PIN ONLY"))
            db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,received_at) VALUES(?,?,?,?,?,'','fixture')",
                       (lot, self.store, product, lot, "SYNTHETIC"))
            db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,10000,'fixture')", (lot,))
            db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))
        return product, lot

    def receive_payload(self, product):
        return {"client_receive_id": uid(), "product_id": product, "lot_code": uid(), "supplier_name": "SYNTHETIC",
                "quantity_mg": 1000, "reason": "Synthetic receipt"}

    def sale_payload(self, lot):
        return {"client_sale_id": uid(), "payment_method": "cash", "items": [{"lot_id": lot, "quantity_mg": 1000}]}

    def test_owner_configuration_is_read_only_private_and_first_setup_still_requires_three_pins(self):
        before = self.state()
        response = self.configuration()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"configured": False, "roles": [], "device_enrollment_contract_version": 2})
        self.assertEqual(response.headers["cache-control"], "no-store")
        caps = self.client.get("/v1/me", headers=self.owner).json()["capabilities"]
        self.assertTrue(caps["pos_pin_required"])
        self.assertTrue(caps["pin_preserving_enrollment"])
        self.assertEqual(caps["device_enrollment_contract_version"], 2)
        self.assertEqual(self.preserving_enroll().status_code, 422)
        blocked = self.client.post("/v1/products", headers=self.owner, json=self.product_payload())
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(self.client.get("/v1/admin/sales-report", headers=self.owner).status_code, 200)
        self.unchanged(before)
        device = self.enroll()
        self.assertEqual(self.configuration().json(), {"configured": True, "roles": ["owner", "manager", "staff"], "device_enrollment_contract_version": 2})
        self.assertEqual(self.configuration(headers={}).status_code, 401)
        for role in ("owner", "manager", "staff"):
            pin = self.bearer(self.unlock(device, role))
            self.assertEqual(self.configuration(headers=pin).status_code, 403)

    def test_new_device_reuses_existing_pin_hashes_versions_actors_limits_and_other_sessions(self):
        first = self.enroll()
        prior = self.bearer(self.unlock(first, "staff"))
        self.assertEqual(self.unlock(first, "owner", "9999").status_code, 401)
        before = self.state()
        response = self.preserving_enroll()
        self.assertEqual(response.status_code, 200, response.text)
        second = response.json()
        after = self.state()
        for table in ("device_auth_roles", "users", "sessions", "device_pin_sessions", "device_auth_limits", "stores"):
            self.assertEqual(before["rows"][table], after["rows"][table], table)
        self.assertTrue(set(before["rows"]["remembered_devices"]).issubset(after["rows"]["remembered_devices"]))
        self.assertEqual(len(after["rows"]["remembered_devices"]), 2)
        self.assertEqual(len(after["rows"]["device_auth_events"]), len(before["rows"]["device_auth_events"]) + 1)
        self.assertEqual(self.client.get("/v1/me", headers=prior).status_code, 200)
        for role in ("owner", "manager", "staff"):
            self.assertEqual(self.unlock(second, role).status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=prior).status_code, 200)

    def test_existing_matching_pin_payload_is_compatible_but_mismatch_cannot_rotate(self):
        self.enroll()
        before = self.state()
        bad = self.post("enroll", {"owner_password": fixture.PASSWORD, "label": "Wrong PINs", "pins": fixture.NEW_PINS}, self.owner)
        self.assertEqual(bad.status_code, 409)
        self.unchanged(before)
        self.enroll("Compatible old APK")
        after = self.state()
        self.assertEqual(before["rows"]["device_auth_roles"], after["rows"]["device_auth_roles"])
        self.assertEqual(before["rows"]["users"], after["rows"]["users"])

    def test_partial_inactive_bad_mapping_or_malformed_verifier_holds_without_repairing_or_replacing(self):
        self.enroll()
        with connect(self.path) as db:
            row = dict(db.execute("SELECT * FROM device_auth_roles WHERE store_id=? AND role='staff'", (self.store,)).fetchone())
            user = dict(db.execute("SELECT * FROM users WHERE id=?", (row["actor_user_id"],)).fetchone())
        for mode in ("partial", "inactive", "role", "hash", "password", "hash_blob", "password_blob"):
            with self.subTest(mode=mode):
                with connect(self.path) as db:
                    if mode == "partial":
                        db.execute("DELETE FROM device_auth_roles WHERE store_id=? AND role='staff'", (self.store,))
                    elif mode in ("inactive", "role", "password", "password_blob"):
                        field, value = {"inactive": ("is_active", 0), "role": ("role", "owner"),
                                        "password": ("password_hash", "unexpected-password-login"),
                                        "password_blob": ("password_hash", b"unexpected-binary-password")}[mode]
                        db.execute("UPDATE users SET " + field + "=? WHERE id=?", (value, user["id"]))
                    elif mode == "hash_blob":
                        db.execute("UPDATE device_auth_roles SET pin_hash=? WHERE store_id=? AND role='staff'", (b"unexpected-binary-verifier", self.store))
                    else:
                        db.execute("UPDATE device_auth_roles SET pin_hash='malformed' WHERE store_id=? AND role='staff'", (self.store,))
                before = self.state()
                self.assertEqual(self.configuration().status_code, 409)
                self.assertEqual(self.preserving_enroll().status_code, 409)
                self.assertEqual(self.client.post("/v1/products", headers=self.owner, json=self.product_payload()).status_code, 409)
                self.unchanged(before)
                with connect(self.path) as db:
                    db.execute("DELETE FROM device_auth_roles WHERE store_id=? AND role='staff'", (self.store,))
                    db.execute("INSERT INTO device_auth_roles VALUES(?,?,?,?,?,?)", tuple(row.values()))
                    db.execute("UPDATE users SET is_active=?,role=?,password_hash=? WHERE id=?",
                               (user["is_active"], user["role"], user["password_hash"], user["id"]))

    def test_password_owner_cannot_make_business_writes_but_role_pins_keep_permissions(self):
        product, lot = self.seed_inventory()
        device = self.enroll()
        sale = self.sale_payload(lot)
        count = {"client_stocktake_id": uid(), "shift_label": "Synthetic", "items": [{"lot_id": lot, "expected_revision": 0, "counted_quantity_mg": 10000}]}
        before = self.state()
        for route, payload in (("/v1/products", self.product_payload()), ("/v1/lots/receive", self.receive_payload(product)),
                               ("/v1/sales", sale), ("/v1/stocktakes", count)):
            self.assertEqual(self.client.post(route, headers=self.owner, json=payload).status_code, 403)
        self.unchanged(before)
        manager = self.bearer(self.unlock(device, "manager"))
        self.assertEqual(self.client.post("/v1/products", headers=manager, json=self.product_payload()).status_code, 200)
        staff = self.bearer(self.unlock(device, "staff"))
        self.assertEqual(self.client.post("/v1/products", headers=staff, json=self.product_payload()).status_code, 403)
        saved = self.client.post("/v1/sales", headers=staff, json=sale)
        self.assertEqual(saved.status_code, 200, saved.text)
        before = self.state()
        self.assertEqual(self.client.post("/v1/sales/" + saved.json()["sale_id"] + "/void", headers=self.owner,
                                         json={"client_void_id": uid(), "reason": "Synthetic"}).status_code, 403)
        self.assertEqual(self.client.post("/v1/stocktake-evidence/" + uid(), params={"lot_id": lot, "client_stocktake_id": uid()},
            headers={**self.owner, "Content-Type": "image/jpeg"}, content=fixture_image()).status_code, 403)
        self.assertEqual(self.client.get("/v1/admin/sales-report", headers=self.owner).status_code, 200)
        self.unchanged(before)

    def test_missing_or_invalid_configured_pepper_fails_closed_without_changing_policy_or_pin_rows(self):
        self.enroll()
        before = self.state()
        missing = str(Path(self.folder.name) / "missing-configured-pepper.key")
        for kwargs, environment in (({"pin_pepper": b"short"}, {}), ({"pin_pepper": b""}, {}),
                                     ({}, {"RAMAGAN_PIN_PEPPER": "", "RAMAGAN_PIN_PEPPER_FILE": missing})):
            with self.subTest(kwargs=bool(kwargs)), patch.dict(os.environ, environment):
                with TestClient(create_app(self.path, **kwargs), raise_server_exceptions=False) as client:
                    caps = client.get("/v1/me", headers=self.owner).json()["capabilities"]
                    self.assertFalse(caps["shared_role_pin"])
                    self.assertTrue(caps["pos_pin_required"])
                    self.assertEqual(client.post("/v1/products", headers=self.owner, json=self.product_payload()).status_code, 503)
                    self.assertEqual(client.get("/v1/admin/sales-report", headers=self.owner).status_code, 200)
        self.unchanged(before)

    def test_configured_but_missing_key_on_unconfigured_shop_cannot_fall_back_to_first_use_password_pos(self):
        missing = str(Path(self.folder.name) / "missing-first-use-pepper.key")
        with patch.dict(os.environ, {"RAMAGAN_PIN_PEPPER": "", "RAMAGAN_PIN_PEPPER_FILE": missing}):
            for options in ({}, {"pin_pepper": b""}):
                with TestClient(create_app(self.path, **options), raise_server_exceptions=False) as client:
                    before = self.state()
                    self.assertTrue(client.get("/v1/me", headers=self.owner).json()["capabilities"]["pos_pin_required"])
                    self.assertEqual(client.post("/v1/products", headers=self.owner, json=self.product_payload()).status_code, 503)
                    self.unchanged(before)

    def test_original_password_actor_recovers_completed_intents_and_metadata_cancellation_without_new_business(self):
        product, lot = self.seed_inventory()
        receive = self.receive_payload(product)
        count_id = uid()
        sale = self.sale_payload(lot)
        with TestClient(create_app(self.path, pin_pepper=b""), raise_server_exceptions=False) as legacy:
            self.assertFalse(legacy.get("/v1/me", headers=self.owner).json()["capabilities"]["pos_pin_required"])
            received = legacy.post("/v1/lots/receive", headers=self.owner, json=receive)
            self.assertEqual(received.status_code, 200, received.text)
            photo = upload_photo(legacy, self.owner, lot, count_id)
            count = {"client_stocktake_id": count_id, "shift_label": "Synthetic legacy snapshot", "items": [
                {"lot_id": lot, "expected_revision": 0, "counted_quantity_mg": 10000, "evidence_id": photo["evidence_id"]}]}
            counted = legacy.post("/v1/stocktakes", headers=self.owner, json=count)
            self.assertEqual(counted.status_code, 200, counted.text)
            saved = legacy.post("/v1/sales", headers=self.owner, json=sale)
            self.assertEqual(saved.status_code, 200, saved.text)
            before_void = self.sale_payload(lot)
            voided_sale = legacy.post("/v1/sales", headers=self.owner, json=before_void)
            self.assertEqual(voided_sale.status_code, 200)
            void_route = "/v1/sales/" + voided_sale.json()["sale_id"] + "/void"
            void_payload = {"client_void_id": uid(), "reason": "Synthetic legacy void"}
            voided = legacy.post(void_route, headers=self.owner, json=void_payload)
            self.assertEqual(voided.status_code, 200, voided.text)
            pending_id = uid()
            pending_photo = upload_photo(legacy, self.owner, lot, pending_id)
            with connect(self.path) as db:
                quantity, revision = tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (lot,)).fetchone())
            pending_count = {"client_stocktake_id": pending_id, "shift_label": "Synthetic pending count", "items": [
                {"lot_id": lot, "expected_revision": revision, "counted_quantity_mg": quantity, "evidence_id": pending_photo["evidence_id"]}]}
        self.enroll()
        before = self.state()
        for route, payload, recorded in (("/v1/lots/receive", receive, received), ("/v1/stocktakes", count, counted),
                                         ("/v1/sales", sale, saved), (void_route, void_payload, voided)):
            duplicate = self.client.post(route, headers=self.owner, json=payload)
            self.assertEqual(duplicate.status_code, 200, duplicate.text)
            self.assertEqual(duplicate.json(), {**recorded.json(), "duplicate": True})
        for route, payload in (("/v1/lots/receive/reconcile", receive), ("/v1/stocktakes/reconcile", count), ("/v1/sales/reconcile", sale)):
            response = self.client.post(route, headers=self.owner, json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["status"], "completed")
        pending = self.client.post("/v1/stocktakes/reconcile", headers=self.owner, json=pending_count)
        self.assertEqual(pending.json(), {"status": "pending", "client_stocktake_id": pending_id})
        self.assertEqual(self.client.post("/v1/stocktakes", headers=self.owner, json=pending_count).status_code, 403)
        self.assertEqual(self.client.get("/v1/sale-voids/by-client/" + uid(), headers=self.owner).status_code, 404)
        self.unchanged(before)
        # Only existing metadata cancellation is permitted under the original
        # password identity. It never receives/sells/restocks any quantity.
        new_sale, new_receive = self.sale_payload(lot), self.receive_payload(product)
        stale_count = {**count, "client_stocktake_id": uid()}
        before = self.state()
        for route, payload, code in (("/v1/sales/reconcile", new_sale, "SALE_CANCELLED"),
                                     ("/v1/lots/receive/reconcile", new_receive, "RECEIVE_CANCELLED"),
                                     ("/v1/stocktakes/reconcile", stale_count, "STOCK_CHANGED")):
            response = self.client.post(route, headers=self.owner, json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["code"], code)
            self.assertFalse(response.json()["committed"])
        after = self.state()
        for table in before["rows"]:
            if table not in {"sale_rejections", "receive_rejections", "stocktake_rejections"}:
                self.assertEqual(before["rows"][table], after["rows"][table], table)
        for route, payload in (("/v1/sales", new_sale), ("/v1/lots/receive", new_receive), ("/v1/stocktakes", stale_count)):
            self.assertEqual(self.client.post(route, headers=self.owner, json=payload).status_code, 409)

    def test_new_enrollment_or_pin_write_cannot_use_session_revoked_while_waiting_for_transaction(self):
        _, lot = self.seed_inventory()
        payload = self.sale_payload(lot)
        with TestClient(create_app(self.path, pin_pepper=b""), raise_server_exceptions=False) as legacy:
            self.assertEqual(legacy.post("/v1/sales", headers=self.owner, json=payload).status_code, 200)
        device = self.enroll()
        pin = self.bearer(self.unlock(device, "manager"))
        original = DeviceAuth.valid_session
        for operation in ("enroll", "product", "duplicate_sale"):
            with self.subTest(operation=operation):
                headers = pin if operation == "product" else self.owner
                authorized = threading.Event()
                def traced(auth, db, digest, actor, now):
                    valid = original(auth, db, digest, actor, now)
                    authorized.set()
                    return valid
                with connect(self.path) as writer:
                    writer.execute("BEGIN IMMEDIATE")
                    with patch.object(DeviceAuth, "valid_session", traced), ThreadPoolExecutor(max_workers=1) as pool:
                        if operation == "enroll":
                            future = pool.submit(self.preserving_enroll)
                        elif operation == "product":
                            future = pool.submit(self.client.post, "/v1/products", headers=headers, json=self.product_payload())
                        else:
                            future = pool.submit(self.client.post, "/v1/sales", headers=headers, json=payload)
                        self.assertTrue(authorized.wait(5))
                        token = headers["Authorization"][7:]
                        writer.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
                        writer.commit()
                        before = self.state()
                        response = future.result(10)
                self.assertEqual(response.status_code, 401, response.text)
                self.unchanged(before)
                with connect(self.path) as db:
                    db.execute("UPDATE sessions SET revoked=0 WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))

    def test_pin_binding_expiry_and_rotation_during_photo_decode_prevent_persisted_upload(self):
        _, lot = self.seed_inventory()
        device = self.enroll()
        original = stocktake_evidence.normalize_image
        for mode in ("expiry", "rotation"):
            with self.subTest(mode=mode):
                pin = self.bearer(self.unlock(device, "manager"))
                changed = []
                def normalize(*args):
                    result = original(*args)
                    if mode == "expiry":
                        self.now += SESSION_SECONDS
                    else:
                        with connect(self.path) as db:
                            db.execute("UPDATE device_auth_roles SET pin_version=pin_version+1 WHERE store_id=? AND role='manager'", (self.store,))
                    changed.append(self.state())
                    return result
                with patch("stocktake_evidence.normalize_image", side_effect=normalize):
                    response = self.client.post("/v1/stocktake-evidence/" + uid(), params={"lot_id": lot, "client_stocktake_id": uid()},
                        headers={**pin, "Content-Type": "image/jpeg"}, content=fixture_image())
                self.assertEqual(response.status_code, 401, response.text)
                self.unchanged(changed[0])


def fixture_image():
    from evidence_fixture import photo_bytes
    return photo_bytes()
