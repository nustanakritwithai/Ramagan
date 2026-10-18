"""Gross/discount/net reconciliation on disposable report fixtures.

This module imports no runtime app and sends no HTTP requests. Only the
concurrent-snapshot test uses a temporary file-backed database; endpoint role
coverage remains in test_sales_report.py and test_discount_http.py.
"""
from __future__ import annotations

import sqlite3
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path

from reports import build_sales_report


SCHEMA = """
CREATE TABLE stores(id TEXT PRIMARY KEY);
CREATE TABLE products(
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
    sku TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
    price_satang_per_gram INTEGER NOT NULL DEFAULT 10000,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE lots(
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
    product_id TEXT NOT NULL REFERENCES products(id), lot_code TEXT NOT NULL,
    expires_on TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE lot_balances(
    lot_id TEXT PRIMARY KEY REFERENCES lots(id), quantity_mg INTEGER NOT NULL
);
CREATE TABLE sales(
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
    created_at TEXT NOT NULL, payment_method TEXT NOT NULL,
    subtotal_satang INTEGER NOT NULL, discount_satang INTEGER NOT NULL DEFAULT 0,
    total_satang INTEGER NOT NULL,
    CHECK(subtotal_satang >= 0 AND discount_satang >= 0 AND total_satang >= 0),
    CHECK(subtotal_satang = discount_satang + total_satang)
);
CREATE TABLE sale_lines(
    id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id),
    lot_id TEXT NOT NULL REFERENCES lots(id), quantity_mg INTEGER NOT NULL,
    line_subtotal_satang INTEGER NOT NULL,
    line_discount_satang INTEGER NOT NULL DEFAULT 0,
    line_total_satang INTEGER NOT NULL,
    line_cost_satang INTEGER,
    CHECK(quantity_mg > 0),
    CHECK(line_subtotal_satang >= 0 AND line_discount_satang >= 0 AND line_total_satang >= 0),
    CHECK(line_subtotal_satang = line_discount_satang + line_total_satang)
);
"""


class DiscountReportTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", isolation_level=None)
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        self.db.executemany("INSERT INTO stores(id) VALUES(?)", [("store-a",), ("store-b",)])
        self.sale_number = 0
        self.trace = []

    def item(self, product, category, lots, *, store="store-a", balance=20000):
        self.db.execute(
            "INSERT INTO products(id,store_id,sku,name,category) VALUES(?,?,?,?,?)",
            (product, store, product, product, category),
        )
        for lot in lots:
            self.db.execute(
                "INSERT INTO lots(id,store_id,product_id,lot_code) VALUES(?,?,?,?)",
                (lot, store, product, lot),
            )
            self.db.execute("INSERT INTO lot_balances VALUES(?,?)", (lot, balance))

    def sale(self, created_at, lines, *, method="cash", store="store-a"):
        """Persist known receipt allocations, independently of the API allocator."""
        self.sale_number += 1
        sale = f"sale-{self.sale_number}"
        gross = sum(line[2] for line in lines)
        discount = sum(line[3] for line in lines)
        self.db.execute(
            "INSERT INTO sales(id,store_id,created_at,payment_method,subtotal_satang,"
            "discount_satang,total_satang) VALUES(?,?,?,?,?,?,?)",
            (sale, store, created_at, method, gross, discount, gross - discount),
        )
        for number, (lot, quantity, subtotal, allocated_discount) in enumerate(lines):
            self.db.execute(
                "INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,line_subtotal_satang,"
                "line_discount_satang,line_total_satang) VALUES(?,?,?,?,?,?,?)",
                (f"{sale}-line-{number}", sale, lot, quantity, subtotal,
                 allocated_discount, subtotal - allocated_discount),
            )
        return sale

    def snapshot(self):
        tables = self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        return {table[0]: sorted(tuple(row) for row in self.db.execute(
            'SELECT * FROM "' + table[0] + '"')) for table in tables}

    def report(self, start="2026-10-14", end="2026-10-15", *, store="store-a", low=10000):
        before = self.snapshot()
        self.trace = []
        self.db.execute("PRAGMA query_only=ON")
        self.db.set_trace_callback(self.trace.append)
        try:
            value = build_sales_report(self.db, store, date.fromisoformat(start),
                                       date.fromisoformat(end), low)
        finally:
            self.db.set_trace_callback(None)
            self.db.execute("PRAGMA query_only=OFF")
        self.assertFalse(self.db.in_transaction)
        self.assertEqual(self.snapshot(), before)
        self.assertTrue(self.trace[0].strip().upper().startswith("BEGIN"))
        self.assertEqual(self.trace[-1].strip().upper(), "ROLLBACK")
        self.assertEqual(sum(sql.lstrip().upper().startswith("BEGIN") for sql in self.trace), 1)
        self.assertEqual(sum(sql.strip().upper() == "ROLLBACK" for sql in self.trace), 1)
        self.assertTrue(all(sql.lstrip().upper().startswith(("BEGIN", "SELECT", "ROLLBACK"))
                            for sql in self.trace))
        return value

    def money_rows(self, rows):
        for row in rows:
            self.assertEqual(row["subtotal_satang"],
                             row["discount_satang"] + row["total_satang"])
            for field in ("subtotal_satang", "discount_satang", "total_satang"):
                self.assertIs(type(row[field]), int)

    def test_17550_multiple_lots_categories_days_reconcile_to_manual_sql(self):
        self.item("flower", "flowers", ["lot-a", "lot-b"])
        self.item("oil", "oils", ["lot-c"])
        first = self.sale("2026-10-13T17:00:00+00:00", [
            ("lot-a", 700, 7000, 219),
            ("lot-b", 500, 5000, 157),
            ("lot-c", 500, 5550, 174),
        ])
        second = self.sale("2026-10-14T17:00:00+00:00",
                           [("lot-a", 250, 2500, 500)], method="transfer")
        # Reports must use receipt amounts despite a changed current catalog price.
        self.db.execute("UPDATE products SET price_satang_per_gram=99999")
        report = self.report()
        manual = self.db.execute("""
            SELECT COUNT(*) AS sale_count, SUM(subtotal_satang) AS subtotal_satang,
                   SUM(discount_satang) AS discount_satang, SUM(total_satang) AS total_satang,
                   SUM(CASE WHEN payment_method='cash' THEN total_satang ELSE 0 END) AS cash_satang,
                   SUM(CASE WHEN payment_method='transfer' THEN total_satang ELSE 0 END) AS transfer_satang
              FROM sales WHERE store_id='store-a'
        """).fetchone()
        for field in manual.keys():
            self.assertEqual(report["summary"][field], manual[field])
        manual_lines = self.db.execute("""
            SELECT SUM(line_subtotal_satang), SUM(line_discount_satang),
                   SUM(line_total_satang), SUM(quantity_mg) FROM sale_lines
        """).fetchone()
        self.assertEqual(tuple(manual_lines), (20050, 1050, 19000, 1950))
        self.assertEqual(report["summary"]["quantity_mg"], manual_lines[3])
        self.assertEqual(report["summary"]["average_satang"], 9500)
        self.assertEqual((report["summary"]["cash_satang"],
                          report["summary"]["transfer_satang"]), (17000, 2000))
        self.assertEqual(report["daily"], [
            {"date": "2026-10-14", "sale_count": 1, "quantity_mg": 1700,
             "subtotal_satang": 17550, "discount_satang": 550, "total_satang": 17000,
             "known_cost_satang": 0, "cost_satang": None, "gross_profit_satang": None,
             "unknown_cost_line_count": 3, "cost_complete": False},
            {"date": "2026-10-15", "sale_count": 1, "quantity_mg": 250,
             "subtotal_satang": 2500, "discount_satang": 500, "total_satang": 2000,
             "known_cost_satang": 0, "cost_satang": None, "gross_profit_satang": None,
             "unknown_cost_line_count": 1, "cost_complete": False},
        ])
        products = {row["sku"]: row for row in report["top_products"]}
        self.assertEqual((products["flower"]["subtotal_satang"],
                          products["flower"]["discount_satang"],
                          products["flower"]["total_satang"]), (14500, 876, 13624))
        self.assertEqual((products["oil"]["subtotal_satang"],
                          products["oil"]["discount_satang"],
                          products["oil"]["total_satang"]), (5550, 174, 5376))
        categories = {row["category"]: row for row in report["top_categories"]}
        for category, product in (("flowers", "flower"), ("oils", "oil")):
            for field in ("subtotal_satang", "discount_satang", "total_satang", "quantity_mg"):
                self.assertEqual(categories[category][field], products[product][field])
        self.assertEqual([row["id"] for row in report["recent_sales"]], [second, first])
        self.assertEqual(report["recent_sales"][1]["subtotal_satang"], 17550)
        self.assertEqual(report["recent_sales"][1]["discount_satang"], 550)
        self.assertEqual(report["recent_sales"][1]["total_satang"], 17000)
        for rows in ([report["summary"]], report["daily"], report["recent_sales"],
                     report["top_products"], report["top_categories"]):
            self.money_rows(rows)

    def test_zero_full_and_zero_price_discounts_keep_quantity_and_bill_count(self):
        self.item("priced", "flowers", ["priced-lot"])
        self.item("free", "gifts", ["free-lot"])
        self.db.execute("UPDATE products SET price_satang_per_gram=0 WHERE id='free'")
        self.sale("2026-10-14T01:00:00+00:00", [("priced-lot", 1000, 2000, 0)])
        self.sale("2026-10-14T02:00:00+00:00", [("priced-lot", 500, 500, 500)],
                  method="transfer")
        self.sale("2026-10-14T03:00:00+00:00", [("free-lot", 250, 0, 0)])
        report = self.report()
        self.assertEqual(report["summary"], {
            "sale_count": 3, "subtotal_satang": 2500, "discount_satang": 500,
            "total_satang": 2000, "cash_satang": 2000, "transfer_satang": 0,
            "quantity_mg": 1750, "average_satang": 666,
            "known_cost_satang": 0, "cost_satang": None, "gross_profit_satang": None,
            "unknown_cost_line_count": 3, "cost_complete": False,
        })
        free = next(row for row in report["top_products"] if row["sku"] == "free")
        self.assertEqual((free["subtotal_satang"], free["discount_satang"],
                          free["total_satang"], free["quantity_mg"]), (0, 0, 0, 250))
        self.assertEqual(report["recent_sales"][1]["total_satang"], 0)
        self.assertEqual(report["recent_sales"][1]["discount_satang"], 500)
        self.money_rows(report["recent_sales"])

    def test_17550_discount_matches_manual_sql_across_lots_categories_and_days(self):
        self.item("flower", "flowers", ["lot-a", "lot-b"])
        self.item("oil", "oils", ["lot-c"])
        discounted = self.sale("2026-10-14T01:00:00+00:00", [
            ("lot-a", 3000, 30000, 8775),
            ("lot-b", 2000, 20000, 5850),
            ("lot-c", 1000, 10000, 2925),
        ])
        self.sale("2026-10-14T17:00:00+00:00",
                  [("lot-a", 1000, 10000, 0)], method="transfer")
        report = self.report()
        manual_bill = self.db.execute(
            "SELECT SUM(subtotal_satang),SUM(discount_satang),SUM(total_satang) "
            "FROM sales WHERE store_id='store-a'"
        ).fetchone()
        manual_lines = self.db.execute(
            "SELECT SUM(line_subtotal_satang),SUM(line_discount_satang),"
            "SUM(line_total_satang) FROM sale_lines"
        ).fetchone()
        self.assertEqual(tuple(manual_bill), (70000, 17550, 52450))
        self.assertEqual(tuple(manual_lines), tuple(manual_bill))
        self.assertEqual(tuple(report["summary"][field] for field in
                               ("subtotal_satang", "discount_satang", "total_satang")),
                         tuple(manual_bill))
        self.assertEqual((report["summary"]["cash_satang"],
                          report["summary"]["transfer_satang"],
                          report["summary"]["quantity_mg"]), (42450, 10000, 7000))
        receipt = next(row for row in report["recent_sales"] if row["id"] == discounted)
        self.assertEqual((receipt["subtotal_satang"], receipt["discount_satang"],
                          receipt["total_satang"]), (60000, 17550, 42450))
        self.assertEqual([row["discount_satang"] for row in report["daily"]], [17550, 0])
        categories = {row["category"]: row for row in report["top_categories"]}
        self.assertEqual((categories["flowers"]["subtotal_satang"],
                          categories["flowers"]["discount_satang"],
                          categories["flowers"]["total_satang"]), (60000, 14625, 45375))
        self.assertEqual((categories["oils"]["subtotal_satang"],
                          categories["oils"]["discount_satang"],
                          categories["oils"]["total_satang"]), (10000, 2925, 7075))
        for rows in (report["daily"], report["recent_sales"], report["top_products"],
                     report["top_categories"]):
            self.money_rows(rows)

    def test_exact_bangkok_utc_day_boundaries(self):
        self.item("boundary", "flowers", ["boundary-lot"])
        before = self.sale("2026-10-13T16:59:59+00:00", [("boundary-lot", 1, 100, 1)])
        first = self.sale("2026-10-13T17:00:00+00:00", [("boundary-lot", 1, 101, 2)])
        last = self.sale("2026-10-14T16:59:59+00:00", [("boundary-lot", 1, 102, 3)])
        after = self.sale("2026-10-14T17:00:00+00:00", [("boundary-lot", 1, 103, 4)])
        report = self.report("2026-10-14", "2026-10-14")
        self.assertEqual(report["period"], {
            "from": "2026-10-14", "to": "2026-10-14", "timezone": "Asia/Bangkok",
        })
        self.assertEqual(report["summary"]["sale_count"], 2)
        self.assertEqual((report["summary"]["subtotal_satang"],
                          report["summary"]["discount_satang"],
                          report["summary"]["total_satang"]), (203, 5, 198))
        included = {row["id"] for row in report["recent_sales"]}
        self.assertEqual(included, {first, last})
        self.assertTrue(included.isdisjoint({before, after}))

    def test_tenant_and_period_isolation_preserve_current_low_stock(self):
        self.item("mine", "flowers", ["mine-lot"], balance=700)
        self.item("theirs", "private-other-category", ["other-lot"],
                  store="store-b", balance=3)
        mine = self.sale("2026-10-14T01:00:00+00:00", [("mine-lot", 10, 100, 25)])
        self.sale("2026-10-14T01:00:00+00:00", [("other-lot", 20, 80000, 70000)],
                  store="store-b")
        self.sale("2026-02-01T01:00:00+00:00", [("mine-lot", 30, 40000, 5000)])
        report = self.report(low=1000)
        self.assertEqual(report["summary"]["total_satang"], 75)
        self.assertEqual(report["summary"]["discount_satang"], 25)
        self.assertEqual([row["id"] for row in report["recent_sales"]], [mine])
        self.assertEqual([row["sku"] for row in report["top_products"]], ["mine"])
        self.assertEqual([row["category"] for row in report["top_categories"]], ["flowers"])
        self.assertEqual([(row["sku"], row["quantity_mg"])
                          for row in report["low_stock"]], [("mine", 700)])
        distant = self.report("2020-01-01", "2020-01-02", low=1000)
        self.assertEqual(distant["summary"]["sale_count"], 0)
        self.assertEqual(distant["low_stock"], report["low_stock"])
        other = self.report(store="store-b", low=1000)
        self.assertEqual(other["summary"]["total_satang"], 10000)
        self.assertEqual([row["sku"] for row in other["low_stock"]], ["theirs"])

    def test_no_sales_zero_fills_discount_fields_without_hiding_current_stock(self):
        self.item("unsold", "flowers", ["unsold-lot"], balance=5000)
        report = self.report()
        self.assertTrue(all(value == 0 for key, value in report["summary"].items() if key != "cost_complete"))
        self.assertTrue(report["summary"]["cost_complete"])
        self.assertEqual(len(report["daily"]), 2)
        for day in report["daily"]:
            self.assertEqual((day["subtotal_satang"], day["discount_satang"],
                              day["total_satang"], day["sale_count"], day["quantity_mg"]),
                             (0, 0, 0, 0, 0))
        for key in ("top_products", "top_categories", "recent_sales"):
            self.assertEqual(report[key], [])
        self.assertEqual(report["low_stock"][0]["quantity_mg"], 5000)
        self.assertEqual(report["capabilities"], {
            "discounts": True, "discount_contract_version": 1,
            "promotions": False, "shift_reconciliation": False,
            "inventory_costs": True, "cost_contract_version": 1,
            "stocktakes": True, "stocktake_contract_version": 2,
            "stocktake_evidence": True, "evidence_contract_version": 1,
            "split_payments": True, "payment_contract_version": 1,
            "sale_reconciliation": True, "sale_reconciliation_contract_version": 1,
        })

    def test_rankings_remain_ordered_by_recorded_net_not_gross(self):
        self.item("high-gross", "high-gross-category", ["high-gross-lot"])
        self.item("high-net", "high-net-category", ["high-net-lot"])
        self.sale("2026-10-14T01:00:00+00:00", [("high-gross-lot", 1000, 10000, 9000)])
        self.sale("2026-10-14T02:00:00+00:00", [("high-net-lot", 1000, 5000, 0)])
        report = self.report()
        self.assertEqual([row["sku"] for row in report["top_products"]],
                         ["high-net", "high-gross"])
        self.assertEqual([row["category"] for row in report["top_categories"]],
                         ["high-net-category", "high-gross-category"])
        self.money_rows(report["top_products"])

    def test_large_integer_receipts_have_no_float_rounding(self):
        self.item("large", "flowers", ["large-lot"])
        self.sale("2026-10-14T01:00:00+00:00",
                  [("large-lot", 5001, 5_001_000_000, 1_234_567_891)])
        report = self.report()
        self.assertEqual((report["summary"]["subtotal_satang"],
                          report["summary"]["discount_satang"],
                          report["summary"]["total_satang"]),
                         (5_001_000_000, 1_234_567_891, 3_766_432_109))
        self.money_rows([report["summary"], *report["daily"],
                         *report["recent_sales"], *report["top_products"],
                         *report["top_categories"]])

    def test_all_sections_share_snapshot_while_separate_wal_writer_commits(self):
        # Hold the reader after its bill scan, then really commit another sale
        # before rankings execute. WAL lets the writer commit during that read.
        original_db = self.db
        with tempfile.TemporaryDirectory(
            prefix="discount-report-wal-", dir=Path(__file__).resolve().parents[1]
        ) as directory:
            path = Path(directory) / "fixture.sqlite3"
            reader = sqlite3.connect(path, isolation_level=None)
            reader.row_factory = sqlite3.Row
            started = threading.Event()
            committed = threading.Event()
            errors = []
            timed_out = []
            trace = []
            injected = []
            writer_thread = None
            try:
                self.db = reader
                reader.execute("PRAGMA foreign_keys=ON")
                self.assertEqual(reader.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
                reader.executescript(SCHEMA)
                reader.executemany("INSERT INTO stores(id) VALUES(?)",
                                   [("store-a",), ("store-b",)])
                self.item("first-product", "flowers", ["first-lot"])
                self.item("second-product", "oils", ["second-lot"])
                first_sale = self.sale("2026-10-14T01:00:00+00:00",
                                       [("first-lot", 100, 1000, 100)])

                def write_second_sale():
                    writer = None
                    try:
                        if not started.wait(10):
                            raise TimeoutError("Reader never reached its ranking query")
                        writer = sqlite3.connect(path, isolation_level=None, timeout=5)
                        writer.execute("PRAGMA foreign_keys=ON")
                        writer.execute("BEGIN IMMEDIATE")
                        writer.execute(
                            "INSERT INTO sales VALUES(?,?,?,?,?,?,?)",
                            ("concurrent-sale", "store-a", "2026-10-14T02:00:00+00:00",
                             "transfer", 2000, 500, 1500),
                        )
                        writer.execute(
                            "INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,line_subtotal_satang,line_discount_satang,line_total_satang) VALUES(?,?,?,?,?,?,?)",
                            ("concurrent-line", "concurrent-sale", "second-lot",
                             200, 2000, 500, 1500),
                        )
                        writer.commit()
                    except BaseException as exc:
                        errors.append(exc)
                    finally:
                        if writer is not None:
                            writer.close()
                        committed.set()

                def before_ranking(sql):
                    trace.append(sql)
                    if (not injected and "SELECT p.sku" in sql
                            and "SUM(sl.line_subtotal_satang)" in sql):
                        injected.append(True)
                        started.set()
                        if not committed.wait(10):
                            # SQLite suppresses trace-callback exceptions, so
                            # record a timeout and assert it after the report.
                            timed_out.append(True)

                writer_thread = threading.Thread(target=write_second_sale, daemon=True)
                writer_thread.start()
                reader.execute("PRAGMA query_only=ON")
                reader.set_trace_callback(before_ranking)
                first = build_sales_report(reader, "store-a", date(2026, 10, 14),
                                           date(2026, 10, 14))
                reader.set_trace_callback(None)
                writer_thread.join(10)
                self.assertFalse(writer_thread.is_alive())
                self.assertEqual(errors, [])
                self.assertEqual(timed_out, [])
                self.assertEqual(injected, [True])
                self.assertTrue(committed.is_set())
                self.assertFalse(reader.in_transaction)
                self.assertEqual(sum(sql.strip().upper() == "BEGIN" for sql in trace), 1)
                self.assertEqual(sum(sql.strip().upper() == "ROLLBACK" for sql in trace), 1)
                self.assertEqual(reader.execute("SELECT COUNT(*) FROM sales").fetchone()[0], 2)

                self.assertEqual(first["summary"], {
                    "sale_count": 1, "subtotal_satang": 1000, "discount_satang": 100,
                    "total_satang": 900, "cash_satang": 900, "transfer_satang": 0,
                    "quantity_mg": 100, "average_satang": 900,
                    "known_cost_satang": 0, "cost_satang": None, "gross_profit_satang": None,
                    "unknown_cost_line_count": 1, "cost_complete": False,
                })
                self.assertEqual([row["id"] for row in first["recent_sales"]], [first_sale])
                self.assertEqual([row["sku"] for row in first["top_products"]], ["first-product"])
                self.assertEqual([row["category"] for row in first["top_categories"]], ["flowers"])
                for rows in (first["daily"], first["recent_sales"],
                             first["top_products"], first["top_categories"]):
                    self.assertEqual(len(rows), 1)
                    self.assertEqual(tuple(rows[0][field] for field in
                                           ("subtotal_satang", "discount_satang", "total_satang")),
                                     (1000, 100, 900))

                second = build_sales_report(reader, "store-a", date(2026, 10, 14),
                                            date(2026, 10, 14))
                self.assertEqual(second["summary"], {
                    "sale_count": 2, "subtotal_satang": 3000, "discount_satang": 600,
                    "total_satang": 2400, "cash_satang": 900, "transfer_satang": 1500,
                    "quantity_mg": 300, "average_satang": 1200,
                    "known_cost_satang": 0, "cost_satang": None, "gross_profit_satang": None,
                    "unknown_cost_line_count": 2, "cost_complete": False,
                })
                self.assertEqual({row["id"] for row in second["recent_sales"]},
                                 {first_sale, "concurrent-sale"})
                for rows in (second["daily"], second["recent_sales"],
                             second["top_products"], second["top_categories"]):
                    self.assertEqual(tuple(sum(row[field] for row in rows) for field in
                                           ("subtotal_satang", "discount_satang", "total_satang")),
                                     (3000, 600, 2400))
                    self.money_rows(rows)
                self.assertEqual(second["low_stock"], first["low_stock"])
                self.assertFalse(reader.in_transaction)
            finally:
                started.set()
                if writer_thread is not None:
                    writer_thread.join(10)
                reader.set_trace_callback(None)
                reader.close()
                self.db = original_db


if __name__ == "__main__":
    unittest.main()
