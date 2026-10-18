"""Explicit transactional upgrades for Ramagan OFFLINE/TEST database copies.

The app factory creates only fresh databases. No app/admin imports, service
operations, live migrations, or blind restore overwrites occur in this module.
"""
from __future__ import annotations
import argparse
import hashlib
from functools import lru_cache
import json
from pathlib import Path
import re
import sqlite3
from typing import Callable
import uuid
from cost_stock import COST_STOCK_TABLES, COST_STOCK_TRIGGERS, EXTRA_SCHEMA

CURRENT_SCHEMA_VERSION = 3
APP_TABLES = frozenset({"stores", "users", "sessions", "products", "lots",
                       "lot_balances", "sales", "sale_lines", "ledger_events"})
IMMUTABLE_TRIGGERS = frozenset({"ledger_no_update", "ledger_no_delete",
    "sales_no_update", "sales_no_delete", "lines_no_update", "lines_no_delete"})
NEW_FIELDS = {"sales": {"discount_satang"},
              "sale_lines": {"line_subtotal_satang", "line_discount_satang"}}
COST_FIELDS = {"products": {"default_cost_satang_per_gram"},
               "lots": {"cost_satang_per_gram"},
               "lot_balances": {"stock_revision"},
               "sale_lines": {"unit_cost_satang_per_gram", "line_cost_satang"}}


class SchemaUpgradeRequired(RuntimeError):
    """Legacy or unproved storage requires explicit operator attention."""
    def __init__(self, report: dict):
        self.report = report
        super().__init__("Schema upgrade HOLD: " + "; ".join(report.get("issues", [])))


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _open(path: Path, *, readonly: bool) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                         uri=True, timeout=20, isolation_level=None)
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=15000")
    if readonly:
        db.execute("PRAGMA query_only=ON")
    return db


def _tables(db: sqlite3.Connection) -> list[str]:
    return [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE "
        "type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _columns(db: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in db.execute("PRAGMA table_info(" + _quote(table) + ")")]


def _objects(db: sqlite3.Connection) -> list[tuple]:
    return list(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master "
                           "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"))


def _snapshot(db: sqlite3.Connection) -> dict:
    tables = _tables(db)
    return {
        "version": db.execute("PRAGMA user_version").fetchone()[0],
        "objects": _objects(db),
        "columns": {t: _columns(db, t) for t in tables},
        "foreign_keys": {t: list(db.execute("PRAGMA foreign_key_list(" + _quote(t) + ")")) for t in tables},
        "indexes": {t: sorted(list(db.execute("PRAGMA index_list(" + _quote(t) + ")")), key=repr) for t in tables},
        "rows": {t: sorted(list(db.execute("SELECT * FROM " + _quote(t))), key=repr) for t in tables},
    }


def _integrity_issues(db: sqlite3.Connection) -> list[str]:
    issues = []
    if list(db.execute("PRAGMA integrity_check")) != [("ok",)]:
        issues.append("SQLite integrity check failed")
    if list(db.execute("PRAGMA foreign_key_check")):
        issues.append("Foreign key check failed")
    return issues


def _money_issues(db: sqlite3.Connection, *, v2: bool) -> list[str]:
    issues = []
    if v2:
        bill_bad = db.execute("SELECT count(*) FROM sales WHERE "
            "typeof(subtotal_satang)<>'integer' OR typeof(total_satang)<>'integer' "
            "OR typeof(discount_satang)<>'integer' OR subtotal_satang<0 OR total_satang<0 "
            "OR discount_satang<0 OR subtotal_satang<>total_satang+discount_satang").fetchone()[0]
        line_bad = db.execute("SELECT count(*) FROM sale_lines WHERE "
            "typeof(line_total_satang)<>'integer' OR typeof(line_subtotal_satang)<>'integer' "
            "OR typeof(line_discount_satang)<>'integer' OR line_total_satang<0 "
            "OR line_subtotal_satang<0 OR line_discount_satang<0 "
            "OR line_subtotal_satang<>line_total_satang+line_discount_satang").fetchone()[0]
        aggregate_bad = db.execute("SELECT count(*) FROM sales s WHERE "
            "s.subtotal_satang<>(SELECT coalesce(sum(l.line_subtotal_satang),0) FROM sale_lines l WHERE l.sale_id=s.id) "
            "OR s.total_satang<>(SELECT coalesce(sum(l.line_total_satang),0) FROM sale_lines l WHERE l.sale_id=s.id) "
            "OR s.discount_satang<>(SELECT coalesce(sum(l.line_discount_satang),0) FROM sale_lines l WHERE l.sale_id=s.id)").fetchone()[0]
    else:
        bill_bad = db.execute("SELECT count(*) FROM sales WHERE "
            "typeof(subtotal_satang)<>'integer' OR typeof(total_satang)<>'integer' "
            "OR subtotal_satang<0 OR total_satang<0 OR subtotal_satang<>total_satang").fetchone()[0]
        line_bad = db.execute("SELECT count(*) FROM sale_lines WHERE "
            "typeof(line_total_satang)<>'integer' OR line_total_satang<0").fetchone()[0]
        aggregate_bad = db.execute("SELECT count(*) FROM sales s WHERE s.subtotal_satang<>"
            "(SELECT coalesce(sum(l.line_total_satang),0) FROM sale_lines l WHERE l.sale_id=s.id)").fetchone()[0]
    if bill_bad:
        issues.append(f"{bill_bad} sale subtotal/total balances are invalid")
    if line_bad:
        issues.append(f"{line_bad} sale line money records are invalid")
    if aggregate_bad:
        issues.append(f"{aggregate_bad} sales do not match their line sums")
    return issues


