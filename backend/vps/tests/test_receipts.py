"""Receipt acceptance with disposable SQLite, including a real loopback HTTP read."""
from __future__ import annotations

import atexit
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

_bootstrap = tempfile.TemporaryDirectory(prefix="receipt-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

import httpx
import uvicorn
from fastapi.testclient import TestClient
from app import APP_VERSION, connect, create_app, create_store
from migrations import _snapshot
from receipts import date_window


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="receipt-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "DISPOSABLE RECEIPT STORE")
        self.other = create_store(self.path, "DISPOSABLE OTHER STORE")
        self.users, self.headers = {}, {}
        with connect(self.path) as db:
            # Authentication fixtures are seeded directly: no passwords/login
            # attempts, owner-shop data or business operations are involved.
            for name, role, store in (("owner", "owner", self.store), ("manager", "manager", self.store),
                                      ("staff", "staff", self.store), ("staff2", "staff", self.store),
                                      ("other", "owner", self.other)):
                user_id, token = str(uuid.uuid4()), secrets.token_urlsafe(48)
                db.execute("INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                    (user_id, store, name + "@receipt-fixture.invalid", "unused-no-login-fixture", role,
                     "2026-10-01T00:00:00+00:00"))
                db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                    (hashlib.sha256(token.encode()).hexdigest(), user_id, int(time.time()) + 3600))
                self.users[name] = user_id
                self.headers[name] = {"Authorization": "Bearer " + token}
        self.dates = {"from_date": "2026-10-01", "to_date": "2026-10-31"}

    def seed_sale(self, *, actor="staff", stamp="2026-10-14T03:00:00+00:00", method="cash",
                  discount=0, price=10000, legacy=False, name="Synthetic receipt product", lot_code=None):
        store = self.other if actor == "other" else self.store
        sid, client, pid, lot = (str(uuid.uuid4()) for _ in range(4))
        code = lot_code or "LOT-" + lot
        total = price - discount
        payments = ([{"payment_method": "cash", "amount_satang": total // 2},
                     {"payment_method": "transfer", "amount_satang": total - total // 2}]
                    if method == "split" else [{"payment_method": method, "amount_satang": total}])
        with connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO products(id,store_id,sku,name,price_satang_per_gram,default_cost_satang_per_gram,created_at) VALUES(?,?,?,?,?,?,?)",
                (pid, store, "SKU-" + pid, name, price, 4000, stamp))
            db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,cost_satang_per_gram,received_at) VALUES(?,?,?,?,?,?,?,?)",
                (lot, store, pid, code, "Synthetic supplier", "PRIVATE-SUPPLIER-DOC", 4000, stamp))
            db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,?,?)", (lot, 9000, stamp))
            db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,authorization_ref,subtotal_satang,discount_satang,total_satang,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (sid, store, client, "PRIVATE-UNCHANGED-HASH", self.users[actor], method,
                 "PRIVATE-AUTHORIZATION-DOC", price, discount, total, stamp))
            db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_subtotal_satang,line_discount_satang,line_total_satang,unit_cost_satang_per_gram,line_cost_satang) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), sid, lot, 1000, price, price, discount, total, 4000, 4000))
            if not legacy:
                db.executemany("INSERT INTO sale_payments(sale_id,payment_method,amount_satang) VALUES(?,?,?)",
                    [(sid, p["payment_method"], p["amount_satang"]) for p in payments])
            db.commit()
        return {"id": sid, "client_sale_id": client, "product_id": pid, "lot_id": lot,
                "lot_code": code, "payments": payments}

    def listing(self, actor="owner", **params):
        return self.client.get("/v1/sales", headers=self.headers[actor], params={**self.dates, **params})

    def detail(self, sale, actor="owner"):
        return self.client.get("/v1/sales/" + sale["id"], headers=self.headers[actor])

    def state(self):
        with connect(self.path) as db:
            db.row_factory = None
            return _snapshot(db)

    def test_roles_tenant_scope_no_secrets_and_no_database_mutations(self):
        own, another, foreign = self.seed_sale(), self.seed_sale(actor="staff2"), self.seed_sale(actor="other")
        before = self.state()
        for role in ("owner", "manager"):
            response = self.listing(role)
            self.assertEqual(response.status_code, 200)
            self.assertEqual({x["id"] for x in response.json()["sales"]}, {own["id"], another["id"]})
            self.assertEqual(response.json()["scope"], "store")
            self.assertEqual(self.detail(another, role).status_code, 200)
        staff = self.listing("staff").json()
        self.assertEqual([x["id"] for x in staff["sales"]], [own["id"]])
        self.assertEqual(staff["scope"], "own")
        self.assertEqual(self.detail(another, "staff").status_code, 403)
        self.assertEqual(self.detail(foreign).status_code, 404)
        self.assertEqual([x["id"] for x in self.listing("other").json()["sales"]], [foreign["id"]])
        self.assertEqual(self.client.get("/v1/sales").status_code, 401)
        self.assertEqual(self.client.get("/v1/sales/" + own["id"]).status_code, 401)
        self.assertEqual(self.client.get("/v1/sales/" + str(uuid.uuid4()), headers=self.headers["owner"]).status_code, 404)
        body = self.detail(own)
        self.assertEqual(body.headers["cache-control"], "no-store")
        self.assertEqual(body.headers["x-content-type-options"], "nosniff")
        for forbidden in ("cost_satang", "gross_profit", "authorization_ref", "request_hash", "password", "token", "PRIVATE-"):
            self.assertNotIn(forbidden, json.dumps(body.json()))
        self.assertTrue(before == self.state(), "Receipt GET changed fixture data or schema")

    def test_exact_dto_legacy_zero_discount_split_and_historical_prices(self):
        zero = self.seed_sale(price=0, method="transfer", legacy=True)
        legacy_cash = self.seed_sale(legacy=True)
        full_discount = self.seed_sale(discount=10000)
        discounted = self.seed_sale(discount=1755)
        split = self.seed_sale(method="split", discount=100)
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=999999,active=0 WHERE id=?", (discounted["product_id"],))
            db.execute("UPDATE lots SET active=0 WHERE id=?", (discounted["lot_id"],))
        before = self.state()
        headers = self.listing().json()
        self.assertEqual(set(headers), {"sales", "next_cursor", "from_date", "to_date", "timezone", "scope"})
        header_keys = {"id", "client_sale_id", "created_at", "cashier_id", "payment_method", "payments",
                       "subtotal_satang", "discount_satang", "total_satang", "status", "void"}
        self.assertTrue(all(set(row) == header_keys for row in headers["sales"]))
        self.assertTrue(all(row["status"] == "completed" and row["void"] is None for row in headers["sales"]))
        detail = self.detail(discounted).json()
        self.assertEqual(set(detail), header_keys | {"store_name", "lines"})
        self.assertEqual((detail["subtotal_satang"], detail["discount_satang"], detail["total_satang"]), (10000, 1755, 8245))
        self.assertEqual(detail["cashier_id"], self.users["staff"])
        self.assertEqual(detail["lines"], [{"lot_id": discounted["lot_id"], "lot_code": discounted["lot_code"],
            "product_name": "Synthetic receipt product", "quantity_mg": 1000,
            "unit_price_satang_per_gram": 10000, "subtotal_satang": 10000, "discount_satang": 1755, "total_satang": 8245}])
        self.assertEqual(self.detail(zero).json()["payments"], [{"payment_method": "transfer", "amount_satang": 0}])
        self.assertEqual(self.detail(legacy_cash).json()["payments"], [{"payment_method": "cash", "amount_satang": 10000}])
        full = self.detail(full_discount).json()
        self.assertEqual((full["subtotal_satang"], full["discount_satang"], full["total_satang"]), (10000, 10000, 0))
        self.assertEqual(full["payments"], [{"payment_method": "cash", "amount_satang": 0}])
        self.assertEqual(self.detail(split).json()["payments"], split["payments"])
        # The original by-client response is preserved, with no receipt fields added.
        lookup = self.client.get("/v1/sales/by-client/" + discounted["client_sale_id"], headers=self.headers["staff"])
        self.assertEqual(lookup.status_code, 200)
        self.assertEqual(set(lookup.json()), {"id", "client_sale_id", "subtotal_satang", "discount_satang", "total_satang", "payment_method", "payments"})
        me = self.client.get("/v1/me", headers=self.headers["staff"]).json()
        self.assertTrue(me["capabilities"]["receipt_history"])
        self.assertEqual(me["capabilities"]["receipt_contract_version"], 1)
        catalog = self.client.get("/v1/catalog", headers=self.headers["staff"]).json()
        self.assertTrue(all("product_id" in lot for lot in catalog["lots"]))
        self.assertEqual(self.client.get("/health").json()["version"], APP_VERSION)
        self.assertTrue(before == self.state(), "Receipt rendering changed persisted prices or money")

    def test_bangkok_boundaries_defaults_and_date_limits(self):
        before = self.seed_sale(stamp="2026-10-13T16:59:59+00:00")
        first = self.seed_sale(stamp="2026-10-13T17:00:00+00:00")
        last = self.seed_sale(stamp="2026-10-14T16:59:59+00:00")
        after = self.seed_sale(stamp="2026-10-14T17:00:00+00:00")
        result = self.listing(from_date="2026-10-14", to_date="2026-10-14").json()
        self.assertEqual({x["id"] for x in result["sales"]}, {first["id"], last["id"]})
        self.assertEqual(result["timezone"], "Asia/Bangkok")
        self.assertNotIn(before["id"], [x["id"] for x in result["sales"]])
        self.assertNotIn(after["id"], [x["id"] for x in result["sales"]])
        start, end, _, _ = date_window(None, None, today=date(2026, 10, 18))
        self.assertEqual((start, end), (date(2026, 9, 19), date(2026, 10, 18)))
        self.assertEqual(date_window(date(2026, 10, 1), None)[:2], (date(2026, 10, 1), date(2026, 10, 30)))
        self.assertEqual(date_window(None, date(2026, 10, 30))[:2], (date(2026, 10, 1), date(2026, 10, 30)))
        self.assertEqual(self.listing(from_date="2024-01-01", to_date="2024-12-31").status_code, 200)
        for params in ({"from_date": "2024-01-01", "to_date": "2025-01-01"},
                       {"from_date": "2026-10-02", "to_date": "2026-10-01"},
                       {"from_date": "bad"}, {"to_date": "9999-12-31"},
                       {"limit": 0}, {"limit": 101}, {"limit": "true"}, {"q": "x" * 101}, {"cursor": ""}):
            self.assertEqual(self.listing(**params).status_code, 422)

    def test_search_is_literal_and_combines_with_permissions_before_pagination(self):
        literal = self.seed_sale(name="Literal 50%_\\fixture", lot_code="SPECIAL_%\\LOT")
        ordinary = self.seed_sale(name="Ordinary product")
        self.seed_sale(actor="staff2", name="Literal 50%_\\fixture")
        for query in ("%_\\", "SPECIAL_%\\LOT", literal["id"], literal["client_sale_id"]):
            result = self.listing("staff", q=query, limit=1)
            self.assertEqual(result.status_code, 200)
            self.assertEqual([x["id"] for x in result.json()["sales"]], [literal["id"]])
            self.assertIsNone(result.json()["next_cursor"])
        self.assertEqual(self.listing(q="' OR 1=1 --").json()["sales"], [])
        self.assertEqual([x["id"] for x in self.listing("staff", q="ordinary").json()["sales"]], [ordinary["id"]])

    def test_keyset_pagination_stable_and_signed_context_bound(self):
        seeded = [self.seed_sale() for _ in range(5)]
        expected = sorted([x["id"] for x in seeded], reverse=True)
        first = self.listing(limit=2).json()
        self.assertEqual([x["id"] for x in first["sales"]], expected[:2])
        cursor = first["next_cursor"]
        self.assertIsInstance(cursor, str)
        self.seed_sale(stamp="2026-10-15T03:00:00+00:00")
        second = self.listing(cursor=cursor, limit=2).json()
        third = self.listing(cursor=second["next_cursor"], limit=2).json()
        self.assertEqual([x["id"] for x in second["sales"] + third["sales"]], expected[2:])
        self.assertIsNone(third["next_cursor"])
        for actor, extra in (("manager", {}), ("staff", {}), ("other", {}),
                             ("owner", {"q": "Synthetic"}), ("owner", {"to_date": "2026-10-30"})):
            self.assertEqual(self.listing(actor, cursor=cursor, **extra).status_code, 422)
        tampered = ("A" if cursor[0] != "A" else "B") + cursor[1:]
        for bad in (tampered, "not-a-valid-cursor", "x" * 2049):
            self.assertEqual(self.listing(cursor=bad).status_code, 422)
        restarted = TestClient(create_app(self.path), raise_server_exceptions=False)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.get("/v1/sales", params={**self.dates, "cursor": cursor}, headers=self.headers["owner"]).status_code, 422)

    def test_one_consistent_read_snapshot_during_concurrent_insert(self):
        original = self.seed_sale(method="split", discount=100)
        with connect(self.path) as db:
            db.execute("PRAGMA journal_mode=WAL")
        import receipts
        original_reader = receipts.recorded_payments
        inserted = []

        def read_payments(db, *args):
            if not inserted:
                inserted.append(self.seed_sale(stamp="2026-10-15T03:00:00+00:00"))
            return original_reader(db, *args)

        with patch("receipts.recorded_payments", side_effect=read_payments):
            result = self.listing().json()
        self.assertEqual([row["id"] for row in result["sales"]], [original["id"]])
        self.assertEqual(result["sales"][0]["payments"], original["payments"])
        self.assertEqual(len(self.listing().json()["sales"]), 2)
        original_header = receipts._header

        def header_with_concurrent_catalog_edit(db, row):
            with connect(self.path) as writer:
                writer.execute("UPDATE products SET name=? WHERE id=?", ("Updated current catalog label", original["product_id"]))
            return original_header(db, row)

        # Header SELECT establishes the snapshot before a different connection
        # changes a label. Detail must not combine pre-edit and post-edit reads.
        with patch("receipts._header", side_effect=header_with_concurrent_catalog_edit):
            detail = self.detail(original).json()
        self.assertEqual(detail["lines"][0]["product_name"], "Synthetic receipt product")
        self.assertEqual(self.detail(original).json()["lines"][0]["product_name"], "Updated current catalog label")

    def test_real_http_receipt_routes_auth_and_cors_are_read_only(self):
        sale = self.seed_sale(method="split", discount=100)
        before = self.state()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(self.api, log_level="critical", access_log=False, lifespan="off"))
        worker = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        worker.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started and worker.is_alive() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(server.started)
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=10) as wire:
                response = wire.get("/v1/sales", headers={**self.headers["staff"], "Origin": "https://localhost"}, params=self.dates)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["access-control-allow-origin"], "https://localhost")
                self.assertEqual(response.json()["sales"][0]["id"], sale["id"])
                self.assertEqual(wire.get("/v1/sales/" + sale["id"], headers=self.headers["staff"]).status_code, 200)
                self.assertEqual(wire.get("/v1/sales").status_code, 401)
                preflight = wire.options("/v1/sales", headers={"Origin": "https://localhost",
                    "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
                self.assertEqual(preflight.status_code, 200)
        finally:
            server.should_exit = True
            worker.join(timeout=10)
            sock.close()
            self.assertFalse(worker.is_alive(), "Disposable receipt HTTP listener did not stop")
        self.assertTrue(before == self.state(), "Real HTTP receipt GET changed fixture data or schema")


if __name__ == "__main__":
    unittest.main()
