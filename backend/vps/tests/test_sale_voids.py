"""Completed receipt void acceptance on disposable SQLite, never shop storage."""
import atexit
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date
import hashlib
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

_bootstrap = tempfile.TemporaryDirectory(prefix="void-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

from fastapi.testclient import TestClient
import httpx
import uvicorn
from app import connect, create_app, create_store
from migrations import _snapshot, inspect_database
from pin_auth import DeviceAuth


def uid():
    return str(uuid.uuid4())


class SaleVoidTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="void-fixture-")
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "fixture.sqlite3")
        self.api = create_app(self.path, origins=["https://localhost"])
        self.client = TestClient(self.api, raise_server_exceptions=False)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "DISPOSABLE VOID ONLY")
        self.other = create_store(self.path, "DISPOSABLE OTHER TENANT")
        self.users, self.headers, self.tokens = {}, {}, {}
        with connect(self.path) as db:
            for actor, role, store in (("owner", "owner", self.store), ("manager", "manager", self.store),
                                       ("staff", "staff", self.store), ("other", "owner", self.other)):
                user, token = uid(), secrets.token_urlsafe(48)
                db.execute("INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'fixture')",
                           (user, store, actor + "@void-fixture.invalid", "unused-synthetic-login", role))
                db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                           (hashlib.sha256(token.encode()).hexdigest(), user, int(time.time()) + 3600))
                self.users[actor], self.tokens[actor] = user, token
                self.headers[actor] = {"Authorization": "Bearer " + token}
            db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))

    def lot(self, *, quantity=10000, price=10000, cost=333, store=None):
        lot, product = uid(), uid()
        store = store or self.store
        with connect(self.path) as db:
            db.execute("INSERT INTO products(id,store_id,sku,name,category,price_satang_per_gram,created_at) VALUES(?,?,?,?,?,?,'fixture')",
                       (product, store, product, "SYNTHETIC VOID ITEM", "synthetic", price))
            db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,cost_satang_per_gram,received_at) VALUES(?,?,?,?,?,?,?,'fixture')",
                       (lot, store, product, lot, "SYNTHETIC", "", cost))
            db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,?,'fixture')", (lot, quantity))
        return lot

    def sale(self, lots, *, discount=0, method="cash", stamp="2026-10-14T03:00:00+00:00"):
        payload = {"client_sale_id": uid(), "payment_method": method, "discount_satang": discount,
                   "items": [{"lot_id": lot, "quantity_mg": 1000} for lot in lots]}
        if method == "split":
            with connect(self.path) as db:
                gross = sum(db.execute("SELECT price_satang_per_gram FROM products p JOIN lots l ON l.product_id=p.id WHERE l.id=?", (lot,)).fetchone()[0] for lot in lots)
            total = gross - discount
            payload["payments"] = [{"payment_method": "cash", "amount_satang": total // 2},
                                   {"payment_method": "transfer", "amount_satang": total - total // 2}]
        with patch("app.now_utc", return_value=stamp):
            response = self.client.post("/v1/sales", headers=self.headers["staff"], json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), payload

    def void_payload(self, **extra):
        return {"client_void_id": uid(), "reason": "Synthetic mistaken receipt", **extra}

    def void(self, sale, payload, actor="owner", client=None):
        return (client or self.client).post("/v1/sales/" + sale["sale_id"] + "/void", headers=self.headers[actor], json=payload)

    def state(self):
        with connect(self.path) as db:
            db.row_factory = None
            return _snapshot(db)

    def unchanged(self, before):
        self.assertTrue(before == self.state(), "Void failure/replay changed data, revisions, timestamps or schema")

    def report(self, start="2026-10-14", end=None):
        response = self.client.get("/v1/admin/sales-report", headers=self.headers["owner"], params={"from": start, "to": end or start})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_cash_transfer_split_zero_full_discount_preserve_original_proof_and_restock_expired_inactive_lots(self):
        for method, discount in (("cash", 0), ("transfer", 17550), ("split", 100), ("cash", 30000)):
            with self.subTest(method=method, discount=discount):
                lots = [self.lot(price=10000), self.lot(price=20000, cost=None)]
                sale, _ = self.sale(lots, method=method, discount=discount)
                with connect(self.path) as db:
                    for lot in lots:
                        db.execute("UPDATE lots SET active=0,expires_on='2000-01-01' WHERE id=?", (lot,))
                    db.execute("UPDATE stores SET sales_enabled=0,requires_authorization=1 WHERE id=?", (self.store,))
                before = self.state()
                response = self.void(sale, self.void_payload(), actor="manager")
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()
                self.assertEqual(result["status"], "voided")
                self.assertFalse(result["duplicate"])
                self.assertEqual(result["actor_user_id"], self.users["manager"])
                self.assertEqual(result["actor_role"], "manager")
                for field in ("subtotal_satang", "discount_satang", "total_satang", "payments", "payment_method"):
                    self.assertEqual(result[field], sale[field])
                self.assertEqual(len(result["restored_items"]), 2)
                self.assertTrue(all("inventory_delta_satang" not in x for x in result["restored_items"]))
                owner_result = self.client.get("/v1/sale-voids/by-client/" + result["client_void_id"],
                                               headers=self.headers["owner"]).json()
                self.assertEqual(sorted(x["inventory_delta_satang"] is None for x in owner_result["restored_items"]), [False, True])
                after = self.state()
                for table in ("sales", "sale_lines", "sale_payments", "sale_rejections", "products", "lots", "users", "stores"):
                    self.assertEqual(before["rows"][table], after["rows"][table], table)
                self.assertTrue(set(before["rows"]["ledger_events"]).issubset(after["rows"]["ledger_events"]))
                with connect(self.path) as db:
                    for lot in lots:
                        self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (lot,)).fetchone()), (10000, 2))
                    self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE sale_id=? AND event_type='ADJUST'", (sale["sale_id"],)).fetchone()[0], 2)
                    db.execute("UPDATE stores SET sales_enabled=1,requires_authorization=0 WHERE id=?", (self.store,))
                detail = self.client.get("/v1/sales/" + sale["sale_id"], headers=self.headers["staff"]).json()
                self.assertEqual(detail["status"], "voided")
                self.assertEqual(detail["void"]["id"], result["id"])
                self.assertEqual(detail["void"]["reason"], result["reason"])
        self.assertEqual(inspect_database(self.path)["status"], "READY")

    def test_same_uuid_replay_lookup_old_checkout_and_conflicts_never_restock_twice(self):
        lots = [self.lot()]
        sale, checkout = self.sale(lots, discount=100)
        payload = self.void_payload()
        first = self.void(sale, payload)
        self.assertEqual(first.status_code, 200, first.text)
        with connect(self.path) as db:
            db.execute("UPDATE products SET price_satang_per_gram=1,active=0")
            db.execute("UPDATE stores SET sales_enabled=0 WHERE id=?", (self.store,))
        before = self.state()
        replay = self.void(sale, {**payload, "reason": "  " + payload["reason"] + "  "}, actor="manager")
        self.assertEqual(replay.status_code, 200, replay.text)
        redacted = {**first.json(), "duplicate": True, "restored_items": [
            {key: value for key, value in item.items() if key != "inventory_delta_satang"}
            for item in first.json()["restored_items"]]}
        self.assertEqual(replay.json(), redacted)
        lookup = self.client.get("/v1/sale-voids/by-client/" + payload["client_void_id"], headers=self.headers["manager"])
        self.assertEqual(lookup.json(), replay.json())
        old = self.client.post("/v1/sales", headers=self.headers["staff"], json=checkout)
        self.assertEqual(old.status_code, 200, old.text)
        self.assertEqual(old.json(), {**sale, "duplicate": True})
        reconciled = self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=checkout)
        self.assertEqual(reconciled.json(), {"status": "completed", "result": old.json()})
        self.assertEqual(self.void(sale, {**payload, "reason": "Different"}).status_code, 409)
        self.assertEqual(self.void(sale, self.void_payload()).status_code, 409)
        self.assertEqual(self.void({"sale_id": uid()}, payload).status_code, 409)
        self.unchanged(before)

    def test_reason_uuid_type_auth_tenant_and_unknown_receipt_guards_are_read_only(self):
        sale, _ = self.sale([self.lot()])
        payload = self.void_payload()
        before = self.state()
        for reason in (None, True, 1, 1.0, [], {}, "", " \t\n ", "x" * 301):
            self.assertEqual(self.void(sale, {**payload, "reason": reason}).status_code, 422)
        for invalid in ({"client_void_id": uid()}, {"reason": "Synthetic"}, {**payload, "client_void_id": "bad"}, {**payload, "restock": False}):
            self.assertEqual(self.void(sale, invalid).status_code, 422)
        self.assertEqual(self.void(sale, payload, actor="staff").status_code, 403)
        self.assertEqual(self.void(sale, payload, actor="other").status_code, 404)
        self.assertEqual(self.void({"sale_id": uid()}, payload).status_code, 404)
        self.assertEqual(self.client.post("/v1/sales/" + sale["sale_id"] + "/void", json=payload).status_code, 401)
        self.assertEqual(self.client.get("/v1/sale-voids/by-client/" + uid(), headers=self.headers["owner"]).status_code, 404)
        self.assertEqual(self.client.get("/v1/sale-voids/by-client/" + uid(), headers=self.headers["staff"]).status_code, 403)
        self.unchanged(before)

    def test_stock_and_revision_limits_do_not_leave_a_void_or_partial_restore(self):
        lots = [self.lot(), self.lot()]
        sale, _ = self.sale(lots)
        for field, value in (("quantity_mg", 100_000_000), ("stock_revision", 9_000_000_000_000_000_000)):
            with connect(self.path) as db:
                db.execute("UPDATE lot_balances SET " + field + "=? WHERE lot_id=?", (value, lots[-1]))
            before = self.state()
            response = self.void(sale, self.void_payload())
            self.assertEqual(response.status_code, 409, response.text)
            self.unchanged(before)
            with connect(self.path) as db:
                db.execute("UPDATE lot_balances SET quantity_mg=9000,stock_revision=1 WHERE lot_id=?", (lots[-1],))

    def test_fault_after_first_balance_ledger_or_line_rolls_back_every_write(self):
        lots = [self.lot(), self.lot()]
        sale, _ = self.sale(lots)
        payload = self.void_payload()
        for event, table in (("UPDATE", "lot_balances"), ("INSERT", "ledger_events"), ("INSERT", "sale_void_lines")):
            with self.subTest(table=table):
                with connect(self.path) as db:
                    db.execute("CREATE TRIGGER synthetic_void_fault AFTER " + event + " ON " + table + " BEGIN SELECT RAISE(ABORT,'Synthetic void failure'); END")
                before = self.state()
                self.assertEqual(self.void(sale, payload).status_code, 500)
                self.unchanged(before)
                with connect(self.path) as db:
                    db.execute("DROP TRIGGER synthetic_void_fault")
        self.assertEqual(self.void(sale, payload).status_code, 200)

    def test_simultaneous_same_and_different_uuids_restore_once(self):
        for same_id in (True, False):
            with self.subTest(same_id=same_id):
                lot = self.lot()
                sale, _ = self.sale([lot])
                first = self.void_payload()
                second = first if same_id else self.void_payload()
                barrier = threading.Barrier(2)
                def run(payload):
                    with TestClient(self.api, raise_server_exceptions=False) as client:
                        barrier.wait(5)
                        response = self.void(sale, payload, client=client)
                        return response.status_code, response.json()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    outputs = list(pool.map(run, [first, second]))
                self.assertEqual(sorted(code for code, _ in outputs), [200, 200] if same_id else [200, 409])
                if same_id:
                    self.assertEqual(sorted(body["duplicate"] for _, body in outputs), [False, True])
                with connect(self.path) as db:
                    self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances WHERE lot_id=?", (lot,)).fetchone()), (10000, 2))
                    self.assertEqual(db.execute("SELECT count(*) FROM sale_voids WHERE sale_id=?", (sale["sale_id"],)).fetchone()[0], 1)

    def test_session_revocation_or_permission_change_while_waiting_for_writer_prevents_void(self):
        sale, _ = self.sale([self.lot()])
        original = DeviceAuth.valid_session
        for mode in ("revoked", "demoted"):
            with self.subTest(mode=mode):
                authorized = threading.Event()
                def traced(auth, db, token_hash, actor, now):
                    good = original(auth, db, token_hash, actor, now)
                    if actor["id"] == self.users["owner"]:
                        authorized.set()
                    return good
                with connect(self.path) as writer:
                    writer.execute("BEGIN IMMEDIATE")
                    with patch.object(DeviceAuth, "valid_session", traced), ThreadPoolExecutor(max_workers=1) as pool:
                        future = pool.submit(self.void, sale, self.void_payload())
                        self.assertTrue(authorized.wait(5), "Initial authorization did not reach the disposable writer lock")
                        if mode == "revoked":
                            writer.execute("UPDATE sessions SET revoked=1 WHERE user_id=?", (self.users["owner"],))
                        else:
                            writer.execute("UPDATE users SET role='staff' WHERE id=?", (self.users["owner"],))
                        writer.commit()
                        response = future.result(10)
                self.assertEqual(response.status_code, 401 if mode == "revoked" else 403, response.text)
                with connect(self.path) as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM sale_voids").fetchone()[0], 0)
                    self.assertEqual(tuple(db.execute("SELECT quantity_mg,stock_revision FROM lot_balances").fetchone()), (9000, 1))
                    db.execute("UPDATE sessions SET revoked=0 WHERE user_id=?", (self.users["owner"],))
                    db.execute("UPDATE users SET role='owner' WHERE id=?", (self.users["owner"],))

    def test_reports_restate_sale_day_and_separately_show_bangkok_void_day_and_payments(self):
        active_lot = self.lot(price=10000, cost=4000)
        self.sale([active_lot], discount=100, method="transfer")
        lots = [self.lot(price=10000, cost=4000), self.lot(price=20000, cost=8000)]
        sale, _ = self.sale(lots, discount=17550, method="split", stamp="2026-10-13T17:00:00+00:00")
        payload = self.void_payload()
        with patch("app.now_utc", return_value="2026-10-14T17:00:00+00:00"):
            # Receipt routes capture the clock when registered, so create this
            # disposable app while the explicit boundary clock is installed.
            with TestClient(create_app(self.path), raise_server_exceptions=False) as client:
                response = self.void(sale, payload, client=client)
        self.assertEqual(response.status_code, 200, response.text)
        report = self.report()
        self.assertEqual((report["summary"]["sale_count"], report["summary"]["subtotal_satang"], report["summary"]["discount_satang"], report["summary"]["total_satang"]), (1, 10000, 100, 9900))
        self.assertEqual((report["summary"]["cash_satang"], report["summary"]["transfer_satang"], report["summary"]["cost_satang"], report["summary"]["gross_profit_satang"]), (0, 9900, 4000, 5900))
        self.assertEqual((report["summary"]["voided_sale_count"], report["summary"]["voided_subtotal_satang"], report["summary"]["voided_discount_satang"], report["summary"]["voided_total_satang"]), (1, 30000, 17550, 12450))
        self.assertEqual(report["daily"][0]["voided_total_satang"], 12450)
        self.assertEqual(report["voids"]["sale_count"], 0)
        self.assertEqual(len(report["recent_sales"]), 1)
        self.assertEqual(report["top_products"][0]["total_satang"], 9900)
        self.assertEqual(report["top_categories"][0]["total_satang"], 9900)
        later = self.report("2026-10-15")
        self.assertEqual(later["summary"]["sale_count"], 0)
        self.assertEqual(later["summary"]["voided_sale_count"], 0)
        self.assertEqual((later["voids"]["sale_count"], later["voids"]["total_satang"], later["voids"]["cash_satang"], later["voids"]["transfer_satang"]), (1, 12450, 6225, 6225))
        self.assertEqual(later["recent_voids"][0]["sale_id"], sale["sale_id"])
        self.assertEqual(later["recent_voids"][0]["voided_at"], "2026-10-14T17:00:00+00:00")
        self.assertEqual(later["voids"]["cost_satang"], 12000)
        self.assertEqual(later["voids"]["gross_profit_satang"], 450)
        with connect(self.path) as db:
            totals = db.execute("SELECT sum(total_satang),sum(discount_satang),sum(subtotal_satang) FROM sales WHERE store_id=? AND NOT EXISTS(SELECT 1 FROM sale_voids v WHERE v.sale_id=sales.id)", (self.store,)).fetchone()
        self.assertEqual(tuple(totals), (report["summary"]["total_satang"], report["summary"]["discount_satang"], report["summary"]["subtotal_satang"]))
        self.assertTrue(report["capabilities"]["sale_voids"])

    def test_void_audit_and_reversal_ledger_cannot_be_changed_or_deleted(self):
        sale, _ = self.sale([self.lot()])
        self.assertEqual(self.void(sale, self.void_payload()).status_code, 200)
        before = self.state()
        with connect(self.path) as db:
            for statement in ("UPDATE sale_voids SET reason='Changed'", "DELETE FROM sale_voids",
                              "UPDATE sale_void_lines SET quantity_mg=quantity_mg+1", "DELETE FROM sale_void_lines",
                              "UPDATE ledger_events SET reason='Changed'", "DELETE FROM ledger_events"):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(statement)
        self.unchanged(before)

    def test_real_http_void_preflight_roles_receipt_lookup_and_stale_stocktake(self):
        lot = self.lot()
        sale, _ = self.sale([lot])
        payload = self.void_payload(reason="ร" * 300)
        stale = {"client_stocktake_id": uid(), "shift_label": "Synthetic prior snapshot",
                 "items": [{"lot_id": lot, "expected_revision": 1, "counted_quantity_mg": 9000}]}
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
                route = "/v1/sales/" + sale["sale_id"] + "/void"
                cors = {"Origin": "https://localhost", "Access-Control-Request-Method": "POST",
                        "Access-Control-Request-Headers": "authorization,content-type"}
                self.assertEqual(wire.options(route, headers=cors).status_code, 200)
                self.assertEqual(wire.options(route, headers={**cors, "Origin": "https://untrusted.invalid"}).status_code, 400)
                before = self.state()
                self.assertEqual(wire.post(route, headers=self.headers["staff"], json=payload).status_code, 403)
                self.assertEqual(wire.post(route, headers=self.headers["other"], json=payload).status_code, 404)
                self.unchanged(before)
                response = wire.post(route, headers={**self.headers["manager"], "Origin": "https://localhost"}, json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers["access-control-allow-origin"], "https://localhost")
                self.assertEqual(response.headers["cache-control"], "no-store")
                self.assertEqual(response.json()["reason"], payload["reason"])
                before = self.state()
                lookup = wire.get("/v1/sale-voids/by-client/" + payload["client_void_id"], headers=self.headers["manager"])
                self.assertEqual(lookup.json(), {**response.json(), "duplicate": True})
                owner_lookup = wire.get("/v1/sale-voids/by-client/" + payload["client_void_id"], headers=self.headers["owner"])
                self.assertEqual(owner_lookup.status_code, 200, owner_lookup.text)
                self.assertEqual(owner_lookup.json()["restored_items"][0]["inventory_delta_satang"], 333)
                projected_owner = {**owner_lookup.json(), "restored_items": [
                    {key: value for key, value in item.items() if key != "inventory_delta_satang"}
                    for item in owner_lookup.json()["restored_items"]]}
                self.assertEqual(projected_owner, lookup.json())
                self.assertEqual(wire.get("/v1/sales/" + sale["sale_id"], headers=self.headers["staff"]).json()["status"], "voided")
                self.assertEqual(wire.post("/v1/stocktakes", headers=self.headers["owner"], json=stale).status_code, 409)
                self.unchanged(before)
        finally:
            server.should_exit = True
            worker.join(10)
            sock.close()
            self.assertFalse(worker.is_alive(), "Disposable void HTTP listener did not stop")

    def test_report_snapshot_stays_consistent_if_another_connection_voids_during_read(self):
        sale, _ = self.sale([self.lot()])
        original_day = __import__("reports").to_bangkok_day
        completed = []
        def day_with_concurrent_void(value):
            if not completed:
                response = self.void(sale, self.void_payload())
                self.assertEqual(response.status_code, 200, response.text)
                completed.append(response.json()["id"])
            return original_day(value)
        with patch("reports.to_bangkok_day", side_effect=day_with_concurrent_void):
            report = self.report()
        self.assertEqual(report["summary"]["sale_count"], 1)
        self.assertEqual(report["summary"]["voided_sale_count"], 0)
        self.assertEqual(report["top_products"][0]["total_satang"], 10000)
        self.assertEqual(report["top_categories"][0]["total_satang"], 10000)
        self.assertEqual(len(report["recent_sales"]), 1)
        next_report = self.report()
        self.assertEqual(next_report["summary"]["sale_count"], 0)
        self.assertEqual(next_report["summary"]["voided_sale_count"], 1)
        self.assertEqual(next_report["top_products"], [])
        self.assertEqual(next_report["top_categories"], [])


if __name__ == "__main__":
    unittest.main()