def _v2_schema_issues(db: sqlite3.Connection) -> list[str]:
    issues = []
    for table, names in NEW_FIELDS.items():
        info = {r[1]: r for r in db.execute("PRAGMA table_info(" + _quote(table) + ")")}
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
        compact = re.sub(r"[\s\"'\[\]\x60()]", "", sql.lower())
        for name in names:
            row = info[name]
            if row[2].upper() != "INTEGER" or row[3] != 1 or str(row[4]).strip("()'\" ") != "0":
                issues.append(f"{table}.{name} must be INTEGER NOT NULL DEFAULT 0")
            if name + ">=0" not in compact and "0<=" + name not in compact:
                issues.append(f"{table}.{name} is missing its nonnegative CHECK")
        expressions = (
            ("subtotal_satang=discount_satang+total_satang", "subtotal_satang=total_satang+discount_satang",
             "discount_satang+total_satang=subtotal_satang", "total_satang+discount_satang=subtotal_satang")
            if table == "sales" else
            ("line_subtotal_satang=line_discount_satang+line_total_satang", "line_subtotal_satang=line_total_satang+line_discount_satang",
             "line_discount_satang+line_total_satang=line_subtotal_satang", "line_total_satang+line_discount_satang=line_subtotal_satang")
        )
        if not any(expr in compact for expr in expressions):
            issues.append(f"{table} is missing its gross = discount + net CHECK")
    return issues


def _v3_issues(db: sqlite3.Connection) -> list[str]:
    issues = []
    for table, names in COST_FIELDS.items():
        info = {row[1]: row for row in db.execute("PRAGMA table_info(" + _quote(table) + ")")}
        sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
        compact = re.sub(r"[\s\"'\[\]\x60()]", "", sql.lower())
        for name in names:
            row = info[name]
            if row[2].upper() != "INTEGER":
                issues.append(f"{table}.{name} must be INTEGER")
            if name == "stock_revision":
                if row[3] != 1 or str(row[4]).strip("()'\" ") != "0":
                    issues.append("stock_revision must be NOT NULL DEFAULT 0")
                if "stock_revisionbetween0and9000000000000000000" not in compact:
                    issues.append("stock_revision is missing bounds CHECK")
            elif row[3] != 0 or row[4] is not None:
                issues.append(f"{table}.{name} must preserve unknown costs as nullable without default")
            if "typeof" + name + "=integer" not in compact:
                issues.append(f"{table}.{name} is missing strict integer CHECK")
            if name != "line_cost_satang" and name != "stock_revision" and name + "between0and100000000" not in compact:
                issues.append(f"{table}.{name} is missing cost bounds CHECK")
        if table == "sale_lines" and not all(part in compact for part in (
                "line_cost_satangisnullandunit_cost_satang_per_gramisnull",
                "line_cost_satang>=0andunit_cost_satang_per_gramisnotnull")):
            issues.append("Sale-line known/unknown cost CHECK is missing")
    for table, name in (("products", "default_cost_satang_per_gram"), ("lots", "cost_satang_per_gram"),
                        ("sale_lines", "unit_cost_satang_per_gram")):
        if db.execute("SELECT count(*) FROM " + table + " WHERE " + name + " IS NOT NULL AND "
                      "(typeof(" + name + ")<>'integer' OR " + name + " NOT BETWEEN 0 AND 100000000)").fetchone()[0]:
            issues.append("Invalid stored cost in " + table)
    if db.execute("SELECT count(*) FROM lot_balances WHERE typeof(stock_revision)<>'integer' "
                  "OR stock_revision NOT BETWEEN 0 AND 9000000000000000000").fetchone()[0]:
        issues.append("Invalid stock revision")
    if db.execute("SELECT count(*) FROM sale_lines WHERE "
                  "(unit_cost_satang_per_gram IS NULL)<>(line_cost_satang IS NULL) OR "
                  "(line_cost_satang IS NOT NULL AND (typeof(line_cost_satang)<>'integer' OR line_cost_satang<0))").fetchone()[0]:
        issues.append("Invalid sale-line known/unknown cost")
    expected = _cost_schema_objects()
    actual = {(row[0], row[1]): row[3] for row in _objects(db)}
    for key, sql in expected.items():
        normalize = lambda value: re.sub(r"\s+", "", value or "").lower().replace("ifnotexists", "")
        if normalize(actual.get(key)) != normalize(sql):
            issues.append("Missing or unexpected cost/stocktake schema object: " + key[1])
    return issues


