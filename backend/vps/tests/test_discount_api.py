"""Discount checkout contracts and complete rollback on disposable DBs only."""
from __future__ import annotations

import atexit
from contextlib import contextmanager
import os
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import uuid

# Importing app builds an application. Never allow that to use a shop DB.
_bootstrap = tempfile.TemporaryDirectory(prefix="discount-api-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

import app as api_module
from app import connect, create_app, create_store, create_user
from discounts import MAX_SALE_SATANG, legacy_checkout_request_hash
from fastapi.testclient import TestClient
from migrations import CURRENT_SCHEMA_VERSION, SchemaUpgradeRequired, migrate_copy
from cost_stock import capabilities as cost_capabilities
from receipts import capabilities as receipt_capabilities
from pin_auth import capabilities as pin_capabilities


class DiscountApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="discount-api-test-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "Disposable discount fixture")
        self.other_store = create_store(self.path, "Other disposable fixture")
        self.users = {}
        self.headers = {}
        for name, role, store in (("owner", "owner", self.store), ("staff", "staff", self.store), ("manager", "manager", self.store), ("other", "owner", self.other_store)):
            email = name + "@discount-fixture.invalid"
            password = "Synthetic fixture passphrase " + name
            self.users[name] = create_user(self.path, store, email, password, role)
            response = self.client.post("/v1/auth/login", json={"email": email, "password": password})
            self.assertEqual(response.status_code, 200)
            self.headers[name] = {"Authorization": "Bearer " + response.json()["token"]}
        self.product_ids = []
        self.lots = []
        for index, price in enumerate((10000, 20000)):
            product = self.client.post("/v1/products", headers=self.headers["owner"], json={"sku": f"DISCOUNT-{index}", "name": "Synthetic item", "price_satang_per_gram": price})
            self.assertEqual(product.status_code, 200)
            pid = product.json()["product_id"]
            receipt = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json={"product_id": pid, "lot_code": f"FIXTURE-{index}", "supplier_name": "Synthetic supplier", "supplier_document_ref": "FIXTURE-ONLY", "quantity_mg": 10000, "reason": "Disposable test only"})
            self.assertEqual(receipt.status_code, 200)
            self.product_ids.append(pid)
            self.lots.append(receipt.json()["lot_id"])

    def enable_fixture_sales(self, store=None):
        with connect(self.path) as db:
            db.execute("UPDATE stores SET sales_enabled=1 WHERE id=?", (store or self.store,))

    def order(self, discount=0, key=None, items=None):
        return {"client_sale_id": key or str(uuid.uuid4()), "items": items or [{"lot_id": lot, "quantity_mg": 1000} for lot in self.lots], "payment_method": "cash", "authorization_ref": "FIXTURE-ONLY", "discount_satang": discount}

    def checkout(self, payload, actor="staff"):
        return self.client.post("/v1/sales", headers=self.headers[actor], json=payload)

    def state(self, path=None):
        with connect(path or self.path) as db:
            schema = [tuple(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
            rows = {}
            for kind, name, _, _sql in schema:
                if kind == "table":
                    quoted = '"' + name.replace('"', '""') + '"'
                    rows[name] = sorted([tuple(row) for row in db.execute("SELECT * FROM " + quoted)], key=repr)
            return schema, rows

    def assert_unchanged(self, before, path=None):
        # Do not dump account/session hash fields on an assertion failure.
        self.assertTrue(before == self.state(path), "Complete DB rows or schema changed unexpectedly")

    def test_schema_ready_capabilities_and_default_sales_gate(self):
        me = self.client.get("/v1/me", headers=self.headers["staff"])
        self.assertEqual(me.status_code, 200)
        body = me.json()
        self.assertEqual(body["capabilities"], {"discounts": True, "discount_contract_version": 1,
            "optional_document_references": True, "document_contract_version": 1, **cost_capabilities(), **receipt_capabilities(), **pin_capabilities()})
        self.assertEqual(body["role"], "staff")
        self.assertEqual(body["store_id"], self.store)
        self.assertFalse(body["store"]["sales_enabled"])
        before = self.state()
        self.assertEqual(self.checkout(self.order(100)).status_code, 403)
        self.assert_unchanged(before)

    def test_zero_100_17550_and_full_bill_discounts_preserve_quantities(self):
        self.enable_fixture_sales()
        for discount in (0, 100, 17550, 30000):
            payload = self.order(discount)
            response = self.checkout(payload)
            self.assertEqual(response.status_code, 200)
            sale = response.json()
            self.assertEqual(sale, {"sale_id": sale["sale_id"], "client_sale_id": payload["client_sale_id"], "subtotal_satang": 30000, "discount_satang": discount, "total_satang": 30000 - discount, "duplicate": False,
                "payment_method": "cash", "payments": [{"payment_method": "cash", "amount_satang": 30000 - discount}]})
            with connect(self.path) as db:
                lines = db.execute("SELECT quantity_mg,line_subtotal_satang,line_discount_satang,line_total_satang FROM sale_lines WHERE sale_id=?", (sale["sale_id"],)).fetchall()
                self.assertEqual(sum(row[0] for row in lines), 2000)
                self.assertEqual(sum(row[1] for row in lines), 30000)
                self.assertEqual(sum(row[2] for row in lines), discount)
                self.assertEqual(sum(row[3] for row in lines), 30000 - discount)
        with connect(self.path) as db:
            self.assertEqual(sorted(row[0] for row in db.execute("SELECT quantity_mg FROM lot_balances")), [6000, 6000])
            self.assertEqual(db.execute("SELECT sum(quantity_delta_mg) FROM ledger_events WHERE event_type='SALE'").fetchone()[0], -8000)

    def test_discount_types_and_bounds_reject_without_any_mutation(self):
        self.enable_fixture_sales()
        for discount in (-1, 30001, True, False, 100.0, 100.5, "100", None, MAX_SALE_SATANG + 1, 2**100):
            with self.subTest(value_type=type(discount).__name__):
                before = self.state()
                self.assertEqual(self.checkout(self.order(discount)).status_code, 422)
                self.assert_unchanged(before)

    def test_zero_price_and_zero_subtotal(self):
        self.enable_fixture_sales()
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=0")
        response = self.checkout(self.order(0))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["subtotal_satang"], 0)
        self.assertEqual(response.json()["total_satang"], 0)
        before = self.state()
        self.assertEqual(self.checkout(self.order(1)).status_code, 422)
        self.assert_unchanged(before)
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=10000 WHERE id=?", (self.product_ids[0],))
        mixed = self.checkout(self.order(100))
        self.assertEqual(mixed.status_code, 200)
        with connect(self.path) as db:
            zero_line = db.execute("SELECT line_subtotal_satang,line_discount_satang,line_total_satang FROM sale_lines WHERE sale_id=? AND lot_id=?", (mixed.json()["sale_id"], self.lots[1])).fetchone()
            self.assertEqual(tuple(zero_line), (0, 0, 0))

    def test_omission_zero_retry_uses_recorded_totals_and_rejects_changed_payload(self):
        self.enable_fixture_sales()
        payload = self.order()
        payload.pop("discount_satang")
        original = self.checkout(payload).json()
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=50000")
        before = self.state()
        retry = {**payload, "items": list(reversed(payload["items"])), "discount_satang": 0, "authorization_ref": " FIXTURE-ONLY "}
        duplicate = self.checkout(retry)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json(), {**original, "duplicate": True})
        self.assert_unchanged(before)
        for changed in ({**retry, "discount_satang": 100}, {**retry, "payment_method": "transfer"}, {**retry, "authorization_ref": "DIFFERENT"}, {**retry, "items": [{"lot_id": self.lots[0], "quantity_mg": 1001}]}):
            self.assertEqual(self.checkout(changed).status_code, 409)
            self.assert_unchanged(before)

    def test_discounted_retry_before_current_price_stock_and_sales_gate(self):
        self.enable_fixture_sales()
        payload = self.order(17550)
        original_response = self.checkout(payload)
        self.assertEqual(original_response.status_code, 200)
        original = original_response.json()
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=MAX(price_satang_per_gram,50000),active=0")
            db.execute("UPDATE lot_balances SET quantity_mg=0")
            db.execute("UPDATE stores SET sales_enabled=0 WHERE id=?", (self.store,))
        before = self.state()
        duplicate = self.checkout(payload)
        self.assertEqual(duplicate.status_code, 200)
        self.assertEqual(duplicate.json(), {**original, "duplicate": True})
        lookup = self.client.get("/v1/sales/by-client/" + payload["client_sale_id"], headers=self.headers["staff"])
        self.assertEqual(lookup.status_code, 200)
        self.assertEqual(lookup.json(), {"id": original["sale_id"], "client_sale_id": payload["client_sale_id"], "subtotal_satang": 30000, "discount_satang": 17550, "total_satang": 12450,
            "payment_method": "cash", "payments": [{"payment_method": "cash", "amount_satang": 12450}]})
        self.assert_unchanged(before)

    def legacy_sale(self):
        payload = self.order()
        sid = str(uuid.uuid4())
        old_hash = legacy_checkout_request_hash(payload["items"], payload["payment_method"], payload["authorization_ref"])
        stamp = "2026-01-01T00:00:00+00:00"
        with connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,authorization_ref,subtotal_satang,total_satang,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (sid, self.store, payload["client_sale_id"], old_hash, self.users["staff"], "cash", "FIXTURE-ONLY", 30000, 30000, stamp))
            for lot_id, gross in zip(self.lots, (10000, 20000)):
                db.execute("UPDATE lot_balances SET quantity_mg=quantity_mg-1000,updated_at=? WHERE lot_id=?", (stamp, lot_id))
                db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_subtotal_satang,line_total_satang) VALUES(?,?,?,?,?,?,?)", (str(uuid.uuid4()), sid, lot_id, 1000, gross, gross, gross))
                db.execute("INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,quantity_delta_mg,reason,sale_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), self.store, lot_id, self.users["staff"], "SALE", -1000, "Legacy fixture checkout", sid, stamp))
            db.commit()
        return payload, sid

    def test_exact_legacy_hash_only_accepts_zero_discount_matching_retry(self):
        payload, sid = self.legacy_sale()
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=50000")
        before = self.state()
        for omit in (False, True):
            retry = dict(payload)
            if omit:
                retry.pop("discount_satang")
            response = self.checkout(retry)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"sale_id": sid, "client_sale_id": payload["client_sale_id"], "subtotal_satang": 30000, "discount_satang": 0, "total_satang": 30000, "duplicate": True,
                "payment_method": "cash", "payments": [{"payment_method": "cash", "amount_satang": 30000}]})
            self.assert_unchanged(before)
        self.assertEqual(self.checkout({**payload, "discount_satang": 1}).status_code, 409)
        self.assertEqual(self.checkout({**payload, "authorization_ref": "WRONG"}).status_code, 409)
        self.assertEqual(self.checkout(payload, "owner").status_code, 403)
        self.assert_unchanged(before)

    def test_real_legacy_migration_then_http_retry_preserves_recorded_sale(self):
        # Frozen original schema supplied by the migration suite, not a v2
        # record with a substituted fingerprint.
        from test_discount_migrations import LEGACY_SCHEMA
        for version in (0, 1):
            with self.subTest(legacy_version=version):
                path = str(Path(self.tmp.name) / f"legacy-offline-{version}.sqlite3")
                with connect(path) as db:
                    db.executescript(LEGACY_SCHEMA)
                    db.execute(f"PRAGMA user_version={version}")
                store = create_store(path, "Disposable original-format store")
                password = "Synthetic legacy fixture passphrase"
                cashier = create_user(path, store, "legacy-staff@fixture.invalid", password, "staff")
                receiver = create_user(path, store, "legacy-owner@fixture.invalid", "Synthetic legacy owner passphrase", "owner")
                product_id, sale_id, client_id = [str(uuid.uuid4()) for _ in range(3)]
                lots = [str(uuid.uuid4()), str(uuid.uuid4())]
                items = [{"lot_id": lot_id, "quantity_mg": quantity} for lot_id, quantity in zip(lots, (100, 200))]
                ref = "LEGACY-FIXTURE-ONLY"
                fingerprint = legacy_checkout_request_hash(items, "cash", ref)
                stamp = "2026-01-01T00:00:00+00:00"
                with connect(path) as db:
                    db.execute("BEGIN IMMEDIATE")
                    db.execute("INSERT INTO products(id,store_id,sku,name,price_satang_per_gram,created_at) VALUES(?,?,?,?,?,?)", (product_id, store, "LEGACY", "Original-format fixture", 150, stamp))
                    for index, (lot_id, qty) in enumerate(zip(lots, (100, 200))):
                        db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,received_at) VALUES(?,?,?,?,?,?,?)", (lot_id, store, product_id, f"LEGACY-{index}", "Synthetic supplier", "FIXTURE", stamp))
                        db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,?,?)", (lot_id, 1000 - qty, stamp))
                        db.execute("INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,quantity_delta_mg,reason,created_at) VALUES(?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), store, lot_id, receiver, "RECEIVE", 1000, "Historical fixture receipt", stamp))
                    db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,authorization_ref,subtotal_satang,total_satang,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", (sale_id, store, client_id, fingerprint, cashier, "cash", ref, 45, 45, stamp))
                    for lot_id, qty, gross in zip(lots, (100, 200), (15, 30)):
                        db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_total_satang) VALUES(?,?,?,?,?,?)", (str(uuid.uuid4()), sale_id, lot_id, qty, 150, gross))
                        db.execute("INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,quantity_delta_mg,reason,sale_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), store, lot_id, cashier, "SALE", -qty, "Historical fixture checkout", sale_id, stamp))
                    db.commit()
                before = self.state(path)
                with self.assertRaises(SchemaUpgradeRequired):
                    create_app(path, origins=["https://localhost"])
                self.assert_unchanged(before, path)
                migration = migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual((migration["status"], migration["schema_version"]), ("PASS", CURRENT_SCHEMA_VERSION))
                self.assertEqual(migrate_copy(path, confirmed_offline_copy=True)["status"], "NOOP")
                migrated = create_app(path, origins=["https://localhost"])
                with TestClient(migrated) as client:
                    login = client.post("/v1/auth/login", json={"email": "legacy-staff@fixture.invalid", "password": password})
                    self.assertEqual(login.status_code, 200)
                    headers = {"Authorization": "Bearer " + login.json()["token"]}
                    me = client.get("/v1/me", headers=headers)
                    self.assertEqual(me.json()["capabilities"], {"discounts": True, "discount_contract_version": 1,
                        "optional_document_references": True, "document_contract_version": 1, **cost_capabilities(), **receipt_capabilities(), **pin_capabilities()})
                    self.assertFalse(me.json()["store"]["sales_enabled"])
                    with connect(path) as db:
                        db.execute("UPDATE products SET price_satang_per_gram=50000")
                        recorded = db.execute("SELECT request_hash,discount_satang FROM sales WHERE id=?", (sale_id,)).fetchone()
                        self.assertTrue(recorded[0] == fingerprint, "Original fingerprint changed during migration")
                        self.assertEqual(recorded[1], 0)
                    before_retry = self.state(path)
                    payload = {"client_sale_id": client_id, "items": items, "payment_method": "cash", "authorization_ref": ref}
                    for request in (payload, {**payload, "discount_satang": 0}):
                        retry = client.post("/v1/sales", headers=headers, json=request)
                        self.assertEqual(retry.status_code, 200)
                        self.assertEqual(retry.json(), {"sale_id": sale_id, "client_sale_id": client_id, "subtotal_satang": 45, "discount_satang": 0, "total_satang": 45, "duplicate": True,
                            "payment_method": "cash", "payments": [{"payment_method": "cash", "amount_satang": 45}]})
                        self.assert_unchanged(before_retry, path)
                    for request in ({**payload, "discount_satang": 1}, {**payload, "items": [{"lot_id": lots[0], "quantity_mg": 101}]}):
                        self.assertEqual(client.post("/v1/sales", headers=headers, json=request).status_code, 409)
                        self.assert_unchanged(before_retry, path)
                    lookup = client.get("/v1/sales/by-client/" + client_id, headers=headers)
                    self.assertEqual(lookup.json(), {"id": sale_id, "client_sale_id": client_id, "subtotal_satang": 45, "discount_satang": 0, "total_satang": 45,
                        "payment_method": "cash", "payments": [{"payment_method": "cash", "amount_satang": 45}]})
                    self.assert_unchanged(before_retry, path)

    def test_lookup_and_checkout_preserve_cashier_and_tenant_boundaries(self):
        self.enable_fixture_sales()
        payload = self.order(100)
        original = self.checkout(payload)
        self.assertEqual(original.status_code, 200)
        self.assertEqual(self.checkout(payload, "owner").status_code, 403)
        path = "/v1/sales/by-client/" + payload["client_sale_id"]
        for actor in ("owner", "manager"):
            self.assertEqual(self.client.get(path, headers=self.headers[actor]).status_code, 200)
        self.assertEqual(self.client.get(path, headers=self.headers["other"]).status_code, 404)
        other_staff_id = create_user(self.path, self.store, "another-staff@discount-fixture.invalid", "Another synthetic passphrase", "staff")
        login = self.client.post("/v1/auth/login", json={"email": "another-staff@discount-fixture.invalid", "password": "Another synthetic passphrase"})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(self.client.get(path, headers={"Authorization": "Bearer " + login.json()["token"]}).status_code, 403)
        self.assertTrue(bool(other_staff_id))
        self.enable_fixture_sales(self.other_store)
        before = self.state()
        self.assertEqual(self.checkout(self.order(100), "other").status_code, 422)
        self.assert_unchanged(before)

    def test_duplicate_lots_and_partial_insufficient_stock_do_not_mutate(self):
        self.enable_fixture_sales()
        before = self.state()
        duplicate = self.order(100, items=[{"lot_id": self.lots[0], "quantity_mg": 1000}, {"lot_id": self.lots[0], "quantity_mg": 1000}])
        self.assertEqual(self.checkout(duplicate).status_code, 422)
        insufficient = self.order(100, items=[{"lot_id": self.lots[0], "quantity_mg": 1000}, {"lot_id": self.lots[1], "quantity_mg": 10001}])
        self.assertEqual(self.checkout(insufficient).status_code, 409)
        self.assert_unchanged(before)

    def test_two_devices_cannot_oversell_with_discounts(self):
        self.enable_fixture_sales()
        payloads = [self.order(17550, items=[{"lot_id": lot, "quantity_mg": 8000} for lot in self.lots]) for _ in range(2)]
        def submit(payload):
            with TestClient(self.api) as client:
                return client.post("/v1/sales", headers=self.headers["staff"], json=payload).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(submit, payloads)), [200, 409])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(sorted(row[0] for row in db.execute("SELECT quantity_mg FROM lot_balances")), [2000, 2000])
            self.assertEqual(tuple(db.execute("SELECT subtotal_satang,discount_satang,total_satang FROM sales").fetchone()), (240000, 17550, 222450))

    def test_two_devices_retry_same_uuid_cut_stock_once(self):
        self.enable_fixture_sales()
        payload = self.order(100)
        def submit(_):
            with TestClient(self.api) as client:
                r = client.post("/v1/sales", headers=self.headers["staff"], json=payload)
                self.assertEqual(r.status_code, 200)
                return r.json()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertEqual(sorted(result["duplicate"] for result in results), [False, True])
        self.assertEqual(results[0]["sale_id"], results[1]["sale_id"])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(sorted(row[0] for row in db.execute("SELECT quantity_mg FROM lot_balances")), [9000, 9000])

    def test_failures_after_first_balance_line_and_ledger_roll_back_all_rows(self):
        self.enable_fixture_sales()
        first_lot = sorted(self.lots)[0]
        with connect(self.path) as db:
            db.execute("UPDATE lot_balances SET updated_at='1999-01-01T00:00:00+00:00'")
        for stage, timing, table, condition in (
            ("balance", "AFTER UPDATE", "lot_balances", f"NEW.lot_id='{first_lot}'"),
            ("line", "AFTER INSERT", "sale_lines", f"NEW.lot_id='{first_lot}'"),
            ("ledger", "AFTER INSERT", "ledger_events", f"NEW.event_type='SALE' AND NEW.lot_id='{first_lot}'"),
        ):
            with self.subTest(stage=stage):
                with connect(self.path) as db:
                    db.execute(f"CREATE TRIGGER fixture_failure {timing} ON {table} WHEN {condition} BEGIN SELECT fixture_hit(); SELECT RAISE(FAIL,'fixture injected failure'); END")
                before = self.state()
                hits = []
                original_connect = api_module.connect
                @contextmanager
                def instrumented(path):
                    with original_connect(path) as db:
                        db.create_function("fixture_hit", 0, lambda: hits.append(stage) or 0)
                        yield db
                with patch.object(api_module, "connect", instrumented):
                    self.assertEqual(self.checkout(self.order(100)).status_code, 500)
                self.assertEqual(hits, [stage], "Requested fault location was not reached")
                self.assert_unchanged(before)
                with connect(self.path) as db:
                    db.execute("DROP TRIGGER fixture_failure")

    def test_supported_maximum_bill_is_exact_and_larger_discount_rejected(self):
        self.enable_fixture_sales()
        product = self.client.post("/v1/products", headers=self.headers["owner"], json={"sku": "MAXIMUM", "name": "Maximum-boundary fixture", "price_satang_per_gram": 100_000_000})
        self.assertEqual(product.status_code, 200)
        pid = product.json()["product_id"]
        lots = [str(uuid.uuid4()) for _ in range(50)]
        stamp = "2026-01-01T00:00:00+00:00"
        with connect(self.path) as db:
            db.execute("BEGIN IMMEDIATE")
            for index, lot_id in enumerate(lots):
                db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,received_at) VALUES(?,?,?,?,?,?,?)", (lot_id, self.store, pid, f"MAX-{index}", "Synthetic", "FIXTURE", stamp))
                db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,?,?)", (lot_id, 1000000, stamp))
                db.execute("INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,quantity_delta_mg,reason,created_at) VALUES(?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), self.store, lot_id, self.users["owner"], "RECEIVE", 1000000, "Maximum fixture", stamp))
            db.commit()
        payload = self.order(MAX_SALE_SATANG, items=[{"lot_id": lot_id, "quantity_mg": 1000000} for lot_id in lots])
        response = self.checkout(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()["subtotal_satang"], response.json()["discount_satang"], response.json()["total_satang"]), (MAX_SALE_SATANG, MAX_SALE_SATANG, 0))
        with connect(self.path) as db:
            self.assertEqual(tuple(db.execute("SELECT sum(line_subtotal_satang),sum(line_discount_satang),sum(line_total_satang) FROM sale_lines WHERE sale_id=?", (response.json()["sale_id"],)).fetchone()), (MAX_SALE_SATANG, MAX_SALE_SATANG, 0))
        before = self.state()
        self.assertEqual(self.checkout({**payload, "discount_satang": MAX_SALE_SATANG + 1}).status_code, 422)
        self.assert_unchanged(before)


if __name__ == "__main__":
    unittest.main()
