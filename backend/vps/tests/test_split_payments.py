"""Split tender, exact retries and explicit cancellation on synthetic fixtures."""
from datetime import datetime
import unittest
import uuid
from zoneinfo import ZoneInfo
import test_discount_api as fixture
from app import connect
from discounts import MAX_SALE_SATANG


class SplitPaymentTests(unittest.TestCase):
    setUp = fixture.DiscountApiTests.setUp
    order = fixture.DiscountApiTests.order
    checkout = fixture.DiscountApiTests.checkout
    state = fixture.DiscountApiTests.state
    assert_unchanged = fixture.DiscountApiTests.assert_unchanged
    enable_fixture_sales = fixture.DiscountApiTests.enable_fixture_sales

    def split(self, cash=10000, transfer=19900, **extra):
        return {**self.order(100), "payment_method": "split", "payments": [
            {"payment_method": "cash", "amount_satang": cash},
            {"payment_method": "transfer", "amount_satang": transfer}], **extra}

    def test_split_single_bill_ledger_report_and_canonical_retry(self):
        self.enable_fixture_sales()
        payload = self.split()
        first = self.checkout(payload)
        self.assertEqual(first.status_code, 200, first.text)
        saved = first.json()
        self.assertEqual(saved["payment_method"], "split")
        self.assertEqual(saved["payments"], payload["payments"])
        self.assertEqual(saved["total_satang"], 29900)
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT payment_method FROM sales").fetchone()[0], "split")
            self.assertEqual(db.execute("SELECT count(*) FROM ledger_events WHERE event_type='SALE'").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT sum(amount_satang) FROM sale_payments").fetchone()[0], 29900)
            db.execute("UPDATE products SET price_satang_per_gram=1")
            db.execute("UPDATE stores SET sales_enabled=0 WHERE id=?", (self.store,))
        before = self.state()
        retry = self.checkout({**payload, "payments": list(reversed(payload["payments"]))})
        self.assertEqual(retry.json(), {**saved, "duplicate": True})
        self.assertEqual(self.checkout(self.split(10001, 19899, client_sale_id=payload["client_sale_id"])).status_code, 409)
        lookup = self.client.get("/v1/sales/by-client/" + payload["client_sale_id"], headers=self.headers["owner"])
        self.assertEqual(lookup.json()["payments"], saved["payments"])
        self.assertEqual(lookup.json()["id"], saved["sale_id"])
        self.assert_unchanged(before)
        day = datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()
        report = self.client.get("/v1/admin/sales-report", headers=self.headers["owner"], params={"from": day, "to": day}).json()
        self.assertEqual((report["summary"]["sale_count"], report["summary"]["total_satang"],
                          report["summary"]["cash_satang"], report["summary"]["transfer_satang"]), (1, 29900, 10000, 19900))
        self.assertEqual(report["recent_sales"][0]["payments"], saved["payments"])

    def test_split_types_methods_and_totals_reject_without_any_mutation(self):
        self.enable_fixture_sales()
        bad = [None, [], [{"payment_method": "cash", "amount_satang": 29900}],
               [{"payment_method": "cash", "amount_satang": 100}, {"payment_method": "cash", "amount_satang": 29800}],
               [{"payment_method": "card", "amount_satang": 100}, {"payment_method": "transfer", "amount_satang": 29800}]]
        for amount in (True, False, "100", 100.0, None, -1, 0, MAX_SALE_SATANG + 1, 2**100):
            bad.append([{"payment_method": "cash", "amount_satang": amount}, {"payment_method": "transfer", "amount_satang": 19800}])
        bad.append([{"payment_method": "cash", "amount_satang": 10000}, {"payment_method": "transfer", "amount_satang": 19899}])
        for payments in bad:
            before = self.state()
            self.assertEqual(self.checkout(self.split(payments=payments)).status_code, 422)
            self.assert_unchanged(before)
        before = self.state()
        self.assertEqual(self.checkout(self.split(payment_method="cash")).status_code, 422)
        self.assertEqual(self.checkout(self.split(discount_satang=30000)).status_code, 422)
        self.assert_unchanged(before)

    def test_failure_after_payment_allocation_rolls_back_whole_checkout(self):
        self.enable_fixture_sales()
        with connect(self.path) as db:
            db.execute("CREATE TRIGGER fixture_fail AFTER INSERT ON sale_payments BEGIN SELECT RAISE(FAIL,'synthetic payment failure'); END")
        before = self.state()
        self.assertEqual(self.checkout(self.split()).status_code, 500)
        self.assert_unchanged(before)

    def test_explicit_sale_cancellation_is_authoritative_and_actor_scoped(self):
        self.enable_fixture_sales()
        payload = self.split()
        before = self.state()
        cancelled = self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=payload)
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json(), {"status": "rejected", "client_sale_id": payload["client_sale_id"],
            "code": "SALE_CANCELLED", "message": "Sale cancelled before commit", "committed": False})
        with connect(self.path) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM sales").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_payments").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_rejections").fetchone()[0], 1)
        after = self.state()
        self.assertEqual(self.checkout(payload).status_code, 409)
        self.assertEqual(self.client.post("/v1/sales/reconcile", headers=self.headers["owner"], json=payload).status_code, 403)
        self.assertEqual(self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json={**payload, "authorization_ref": "CHANGED"}).status_code, 409)
        self.assert_unchanged(after)
        fresh = {**payload, "client_sale_id": str(uuid.uuid4())}
        committed = self.checkout(fresh)
        self.assertEqual(committed.status_code, 200)
        completed = self.client.post("/v1/sales/reconcile", headers=self.headers["staff"], json=fresh)
        self.assertEqual(completed.json(), {"status": "completed", "result": {**committed.json(), "duplicate": True}})


if __name__ == "__main__":
    unittest.main()
