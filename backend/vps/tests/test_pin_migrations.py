"""Schema-four to five rehearsal on synthetic copies, without importing app."""
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from migrations import (SchemaUpgradeRequired, backup_and_migrate_copy, initialize_database,
                        inspect_database, migrate_copy, restore_copy)
from schema_v5 import SCHEMA_V5, TABLES_V5
from test_discount_migrations import (FRESH_SCHEMA, V4_SCHEMA, fixture_connection,
                                      logical_snapshot)


def create_v4_fixture(path):
    with fixture_connection(path) as db:
        db.executescript(V4_SCHEMA)
        db.execute("PRAGMA user_version=4")
        db.execute("INSERT INTO stores VALUES('shop','Synthetic offline shop',0,1,'2026-01-01')")
        db.execute("INSERT INTO users VALUES('real-owner','shop','owner@offline.invalid','preserve-original-password-hash','owner',1,'2026-01-01')")
        db.execute("INSERT INTO sessions VALUES('preserve-original-session-hash','real-owner',1900000000,0)")
        db.execute("INSERT INTO products(id,store_id,sku,name,price_satang_per_gram,created_at) VALUES('product','shop','SYN','Synthetic',100,'2026-01-01')")
        db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,received_at) VALUES('lot','shop','product','LOT','Synthetic','fixture-doc','2026-01-01')")
        db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES('lot',1000,'2026-01-01')")
        db.execute("INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,subtotal_satang,discount_satang,total_satang,created_at) VALUES('sale','shop','client','preserved-request-hash','real-owner','cash',40,5,35,'2026-01-01')")
        db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_subtotal_satang,line_discount_satang,line_total_satang) VALUES('line','sale','lot',400,100,40,5,35)")
        db.execute("INSERT INTO sale_payments VALUES('sale','cash',35)")
        db.execute("INSERT INTO ledger_events VALUES('ledger','shop','lot','real-owner','SALE',-400,'Synthetic','sale','2026-01-01')")
        data = b"synthetic previously stored evidence bytes"
        digest = hashlib.sha256(data).hexdigest()
        db.execute("""INSERT INTO stocktake_evidence VALUES(
            'photo','shop','real-owner','owner@offline.invalid','upload','count','lot',
            ?,?,'image/jpeg',1,1,?,?,'2026-01-01')""", (digest, digest, len(data), data))
        db.execute("CREATE TABLE operator_notes(note TEXT)")
        db.execute("INSERT INTO operator_notes VALUES('Unrelated original table')")
    return logical_snapshot(path)


class PinMigrationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="pin-migration-offline-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.path = self.root / "offline-schema4.sqlite3"

    def test_four_to_five_adds_only_empty_tables_preserves_every_original_field_and_object(self):
        before = create_v4_fixture(self.path)
        self.assertEqual(inspect_database(self.path)["status"], "UPGRADE_REQUIRED")
        result = migrate_copy(self.path, confirmed_offline_copy=True)
        self.assertEqual((result["status"], result["schema_version"]), ("PASS", 5))
        after = logical_snapshot(self.path)
        self.assertEqual(after["version"], 5)
        with fixture_connection(self.path) as db:
            for table, columns in before["columns"].items():
                fields = ",".join('"' + name + '"' for name in columns)
                rows = sorted(db.execute('SELECT ' + fields + ' FROM "' + table + '"'), key=repr)
                self.assertTrue(rows == before["rows"][table], "Original data changed: " + table)
                self.assertEqual(before["fks"][table], after["fks"][table])
                self.assertEqual(before["indexes"][table], after["indexes"][table])
            originals = {(kind, name): (kind, name, table, sql) for kind, name, table, sql in before["schema"]}
            actual = {(kind, name): (kind, name, table, sql) for kind, name, table, sql in after["schema"]}
            self.assertTrue(all(actual[key] == value for key, value in originals.items()))
            for table in TABLES_V5:
                self.assertEqual(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM users").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT sales_enabled,requires_authorization FROM stores").fetchall(), [(0, 1)])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        frozen = logical_snapshot(self.path)
        self.assertEqual(migrate_copy(self.path, confirmed_offline_copy=True)["status"], "NOOP")
        self.assertEqual(frozen, logical_snapshot(self.path))
        self.assertEqual(inspect_database(self.path)["status"], "READY")

    def test_existing_four_factory_refuses_before_ddl_or_journal_mode_change(self):
        before = create_v4_fixture(self.path)
        raw = self.path.read_bytes()
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(self.path, FRESH_SCHEMA)
        self.assertEqual(before, logical_snapshot(self.path))
        self.assertEqual(raw, self.path.read_bytes())
        with fixture_connection(self.path) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_real_faults_after_pin_ddl_and_version_roll_back_all_schema_data_and_version(self):
        for stage in ("after_pin_ddl", "after_version"):
            with self.subTest(stage=stage):
                path = self.root / (stage + ".sqlite3")
                before = create_v4_fixture(path)
                hit = []
                def fail(point):
                    if point == stage:
                        hit.append(point)
                        raise RuntimeError("Synthetic PIN migration fault")
                with self.assertRaisesRegex(RuntimeError, "Synthetic"):
                    migrate_copy(path, confirmed_offline_copy=True, failure_hook=fail)
                self.assertEqual(hit, [stage])
                self.assertEqual(before, logical_snapshot(path))
                self.assertEqual(inspect_database(path)["status"], "UPGRADE_REQUIRED")

    def test_backup_offline_restore_proves_original_and_refuses_existing_target(self):
        before = create_v4_fixture(self.path)
        result = backup_and_migrate_copy(self.path, self.root / "private", confirmed_offline_copy=True)
        self.assertEqual(result["consistent_backup"], "PASS")
        self.assertEqual(result["offline_restore"], "PASS")
        backup = Path(result["backup"])
        self.assertEqual(before, logical_snapshot(backup))
        output = self.root / "new-restored-schema4.sqlite3"
        self.assertEqual(restore_copy(backup, output, confirmed_offline_copy=True)["status"], "PASS")
        self.assertEqual(before, logical_snapshot(output))
        with self.assertRaises(ValueError):
            restore_copy(backup, self.path, confirmed_offline_copy=True)

    def test_partial_unversioned_and_future_pin_schemas_hold_without_modification(self):
        for mode in ("partial", "unversioned", "future"):
            with self.subTest(mode=mode):
                path = self.root / (mode + ".sqlite3")
                create_v4_fixture(path)
                with fixture_connection(path) as db:
                    if mode == "partial":
                        db.execute("CREATE TABLE device_auth_roles(unproved TEXT)")
                    elif mode == "unversioned":
                        db.executescript(SCHEMA_V5)
                    else:
                        db.execute("PRAGMA user_version=6")
                before = logical_snapshot(path)
                with self.assertRaises(SchemaUpgradeRequired):
                    migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual(before, logical_snapshot(path))

    def test_fresh_five_is_empty_wal_and_audit_is_immutable(self):
        initialize_database(self.path, FRESH_SCHEMA)
        self.assertEqual(inspect_database(self.path)["status"], "READY")
        with fixture_connection(self.path) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(db.execute("SELECT count(*) FROM users").fetchone()[0], 0)
            for table in TABLES_V5:
                self.assertEqual(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0], 0)
            db.execute("INSERT INTO stores VALUES('shop','Synthetic',0,1,'fixture')")
            db.execute("INSERT INTO device_auth_events VALUES('event','shop',NULL,NULL,NULL,'LOCKED',1)")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM device_auth_events")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE device_auth_events SET event='LOCK'")


if __name__ == "__main__":
    unittest.main()
