"""Independent SQLite gross/net/COGS fixtures; never imports the live app."""
from datetime import date
from pathlib import Path
import sqlite3
import tempfile
import unittest
from reports import build_sales_report

SCHEMA="""
CREATE TABLE products(id TEXT PRIMARY KEY,store_id TEXT,sku TEXT,name TEXT,category TEXT,
 price_satang_per_gram INTEGER DEFAULT 10000,active INTEGER DEFAULT 1,
 default_cost_satang_per_gram INTEGER);
CREATE TABLE lots(id TEXT PRIMARY KEY,store_id TEXT,product_id TEXT,lot_code TEXT,
 expires_on TEXT,active INTEGER DEFAULT 1,cost_satang_per_gram INTEGER);
CREATE TABLE lot_balances(lot_id TEXT PRIMARY KEY,quantity_mg INTEGER);
CREATE TABLE sales(id TEXT PRIMARY KEY,store_id TEXT,created_at TEXT,payment_method TEXT,
 subtotal_satang INTEGER,discount_satang INTEGER,total_satang INTEGER);
CREATE TABLE sale_lines(id TEXT PRIMARY KEY,sale_id TEXT,lot_id TEXT,quantity_mg INTEGER,
 line_subtotal_satang INTEGER,line_discount_satang INTEGER,line_total_satang INTEGER,
 line_cost_satang INTEGER);
"""

class CostReportTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(":memory:",isolation_level=None)
        self.db.row_factory=sqlite3.Row
        self.db.executescript(SCHEMA)
        self.addCleanup(self.db.close)
        self.number=0

    def lot(self,name,category="top",store="a"):
        self.db.execute("INSERT INTO products(id,store_id,sku,name,category) VALUES(?,?,?,?,?)",(name,store,name,name,category))
        self.db.execute("INSERT INTO lots(id,store_id,product_id,lot_code) VALUES(?,?,?,?)",(name,store,name,name))
        self.db.execute("INSERT INTO lot_balances VALUES(?,?)",(name,5000))
        return name

    def sale(self,lines,*,at="2026-10-18T03:00:00+00:00",method="cash",store="a",db=None):
        db=db or self.db
        self.number+=1
        sid="sale-"+str(self.number)
        gross=sum(g for _,g,_,_ in lines)
        discount=sum(d for _,_,d,_ in lines)
        db.execute("INSERT INTO sales VALUES(?,?,?,?,?,?,?)",(sid,store,at,method,gross,discount,gross-discount))
        for i,(lot,g,d,c) in enumerate(lines):
            db.execute("INSERT INTO sale_lines VALUES(?,?,?,?,?,?,?,?)",(sid+"-"+str(i),sid,lot,1000,g,d,g-d,c))
        return sid

    def report(self,day="2026-10-18",store="a",db=None):
        return build_sales_report(db or self.db,store,date.fromisoformat(day),date.fromisoformat(day))

    def assert_cost(self,row,known,missing,net):
        self.assertEqual(row["known_cost_satang"],known)
        self.assertEqual(row["unknown_cost_line_count"],missing)
        self.assertEqual(row["cost_complete"],missing==0)
        self.assertEqual(row["cost_satang"],None if missing else known)
        self.assertEqual(row["gross_profit_satang"],None if missing else net-known)

    def test_all_groups_reconcile_net_after_discount_and_cash_transfer(self):
        a,b=self.lot("a1"),self.lot("b1","mini")
        self.sale([(a,10000,33,4000),(b,20000,67,7000)])
        self.sale([(a,10000,1750,4000),(b,20000,15800,7000)],method="transfer")
        r=self.report()
        self.assertEqual(r["summary"]["subtotal_satang"],60000)
        self.assertEqual(r["summary"]["discount_satang"],17650)
        self.assertEqual(r["summary"]["total_satang"],42350)
        self.assertEqual(r["summary"]["cash_satang"],29900)
        self.assertEqual(r["summary"]["transfer_satang"],12450)
        for group in (r["summary"],r["daily"][0]):self.assert_cost(group,22000,0,42350)
        for key in ("recent_sales","top_products","top_categories"):
            self.assertEqual(sum(x["cost_satang"] for x in r[key]),22000)
            self.assertEqual(sum(x["gross_profit_satang"] for x in r[key]),20350)
            self.assertEqual(sum(x["total_satang"] for x in r[key]),42350)
        self.assertTrue(r["capabilities"]["inventory_costs"])
        self.assertEqual(r["capabilities"]["cost_contract_version"],1)
        self.assertFalse(r["capabilities"]["promotions"])
        self.assertFalse(r["capabilities"]["shift_reconciliation"])

    def test_unknown_history_is_not_zero_or_full_profit_but_explicit_zero_is_known(self):
        known,unknown,free=self.lot("known"),self.lot("unknown","mini"),self.lot("free","free")
        self.sale([(known,10000,0,4000),(unknown,20000,0,None),(free,1000,0,0)])
        r=self.report()
        for group in (r["summary"],r["daily"][0],r["recent_sales"][0]):self.assert_cost(group,4000,1,31000)
        rows={x["sku"]:x for x in r["top_products"]}
        self.assert_cost(rows["known"],4000,0,10000)
        self.assert_cost(rows["unknown"],0,1,20000)
        self.assert_cost(rows["free"],0,0,1000)
        categories={x["category"]:x for x in r["top_categories"]}
        self.assert_cost(categories["mini"],0,1,20000)

    def test_full_discount_retains_cost_and_reports_negative_profit(self):
        lot=self.lot("loss")
        self.sale([(lot,30000,30000,17550)],method="transfer")
        r=self.report()
        for row in [r["summary"],*r["daily"],*r["recent_sales"],*r["top_products"],*r["top_categories"]]:
            self.assert_cost(row,17550,0,0)
            self.assertEqual(row["gross_profit_satang"],-17550)

    def test_empty_report_is_known_zero_even_with_unknown_inventory_cost(self):
        self.lot("unknown-stock")
        r=self.report()
        self.assert_cost(r["summary"],0,0,0)
        self.assert_cost(r["daily"][0],0,0,0)
        self.assertEqual(r["recent_sales"],[])

    def test_bangkok_boundaries_and_other_store_cannot_pollute_cost_coverage(self):
        lot=self.lot("mine")
        other=self.lot("other",store="b")
        self.sale([(lot,10000,0,None)],at="2026-10-17T16:59:59+00:00")
        self.sale([(lot,10000,100,3500)],at="2026-10-17T17:00:00+00:00")
        self.sale([(lot,20000,0,7500)],at="2026-10-18T16:59:59+00:00")
        self.sale([(lot,10000,0,None)],at="2026-10-18T17:00:00+00:00")
        self.sale([(other,50000,0,None)],store="b")
        r=self.report()
        self.assertEqual(r["summary"]["sale_count"],2)
        self.assert_cost(r["summary"],11000,0,29900)
        self.assert_cost(self.report(store="b")["summary"],0,1,50000)

    def test_current_product_and_lot_cost_edits_do_not_rewrite_historical_profit(self):
        lot=self.lot("stable")
        self.sale([(lot,10000,100,4000)])
        before=self.report()
        self.db.execute("UPDATE products SET price_satang_per_gram=99999,default_cost_satang_per_gram=8000")
        self.db.execute("UPDATE lots SET cost_satang_per_gram=9000")
        self.assertEqual(self.report(),before)

    def test_cost_sections_share_one_concurrent_sqlite_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="cost-snapshot-fixture-") as folder:
            path=Path(folder)/"fixture.sqlite3"
            reader=sqlite3.connect(path,isolation_level=None)
            reader.row_factory=sqlite3.Row
            reader.execute("PRAGMA journal_mode=WAL")
            reader.executescript(SCHEMA)
            reader.execute("INSERT INTO products(id,store_id,sku,name,category) VALUES('p','a','p','p','top')")
            reader.execute("INSERT INTO lots(id,store_id,product_id,lot_code) VALUES('p','a','p','p')")
            reader.execute("INSERT INTO lot_balances VALUES('p',5000)")
            self.sale([("p",10000,100,4000)],db=reader)
            writer=sqlite3.connect(path,isolation_level=None)
            outer=self
            class SnapshotHook:
                fired=False
                def execute(self,sql,args=()):
                    result=reader.execute(sql,args)
                    if "SELECT s.id, s.created_at" in sql and not self.fired:
                        self.fired=True
                        outer.sale([("p",20000,200,7000)],db=writer)
                    return result
                def rollback(self):reader.rollback()
            try:
                r=self.report(db=SnapshotHook())
                for row in (r["summary"],r["daily"][0],r["top_products"][0],r["top_categories"][0]):
                    self.assert_cost(row,4000,0,9900)
                self.assert_cost(self.report(db=reader)["summary"],11000,0,29700)
            finally:
                writer.close();reader.close()

if __name__=="__main__":unittest.main()
