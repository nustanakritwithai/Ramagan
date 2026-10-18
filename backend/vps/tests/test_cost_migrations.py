"""Schema 2 to 3 copy-only migration, rollback and restore proof."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from migrations import (CURRENT_SCHEMA_VERSION, SchemaUpgradeRequired, backup_and_migrate_copy, initialize_database,
                        inspect_database, migrate_copy, restore_copy)
from test_discount_migrations import (FRESH_SCHEMA, V2_SCHEMA, STORE_ID, USER_ID, LOT_IDS,
    create_legacy_fixture, fixture_connection, logical_snapshot)


def create_v2_fixture(path):
    create_legacy_fixture(path, version=1)
    with fixture_connection(path) as db:
        db.execute("ALTER TABLE sales ADD COLUMN discount_satang INTEGER NOT NULL DEFAULT 0 "
                   "CHECK(discount_satang>=0 AND subtotal_satang=total_satang+discount_satang)")
        db.execute("ALTER TABLE sale_lines ADD COLUMN line_subtotal_satang INTEGER NOT NULL DEFAULT 0 CHECK(line_subtotal_satang>=0)")
        trigger = db.execute("SELECT sql FROM sqlite_master WHERE name='lines_no_update'").fetchone()[0]
        db.execute("DROP TRIGGER lines_no_update")
        db.execute("UPDATE sale_lines SET line_subtotal_satang=line_total_satang")
        db.execute(trigger)
        db.execute("ALTER TABLE sale_lines ADD COLUMN line_discount_satang INTEGER NOT NULL DEFAULT 0 "
                   "CHECK(line_discount_satang>=0 AND line_subtotal_satang=line_total_satang+line_discount_satang)")
        db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,"
                   "subtotal_satang,discount_satang,total_satang,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                   ("discounted-v2-sale", STORE_ID, "v2-client-key", "v2-original-request-hash", USER_ID,
                    "transfer", 100, 25, 75, "2026-01-02T00:00:00+00:00"))
        db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,"
                   "line_subtotal_satang,line_discount_satang,line_total_satang) VALUES(?,?,?,?,?,?,?,?)",
                   ("discounted-v2-line", "discounted-v2-sale", LOT_IDS[0], 1000, 100, 100, 25, 75))
        db.execute("PRAGMA user_version=2")
    return logical_snapshot(path)


class CostMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cost-migration-offline-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "offline-v2.sqlite3"

    def test_schema2_upgrade_preserves_all_original_values_unknown_costs_and_flags(self):
        before = create_v2_fixture(self.path)
        self.assertEqual(inspect_database(self.path)["classification"], "discount_v2")
        self.assertEqual(inspect_database(self.path)["status"], "UPGRADE_REQUIRED")
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(self.path, FRESH_SCHEMA)
        self.assertEqual(before, logical_snapshot(self.path))
        result = migrate_copy(self.path, confirmed_offline_copy=True)
        self.assertEqual((result["status"], result["schema_version"]), ("PASS", CURRENT_SCHEMA_VERSION))
        after = logical_snapshot(self.path)
        with fixture_connection(self.path) as db:
            for table, columns in before["columns"].items():
                projection = ",".join('"' + name + '"' for name in columns)
                rows = sorted(db.execute('SELECT ' + projection + ' FROM "' + table + '"').fetchall(), key=repr)
                self.assertTrue(rows == before["rows"][table], "Original field changed: " + table)
                self.assertEqual(before["fks"][table], after["fks"][table])
                self.assertEqual(before["indexes"][table], after["indexes"][table])
            self.assertEqual(db.execute("SELECT count(*) FROM lots WHERE cost_satang_per_gram IS NOT NULL").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM sale_lines WHERE line_cost_satang IS NOT NULL OR unit_cost_satang_per_gram IS NOT NULL").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT DISTINCT stock_revision FROM lot_balances").fetchall(), [(0,)])
            self.assertEqual(db.execute("SELECT sales_enabled,requires_authorization FROM stores").fetchall(), [(0, 1)])
            self.assertEqual(db.execute("SELECT discount_satang,total_satang FROM sales WHERE id='discounted-v2-sale'").fetchone(), (25, 75))
        frozen = logical_snapshot(self.path)
        self.assertEqual(migrate_copy(self.path, confirmed_offline_copy=True)["status"], "NOOP")
        self.assertEqual(frozen, logical_snapshot(self.path))
        self.assertEqual(inspect_database(self.path)["status"], "READY")

    def test_schema2_failures_restore_all_ddl_rows_and_version(self):
        for stage in ("after_cost_ddl", "after_cost_tables", "after_version"):
            path = self.root / (stage + ".sqlite3")
            before = create_v2_fixture(path)
            def fail(point):
                if point == stage:
                    raise RuntimeError("Injected cost migration failure")
            with self.assertRaisesRegex(RuntimeError, "Injected"):
                migrate_copy(path, confirmed_offline_copy=True, failure_hook=fail)
            self.assertEqual(before, logical_snapshot(path))

    def test_schema2_consistent_backup_and_new_target_restore_preserve_rows(self):
        before = create_v2_fixture(self.path)
        result = backup_and_migrate_copy(self.path, self.root / "private-backups", confirmed_offline_copy=True)
        self.assertEqual(result["offline_restore"], "PASS")
        backup = Path(result["backup"])
        self.assertEqual(before, logical_snapshot(backup))
        restored = self.root / "restored-v2.sqlite3"
        self.assertEqual(restore_copy(backup, restored, confirmed_offline_copy=True)["status"], "PASS")
        self.assertEqual(before, logical_snapshot(restored))
        self.assertEqual(migrate_copy(restored, confirmed_offline_copy=True)["status"], "PASS")

    def test_partial_cost_schema_and_missing_or_changed_new_trigger_hold(self):
        create_v2_fixture(self.path)
        with fixture_connection(self.path) as db:
            db.execute("ALTER TABLE products ADD COLUMN default_cost_satang_per_gram INTEGER")
        before = logical_snapshot(self.path)
        with self.assertRaises(SchemaUpgradeRequired):
            migrate_copy(self.path, confirmed_offline_copy=True)
        self.assertEqual(before, logical_snapshot(self.path))
        fresh = self.root / "fresh.sqlite3"
        initialize_database(fresh, FRESH_SCHEMA)
        with fixture_connection(fresh) as db:
            db.execute("DROP TRIGGER stocktake_rejections_no_update")
            db.execute("CREATE TRIGGER stocktake_rejections_no_update BEFORE UPDATE ON stocktake_rejections BEGIN SELECT 1; END")
        self.assertEqual(inspect_database(fresh)["status"], "HOLD")

    def test_missing_new_table_column_and_noninteger_legacy_quantity_hold(self):
        create_v2_fixture(self.path)
        with fixture_connection(self.path) as db:
            db.execute("UPDATE lot_balances SET quantity_mg=0.5 WHERE lot_id=?", (LOT_IDS[0],))
        before = logical_snapshot(self.path)
        self.assertEqual(inspect_database(self.path)["status"], "HOLD")
        with self.assertRaises(SchemaUpgradeRequired):
            migrate_copy(self.path, confirmed_offline_copy=True)
        self.assertEqual(before, logical_snapshot(self.path))
        fresh = self.root / "bad-columns.sqlite3"
        initialize_database(fresh, FRESH_SCHEMA)
        with fixture_connection(fresh) as db:
            db.execute("ALTER TABLE stocktakes DROP COLUMN actor_email")
        self.assertEqual(inspect_database(fresh)["status"], "HOLD")


if __name__ == "__main__":
    unittest.main()
