"""Acceptance through a real loopback Uvicorn listener and disposable SQLite.

This never launches or restarts the installed VPS service. CI runs the same
wire contract on Windows and Linux; no credentials or tokens enter evidence.
"""
from __future__ import annotations

import atexit
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
from cost_stock import capabilities as cost_capabilities
from receipts import capabilities as receipt_capabilities
from pin_auth import capabilities as pin_capabilities

_bootstrap = tempfile.TemporaryDirectory(prefix="discount-http-import-")
atexit.register(_bootstrap.cleanup)
os.environ["RAMAGAN_DB_PATH"] = str(Path(_bootstrap.name) / "import.sqlite3")

import httpx
import uvicorn
from app import connect, create_app, create_store, create_user
from migrations import CURRENT_SCHEMA_VERSION


class DiscountHttpAcceptanceTests(unittest.TestCase):
    @patch("app.now_utc", return_value="2026-10-14T03:00:00+00:00")
    def test_real_runtime_contract_origins_roles_and_sql_reconciliation(self, _clock):
        with tempfile.TemporaryDirectory(prefix="discount-http-fixture-") as folder:
            db_path = str(Path(folder) / "fixture.sqlite3")
            origins = ["https://localhost", "https://nustanakritwithai.github.io"]
            api = create_app(db_path, origins=origins)
            store = create_store(db_path, "Disposable HTTP fixture")
            other_store = create_store(db_path, "Isolated HTTP fixture")
            accounts = {}
            for role in ("owner", "manager", "staff", "other"):
                email = role + "@wire-fixture.invalid"
                password = secrets.token_urlsafe(32)
                create_user(db_path, other_store if role == "other" else store,
                            email, password, "owner" if role == "other" else role)
                accounts[role] = (email, password)

            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(
                api, host="127.0.0.1", port=port,
                log_level="critical", access_log=False, lifespan="off"))
            worker = threading.Thread(target=server.run,
                                      kwargs={"sockets": [sock]}, daemon=True)
            worker.start()
            evidence = {"schema_version": CURRENT_SCHEMA_VERSION,
                        "runtime": "Uvicorn over loopback TCP; disposable SQLite"}
            try:
                deadline = time.monotonic() + 10
                while not server.started and worker.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(server.started, "Fixture HTTP server failed to start")
                with httpx.Client(base_url=f"http://127.0.0.1:{port}",
                                  trust_env=False, timeout=10) as client:
                    self.assertEqual(client.get("/health").json()["status"], "ok")
                    headers = {}
                    for role, (email, password) in accounts.items():
                        login = client.post("/v1/auth/login", json={
                            "email": email, "password": password})
                        self.assertEqual(login.status_code, 200)
                        headers[role] = {"Authorization": "Bearer " + login.json()["token"]}
                    origin_checks = []
                    for origin in origins:
                        health = client.get("/health", headers={"Origin": origin})
                        self.assertEqual(health.status_code, 200)
                        self.assertEqual(health.headers.get_list("access-control-allow-origin"),
                                         [origin])
                        for route, method in (("/v1/auth/login", "POST"),
                                              ("/v1/admin/sales-report", "GET")):
                            preflight = client.options(route, headers={
                                "Origin": origin, "Access-Control-Request-Method": method,
                                "Access-Control-Request-Headers": "authorization,content-type"})
                            self.assertEqual(preflight.status_code, 200)
                            self.assertEqual(preflight.headers.get_list(
                                "access-control-allow-origin"), [origin])
                            self.assertIn("origin", preflight.headers.get("vary", "").lower())
                            origin_checks.append({"origin": origin, "route": route,
                                                  "status": preflight.status_code})
                    rejected = client.options("/v1/auth/login", headers={
                        "Origin": "https://untrusted.invalid",
                        "Access-Control-Request-Method": "POST"})
                    self.assertEqual(rejected.status_code, 400)
                    self.assertNotIn("access-control-allow-origin", rejected.headers)
                    me = client.get("/v1/me", headers=headers["staff"])
                    self.assertEqual(me.status_code, 200)
                    self.assertEqual(me.json()["capabilities"],
                                     {"discounts": True, "discount_contract_version": 1,
                                      "optional_document_references": True, "document_contract_version": 1, **cost_capabilities("staff"), **receipt_capabilities(), **pin_capabilities()})
                    self.assertFalse(me.json()["store"]["sales_enabled"])

                    lots = []
                    for index, price in enumerate((10000, 20000)):
                        product = client.post("/v1/products", headers=headers["owner"], json={
                            "sku": f"WIRE-{index}", "name": "Synthetic item",
                            "category": "fixture", "price_satang_per_gram": price})
                        self.assertEqual(product.status_code, 200)
                        receipt = client.post("/v1/lots/receive",
                                              headers=headers["owner"], json={
                            "product_id": product.json()["product_id"],
                            "lot_code": f"WIRE-LOT-{index}", "supplier_name": "Synthetic",
                            "supplier_document_ref": "FIXTURE-ONLY",
                            "quantity_mg": 10000, "reason": "Disposable acceptance fixture"})
                        self.assertEqual(receipt.status_code, 200)
                        lots.append(receipt.json()["lot_id"])
                    request = {
                        "client_sale_id": str(uuid.uuid4()),
                        "items": [{"lot_id": lot, "quantity_mg": 1000} for lot in lots],
                        "payment_method": "cash", "authorization_ref": "FIXTURE-ONLY",
                        "discount_satang": 100,
                    }
                    gated = client.post("/v1/sales", headers=headers["staff"], json=request)
                    self.assertEqual(gated.status_code, 403)
                    with connect(db_path) as db:
                        self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
                        # Only this disposable fixture store is activated.
                        db.execute("UPDATE stores SET sales_enabled=1 WHERE id=?", (store,))
                    cash = client.post("/v1/sales", headers=headers["staff"], json=request)
                    self.assertEqual(cash.status_code, 200)
                    self.assertEqual((cash.json()["subtotal_satang"],
                                      cash.json()["discount_satang"],
                                      cash.json()["total_satang"]), (30000, 100, 29900))
                    transfer_request = {**request, "client_sale_id": str(uuid.uuid4()),
                                        "payment_method": "transfer", "discount_satang": 17550}
                    transfer = client.post("/v1/sales", headers=headers["staff"],
                                           json=transfer_request)
                    self.assertEqual(transfer.status_code, 200)
                    self.assertEqual(transfer.json()["total_satang"], 12450)
                    duplicate = client.post("/v1/sales", headers=headers["staff"],
                                            json=transfer_request)
                    self.assertEqual(duplicate.status_code, 200)
                    self.assertEqual(duplicate.json(), {**transfer.json(), "duplicate": True})
                    lookup = client.get("/v1/sales/by-client/" + transfer_request["client_sale_id"],
                                        headers=headers["staff"])
                    self.assertEqual(lookup.status_code, 200)
                    self.assertEqual(lookup.json(), {
                        "id": transfer.json()["sale_id"],
                        "client_sale_id": transfer_request["client_sale_id"],
                        "subtotal_satang": 30000, "discount_satang": 17550,
                        "total_satang": 12450, "payment_method": "transfer",
                        "payments": [{"payment_method": "transfer", "amount_satang": 12450}]})
                    self.assertEqual(client.post("/v1/sales", headers=headers["staff"],
                        json={**transfer_request, "discount_satang": 100}).status_code, 409)
                    self.assertEqual(client.post("/v1/sales", headers=headers["staff"],
                        json={**request, "client_sale_id": str(uuid.uuid4()),
                              "discount_satang": True}).status_code, 422)
                    day = "2026-10-14"  # Fixed fixture clock; no midnight race.
                    report_url = "/v1/admin/sales-report"
                    roles = {}
                    reports = {}
                    for role in headers:
                        response = client.get(report_url, headers={
                            **headers[role], "Origin": origins[1]},
                            params={"from": day, "to": day})
                        roles[role] = response.status_code
                        self.assertEqual(response.headers.get_list(
                            "access-control-allow-origin"), [origins[1]])
                        if response.status_code == 200:
                            reports[role] = response.json()
                    self.assertEqual(roles, {"owner": 200, "manager": 403,
                                             "staff": 403, "other": 200})
                    self.assertEqual(client.get(report_url).status_code, 401)
                    self.assertEqual(reports["other"]["summary"]["sale_count"], 0)
                    summary = reports["owner"]["summary"]
                    self.assertNotIn("manager", reports)
                    self.assertEqual((summary["subtotal_satang"], summary["discount_satang"],
                                      summary["total_satang"], summary["cash_satang"],
                                      summary["transfer_satang"]), (60000, 17650, 42350, 29900, 12450))
                    caps = reports["owner"]["capabilities"]
                    self.assertEqual(caps, {"discounts": True, "discount_contract_version": 1,
                                            "sale_voids": True, "sale_void_contract_version": 1,
                                            "promotions": False, "shift_reconciliation": False, **cost_capabilities()})
                    with connect(db_path) as db:
                        self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], CURRENT_SCHEMA_VERSION)
                        sql = tuple(db.execute(
                            "SELECT sum(subtotal_satang),sum(discount_satang),sum(total_satang) "
                            "FROM sales WHERE store_id=?", (store,)).fetchone())
                        self.assertEqual(sql, (60000, 17650, 42350))
                        line_sql = tuple(db.execute(
                            "SELECT sum(line_subtotal_satang),sum(line_discount_satang),"
                            "sum(line_total_satang) FROM sale_lines").fetchone())
                        self.assertEqual(line_sql, sql)
                        self.assertEqual(sorted(row[0] for row in db.execute(
                            "SELECT quantity_mg FROM lot_balances")), [8000, 8000])
                        self.assertEqual(db.execute(
                            "SELECT sales_enabled FROM stores WHERE id=?",
                            (other_store,)).fetchone()[0], 0)
                        self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
                    evidence.update({
                        "result": "PASS", "me_capabilities": me.json()["capabilities"],
                        "request": transfer_request, "sale": transfer.json(),
                        "duplicate": duplicate.json(), "lookup": lookup.json(),
                        "summary": summary, "report_capabilities": caps,
                        "role_http_status": roles, "preflight": origin_checks,
                        "untrusted_preflight": 400, "sql_gross_discount_net": list(sql),
                        "installed_vps_service_touched": False,
                    })
            finally:
                server.should_exit = True
                worker.join(timeout=10)
                if worker.is_alive():
                    server.force_exit = True
                    worker.join(timeout=5)
                sock.close()
                self.assertFalse(worker.is_alive(), "Fixture server failed to stop")
            evidence_path = os.environ.get("RAMAGAN_DISCOUNT_HTTP_EVIDENCE")
            if evidence_path:
                target = Path(evidence_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
