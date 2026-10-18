"""Schema-five to six backup, atomic failure and restore on synthetic copies."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from migrations import (CURRENT_SCHEMA_VERSION, SchemaUpgradeRequired, backup_and_migrate_copy,
                        initialize_database, inspect_database, migrate_copy, restore_copy)
from schema_v5 import SCHEMA_V5
from schema_v6 import SCHEMA_V6, TABLES_V6
from test_pin_migrations import create_v4_fixture
from test_discount_migrations import FRESH_SCHEMA, fixture_connection, logical_snapshot


def create_v5_fixture(path):
    create_v4_fixture(path)
    with fixture_connection(path) as db:
        db.executescript(SCHEMA_V5)
        for role in ("owner", "manager", "staff"):
            db.execute("INSERT INTO users VALUES(?,?,?,?,?,1,'fixture')",
                       (role, "shop", role + "@synthetic-role.invalid", "unusable-pin-role-v1$fixture", role))
            db.execute("INSERT INTO device_auth_roles VALUES('shop',?,?,?,1,1)",
                       (role, role, "pin-scrypt-v1$" + "a" * 32 + "$" + "b" * 64))
        db.execute("INSERT INTO remembered_devices VALUES('device','shop','hashed-only-credential','Synthetic device','real-owner',1,9999999999,NULL)")
        db.execute("INSERT INTO sessions VALUES('hashed-only-pin-session','owner',9999999999,0)")
        db.execute("INSERT INTO device_pin_sessions VALUES('hashed-only-pin-session','device','shop','owner',1,1)")
        db.execute("INSERT INTO device_auth_limits VALUES('shop','store_role','shop','manager',2,0,0)")
        db.execute("INSERT INTO device_auth_events VALUES('enroll','shop','device','real-owner',NULL,'ENROLL',1)")
        db.execute("PRAGMA user_version=5")
    return logical_snapshot(path)


class VoidMigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="void-migration-copy-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.path = self.root / "schema5.sqlite3"

    def test_five_to_six_adds_only_empty_audit_objects_and_repeat_is_noop(self):
        before = create_v5_fixture(self.path)
        self.assertEqual(inspect_database(self.path)["status"], "UPGRADE_REQUIRED")
        result = migrate_copy(self.path, confirmed_offline_copy=True)
        self.assertEqual((result["status"], result["schema_version"]), ("PASS", CURRENT_SCHEMA_VERSION))
        after = logical_snapshot(self.path)
        for key in ("columns", "fks", "indexes", "rows"):
            for table, expected in before[key].items():
                self.assertEqual(after[key][table], expected, key + ": " + table)
        originals = {(row[0], row[1]): row for row in before["schema"]}
        actual = {(row[0], row[1]): row for row in after["schema"]}
        self.assertTrue(all(actual[key] == value for key, value in originals.items()))
        with fixture_connection(self.path) as db:
            for table in TABLES_V6:
                self.assertEqual(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT sales_enabled,requires_authorization FROM stores").fetchall(), [(0, 1)])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(migrate_copy(self.path, confirmed_offline_copy=True)["status"], "NOOP")
        self.assertEqual(after, logical_snapshot(self.path))

    def test_existing_five_factory_refuses_before_any_sqlite_write(self):
        before = create_v5_fixture(self.path)
        raw = self.path.read_bytes()
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(self.path, FRESH_SCHEMA)
        self.assertEqual(raw, self.path.read_bytes())
        self.assertEqual(before, logical_snapshot(self.path))

    def test_failure_after_void_ddl_or_version_restores_all_original_rows_objects_and_version(self):
        for stage in ("after_void_ddl", "after_version"):
            with self.subTest(stage=stage):
                path = self.root / (stage + ".sqlite3")
                before = create_v5_fixture(path)
                reached = []
                def fail(point):
                    if point == stage:
                        reached.append(point)
                        raise RuntimeError("Synthetic completed-sale void migration fault")
                with self.assertRaisesRegex(RuntimeError, "Synthetic"):
                    migrate_copy(path, confirmed_offline_copy=True, failure_hook=fail)
                self.assertEqual(reached, [stage])
                self.assertEqual(before, logical_snapshot(path))
                self.assertEqual(inspect_database(path)["status"], "UPGRADE_REQUIRED")

    def test_backup_and_new_restore_preserve_original_five_and_refuse_overwrite(self):
        before = create_v5_fixture(self.path)
        result = backup_and_migrate_copy(self.path, self.root / "private", confirmed_offline_copy=True)
        self.assertEqual((result["consistent_backup"], result["offline_restore"]), ("PASS", "PASS"))
        backup = Path(result["backup"])
        self.assertEqual(before, logical_snapshot(backup))
        restored = self.root / "restored-schema5.sqlite3"
        self.assertEqual(restore_copy(backup, restored, confirmed_offline_copy=True)["status"], "PASS")
        self.assertEqual(before, logical_snapshot(restored))
        with self.assertRaises(ValueError):
            restore_copy(backup, self.path, confirmed_offline_copy=True)
        self.assertEqual(inspect_database(self.path)["status"], "READY")

    def test_partial_unversioned_or_future_void_schema_holds_without_modification(self):
        for mode in ("partial", "unversioned", "future"):
            with self.subTest(mode=mode):
                path = self.root / (mode + ".sqlite3")
                create_v5_fixture(path)
                with fixture_connection(path) as db:
                    if mode == "partial":
                        db.execute("CREATE TABLE sale_voids(unproved TEXT)")
                    elif mode == "unversioned":
                        db.executescript(SCHEMA_V6)
                    else:
                        db.execute("PRAGMA user_version=" + str(CURRENT_SCHEMA_VERSION + 1))
                before = logical_snapshot(path)
                with self.assertRaises(SchemaUpgradeRequired):
                    migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual(before, logical_snapshot(path))


if __name__ == "__main__":
    unittest.main()