@lru_cache(maxsize=1)
def _cost_schema_objects() -> dict:
    """Canonical new table columns/checks/FKs/indexes and immutable trigger bodies."""
    db = sqlite3.connect(":memory:")
    try:
        db.executescript("CREATE TABLE stores(id TEXT);CREATE TABLE users(id TEXT);"
            "CREATE TABLE lots(id TEXT,cost_satang_per_gram INTEGER);CREATE TABLE ledger_events(id TEXT);")
        db.executescript(EXTRA_SCHEMA)
        return {(row[0], row[1]): row[3] for row in _objects(db)
                if row[1] in COST_STOCK_TABLES or row[1] in COST_STOCK_TRIGGERS or row[1] == "stocktakes_store_created"}
    finally:
        db.close()


def _assessment(db: sqlite3.Connection) -> dict:
    version = db.execute("PRAGMA user_version").fetchone()[0]
    tables = set(_tables(db))
    report = {"status": "HOLD", "schema_version": version, "classification": "unknown", "issues": []}
    if not tables and not _objects(db) and version == 0:
        report.update(status="FRESH", classification="empty")
        return report
    if not APP_TABLES.issubset(tables):
        report["issues"].append("Incomplete or unrelated application schema; fresh initialization refused")
        return report
    present = {t: NEW_FIELDS[t].intersection(_columns(db, t)) for t in NEW_FIELDS}
    all_new = all(present[t] == NEW_FIELDS[t] for t in NEW_FIELDS)
    none_new = all(not present[t] for t in NEW_FIELDS)
    if not all_new and not none_new:
        report["issues"].append("Partial discount schema; operator investigation required")
        return report
    present_cost = {t: COST_FIELDS[t].intersection(_columns(db, t)) for t in COST_FIELDS}
    all_cost = all(present_cost[t] == COST_FIELDS[t] for t in COST_FIELDS)
    any_cost = any(present_cost.values()) or bool(tables.intersection(COST_STOCK_TABLES))
    if any_cost and (not all_cost or not COST_STOCK_TABLES.issubset(tables)):
        report["issues"].append("Partial cost/stocktake schema; operator investigation required")
        return report
    triggers = {r[1] for r in _objects(db) if r[0] == "trigger"}
    if not IMMUTABLE_TRIGGERS.issubset(triggers):
        report["issues"].append("Required immutable triggers are missing")
    if version not in (0, 1, 2, CURRENT_SCHEMA_VERSION):
        report["issues"].append("Unsupported schema version")
    if version >= 2 and not all_new:
        report["issues"].append("Versioned schema lacks discount fields")
    if version == CURRENT_SCHEMA_VERSION and (not all_cost or not COST_STOCK_TRIGGERS.issubset(triggers)):
        report["issues"].append("Schema version 3 lacks cost/stocktake fields or immutable triggers")
    try:
        report["issues"].extend(_integrity_issues(db))
        if db.execute("SELECT count(*) FROM lot_balances WHERE typeof(quantity_mg)<>'integer' "
                      "OR quantity_mg NOT BETWEEN 0 AND 100000000").fetchone()[0]:
            report["issues"].append("Stock quantities must be integer milligrams within supported bounds; no automatic conversion")
        report["issues"].extend(_money_issues(db, v2=all_new))
        if all_new:
            report["issues"].extend(_v2_schema_issues(db))
        if all_cost:
            report["issues"].extend(_v3_issues(db))
    except sqlite3.DatabaseError:
        report["issues"].append("Schema cannot satisfy the required money proof")
    report["classification"] = "cost_stock_v3" if all_cost else ("discount_v2" if all_new else "legacy")
    report["table_counts"] = {t: db.execute("SELECT count(*) FROM " + _quote(t)).fetchone()[0] for t in sorted(tables)}
    if not report["issues"]:
        if all_new and all_cost and version == CURRENT_SCHEMA_VERSION:
            report["status"] = "READY"
        elif (none_new and not any_cost and version in (0, 1)) or (all_new and not any_cost and version == 2):
            report["status"] = "UPGRADE_REQUIRED"
            report["issues"] = ["Schema upgrade requires explicit backed-up offline-copy migration"]
        else:
            report["issues"] = ["Unversioned or inconsistent schema requires operator proof; automatic adoption refused"]
    return report


