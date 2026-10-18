"""Owner-only finance privacy over real disposable SQLite business workflows.

The recursive DTO check intentionally rejects hidden keys even when their value
is null.  Cost calculations and immutable records must still be preserved in
SQLite while Manager retains the existing operational permissions.
"""
import atexit
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import unittest
import uuid
from zoneinfo import ZoneInfo

_bootstrap = tempfile.TemporaryDirectory(prefix="cost-privacy-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

from fastapi.testclient import TestClient
from app import connect, create_app, create_store
from evidence_fixture import upload_photo
from migrations import _snapshot


def uid():
    return str(uuid.uuid4())


class CostPrivacyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cost-privacy-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "SYNTHETIC COST PRIVACY ONLY")
        self.other = create_store(self.path, "SYNTHETIC FOREIGN STORE")
        self.users, self.headers, self.token_hashes = {}, {}, {}
        with connect(self.path) as db:
            for name, role, store in (("owner", "owner", self.store), ("manager", "manager", self.store),
                                      ("staff", "staff", self.store), ("foreign", "owner", self.other)):
                actor, token = uid(), secrets.token_urlsafe(48)
                digest = hashlib.sha256(token.encode()).hexdigest()
                db.execute("INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'fixture')",
                           (actor, store, name + "@cost-privacy.invalid", "unused-synthetic-password", role))
                db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                           (digest, actor, int(time.time()) + 3600))
                self.users[name], self.headers[name], self.token_hashes[name] = actor, {"Authorization": "Bearer " + token}, digest
            db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))

    def state(self):
        with connect(self.path) as db:
            db.row_factory = None
            return _snapshot(db)

    def assert_private(self, value, path="$"):
        """Check every nested key, independently of the server's projection code."""
        if isinstance(value, dict):
            for key, item in value.items():
                lowered = key.lower()
                forbidden = ("cost" in lowered or "profit" in lowered or
                             "inventory_value" in lowered or lowered == "inventory_delta_satang")
                self.assertFalse(forbidden, "Sensitive key exposed at " + path + "." + key)
                self.assert_private(item, path + "." + key)
        elif isinstance(value, list):
            for index, item in enumerate(value):
                self.assert_private(item, path + "[" + str(index) + "]")

    def good(self, response, *, private=False):
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        if private:
            self.assert_private(body)
        return body

    def product_payload(self, **extra):
        return {"sku": "SYN-" + uid(), "name": "SYNTHETIC COST PRIVACY", "category": "fixture",
                "price_satang_per_gram": 10000, **extra}

    def product(self, default=4321):
        result = self.good(self.client.post("/v1/products", headers=self.headers["owner"],
                           json=self.product_payload(default_cost_satang_per_gram=default)))
        return result["product_id"]

    def intake_payload(self, product, **extra):
        return {"client_receive_id": uid(), "product_id": product, "lot_code": "SYN-LOT-" + uid(),
                "supplier_name": "Synthetic supplier", "quantity_mg": 10000,
                "reason": "Disposable privacy fixture", **extra}

    def receive(self, payload, actor="owner"):
        return self.good(self.client.post("/v1/lots/receive", headers=self.headers[actor], json=payload), private=actor != "owner")

    def seed_lot(self, default=4321):
        product = self.product(default)
        payload = self.intake_payload(product)
        return product, self.receive(payload)["lot_id"], payload

    def count_payload(self, lot, *, quantity=8500, revision=0, actor="manager"):
        payload = {"client_stocktake_id": uid(), "shift_label": "Synthetic shift", "items": [
            {"lot_id": lot, "expected_revision": revision, "counted_quantity_mg": quantity}]}
        payload["items"][0]["evidence_id"] = upload_photo(self.client, self.headers[actor], lot,
            payload["client_stocktake_id"])["evidence_id"]
        return payload

    def sale_payload(self, lot):
        return {"client_sale_id": uid(), "items": [{"lot_id": lot, "quantity_mg": 1000}],
                "payment_method": "transfer", "discount_satang": 100}

    def test_capabilities_are_actor_bound_without_disabling_manager_operations(self):
        for actor in ("owner", "manager", "staff"):
            with self.subTest(actor=actor):
                profile = self.good(self.client.get("/v1/me", headers=self.headers[actor]))
                caps = profile["capabilities"]
                self.assertIs(caps["can_view_costs"], actor == "owner")
                self.assertIs(caps["can_access_dashboard"], actor == "owner")
                self.assertIs(caps["can_manage_settings"], actor == "owner")
                self.assertEqual(caps["cost_privacy_contract_version"], 1)
                self.assertTrue(caps["inventory_costs"])
                self.assertEqual(caps["cost_contract_version"], 1)
                self.assertTrue(caps["stocktakes"])
                self.assertTrue(caps["stocktake_evidence"])
        with connect(self.path) as db:
            db.execute("UPDATE users SET role='staff' WHERE id=?", (self.users["owner"],))
        updated = self.good(self.client.get("/v1/me", headers=self.headers["owner"]))
        self.assertEqual(updated["role"], "staff")
        self.assertFalse(updated["capabilities"]["can_view_costs"])
        self.assertFalse(updated["capabilities"]["can_access_dashboard"])

    def test_catalog_inventory_finance_fields_removed_for_manager_and_staff(self):
        product, lot, _ = self.seed_lot()
        owner = self.good(self.client.get("/v1/inventory", headers=self.headers["owner"]))
        self.assertEqual(owner["products"][0]["default_cost_satang_per_gram"], 4321)
        self.assertEqual(owner["lots"][0]["cost_satang_per_gram"], 4321)
        self.assertEqual(owner["lots"][0]["inventory_value_satang"], 43210)
        self.assertEqual(owner["summary"]["inventory_value_satang"], 43210)
        before = self.state()
        manager = self.good(self.client.get("/v1/inventory", headers=self.headers["manager"]), private=True)
        self.assertEqual(manager["lots"][0]["id"], lot)
        self.assertEqual(manager["lots"][0]["quantity_mg"], 10000)
        self.assertEqual(manager["summary"]["quantity_mg"], 10000)
        for actor in ("manager", "staff"):
            catalog = self.good(self.client.get("/v1/catalog", headers=self.headers[actor]), private=True)
            self.assertEqual(catalog["products"][0]["id"], product)
            self.assertEqual(catalog["lots"][0]["quantity_mg"], 10000)
        self.assertEqual(self.client.get("/v1/inventory", headers=self.headers["staff"]).status_code, 403)
        self.assertEqual(before, self.state(), "Read projections changed immutable or business data")

    def test_manager_create_and_intake_keep_permissions_but_cannot_set_cost(self):
        owner_product = self.product()
        for value in (0, 4321, 100_000_000):
            with self.subTest(value=value):
                before = self.state()
                denied = self.client.post("/v1/products", headers=self.headers["manager"],
                    json=self.product_payload(default_cost_satang_per_gram=value))
                self.assertEqual(denied.status_code, 403, denied.text)
                self.assert_private(denied.json())
                denied = self.client.post("/v1/lots/receive", headers=self.headers["manager"],
                    json=self.intake_payload(owner_product, cost_satang_per_gram=value))
                self.assertEqual(denied.status_code, 403, denied.text)
                self.assert_private(denied.json())
                self.assertEqual(before, self.state(), "Rejected finance write changed business data")
        for extra in ({}, {"default_cost_satang_per_gram": None}):
            created = self.good(self.client.post("/v1/products", headers=self.headers["manager"],
                json=self.product_payload(**extra)), private=True)
            with connect(self.path) as db:
                self.assertIsNone(db.execute("SELECT default_cost_satang_per_gram FROM products WHERE id=?",
                                  (created["product_id"],)).fetchone()[0])
        for extra in ({}, {"cost_satang_per_gram": None}):
            result = self.receive(self.intake_payload(owner_product, **extra), actor="manager")
            self.assertEqual(result["quantity_mg"], 10000)
            with connect(self.path) as db:
                self.assertEqual(db.execute("SELECT cost_satang_per_gram FROM lots WHERE id=?",
                                 (result["lot_id"],)).fetchone()[0], 4321)

    def test_receive_manager_fresh_replay_reconcile_cancel_and_legacy_saved_cost(self):
        product = self.product()
        payload = self.intake_payload(product)
        first = self.receive(payload, actor="manager")
        self.assertFalse(first["duplicate"])
        with connect(self.path) as db:
            saved = json.loads(db.execute("SELECT result_json FROM receive_requests WHERE client_receive_id=?",
                               (payload["client_receive_id"],)).fetchone()[0])
            self.assertEqual(saved["cost_satang_per_gram"], 4321)
            db.execute("UPDATE products SET default_cost_satang_per_gram=9000 WHERE id=?", (product,))
        before = self.state()
        replay = self.receive(payload, actor="manager")
        self.assertEqual(replay, {**first, "duplicate": True})
        reconciled = self.good(self.client.post("/v1/lots/receive/reconcile", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(reconciled, {"status": "completed", "result": replay})
        owner = self.receive(payload)
        self.assertEqual(owner["cost_satang_per_gram"], 4321)
        self.assertEqual(before, self.state(), "Projection/retry changed recorded receive or balance")
        never = self.intake_payload(product)
        cancelled = self.good(self.client.post("/v1/lots/receive/reconcile", headers=self.headers["manager"], json=never), private=True)
        self.assertEqual(cancelled["status"], "rejected")
        self.assertEqual(cancelled["code"], "RECEIVE_CANCELLED")
        self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["manager"], json=never).status_code, 409)
        repeated = self.good(self.client.post("/v1/lots/receive/reconcile", headers=self.headers["manager"], json=never), private=True)
        self.assertEqual(repeated, cancelled)

    def test_manager_cannot_probe_legacy_explicit_receive_cost_through_replay_or_reconcile(self):
        product = self.product()
        payload = self.intake_payload(product, cost_satang_per_gram=1234)
        self.receive(payload)
        before = self.state()
        for route in ("/v1/lots/receive", "/v1/lots/receive/reconcile"):
            for value in (0, 1234, 4321):
                result = self.client.post(route, headers=self.headers["manager"], json={**payload, "cost_satang_per_gram": value})
                self.assertEqual(result.status_code, 403, result.text)
                self.assert_private(result.json())
        self.assertEqual(before, self.state())

    def test_same_actor_legacy_explicit_cost_receive_can_resolve_after_demotion_without_writes(self):
        product = self.product()
        payload = self.intake_payload(product, cost_satang_per_gram=1234)
        # Simulate a previously completed cost-bearing Manager request by
        # creating it under the old permission and then applying today's role.
        with connect(self.path) as db:
            db.execute("UPDATE users SET role='owner' WHERE id=?", (self.users["manager"],))
        recorded = self.good(self.client.post("/v1/lots/receive", headers=self.headers["manager"], json=payload))
        self.assertEqual(recorded["cost_satang_per_gram"], 1234)
        with connect(self.path) as db:
            db.execute("UPDATE users SET role='manager' WHERE id=?", (self.users["manager"],))
        before = self.state()
        expected = {key: value for key, value in recorded.items() if key != "cost_satang_per_gram"}
        expected["duplicate"] = True
        replay = self.good(self.client.post("/v1/lots/receive", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(replay, expected)
        reconciled = self.good(self.client.post("/v1/lots/receive/reconcile", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(reconciled, {"status": "completed", "result": expected})
        for route in ("/v1/lots/receive", "/v1/lots/receive/reconcile"):
            for changed in ({"cost_satang_per_gram": 4321}, {"client_receive_id": uid()}, {"quantity_mg": 9000}):
                denied = self.client.post(route, headers=self.headers["manager"], json={**payload, **changed})
                self.assertEqual(denied.status_code, 403, denied.text)
                self.assert_private(denied.json())
        self.assertEqual(before, self.state(), "Resolving legacy intake changed saved cost, stock, ledger or audit")

    def test_stocktake_manager_fresh_replay_history_lookup_and_reconcile_hide_valuation(self):
        _, lot, _ = self.seed_lot()
        payload = self.count_payload(lot)
        first = self.good(self.client.post("/v1/stocktakes", headers=self.headers["manager"], json=payload), private=True)
        self.assertFalse(first["duplicate"])
        self.assertEqual(first["items"][0]["variance_mg"], -1500)
        self.assertEqual(first["actor_user_id"], self.users["manager"])
        self.assertEqual(first["items"][0]["evidence"]["evidence_id"], payload["items"][0]["evidence_id"])
        before = self.state()
        replay = self.good(self.client.post("/v1/stocktakes", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(replay, {**first, "duplicate": True})
        lookup = self.good(self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"], headers=self.headers["manager"]), private=True)
        self.assertEqual(lookup, replay)
        history = self.good(self.client.get("/v1/stocktakes", headers=self.headers["manager"]), private=True)
        self.assertEqual(history["stocktakes"][0]["variance_mg"], -1500)
        reconciled = self.good(self.client.post("/v1/stocktakes/reconcile", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(reconciled, {"status": "completed", "result": replay})
        owner = self.good(self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"], headers=self.headers["owner"]))
        self.assertEqual(owner["items"][0]["inventory_delta_satang"], -6481)
        self.assertEqual(before, self.state())
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT inventory_delta_satang FROM stocktake_lines").fetchone()[0], -6481)
            self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (lot,)).fetchone()), (8500, 1))

    def test_stocktake_pending_stale_rejection_and_staff_denials_are_private(self):
        _, lot, _ = self.seed_lot()
        payload = self.count_payload(lot)
        pending = self.good(self.client.post("/v1/stocktakes/reconcile", headers=self.headers["manager"], json=payload), private=True)
        self.assertEqual(pending["status"], "pending")
        stale = {**payload, "client_stocktake_id": uid(), "items": [{**payload["items"][0], "expected_revision": 1}]}
        rejected = self.good(self.client.post("/v1/stocktakes/reconcile", headers=self.headers["manager"], json=stale), private=True)
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(rejected["code"], "STOCK_CHANGED")
        for method, route, body in (("get", "/v1/stocktakes", None),
                                    ("get", "/v1/stocktakes/by-client/" + uid(), None),
                                    ("post", "/v1/stocktakes", payload),
                                    ("post", "/v1/stocktakes/reconcile", payload)):
            kwargs = {"headers": self.headers["staff"]}
            if body is not None:
                kwargs["json"] = body
            result = getattr(self.client, method)(route, **kwargs)
            self.assertEqual(result.status_code, 403, result.text)
            self.assert_private(result.json())

    def test_receipts_sales_void_fresh_duplicate_lookup_ledger_preserve_finance_privacy(self):
        _, lot, _ = self.seed_lot()
        sale_payload = self.sale_payload(lot)
        sale = self.good(self.client.post("/v1/sales", headers=self.headers["staff"], json=sale_payload), private=True)
        self.assertEqual(sale["total_satang"], 9900)
        for actor in ("manager", "staff"):
            for route in ("/v1/sales", "/v1/sales/" + sale["sale_id"], "/v1/sales/by-client/" + sale_payload["client_sale_id"]):
                self.good(self.client.get(route, headers=self.headers[actor]), private=True)
        void_payload = {"client_void_id": uid(), "reason": "Synthetic mistaken sale"}
        route = "/v1/sales/" + sale["sale_id"] + "/void"
        first = self.good(self.client.post(route, headers=self.headers["manager"], json=void_payload), private=True)
        self.assertEqual(first["status"], "voided")
        self.assertFalse(first["duplicate"])
        self.assertEqual(first["restored_items"][0]["quantity_after_mg"], 10000)
        before = self.state()
        replay = self.good(self.client.post(route, headers=self.headers["manager"], json=void_payload), private=True)
        self.assertEqual(replay, {**first, "duplicate": True})
        lookup = self.good(self.client.get("/v1/sale-voids/by-client/" + void_payload["client_void_id"], headers=self.headers["manager"]), private=True)
        self.assertEqual(lookup, replay)
        for actor in ("manager", "staff"):
            listing = self.good(self.client.get("/v1/sales", headers=self.headers[actor]), private=True)
            self.assertEqual(listing["sales"][0]["status"], "voided")
            self.good(self.client.get("/v1/sales/" + sale["sale_id"], headers=self.headers[actor]), private=True)
        ledger = self.good(self.client.get("/v1/ledger", headers=self.headers["manager"]), private=True)
        self.assertTrue(ledger["events"])
        owner = self.good(self.client.get("/v1/sale-voids/by-client/" + void_payload["client_void_id"], headers=self.headers["owner"]))
        self.assertEqual(owner["restored_items"][0]["inventory_delta_satang"], 4321)
        self.assertEqual(before, self.state(), "Voided receipt retry or private read changed records")
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT line_cost_satang FROM sale_lines").fetchone()[0], 4321)
            self.assertEqual(db.execute("SELECT inventory_delta_satang FROM sale_void_lines").fetchone()[0], 4321)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertFalse(db.execute("PRAGMA foreign_key_check").fetchall())

    def test_dashboard_reports_owner_only_and_sensitive_query_probes_do_not_bypass(self):
        _, lot, _ = self.seed_lot()
        self.good(self.client.post("/v1/sales", headers=self.headers["staff"], json=self.sale_payload(lot)))
        day = datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()
        owner = self.good(self.client.get("/v1/admin/sales-report", headers=self.headers["owner"], params={"from": day, "to": day}))
        self.assertEqual(owner["summary"]["cost_satang"], 4321)
        self.assertEqual(owner["summary"]["gross_profit_satang"], 5579)
        before = self.state()
        for actor in ("manager", "staff"):
            for query in ({}, {"role": "owner", "include_costs": "true", "from": day, "to": day}, {"from": "not-a-date"}):
                denied = self.client.get("/v1/admin/sales-report", headers=self.headers[actor], params=query)
                self.assertIn(denied.status_code, (403, 422) if query.get("from") == "not-a-date" else (403,), denied.text)
                self.assert_private(denied.json())
            routes = ("/v1/catalog", "/v1/inventory") if actor == "manager" else ("/v1/catalog",)
            for route in routes:
                self.good(self.client.get(route, headers=self.headers[actor], params={"role": "owner", "include_costs": "true", "can_view_costs": "true"}), private=True)
        self.assertEqual(before, self.state())

    def test_manager_and_staff_cannot_manage_store_or_device_settings(self):
        enabled_api = create_app(self.path, origins=["https://localhost"],
                                  pin_pepper=b"synthetic-cost-privacy-test-pepper-only-2026")
        client = TestClient(enabled_api, raise_server_exceptions=False)
        self.addCleanup(client.close)
        pins = {"owner": "0123", "manager": "4567", "staff": "8901"}
        before = self.state()
        for actor in ("manager", "staff"):
            denied = client.get("/v1/auth/device/configuration", headers=self.headers[actor])
            self.assertEqual(denied.status_code, 403, denied.text)
            self.assert_private(denied.json())
            for action, payload in (
                ("enroll", {"owner_password": "Synthetic password never verified", "label": "Fixture only", "pins": pins}),
                ("pins", {"owner_password": "Synthetic password never verified", "pins": pins}),
                ("revoke", {"owner_password": "Synthetic password never verified", "device_id": uid()}),
            ):
                response = client.post("/v1/auth/device/" + action, headers=self.headers[actor], json=payload)
                self.assertEqual(response.status_code, 403, response.text)
                self.assert_private(response.json())
        self.assertEqual(before, self.state(), "Rejected settings changes altered devices, roles, sessions or audits")

    def test_revoked_demoted_and_foreign_sessions_cannot_retrieve_sensitive_results(self):
        _, lot, receive_payload = self.seed_lot()
        count = self.count_payload(lot, actor="owner")
        self.good(self.client.post("/v1/stocktakes", headers=self.headers["owner"], json=count))
        with connect(self.path) as db:
            db.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (self.token_hashes["owner"],))
        before = self.state()
        for route in ("/v1/me", "/v1/catalog", "/v1/inventory", "/v1/admin/sales-report",
                      "/v1/stocktakes/by-client/" + count["client_stocktake_id"]):
            result = self.client.get(route, headers=self.headers["owner"])
            self.assertEqual(result.status_code, 401, result.text)
            self.assert_private(result.json())
        foreign = self.good(self.client.get("/v1/inventory", headers=self.headers["foreign"]))
        self.assertEqual(foreign["lots"], [])
        foreign_count = self.client.get("/v1/stocktakes/by-client/" + count["client_stocktake_id"], headers=self.headers["foreign"])
        self.assertEqual(foreign_count.status_code, 404)
        self.assert_private(foreign_count.json())
        self.assertEqual(before, self.state())
        with connect(self.path) as db:
            db.execute("UPDATE users SET role='staff' WHERE id=?", (self.users["manager"],))
        before = self.state()
        for method, route, payload in (("get", "/v1/inventory", None),
                                       ("post", "/v1/lots/receive", receive_payload),
                                       ("post", "/v1/lots/receive/reconcile", receive_payload),
                                       ("post", "/v1/stocktakes/reconcile", count)):
            kwargs = {"headers": self.headers["manager"]}
            if payload is not None:
                kwargs["json"] = payload
            result = getattr(self.client, method)(route, **kwargs)
            self.assertEqual(result.status_code, 403, result.text)
            self.assert_private(result.json())
        self.assertEqual(before, self.state())


if __name__ == "__main__":
    unittest.main()
