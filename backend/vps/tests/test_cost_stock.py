"""Lot costing and physical-count acceptance on disposable SQLite only."""
import atexit
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

_bootstrap = tempfile.TemporaryDirectory(prefix="cost-stock-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

from fastapi.testclient import TestClient
from app import connect, create_app, create_store, create_user
from cost_stock import inventory_value
from migrations import _snapshot
from evidence_fixture import upload_photo


class CostStockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cost-stock-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "Synthetic cost/count fixture")
        self.other = create_store(self.path, "Other synthetic tenant")
        self.users, self.headers = {}, {}
        for name, role, store in (("owner", "owner", self.store), ("manager", "manager", self.store),
                                  ("staff", "staff", self.store), ("other", "owner", self.other)):
            password = "Disposable cost/count passphrase " + name
            email = name + "@cost-stock.invalid"
            self.users[name] = create_user(self.path, store, email, password, role)
            result = self.client.post("/v1/auth/login", json={"email": email, "password": password})
            self.assertEqual(result.status_code, 200)
            self.headers[name] = {"Authorization": "Bearer " + result.json()["token"]}

    def state(self):
        with connect(self.path) as db:
            db.row_factory = None
            return _snapshot(db)

    def unchanged(self, before):
        self.assertTrue(before == self.state(), "Fixture state or schema changed unexpectedly")

    def product(self, default=None, *, price=10000):
        result = self.client.post("/v1/products", headers=self.headers["owner"], json={
            "sku": str(uuid.uuid4()), "name": "Synthetic inventory item", "price_satang_per_gram": price,
            "default_cost_satang_per_gram": default})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()["product_id"]

    def receipt_payload(self, product, **extra):
        return {"product_id": product, "lot_code": str(uuid.uuid4()), "supplier_name": "Synthetic supplier",
                "supplier_document_ref": "FIXTURE-NO-REAL-DOCUMENT", "quantity_mg": 5000,
                "reason": "Disposable fixture receipt", "client_receive_id": str(uuid.uuid4()), **extra}

    def receive(self, product, **extra):
        result = self.client.post("/v1/lots/receive", headers=self.headers["owner"],
                                  json=self.receipt_payload(product, **extra))
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def inventory(self, actor="owner"):
        result = self.client.get("/v1/inventory", headers=self.headers[actor])
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def count_payload(self, lots, actor="owner", **extra):
        count_id = extra.get("client_stocktake_id", str(uuid.uuid4()))
        return {"client_stocktake_id": count_id, "shift_label": "Synthetic morning",
                "reason": "Physical count fixture", "items": [{"lot_id": lot["id"],
                    "expected_revision": lot["stock_revision"],
                    "evidence_id": upload_photo(self.client, self.headers[actor], lot["id"], count_id)["evidence_id"],
                    "counted_quantity_mg": lot["quantity_mg"]} for lot in lots], **extra}

    def count(self, payload, actor="owner"):
        return self.client.post("/v1/stocktakes", headers=self.headers[actor], json=payload)

    def enable(self):
        with connect(self.path) as db:
            db.execute("UPDATE stores SET sales_enabled=1 WHERE id=?", (self.store,))

    def sale_payload(self, lot, qty=1000, discount=0):
        return {"client_sale_id": str(uuid.uuid4()), "items": [{"lot_id": lot, "quantity_mg": qty}],
                "payment_method": "cash", "authorization_ref": "SYNTHETIC-DOC", "discount_satang": discount}

    def sale(self, payload):
        return self.client.post("/v1/sales", headers=self.headers["staff"], json=payload)

    def test_default_actual_unknown_zero_cost_and_staff_privacy(self):
        for default, actual in ((None, None), (0, 0), (333, 333)):
            product = self.product(default)
            result = self.receive(product)
            self.assertEqual(result["cost_satang_per_gram"], actual)
            self.assertEqual(result["event_id"], result["ledger_event_id"])
        override = self.receive(self.product(200), cost_satang_per_gram=0)
        self.assertEqual(override["cost_satang_per_gram"], 0)
        inventory = self.inventory("owner")
        self.assertEqual(inventory["summary"]["quantity_mg"], 20000)
        self.assertEqual(inventory["summary"]["unknown_cost_lot_count"], 1)
        self.assertIsNone(inventory["summary"]["inventory_value_satang"])
        self.assertEqual(inventory["summary"]["known_inventory_value_satang"], 1665)
        catalog = self.client.get("/v1/catalog", headers=self.headers["owner"]).json()
        self.assertIn("default_cost_satang_per_gram", catalog["products"][0])
        manager = self.client.get("/v1/catalog", headers=self.headers["manager"]).json()
        self.assertNotIn("cost", str(manager))
        staff = self.client.get("/v1/catalog", headers=self.headers["staff"]).json()
        self.assertNotIn("cost", str(staff))
        self.assertEqual(self.client.get("/v1/inventory", headers=self.headers["staff"]).status_code, 403)
        self.assertEqual(self.client.get("/v1/inventory").status_code, 401)
        self.assertEqual(self.inventory("other")["lots"], [])

    def test_strict_cost_and_quantity_types_and_bounds_reject_without_mutation(self):
        product = self.product()
        for value in (-1, True, False, 1.0, "1", 100000001, 2**100):
            before = self.state()
            payload = {"sku": "INVALID", "name": "Synthetic", "price_satang_per_gram": 100,
                       "default_cost_satang_per_gram": value}
            self.assertEqual(self.client.post("/v1/products", headers=self.headers["owner"], json=payload).status_code, 422)
            self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"],
                json=self.receipt_payload(product, cost_satang_per_gram=value)).status_code, 422)
            self.unchanged(before)
        for value in (True, 1.0, "1", None):
            before = self.state()
            self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"],
                json=self.receipt_payload(product, quantity_mg=value)).status_code, 422)
            self.unchanged(before)

    def test_receipt_uuid_replays_stored_cost_before_current_defaults_or_activity(self):
        product = self.product(333)
        payload = self.receipt_payload(product)
        first = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload)
        self.assertEqual(first.status_code, 200)
        with connect(self.path) as db:
            db.execute("UPDATE products SET default_cost_satang_per_gram=999,active=0 WHERE id=?", (product,))
        before = self.state()
        replay = self.client.post("/v1/lots/receive", headers=self.headers["manager"], json={**payload, "cost_satang_per_gram": None})
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), {**{key: value for key, value in first.json().items()
                                          if key != "cost_satang_per_gram"}, "duplicate": True})
        owner_replay = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload)
        self.assertEqual(owner_replay.json(), {**first.json(), "duplicate": True})
        for changed in ({"cost_satang_per_gram": 333}, {"quantity_mg": 4000}, {"reason": "Different"}):
            self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"],
                json={**payload, **changed}).status_code, 409)
        self.unchanged(before)

    def test_old_receipt_without_uuid_keeps_original_contract_and_duplicate_lot_guard(self):
        payload = self.receipt_payload(self.product())
        payload.pop("client_receive_id")
        first = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload)
        self.assertEqual(first.status_code, 200)
        self.assertIsNone(first.json()["client_receive_id"])
        self.assertIsNone(first.json()["cost_satang_per_gram"])
        before = self.state()
        self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload).status_code, 409)
        self.unchanged(before)

    def test_concurrent_receipt_same_uuid_creates_one_lot_and_event(self):
        payload = self.receipt_payload(self.product(123))
        def submit(_):
            with TestClient(self.api) as client:
                response = client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload)
                self.assertEqual(response.status_code, 200)
                return response.json()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        self.assertEqual(sorted(row["duplicate"] for row in results), [False, True])
        self.assertEqual(results[0]["lot_id"], results[1]["lot_id"])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM lots").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events").fetchone()[0], 1)

    def test_fractional_mg_cogs_snapshots_reconcile_full_lot_and_retry(self):
        product = self.product(333)
        lot = self.receive(product, quantity_mg=1001)["lot_id"]
        self.enable()
        cost_total = 0
        payload = self.sale_payload(lot, qty=1)
        for qty in (1, 499, 500, 1):
            order = payload if qty == 1 and cost_total == 0 else self.sale_payload(lot, qty=qty)
            response = self.sale(order)
            self.assertEqual(response.status_code, 200, response.text)
            with connect(self.path) as db:
                row = db.execute("SELECT unit_cost_satang_per_gram,line_cost_satang FROM sale_lines WHERE sale_id=?",
                                 (response.json()["sale_id"],)).fetchone()
                self.assertEqual(row[0], 333)
                cost_total += row[1]
        self.assertEqual(cost_total, inventory_value(333, 1001))
        with connect(self.path) as db:
            self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances").fetchone()), (0, 4))
            db.execute("UPDATE products SET default_cost_satang_per_gram=999,price_satang_per_gram=1 WHERE id=?", (product,))
        before = self.state()
        retry = self.sale(payload)
        self.assertEqual(retry.status_code, 200)
        self.assertTrue(retry.json()["duplicate"])
        self.unchanged(before)
        with connect(self.path) as db, self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE lots SET cost_satang_per_gram=999 WHERE id=?", (lot,))

    def test_unknown_zero_and_full_discount_cost_snapshots(self):
        self.enable()
        for cost in (None, 0, 5000):
            lot = self.receive(self.product(cost))["lot_id"]
            result = self.sale(self.sale_payload(lot, discount=10000))
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["total_satang"], 0)
            with connect(self.path) as db:
                line = db.execute("SELECT unit_cost_satang_per_gram,line_cost_satang FROM sale_lines WHERE sale_id=?",
                                  (result.json()["sale_id"],)).fetchone()
                self.assertEqual(tuple(line), (cost, cost))

    def test_stocktake_short_surplus_zero_history_and_idempotency(self):
        for cost in (333, None, 0):
            self.receive(self.product(cost))
        lots = self.inventory()["lots"]
        payload = self.count_payload(lots, actor="manager")
        payload["items"][0]["counted_quantity_mg"] -= 3
        payload["items"][1]["counted_quantity_mg"] += 7
        response = self.count(payload, "manager")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["actor_user_id"], self.users["manager"])
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(sorted(line["variance_mg"] for line in result["items"]), [-3, 0, 7])
        self.assertTrue(all(line["stock_revision_after"] == 1 for line in result["items"]))
        self.assertTrue(all("inventory_delta_satang" not in line for line in result["items"]))
        owner_result = self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"],
                                       headers=self.headers["owner"]).json()
        for line in owner_result["items"]:
            lot = next(row for row in lots if row["id"] == line["lot_id"])
            c = lot["cost_satang_per_gram"]
            expected = None if c is None else inventory_value(c, line["counted_quantity_mg"]) - inventory_value(c, line["system_quantity_mg"])
            self.assertEqual(line["inventory_delta_satang"], expected)
        before = self.state()
        replay = self.count({**payload, "items": list(reversed(payload["items"]))})
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), owner_result)
        lookup = self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"], headers=self.headers["owner"])
        self.assertEqual(lookup.json(), owner_result)
        self.assertEqual(self.count({**payload, "reason": "Different"}).status_code, 409)
        self.unchanged(before)
        history = self.client.get("/v1/stocktakes", headers=self.headers["owner"]).json()["stocktakes"]
        self.assertEqual((history[0]["line_count"], history[0]["variance_mg"]), (3, 4))
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='ADJUST'").fetchone()[0], 2)
            for table in ("stocktakes", "stocktake_lines", "receive_requests"):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("DELETE FROM " + table)

    def test_no_variance_count_advances_revision_and_stale_snapshot_rejects_atomically(self):
        self.receive(self.product(100))
        lots = self.inventory()["lots"]
        first = self.count(self.count_payload(lots))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["items"][0]["variance_mg"], 0)
        stale = self.count_payload(lots)
        before = self.state()
        self.assertEqual(self.count(stale).status_code, 409)
        self.unchanged(before)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='ADJUST'").fetchone()[0], 0)

    def test_optional_count_reason_normalizes_in_history_retries_and_reconciliation(self):
        self.receive(self.product(100))
        for index, reason in enumerate((None, "", " \t\n ")):
            with self.subTest(reason=reason):
                actor = "manager" if index == 1 else "owner"
                payload = self.count_payload(self.inventory()["lots"], actor=actor)
                if reason is None:
                    del payload["reason"]
                else:
                    payload["reason"] = reason
                payload["items"][0]["counted_quantity_mg"] -= 1
                result = self.count(payload, actor)
                self.assertEqual(result.status_code, 200, result.text)
                saved = result.json()
                self.assertEqual(saved["reason"], "")
                self.assertEqual(saved["items"][0]["variance_mg"], -1)
                before = self.state()
                for retry_reason in (None, "", " \t\n "):
                    retry_payload = {**payload, "reason": retry_reason}
                    if retry_reason is None:
                        del retry_payload["reason"]
                    replay = self.count(retry_payload, actor)
                    self.assertEqual(replay.status_code, 200, replay.text)
                    self.assertEqual(replay.json(), {**saved, "duplicate": True})
                    reconciled = self.client.post("/v1/stocktakes/reconcile", headers=self.headers[actor], json=retry_payload)
                    self.assertEqual(reconciled.status_code, 200, reconciled.text)
                    self.assertEqual(reconciled.json(), {"status": "completed", "result": replay.json()})
                changed = self.count({**payload, "reason": "Added after commit"}, actor)
                self.assertEqual(changed.status_code, 409)
                self.unchanged(before)
        history = self.client.get("/v1/stocktakes", headers=self.headers["manager"]).json()["stocktakes"]
        self.assertEqual(len(history), 3)
        self.assertTrue(all(row["reason"] == "" for row in history))
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='ADJUST'").fetchone()[0], 3)
            self.assertFalse(db.execute("PRAGMA foreign_key_check").fetchall())

    def test_count_reason_maximum_remains_supported_and_is_part_of_saved_payload(self):
        self.receive(self.product(100))
        reason = "ร" * 300
        payload = self.count_payload(self.inventory()["lots"], reason=reason)
        response = self.count(payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["reason"], reason)
        before = self.state()
        replay = self.count(payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json(), {**response.json(), "duplicate": True})
        self.assertEqual(self.count({**payload, "reason": ""}).status_code, 409)
        self.unchanged(before)

    def test_aba_balance_returning_to_same_quantity_still_rejects_old_revision(self):
        self.receive(self.product(100))
        old = self.inventory()["lots"]
        down = self.count_payload(old)
        down["items"][0]["counted_quantity_mg"] -= 1
        self.assertEqual(self.count(down).status_code, 200)
        up = self.count_payload(self.inventory()["lots"])
        up["items"][0]["counted_quantity_mg"] += 1
        self.assertEqual(self.count(up).status_code, 200)
        self.assertEqual(self.inventory()["lots"][0]["quantity_mg"], old[0]["quantity_mg"])
        stale = self.count_payload(old)
        before = self.state()
        self.assertEqual(self.count(stale).status_code, 409)
        self.unchanged(before)

    def test_stocktake_invalid_types_duplicates_and_permissions_do_not_mutate(self):
        self.receive(self.product(100))
        payload = self.count_payload(self.inventory()["lots"])
        for field, values in (("counted_quantity_mg", (-1, 100000001, True, 1.0, "1", None)),
                              ("expected_revision", (-1, True, 1.0, "0", None, 2**100))):
            for value in values:
                before = self.state()
                item = {**payload["items"][0], field: value}
                self.assertEqual(self.count({**payload, "items": [item]}).status_code, 422)
                self.unchanged(before)
        before = self.state()
        self.assertEqual(self.count({**payload, "items": payload["items"] * 2}).status_code, 422)
        for reason in (None, True, 1, 1.0, [], {}, "x" * 301):
            self.assertEqual(self.count({**payload, "reason": reason}).status_code, 422)
        self.assertEqual(self.count({**payload, "shift_label": "  "}).status_code, 422)
        self.assertEqual(self.count(payload, "staff").status_code, 403)
        self.assertEqual(self.count(payload, "other").status_code, 422)
        self.assertEqual(self.client.get("/v1/stocktakes", headers=self.headers["staff"]).status_code, 403)
        self.assertEqual(self.client.get("/v1/stocktakes/by-client/" + payload["client_stocktake_id"],
            headers=self.headers["other"]).status_code, 404)
        self.unchanged(before)

    def test_inventory_retains_inactive_expired_lots_and_counts_selected_only(self):
        a = self.receive(self.product(100))["lot_id"]
        b = self.receive(self.product())["lot_id"]
        with connect(self.path) as db:
            db.execute("UPDATE lots SET active=0,expires_on='2000-01-01' WHERE id=?", (a,))
        lots = self.inventory()["lots"]
        self.assertEqual(len(lots), 2)
        target = next(row for row in lots if row["id"] == a)
        payload = self.count_payload([target])
        payload["items"][0]["counted_quantity_mg"] = 0
        self.assertEqual(self.count(payload).status_code, 200)
        with connect(self.path) as db:
            self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (b,)).fetchone()), (5000, 0))
        self.assertEqual(self.inventory()["summary"]["unknown_cost_lot_count"], 1)

    def test_count_failures_after_balance_ledger_and_line_roll_back_everything(self):
        for _ in range(2):
            self.receive(self.product(100))
        payload = self.count_payload(self.inventory()["lots"])
        for item in payload["items"]:
            item["counted_quantity_mg"] -= 100
        for event, table, condition in (("UPDATE", "lot_balances", "1"),
                                         ("INSERT", "ledger_events", "NEW.event_type='ADJUST'"),
                                         ("INSERT", "stocktake_lines", "1")):
            with connect(self.path) as db:
                db.execute(f"CREATE TRIGGER fixture_failure AFTER {event} ON {table} WHEN {condition} BEGIN SELECT RAISE(FAIL,'Synthetic count failure'); END")
            before = self.state()
            self.assertEqual(self.count(payload).status_code, 500)
            self.unchanged(before)
            with connect(self.path) as db:
                db.execute("DROP TRIGGER fixture_failure")

    def test_concurrent_count_same_uuid_once_and_distinct_uuid_conflict(self):
        self.receive(self.product(100))
        payload = self.count_payload(self.inventory()["lots"])
        def submit(p):
            with TestClient(self.api) as client:
                r = client.post("/v1/stocktakes", headers=self.headers["owner"], json=p)
                return r.status_code, r.json()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [payload, payload]))
        self.assertEqual([r[0] for r in results], [200, 200])
        self.assertEqual(sorted(r[1]["duplicate"] for r in results), [False, True])
        current = self.count_payload(self.inventory()["lots"])
        parallel = self.count_payload(self.inventory()["lots"])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, [current, parallel]))
        self.assertEqual(sorted(r[0] for r in results), [200, 409])

    def test_concurrent_sale_and_count_do_not_apply_stale_absolute_quantity(self):
        lot = self.receive(self.product(100))["lot_id"]
        self.enable()
        count = self.count_payload(self.inventory()["lots"])
        count["items"][0]["counted_quantity_mg"] = 4000
        sale = self.sale_payload(lot, qty=1000)
        def submit(kind):
            with TestClient(self.api) as client:
                return client.post("/v1/stocktakes" if kind == "count" else "/v1/sales",
                    headers=self.headers["owner" if kind == "count" else "staff"],
                    json=count if kind == "count" else sale).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(submit, ["count", "sale"]))
        self.assertEqual(statuses[1], 200)
        self.assertIn(statuses[0], (200, 409))
        with connect(self.path) as db:
            balance = db.execute("SELECT quantity_mg FROM lot_balances").fetchone()[0]
            self.assertEqual(balance, 3000 if statuses[0] == 200 else 4000)
            self.assertEqual(balance, db.execute("SELECT sum(quantity_delta_mg) FROM ledger_events").fetchone()[0])

    def test_receipt_failures_and_cost_overflow_boundaries(self):
        product = self.product(100000000)
        payload = self.receipt_payload(product, quantity_mg=100000000)
        with connect(self.path) as db:
            db.execute("CREATE TRIGGER fixture_failure AFTER INSERT ON receive_requests BEGIN SELECT RAISE(FAIL,'Synthetic receipt failure'); END")
        before = self.state()
        self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload).status_code, 409)
        self.unchanged(before)
        with connect(self.path) as db:
            db.execute("DROP TRIGGER fixture_failure")
        self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload).status_code, 200)
        self.assertEqual(self.inventory()["summary"]["inventory_value_satang"], 10_000_000_000_000)

    def test_optional_intake_references_preserved_and_sale_flag_still_authoritative(self):
        product = self.product(10)
        for mode in ("omitted", "blank", "supplied"):
            payload = self.receipt_payload(product)
            if mode == "omitted":
                payload.pop("supplier_document_ref")
            else:
                payload["supplier_document_ref"] = "" if mode == "blank" else "  SYNTHETIC-REF  "
            response = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload)
            self.assertEqual(response.status_code, 200, response.text)
            with connect(self.path) as db:
                self.assertEqual(db.execute("SELECT supplier_document_ref FROM lots WHERE id=?",
                    (response.json()["lot_id"],)).fetchone()[0], "SYNTHETIC-REF" if mode == "supplied" else "")
        for invalid in (True, 123, None, "x" * 201):
            before = self.state()
            self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"],
                json=self.receipt_payload(product, supplier_document_ref=invalid)).status_code, 422)
            self.unchanged(before)
        lot = response.json()["lot_id"]
        self.enable()
        order = self.sale_payload(lot)
        order.pop("authorization_ref")
        before = self.state()
        self.assertEqual(self.sale(order).status_code, 422)
        self.unchanged(before)
        with connect(self.path) as db:
            db.execute("UPDATE stores SET requires_authorization=0 WHERE id=?", (self.store,))
        self.assertEqual(self.sale(order).status_code, 200)

    def test_stocktake_reconcile_completed_pending_rejection_and_late_post(self):
        self.receive(self.product(100))
        original = self.count_payload(self.inventory()["lots"])
        endpoint = "/v1/stocktakes/reconcile"
        before = self.state()
        pending = self.client.post(endpoint, headers=self.headers["owner"], json=original)
        self.assertEqual(pending.json(), {"status": "pending", "client_stocktake_id": original["client_stocktake_id"]})
        self.unchanged(before)
        saved = self.count(original).json()
        completed = self.client.post(endpoint, headers=self.headers["owner"], json=original)
        self.assertEqual(completed.json(), {"status": "completed", "result": {**saved, "duplicate": True}})
        stale = {**original, "client_stocktake_id": str(uuid.uuid4())}
        before = self.state()
        rejected = self.client.post(endpoint, headers=self.headers["owner"], json=stale)
        self.assertEqual(rejected.status_code, 200, rejected.text)
        self.assertEqual(rejected.json(), {"status": "rejected", "client_stocktake_id": stale["client_stocktake_id"],
            "code": "STOCK_CHANGED", "message": "Stock changed; reload and recount", "committed": False})
        after = self.state()
        self.assertEqual(len(after["rows"]["stocktake_rejections"]), 1)
        for table in before["rows"]:
            if table != "stocktake_rejections":
                self.assertTrue(before["rows"][table] == after["rows"][table], "Reconciliation changed business rows")
        self.assertEqual(self.count(stale).status_code, 409)
        self.assertEqual(self.client.post(endpoint, headers=self.headers["owner"], json=stale).json(), rejected.json())
        for payload in ({**stale, "reason": "changed"}, {**original, "reason": "changed"}):
            self.assertEqual(self.client.post(endpoint, headers=self.headers["owner"], json=payload).status_code, 409)
        self.assertEqual(self.client.post(endpoint, headers=self.headers["staff"], json=stale).status_code, 403)
        self.unchanged(after)
        history = self.client.get("/v1/stocktakes", headers=self.headers["owner"]).json()["stocktakes"]
        self.assertEqual(history[0]["actor_email"], "owner@cost-stock.invalid")

    def test_receive_reconcile_committed_or_cancelled_never_creates_inventory(self):
        product = self.product(100)
        payload = self.receipt_payload(product)
        endpoint = "/v1/lots/receive/reconcile"
        before = self.state()
        cancelled = self.client.post(endpoint, headers=self.headers["owner"], json=payload)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json(), {"status": "rejected", "client_receive_id": payload["client_receive_id"],
            "code": "RECEIVE_CANCELLED", "message": "Receipt cancelled before commit", "committed": False})
        after = self.state()
        for table in before["rows"]:
            if table != "receive_rejections":
                self.assertTrue(before["rows"][table] == after["rows"][table], "Receive cancellation changed business rows")
        self.assertEqual(self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=payload).status_code, 409)
        self.assertEqual(self.client.post(endpoint, headers=self.headers["manager"], json=payload).json(), cancelled.json())
        self.assertEqual(self.client.post(endpoint, headers=self.headers["owner"], json={**payload, "quantity_mg": 1}).status_code, 409)
        self.assertEqual(self.client.post(endpoint, headers=self.headers["staff"], json=payload).status_code, 403)
        no_uuid = {**payload}; no_uuid.pop("client_receive_id")
        self.assertEqual(self.client.post(endpoint, headers=self.headers["owner"], json=no_uuid).status_code, 422)
        self.unchanged(after)
        committed_payload = {**payload, "client_receive_id": str(uuid.uuid4())}
        committed = self.client.post("/v1/lots/receive", headers=self.headers["owner"], json=committed_payload)
        self.assertEqual(committed.status_code, 200)
        before = self.state()
        completed = self.client.post(endpoint, headers=self.headers["owner"], json=committed_payload)
        self.assertEqual(completed.json(), {"status": "completed", "result": {**committed.json(), "duplicate": True}})
        self.assertEqual(self.client.post(endpoint, headers=self.headers["owner"], json={**committed_payload, "reason": "changed"}).status_code, 409)
        self.unchanged(before)

    def test_receive_cancel_and_late_post_race_is_linearized(self):
        payload = self.receipt_payload(self.product(100))
        def submit(kind):
            with TestClient(self.api) as client:
                response = client.post("/v1/lots/receive" + ("/reconcile" if kind == "reconcile" else ""),
                    headers=self.headers["owner"], json=payload)
                return response.status_code, response.json()
        with ThreadPoolExecutor(max_workers=2) as pool:
            post, reconcile = list(pool.map(submit, ["post", "reconcile"]))
        self.assertEqual(reconcile[0], 200)
        with connect(self.path) as db:
            count = db.execute("SELECT count(*) FROM lots").fetchone()[0]
            if reconcile[1]["status"] == "completed":
                self.assertEqual(post[0], 200)
                self.assertEqual(count, 1)
                self.assertEqual(db.execute("SELECT count(*) FROM receive_rejections").fetchone()[0], 0)
            else:
                self.assertEqual(post[0], 409)
                self.assertEqual(count, 0)
                self.assertEqual(db.execute("SELECT count(*) FROM ledger_events").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