def inspect_database(path: str | Path) -> dict:
    """Read-only: no creation, initialization, service access or app imports."""
    target = Path(path)
    if not target.is_file():
        return {"status": "HOLD", "classification": "missing", "schema_version": None,
                "issues": ["Database file does not exist"]}
    db = _open(target, readonly=True)
    try:
        db.execute("BEGIN")
        return _assessment(db)
    finally:
        db.rollback()
        db.close()


def _schema_statements(schema_sql: str):
    buffer = ""
    for char in schema_sql:
        buffer += char
        if char == ";" and sqlite3.complete_statement(buffer):
            if buffer.strip():
                yield buffer.strip()
            buffer = ""
    if buffer.strip():
        if not sqlite3.complete_statement(buffer + ";"):
            raise ValueError("Incomplete schema SQL")
        yield buffer.strip()


def initialize_database(path: str | Path, schema_sql: str) -> None:
    """Create fresh databases only; legacy databases raise before any DDL."""
    target = Path(path)
    if target.exists():
        report = inspect_database(target)
        if report["status"] == "READY":
            return
        if report["status"] != "FRESH":
            raise SchemaUpgradeRequired(report)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.touch(mode=0o600, exist_ok=False)
    db = sqlite3.connect(target, timeout=20, isolation_level=None)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        # Preserve the original fresh-database WAL behavior. Existing READY or
        # legacy databases return/raise above without changing their journal mode.
        report = _assessment(db)
        if report["status"] != "FRESH":
            raise SchemaUpgradeRequired(report)
        if db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() != "wal":
            raise sqlite3.DatabaseError("Fresh database could not enable WAL")
        db.execute("BEGIN IMMEDIATE")
        report = _assessment(db)
        if report["status"] != "FRESH":
            raise SchemaUpgradeRequired(report)
        for statement in _schema_statements(schema_sql):
            db.execute(statement)
        db.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
        report = _assessment(db)
        if report["status"] != "READY":
            raise SchemaUpgradeRequired(report)
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _copy_guard(path: Path, confirmed: bool) -> None:
    if not confirmed:
        raise ValueError("Explicit confirmed_offline_copy=True is required")
    normalized = str(path.resolve()).replace("\\", "/").lower()
    protected = ("c:/ramaganv1staging", "c:/ramagan/data", "c:/ramaganv1/data")
    if any(normalized == root or normalized.startswith(root + "/") for root in protected):
        raise ValueError("Known service database locations are forbidden; use an offline/test copy")


def _preservation_issues(db: sqlite3.Connection, before: dict) -> list[str]:
    after = _snapshot(db)
    issues = []
    if not set(before["rows"]).issubset(after["rows"]) or set(after["rows"]) - set(before["rows"]) - COST_STOCK_TABLES:
        issues.append("Original table set changed unexpectedly")
    original_objects = {(r[0], r[1]): r for r in before["objects"]}
    current_objects = {(r[0], r[1]): r for r in after["objects"]}
    allowed_new = ({("table", name) for name in COST_STOCK_TABLES} |
                   {("trigger", name) for name in COST_STOCK_TRIGGERS} |
                   {("index", "stocktakes_store_created")})
    if not set(original_objects).issubset(current_objects) or set(current_objects) - set(original_objects) - allowed_new:
        issues.append("Original schema object set changed unexpectedly")
    for key, original in original_objects.items():
        if key not in {("table", name) for name in ("sales", "sale_lines", "products", "lots", "lot_balances")} and current_objects.get(key) != original:
            issues.append("Original trigger/index/view/other-table SQL changed")
            break
    for table, columns in before["columns"].items():
        projection = ",".join(_quote(c) for c in columns)
        rows = sorted(list(db.execute("SELECT " + projection + " FROM " + _quote(table))), key=repr)
        if repr(rows) != repr(before["rows"][table]):
            issues.append("Original row fields changed in " + table)
        if after["foreign_keys"][table] != before["foreign_keys"][table] or after["indexes"][table] != before["indexes"][table]:
            issues.append("Original foreign keys or indexes changed in " + table)
    return issues


