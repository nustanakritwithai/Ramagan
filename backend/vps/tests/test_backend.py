"""Endpoint and transaction tests; use a disposable SQLite database only."""
from __future__ import annotations

import sqlite3
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient
from app import connect, create_app, create_store, create_user, init_database


class RamaganApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "test.sqlite3")
        self.app = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.app)
        self.store = create_store(self.path, "Test Store")
        self.store_b = create_store(self.path, "Other Store")
        self.owner = create_user(self.path, self.store, "owner@example.test", "a safe long passphrase 123", "owner")
        self.staff = create_user(self.path, self.store, "staff@example.test", "staff long passphrase 456", "staff")
        self.other = create_user(self.path, self.store_b, "other@example.test", "another secure passphrase", "owner")
        self.owner_token = self.login("owner@example.test", "a safe long passphrase 123")
        self.staff_token = self.login("staff@example.test", "staff long passphrase 456")
        self.other_token = self.login("other@example.test", "another secure passphrase")

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def login(self, email, password):
        response = self.client.post("/v1/auth/login", json={"email": email, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["token"]

    def head(self, token):
        return {"Authorization": "Bearer " + token}

    def product(self):
        response = self.client.post("/v1/products", headers=self.head(self.owner_token),
            json={"sku": "SKU-001", "name": "Test item", "category": "test",
                  "price_satang_per_gram": 10000})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["product_id"]

    def receive(self, product_id, name="LOT-A", qty=5000):
        r = self.client.post("/v1/lots/receive", headers=self.head(self.owner_token),
             json={"product_id": product_id, "lot_code": name, "supplier_name": "Test supplier",
                   "supplier_document_ref": "TEST-1", "quantity_mg": qty,
                   "reason": "Isolated test receipt"})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["lot_id"]

    def enable_test_sales(self):
        with connect(self.path) as db:
            db.execute("UPDATE stores SET sales_enabled=1 WHERE id=?", (self.store,))

    def order(self, items, key=None):
        return {"client_sale_id": key or str(uuid.uuid4()),
                "items": items, "payment_method": "cash", "authorization_ref": "TEST-ONLY"}

    def test_no_auth_and_production_default_off(self):
        self.assertEqual(self.client.get("/v1/catalog").status_code, 401)
        self.assertEqual(self.client.get("/v1/me", headers=self.head(self.staff_token)).status_code, 200)
        pid = self.product()
        lot = self.receive(pid)
        res = self.client.post("/v1/sales", headers=self.head(self.staff_token),
                               json=self.order([{"lot_id":lot,"quantity_mg":1000}]))
        self.assertEqual(res.status_code, 403)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT quantity_mg FROM lot_balances").fetchone()[0], 5000)

    def test_manager_only_write_and_cross_store(self):
        self.assertEqual(self.client.post("/v1/products", headers=self.head(self.staff_token),
                json={"sku":"X","name":"X","category":"test","price_satang_per_gram":100}).status_code, 403)
        pid = self.product()
        lot = self.receive(pid)
        response = self.client.get("/v1/catalog", headers=self.head(self.other_token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["products"]), 0)
        self.assertEqual(len(response.json()["lots"]), 0)
        self.assertEqual(self.client.get("/v1/ledger", headers=self.head(self.staff_token)).status_code, 403)
        self.assertEqual(self.client.get("/v1/ledger", headers=self.head(self.owner_token)).status_code, 200)

    def test_atomic_checkout_balance_and_idempotency(self):
        pid = self.product()
        a, b = self.receive(pid, "L-A", 3000), self.receive(pid, "L-B", 500)
        self.enable_test_sales()
        failed = self.client.post("/v1/sales", headers=self.head(self.staff_token),
             json=self.order([{"lot_id":a,"quantity_mg":1000},{"lot_id":b,"quantity_mg":600}]))
        self.assertEqual(failed.status_code, 409)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT quantity_mg FROM lot_balances WHERE lot_id=?", (a,)).fetchone()[0], 3000)
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='SALE'").fetchone()[0], 0)
        order = self.order([{"lot_id":a,"quantity_mg":1000},{"lot_id":b,"quantity_mg":500}])
        ok = self.client.post("/v1/sales", headers=self.head(self.staff_token), json=order)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["total_satang"], 15000)
        retry = self.client.post("/v1/sales", headers=self.head(self.staff_token), json=order)
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.json()["duplicate"])
        self.assertEqual(retry.json()["sale_id"], ok.json()["sale_id"])
        changed = {**order, "items":[{"lot_id":a,"quantity_mg":2000}]}
        self.assertEqual(self.client.post("/v1/sales",headers=self.head(self.staff_token),json=changed).status_code,409)
        self.assertEqual(self.client.post("/v1/sales",headers=self.head(self.owner_token),json=order).status_code,403)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_lines").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='SALE'").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT quantity_mg FROM lot_balances WHERE lot_id=?", (a,)).fetchone()[0], 2000)

    def test_duplicate_lot_receipt_and_immutable_events(self):
        pid = self.product()
        self.receive(pid, "LOT-UNIQUE")
        retry = self.client.post("/v1/lots/receive", headers=self.head(self.owner_token),
             json={"product_id": pid, "lot_code":"LOT-UNIQUE",
                   "supplier_name":"Test", "supplier_document_ref":"T-2",
                   "quantity_mg":1000,"reason":"duplicate"})
        self.assertEqual(retry.status_code, 409)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events").fetchone()[0], 1)
            ev = db.execute("SELECT id FROM ledger_events").fetchone()[0]
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM ledger_events WHERE id=?", (ev,))

    def test_concurrent_sale_only_one_wins(self):
        pid = self.product()
        lot = self.receive(pid, qty=1000)
        self.enable_test_sales()
        payloads = [self.order([{"lot_id":lot,"quantity_mg":800}]) for _ in range(2)]
        def fire(payload):
            with TestClient(self.app) as client:
                return client.post("/v1/sales",headers=self.head(self.staff_token),json=payload).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(fire, payloads))
        self.assertEqual(sorted(statuses), [200,409])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT quantity_mg FROM lot_balances").fetchone()[0], 200)

    def test_revoke_session(self):
        self.assertEqual(self.client.get("/v1/me", headers=self.head(self.staff_token)).status_code,200)
        self.assertEqual(self.client.post("/v1/auth/logout",headers=self.head(self.staff_token)).status_code,200)
        self.assertEqual(self.client.get("/v1/me", headers=self.head(self.staff_token)).status_code,401)


if __name__ == "__main__":
    unittest.main()
