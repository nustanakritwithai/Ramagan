"""Migration acceptance uses synthetic local SQLite files; never imports app."""
import contextlib
import io
import json
import os
import stat
from pathlib import Path
import sqlite3
import tempfile
import unittest

from migrations import (
    CURRENT_SCHEMA_VERSION, SchemaUpgradeRequired, backup_and_migrate_copy,
    initialize_database, inspect_database, main, migrate_copy, restore_copy,
)
from cost_stock import EXTRA_SCHEMA
from schema_v4 import SCHEMA_V4

# Frozen pre-discount schema from 9c59899. No app import/module-level DB creation.
LEGACY_SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sales_enabled INTEGER NOT NULL DEFAULT 0 CHECK(sales_enabled IN (0,1)),
  requires_authorization INTEGER NOT NULL DEFAULT 1 CHECK(requires_authorization IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','manager','staff')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  price_satang_per_gram INTEGER NOT NULL CHECK(price_satang_per_gram BETWEEN 0 AND 100000000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(store_id, sku)
);
CREATE TABLE IF NOT EXISTS lots (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  lot_code TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  supplier_document_ref TEXT NOT NULL,
  expires_on TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  received_at TEXT NOT NULL,
  UNIQUE(store_id, lot_code)
);
CREATE TABLE IF NOT EXISTS lot_balances (
  lot_id TEXT PRIMARY KEY REFERENCES lots(id),
  quantity_mg INTEGER NOT NULL CHECK(quantity_mg >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_sale_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  cashier_user_id TEXT NOT NULL REFERENCES users(id),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('cash','transfer')),
  authorization_ref TEXT,
  subtotal_satang INTEGER NOT NULL CHECK(subtotal_satang >= 0),
  total_satang INTEGER NOT NULL CHECK(total_satang >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(store_id, client_sale_id)
);
CREATE TABLE IF NOT EXISTS sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  quantity_mg INTEGER NOT NULL CHECK(quantity_mg > 0),
  unit_price_satang_per_gram INTEGER NOT NULL CHECK(unit_price_satang_per_gram >= 0),
  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),
  UNIQUE(sale_id, lot_id)
);
CREATE TABLE IF NOT EXISTS ledger_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('RECEIVE','SALE','ADJUST','DESTROY','TRANSFER_IN','TRANSFER_OUT')),
  quantity_delta_mg INTEGER NOT NULL CHECK(quantity_delta_mg <> 0),
  reason TEXT NOT NULL,
  sale_id TEXT REFERENCES sales(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'Immutable ledger events'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'Immutable ledger events'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_update BEFORE UPDATE ON sales
BEGIN SELECT RAISE(ABORT, 'Immutable sales'); END;
CREATE TRIGGER IF NOT EXISTS sales_no_delete BEFORE DELETE ON sales
BEGIN SELECT RAISE(ABORT, 'Immutable sales'); END;
CREATE TRIGGER IF NOT EXISTS lines_no_update BEFORE UPDATE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Immutable sale lines'); END;
CREATE TRIGGER IF NOT EXISTS lines_no_delete BEFORE DELETE ON sale_lines
BEGIN SELECT RAISE(ABORT, 'Immutable sale lines'); END;
CREATE INDEX IF NOT EXISTS sales_store_created ON sales(store_id,created_at);
CREATE INDEX IF NOT EXISTS ledger_store_lot_created ON ledger_events(store_id,lot_id,created_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
"""
V2_SCHEMA = LEGACY_SCHEMA.replace(
    "  total_satang INTEGER NOT NULL CHECK(total_satang >= 0),",
    "  discount_satang INTEGER NOT NULL DEFAULT 0 CHECK(discount_satang >= 0),\n"
    "  total_satang INTEGER NOT NULL CHECK(total_satang >= 0),",
).replace(
    "  UNIQUE(store_id, client_sale_id)",
    "  CHECK(subtotal_satang = discount_satang + total_satang),\n  UNIQUE(store_id, client_sale_id)",
).replace(
    "  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),",
    "  line_subtotal_satang INTEGER NOT NULL DEFAULT 0 CHECK(line_subtotal_satang >= 0),\n"
    "  line_discount_satang INTEGER NOT NULL DEFAULT 0 CHECK(line_discount_satang >= 0),\n"
    "  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),",
).replace(
    "  UNIQUE(sale_id, lot_id)",
    "  CHECK(line_subtotal_satang = line_discount_satang + line_total_satang),\n  UNIQUE(sale_id, lot_id)",
)
V3_SCHEMA = V2_SCHEMA.replace(
    "  price_satang_per_gram INTEGER NOT NULL CHECK(price_satang_per_gram BETWEEN 0 AND 100000000),",
    "  price_satang_per_gram INTEGER NOT NULL CHECK(price_satang_per_gram BETWEEN 0 AND 100000000),\n"
    "  default_cost_satang_per_gram INTEGER CHECK(default_cost_satang_per_gram IS NULL OR (typeof(default_cost_satang_per_gram)='integer' AND default_cost_satang_per_gram BETWEEN 0 AND 100000000)),",
).replace(
    "  supplier_document_ref TEXT NOT NULL,",
    "  supplier_document_ref TEXT NOT NULL,\n"
    "  cost_satang_per_gram INTEGER CHECK(cost_satang_per_gram IS NULL OR (typeof(cost_satang_per_gram)='integer' AND cost_satang_per_gram BETWEEN 0 AND 100000000)),",
).replace(
    "  quantity_mg INTEGER NOT NULL CHECK(quantity_mg >= 0),",
    "  quantity_mg INTEGER NOT NULL CHECK(quantity_mg >= 0),\n"
    "  stock_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stock_revision)='integer' AND stock_revision BETWEEN 0 AND 9000000000000000000),",
).replace(
    "  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),",
    "  line_total_satang INTEGER NOT NULL CHECK(line_total_satang >= 0),\n"
    "  unit_cost_satang_per_gram INTEGER CHECK(unit_cost_satang_per_gram IS NULL OR (typeof(unit_cost_satang_per_gram)='integer' AND unit_cost_satang_per_gram BETWEEN 0 AND 100000000)),\n"
    "  line_cost_satang INTEGER CHECK((line_cost_satang IS NULL AND unit_cost_satang_per_gram IS NULL) OR (typeof(line_cost_satang)='integer' AND line_cost_satang>=0 AND unit_cost_satang_per_gram IS NOT NULL)),",
) + EXTRA_SCHEMA
FRESH_SCHEMA = V3_SCHEMA.replace("CHECK(payment_method IN ('cash','transfer'))",
                                 "CHECK(payment_method IN ('cash','transfer','split'))") + SCHEMA_V4
STORE_ID = "11111111-1111-4111-8111-111111111111"
USER_ID = "22222222-2222-4222-8222-222222222222"
PRODUCT_ID = "33333333-3333-4333-8333-333333333333"
SALE_ID = "44444444-4444-4444-8444-444444444444"
LOT_IDS = ("55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666")
CLIENT_SALE_ID = "77777777-7777-4777-8777-777777777777"


@contextlib.contextmanager
def fixture_connection(path):
    db = sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


def create_legacy_fixture(path, *, version=0, subtotal=45, total=45, line_amounts=(15, 30)):
    """Historical data fixture with sales disabled and all original tables populated."""
    with fixture_connection(path) as db:
        db.executescript(LEGACY_SCHEMA)
        db.execute("PRAGMA foreign_keys=ON")
        db.execute(f"PRAGMA user_version={version}")
        db.execute("INSERT INTO stores(id,name,created_at) VALUES(?,?,?)", (STORE_ID, "SIMULATED historical fixture", "2026-01-01"))
        db.execute("INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                   (USER_ID, STORE_ID, "fixture@example.invalid", "fixture-password-hash-preserved", "staff", "2026-01-01"))
        db.execute("INSERT INTO sessions VALUES(?,?,?,?)", ("fixture-token-hash", USER_ID, 123456, 0))
        db.execute("INSERT INTO products(id,store_id,sku,name,price_satang_per_gram,created_at) VALUES(?,?,?,?,?,?)",
                   (PRODUCT_ID, STORE_ID, "SIM", "Simulated", 150, "2026-01-01"))
        for i, lot in enumerate(LOT_IDS):
            db.execute("INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,supplier_document_ref,received_at) VALUES(?,?,?,?,?,?,?)",
                       (lot, STORE_ID, PRODUCT_ID, f"L{i}", "Simulated", "fixture-doc", "2026-01-01"))
            db.execute("INSERT INTO lot_balances VALUES(?,?,?)", (lot, 1000 + i, "2026-01-01"))
        db.execute("INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?)",
                   (SALE_ID, STORE_ID, CLIENT_SALE_ID, "original-idempotency-request-hash", USER_ID,
                    "cash", "original-auth-reference", subtotal, total, "2026-01-01"))
        for i, amount in enumerate(line_amounts):
            db.execute("INSERT INTO sale_lines VALUES(?,?,?,?,?,?)",
                       (f"line-{i}", SALE_ID, LOT_IDS[i], (i + 1) * 100, 150, amount))
            db.execute("INSERT INTO ledger_events VALUES(?,?,?,?,?,?,?,?,?)",
                       (f"ledger-{i}", STORE_ID, LOT_IDS[i], USER_ID, "SALE", -(i + 1) * 100,
                        "Historical fixture", SALE_ID, "2026-01-01"))
        db.execute("CREATE TABLE operator_notes(note TEXT, blob_value BLOB)")
        db.execute("INSERT INTO operator_notes VALUES(?,?)", ("Unrelated table must survive", b"\x00\xff"))
        db.execute("CREATE INDEX custom_line_price ON sale_lines(unit_price_satang_per_gram)")
    return {"store_id": STORE_ID, "user_id": USER_ID, "sale_id": SALE_ID, "lot_ids": LOT_IDS,
            "client_sale_id": CLIENT_SALE_ID}


def logical_snapshot(path):
    with fixture_connection(path) as db:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        return {
            "version": db.execute("PRAGMA user_version").fetchone()[0],
            "schema": list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")),
            "rows": {t: sorted(list(db.execute('SELECT * FROM "' + t + '"')), key=repr) for t in tables},
            "columns": {t: [r[1] for r in db.execute('PRAGMA table_info("' + t + '")')] for t in tables},
            "fks": {t: list(db.execute('PRAGMA foreign_key_list("' + t + '")')) for t in tables},
            "indexes": {t: sorted(list(db.execute('PRAGMA index_list("' + t + '")')), key=repr) for t in tables},
        }


class DiscountMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ramagan-discount-migration-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / "offline-fixture.sqlite3"

    def fixture(self, **kwargs):
        create_legacy_fixture(self.db, **kwargs)
        return logical_snapshot(self.db)

    def test_legacy_versions_preserve_every_old_field_schema_object_and_zero_discount(self):
        for version in (0, 1):
            with self.subTest(version=version):
                path = self.root / f"legacy-{version}.sqlite3"
                create_legacy_fixture(path, version=version)
                before = logical_snapshot(path)
                result = migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual(result["status"], "PASS")
                after = logical_snapshot(path)
                self.assertEqual(after["version"], CURRENT_SCHEMA_VERSION)
                self.assertEqual(before["fks"], {t: after["fks"][t] for t in before["fks"]})
                self.assertEqual(before["indexes"], {t: after["indexes"][t] for t in before["indexes"]})
                changed_tables = {"sales", "sale_lines", "products", "lots", "lot_balances"}
                original_objects = {(r[0], r[1]) for r in before["schema"]}
                self.assertEqual([r for r in before["schema"] if not (r[0] == "table" and r[1] in changed_tables)],
                                 [r for r in after["schema"] if (r[0], r[1]) in original_objects and not (r[0] == "table" and r[1] in changed_tables)])
                with fixture_connection(path) as db:
                    for table, columns in before["columns"].items():
                        projection = ",".join('"' + c + '"' for c in columns)
                        actual = sorted(list(db.execute('SELECT ' + projection + ' FROM "' + table + '"')), key=repr)
                        self.assertEqual(repr(actual), repr(before["rows"][table]))
                    self.assertEqual(db.execute("SELECT discount_satang FROM sales").fetchall(), [(0,)])
                    self.assertEqual(db.execute("SELECT line_subtotal_satang,line_discount_satang,line_total_satang FROM sale_lines ORDER BY id").fetchall(),
                                     [(15, 0, 15), (30, 0, 30)])
                    self.assertEqual(db.execute("SELECT sales_enabled FROM stores").fetchall(), [(0,)])
                    for table in ("sales", "sale_lines", "ledger_events"):
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute('DELETE FROM "' + table + '"')
                        with self.assertRaises(sqlite3.IntegrityError):
                            db.execute('UPDATE "' + table + '" SET id=id')
                frozen = logical_snapshot(path)
                self.assertEqual(migrate_copy(path, confirmed_offline_copy=True)["status"], "NOOP")
                self.assertEqual(frozen, logical_snapshot(path))
                self.assertEqual(inspect_database(path)["status"], "READY")

    def test_factory_refuses_legacy_before_any_change_and_inspection_is_readonly(self):
        before = self.fixture()
        raw_before = self.db.read_bytes()
        report = inspect_database(self.db)
        self.assertEqual(report["status"], "UPGRADE_REQUIRED")
        self.assertEqual(raw_before, self.db.read_bytes())
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(self.db, FRESH_SCHEMA)
        self.assertEqual(before, logical_snapshot(self.db))
        self.assertEqual(raw_before, self.db.read_bytes())

    def test_invalid_subtotal_and_line_sum_hold_without_ddl(self):
        for kwargs in ({"total": 44}, {"line_amounts": (15, 29)}):
            with self.subTest(kwargs=kwargs):
                path = self.root / ("bad-" + str(len(list(self.root.iterdir()))) + ".sqlite3")
                create_legacy_fixture(path, **kwargs)
                before = logical_snapshot(path)
                self.assertEqual(inspect_database(path)["status"], "HOLD")
                with self.assertRaises(SchemaUpgradeRequired):
                    migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual(before, logical_snapshot(path))

    def test_failures_after_ddl_backfill_and_version_roll_back_entire_transaction(self):
        for stage in ("after_ddl", "after_trigger_drop", "after_backfill", "after_version"):
            with self.subTest(stage=stage):
                path = self.root / (stage + ".sqlite3")
                create_legacy_fixture(path, version=1)
                before = logical_snapshot(path)
                def fail(point):
                    if point == stage:
                        raise RuntimeError("Injected transaction failure")
                with self.assertRaisesRegex(RuntimeError, "Injected"):
                    migrate_copy(path, confirmed_offline_copy=True, failure_hook=fail)
                self.assertEqual(before, logical_snapshot(path))
                self.assertEqual(inspect_database(path)["status"], "UPGRADE_REQUIRED")

    def test_collateral_update_trigger_detected_and_rolled_back(self):
        self.fixture()
        with fixture_connection(self.db) as db:
            db.execute("CREATE TRIGGER unexpected_update AFTER UPDATE ON sale_lines BEGIN UPDATE lot_balances SET quantity_mg=quantity_mg+1; END")
        before = logical_snapshot(self.db)
        with self.assertRaises(SchemaUpgradeRequired):
            migrate_copy(self.db, confirmed_offline_copy=True)
        self.assertEqual(before, logical_snapshot(self.db))

    def test_fresh_init_version_constraints_and_second_init_noop(self):
        initialize_database(self.db, FRESH_SCHEMA)
        self.assertEqual(inspect_database(self.db)["status"], "READY")
        with fixture_connection(self.db) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.db.stat().st_mode), 0o600)
        before = logical_snapshot(self.db)
        initialize_database(self.db, FRESH_SCHEMA)
        self.assertEqual(before, logical_snapshot(self.db))
        with fixture_connection(self.db) as db:
            # Foreign keys are irrelevant for these deliberately invalid money rows.
            sql = "INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,payment_method,subtotal_satang,discount_satang,total_satang,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
            for subtotal, discount, total in ((10, -1, 11), (10, 2, 9)):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql, ("bad", "none", "bad", "hash", "none", "cash", subtotal, discount, total, "fixture"))
            for gross, discount, net in ((10, -1, 11), (10, 2, 9)):
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute("INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,unit_price_satang_per_gram,line_subtotal_satang,line_discount_satang,line_total_satang) VALUES(?,?,?,?,?,?,?,?)",
                               ("bad", "none", "none", 1, 1, gross, discount, net))

    def test_existing_ready_factory_preserves_delete_journal_and_file(self):
        self.fixture()
        migrate_copy(self.db, confirmed_offline_copy=True)
        with fixture_connection(self.db) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        before = self.db.read_bytes()
        initialize_database(self.db, FRESH_SCHEMA)
        self.assertEqual(before, self.db.read_bytes())
        with fixture_connection(self.db) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_unversioned_v2_partial_future_and_missing_trigger_hold(self):
        initialize_database(self.db, FRESH_SCHEMA)
        with fixture_connection(self.db) as db:
            db.execute("PRAGMA user_version=0")
        before = logical_snapshot(self.db)
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(self.db, FRESH_SCHEMA)
        with self.assertRaises(SchemaUpgradeRequired):
            migrate_copy(self.db, confirmed_offline_copy=True)
        self.assertEqual(before, logical_snapshot(self.db))
        for kind in ("partial", "future", "missing-trigger"):
            with self.subTest(kind=kind):
                path = self.root / (kind + ".sqlite3")
                create_legacy_fixture(path)
                with fixture_connection(path) as db:
                    if kind == "partial":
                        db.execute("ALTER TABLE sales ADD COLUMN discount_satang INTEGER NOT NULL DEFAULT 0")
                    elif kind == "future":
                        db.execute("PRAGMA user_version=99")
                    else:
                        db.execute("DROP TRIGGER lines_no_update")
                before = logical_snapshot(path)
                with self.assertRaises(SchemaUpgradeRequired):
                    migrate_copy(path, confirmed_offline_copy=True)
                self.assertEqual(before, logical_snapshot(path))

    def test_empty_file_fresh_and_invalid_schema_rolls_back(self):
        self.db.touch()
        initialize_database(self.db, FRESH_SCHEMA)
        self.assertEqual(inspect_database(self.db)["status"], "READY")
        broken = self.root / "broken.sqlite3"
        with self.assertRaises(SchemaUpgradeRequired):
            initialize_database(broken, LEGACY_SCHEMA)
        self.assertEqual(inspect_database(broken)["status"], "FRESH")

    def test_explicit_copy_confirmation_and_known_service_locations_refused(self):
        self.fixture()
        before = logical_snapshot(self.db)
        with self.assertRaises(ValueError):
            migrate_copy(self.db)
        with self.assertRaises(ValueError):
            restore_copy(self.db, self.root / "restore.sqlite3")
        self.assertEqual(before, logical_snapshot(self.db))
        # Guard tested without opening a protected database on Windows.
        if __import__("os").name == "nt":
            for protected in (r"C:\RamaganV1Staging", r"C:\Ramagan\data", r"C:\RamaganV1Staging\data\ramagan.sqlite3"):
                with self.subTest(protected=protected), self.assertRaisesRegex(ValueError, "forbidden"):
                    migrate_copy(protected, confirmed_offline_copy=True)
            with self.assertRaisesRegex(ValueError, "forbidden"):
                backup_and_migrate_copy(self.db, r"C:\RamaganV1Staging", confirmed_offline_copy=True)


    def test_consistent_backup_offline_restore_and_rollback_on_failure(self):
        before = self.fixture(version=1)
        result = backup_and_migrate_copy(self.db, self.root / "private-backups", confirmed_offline_copy=True)
        backup = Path(result["backup"])
        self.assertEqual(before, logical_snapshot(backup))
        self.assertEqual(result["consistent_backup"], "PASS")
        self.assertEqual(result["offline_restore"], "PASS")
        self.assertEqual(result["restore_tables_and_rows"], "MATCH")
        self.assertFalse(list(backup.parent.glob("restore-proof-*")))
        restored = self.root / "new-offline-restore.sqlite3"
        self.assertEqual(restore_copy(backup, restored, confirmed_offline_copy=True)["status"], "PASS")
        self.assertEqual(before, logical_snapshot(restored))
        with self.assertRaises(ValueError):
            restore_copy(backup, self.db, confirmed_offline_copy=True)
        failed = self.root / "failure-copy.sqlite3"
        create_legacy_fixture(failed)
        failed_before = logical_snapshot(failed)
        def fail(stage):
            if stage == "after_version":
                raise RuntimeError("Injected")
        with self.assertRaises(RuntimeError):
            backup_and_migrate_copy(failed, self.root / "failure-backups", confirmed_offline_copy=True, failure_hook=fail)
        self.assertEqual(failed_before, logical_snapshot(failed))
        backups = list((self.root / "failure-backups").glob("ramagan-before-v4-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(failed_before, logical_snapshot(backups[0]))

    def test_source_change_after_backup_is_hold_without_migration(self):
        self.fixture()
        from migrations import _open, _snapshot
        db = _open(self.db, readonly=True)
        try:
            before = _snapshot(db)
        finally:
            db.close()
        with fixture_connection(self.db) as db:
            db.execute("UPDATE stores SET name='changed after snapshot'")
        changed = logical_snapshot(self.db)
        with self.assertRaises(SchemaUpgradeRequired):
            migrate_copy(self.db, confirmed_offline_copy=True, _expected_snapshot=before)
        self.assertEqual(changed, logical_snapshot(self.db))

    def test_cli_json_exit_codes_and_no_sensitive_row_output(self):
        self.fixture()
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["inspect", "--db", str(self.db)]), 2)
        data = json.loads(output.getvalue())
        self.assertEqual(data["status"], "UPGRADE_REQUIRED")
        self.assertNotIn("fixture-password-hash", output.getvalue())
        self.assertNotIn("original-idempotency", output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["migrate-copy", "--db", str(self.db), "--backup-dir", str(self.root / "cli-private"),
                         "--confirm", "OFFLINE_TEST_COPY_ONLY"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "PASS")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(["inspect", "--db", str(self.root / "missing.sqlite3")]), 2)
        self.assertFalse((self.root / "missing.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()