def migrate_copy(path: str | Path, *, confirmed_offline_copy: bool = False,
                 failure_hook: Callable[[str], None] | None = None,
                 _expected_snapshot: dict | None = None) -> dict:
    """All DDL/data/version changes roll back together on any failure."""
    target = Path(path)
    _copy_guard(target, confirmed_offline_copy)
    db = _open(target, readonly=False)
    try:
        db.execute("BEGIN IMMEDIATE")
        before = _snapshot(db)
        if _expected_snapshot is not None and before != _expected_snapshot:
            raise SchemaUpgradeRequired({"status": "HOLD", "issues": ["Source changed after verified backup; migration refused"]})
        report = _assessment(db)
        if report["status"] == "READY":
            db.rollback()
            return {**report, "status": "NOOP", "changed": False}
        if report["status"] != "UPGRADE_REQUIRED":
            raise SchemaUpgradeRequired(report)
        # Every version step shares this transaction and the original backup proof.
        if report["classification"] == "legacy":
            db.execute("ALTER TABLE sales ADD COLUMN discount_satang INTEGER NOT NULL DEFAULT 0 "
                       "CHECK(discount_satang >= 0 AND subtotal_satang = total_satang + discount_satang)")
            db.execute("ALTER TABLE sale_lines ADD COLUMN line_subtotal_satang INTEGER NOT NULL DEFAULT 0 "
                       "CHECK(line_subtotal_satang >= 0)")
            if failure_hook:
                failure_hook("after_ddl")
            trigger_sql = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' "
                "AND name='lines_no_update' AND tbl_name='sale_lines'").fetchone()
            if not trigger_sql or not trigger_sql[0]:
                raise SchemaUpgradeRequired({"status": "HOLD", "issues": ["Exact sale-line immutable trigger not found"]})
            db.execute("DROP TRIGGER lines_no_update")
            if failure_hook:
                failure_hook("after_trigger_drop")
            db.execute("UPDATE sale_lines SET line_subtotal_satang = line_total_satang")
            db.execute(trigger_sql[0])
            if failure_hook:
                failure_hook("after_backfill")
            db.execute("ALTER TABLE sale_lines ADD COLUMN line_discount_satang INTEGER NOT NULL DEFAULT 0 "
                       "CHECK(line_discount_satang >= 0 AND line_subtotal_satang = line_total_satang + line_discount_satang)")
        for table, name in (("products", "default_cost_satang_per_gram"), ("lots", "cost_satang_per_gram"),
                            ("sale_lines", "unit_cost_satang_per_gram")):
            db.execute("ALTER TABLE " + table + " ADD COLUMN " + name + " INTEGER CHECK(" + name +
                " IS NULL OR (typeof(" + name + ")='integer' AND " + name + " BETWEEN 0 AND 100000000))")
        db.execute("ALTER TABLE sale_lines ADD COLUMN line_cost_satang INTEGER CHECK("
            "(line_cost_satang IS NULL AND unit_cost_satang_per_gram IS NULL) OR "
            "(typeof(line_cost_satang)='integer' AND line_cost_satang>=0 AND unit_cost_satang_per_gram IS NOT NULL))")
        db.execute("ALTER TABLE lot_balances ADD COLUMN stock_revision INTEGER NOT NULL DEFAULT 0 "
                   "CHECK(typeof(stock_revision)='integer' AND stock_revision BETWEEN 0 AND 9000000000000000000)")
        if failure_hook:
            failure_hook("after_cost_ddl")
        for statement in _schema_statements(EXTRA_SCHEMA):
            db.execute(statement)
        if failure_hook:
            failure_hook("after_cost_tables")
        issues = (_preservation_issues(db, before) + _integrity_issues(db) +
                  _money_issues(db, v2=True) + _v2_schema_issues(db) + _v3_issues(db))
        if issues:
            raise SchemaUpgradeRequired({"status": "HOLD", "issues": issues})
        db.execute(f"PRAGMA user_version={CURRENT_SCHEMA_VERSION}")
        if failure_hook:
            failure_hook("after_version")
        db.commit()
        return {"status": "PASS", "changed": True, "schema_version": CURRENT_SCHEMA_VERSION,
                "original_fields_preserved": True, "immutable_triggers_preserved": True,
                "foreign_keys": "PASS", "integrity": "PASS", "historical_costs": "UNKNOWN_PRESERVED",
                "legacy_discount_satang": 0 if report["classification"] == "legacy" else "PRESERVED"}
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verified_copy(source: Path, destination: Path) -> dict:
    if destination.exists():
        raise ValueError("Copy destination must not exist")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.touch(mode=0o600, exist_ok=False)
    try:
        src = _open(source, readonly=True)
        dst = sqlite3.connect(destination, isolation_level=None)
        try:
            src.execute("BEGIN")
            expected = _snapshot(src)
            src.backup(dst)
            actual = _snapshot(dst)
            issues = _integrity_issues(dst)
            if actual != expected or issues:
                raise SchemaUpgradeRequired({"status": "HOLD", "issues": issues or ["Backup schema/rows/version differ from source snapshot"]})
            return expected
        finally:
            src.close()
            dst.close()
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def restore_copy(backup: str | Path, output: str | Path, *, confirmed_offline_copy: bool = False) -> dict:
    """Restore a NEW offline copy; overwriting any existing target is refused."""
    source, target = Path(backup), Path(output)
    _copy_guard(target, confirmed_offline_copy)
    _copy_guard(source, confirmed_offline_copy)
    if source.resolve() == target.resolve():
        raise ValueError("Backup and output must differ")
    _verified_copy(source, target)
    return {"status": "PASS", "restored_copy": str(target.resolve()), "sha256": _sha256(target),
            "integrity": "PASS", "foreign_keys": "PASS", "tables_and_rows": "MATCH"}


