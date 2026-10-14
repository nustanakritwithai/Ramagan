"""Report endpoint security, tenant isolation and sales reconciliation."""
from __future__ import annotations

import tempfile
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from app import connect, create_app, create_store, create_user
from reports import to_bangkok_day, utc_range

BKK = ZoneInfo("Asia/Bangkok")


class AdminSalesReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "report.sqlite3")
        self.app = create_app(self.path, origins=["https://nustanakritwithai.github.io"])
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.store = create_store(self.path, "Ramagan Test")
        self.other_store = create_store(self.path, "Second Store")
        create_user(self.path, self.store, "owner@tests.invalid",
                    "Unique long password 984", "owner")
        create_user(self.path, self.store, "manager@tests.invalid",
                    "Unique long password 983", "manager")
        create_user(self.path, self.store, "staff@tests.invalid",
                    "Unique long password 982", "staff")
        create_user(self.path, self.other_store, "other@tests.invalid",
                    "Unique long password 981", "owner")
        self.owner = self.login("owner@tests.invalid", "Unique long password 984")
        self.manager = self.login("manager@tests.invalid", "Unique long password 983")
        self.staff = self.login("staff@tests.invalid", "Unique long password 982")
        self.other = self.login("other@tests.invalid", "Unique long password 981")
        self.today = datetime.now(BKK).date().isoformat()

    def login(self, email, password):
        response = self.client.post("/v1/auth/login", json={
            "email": email, "password": password
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["token"]

    def headers(self, token):
        return {"Authorization": f"Bearer {token}"}

    def create_item(self):
        r = self.client.post("/v1/products", json={
            "sku": "SKU-ONE", "name": "Test inventory", "category": "top",
            "price_satang_per_gram": 10000
        }, headers=self.headers(self.owner))
        self.assertEqual(r.status_code, 200, r.text)
        pid = r.json()["product_id"]
        r = self.client.post("/v1/lots/receive", json={
            "product_id": pid, "lot_code": "LOT-ONE",
            "supplier_name": "Demo supplier",
            "supplier_document_ref": "DEMO-REF",
            "quantity_mg": 5000, "reason": "Test receipt only"
        }, headers=self.headers(self.owner))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["lot_id"]

    def sale(self, lot_id, grams_mg, method):
        r = self.client.post("/v1/sales", headers=self.headers(self.staff), json={
            "client_sale_id": str(uuid.uuid4()),
            "items": [{"lot_id": lot_id, "quantity_mg": grams_mg}],
            "payment_method": method, "authorization_ref": "TEST-ONLY"
        })
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def report(self, token, **params):
        return self.client.get("/v1/admin/sales-report",
                               headers=self.headers(token), params=params)

    def test_empty_report_never_invents_sales(self):
        lot = self.create_item()
        r = self.report(self.owner, **{"from": self.today, "to": self.today})
        self.assertEqual(r.status_code, 200, r.text)
        report = r.json()
        self.assertEqual(report["summary"]["sale_count"], 0)
        self.assertEqual(report["summary"]["total_satang"], 0)
        self.assertEqual(len(report["recent_sales"]), 0)
        self.assertEqual(len(report["daily"]), 1)
        self.assertEqual(report["low_stock"][0]["quantity_mg"], 5000)
        self.assertFalse(report["capabilities"]["promotions"])
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT sales_enabled FROM stores WHERE id=?",
                                        (self.store,)).fetchone()[0], 0)

    def test_only_authorized_members_can_read_reports(self):
        self.assertEqual(self.client.get("/v1/admin/sales-report").status_code, 401)
        self.assertEqual(self.report(self.staff).status_code, 403)
        self.assertEqual(self.report(self.owner).status_code, 200)
        self.assertEqual(self.report(self.manager).status_code, 200)

    def test_revenue_cash_transfer_stock_and_categories(self):
        lot = self.create_item()
        with connect(self.path) as db:
            # TEST DB ONLY: staging and production sale gates are unchanged.
            db.execute("UPDATE stores SET sales_enabled=1 WHERE id=?", (self.store,))
        self.sale(lot, 1000, "cash")      # 1g => 100.00 THB
        self.sale(lot, 2000, "transfer")  # 2g => 200.00 THB
        r = self.report(self.manager, **{"from": self.today, "to": self.today,
                                          "low_stock_mg": 2100})
        self.assertEqual(r.status_code, 200, r.text)
        result = r.json()
        summary = result["summary"]
        self.assertEqual(summary["sale_count"], 2)
        self.assertEqual(summary["total_satang"], 30000)
        self.assertEqual(summary["cash_satang"], 10000)
        self.assertEqual(summary["transfer_satang"], 20000)
        self.assertEqual(summary["quantity_mg"], 3000)
        self.assertEqual(sum(x["total_satang"] for x in result["daily"]), 30000)
        self.assertEqual(result["top_products"][0]["sku"], "SKU-ONE")
        self.assertEqual(result["top_products"][0]["total_satang"], 30000)
        self.assertEqual(result["top_categories"][0]["category"], "top")
        self.assertEqual(result["low_stock"][0]["quantity_mg"], 2000)
        self.assertEqual(len(result["recent_sales"]), 2)
        self.assertEqual(self.report(self.other).json()["summary"]["sale_count"], 0)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT quantity_mg FROM lot_balances").fetchone()[0], 2000)

    def test_invalid_range_and_negative_threshold_rejected(self):
        self.assertEqual(self.report(self.owner, **{
            "from": "2026-01-01", "to": "2026-05-01"
        }).status_code, 422)
        self.assertEqual(self.report(self.owner, **{
            "from": "2026-05-02", "to": "2026-05-01"
        }).status_code, 422)
        self.assertEqual(self.report(self.owner, low_stock_mg=-2).status_code, 422)

    def test_bangkok_rollover_and_inclusive_date(self):
        self.assertEqual(to_bangkok_day("2026-10-13T18:00:00+00:00"), "2026-10-14")
        start, finish = utc_range(datetime(2026, 10, 14).date(),
                                   datetime(2026, 10, 14).date())
        self.assertEqual(start, "2026-10-13T17:00:00+00:00")
        self.assertEqual(finish, "2026-10-14T17:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