def backup_and_migrate_copy(path: str | Path, backup_directory: str | Path, *,
                           confirmed_offline_copy: bool = False,
                           failure_hook: Callable[[str], None] | None = None) -> dict:
    target, directory = Path(path), Path(backup_directory)
    _copy_guard(target, confirmed_offline_copy)
    _copy_guard(directory, confirmed_offline_copy)
    report = inspect_database(target)
    if report["status"] == "READY":
        return migrate_copy(target, confirmed_offline_copy=True)
    if report["status"] != "UPGRADE_REQUIRED":
        raise SchemaUpgradeRequired(report)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = directory / ("ramagan-before-v3-" + uuid.uuid4().hex + ".sqlite3")
    expected = _verified_copy(target, backup)
    clone = directory / ("restore-proof-" + uuid.uuid4().hex + ".sqlite3")
    try:
        restore_copy(backup, clone, confirmed_offline_copy=True)
    finally:
        clone.unlink(missing_ok=True)
    result = migrate_copy(target, confirmed_offline_copy=True, failure_hook=failure_hook, _expected_snapshot=expected)
    return {**result, "backup": str(backup.resolve()), "backup_sha256": _sha256(backup),
            "consistent_backup": "PASS", "offline_restore": "PASS",
            "restore_tables_and_rows": "MATCH", "temporary_restore_cleaned": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--db", required=True)
    migrate = commands.add_parser("migrate-copy")
    migrate.add_argument("--db", required=True)
    migrate.add_argument("--backup-dir", required=True, help="Private directory outside repository/web roots")
    migrate.add_argument("--confirm", required=True, choices=["OFFLINE_TEST_COPY_ONLY"])
    restore = commands.add_parser("restore-copy")
    restore.add_argument("--backup", required=True)
    restore.add_argument("--out", required=True)
    restore.add_argument("--confirm", required=True, choices=["OFFLINE_TEST_COPY_ONLY"])
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_database(args.db)
        elif args.command == "migrate-copy":
            result = backup_and_migrate_copy(args.db, args.backup_dir, confirmed_offline_copy=True)
        else:
            result = restore_copy(args.backup, args.out, confirmed_offline_copy=True)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] in ("READY", "FRESH", "PASS", "NOOP") else 2
    except SchemaUpgradeRequired as exc:
        print(json.dumps(exc.report, sort_keys=True))
        return 2
    except (OSError, sqlite3.DatabaseError, ValueError) as exc:
        print(json.dumps({"status": "HOLD", "error_type": type(exc).__name__,
                          "issues": ["Operation failed; no migration was committed"]}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
