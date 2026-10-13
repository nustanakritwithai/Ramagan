"""Operator-only commands for Ramagan self-hosted central database.

Run from Windows VPS console. This file is never exposed as an HTTP endpoint.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from app import DEFAULT_PATH, ROLES, connect, create_store, create_user, init_database, password_hash

def new_password() -> str:
    first = getpass.getpass("New password (12+ characters, not echoed): ")
    second = getpass.getpass("Repeat password: ")
    if first != second:
        raise ValueError("Passwords do not match")
    password_hash(first)
    return first

def main() -> int:
    p = argparse.ArgumentParser(description="Ramagan POS self-hosted administrative console")
    p.add_argument("--db", default=os.getenv("RAMAGAN_DB_PATH", DEFAULT_PATH))
    commands = p.add_subparsers(dest="action", required=True)
    init = commands.add_parser("init-store", help="Create an empty store and first owner")
    init.add_argument("--store", required=True)
    init.add_argument("--owner-email", required=True)
    staff = commands.add_parser("add-user", help="Create employee account")
    staff.add_argument("--store-id", required=True)
    staff.add_argument("--email", required=True)
    staff.add_argument("--role", choices=ROLES, required=True)
    rotate = commands.add_parser("reset-password", help="Reset employee password and revoke sessions")
    rotate.add_argument("--email", required=True)
    revoke = commands.add_parser("disable-user", help="Disable employee and revoke sessions")
    revoke.add_argument("--email", required=True)
    commands.add_parser("status", help="Inspect stores and counts; no sensitive data")
    backup = commands.add_parser("backup", help="Consistent SQLite snapshot to a private directory")
    backup.add_argument("--out", required=True)
    activate = commands.add_parser("enable-sales", help="Only after legal + QA clearance")
    activate.add_argument("--store-id", required=True)
    activate.add_argument("--confirm", required=True)
    disable = commands.add_parser("disable-sales", help="Emergency stop new sales")
    disable.add_argument("--store-id", required=True)
    args = p.parse_args()
    init_database(args.db)

    if args.action == "init-store":
        pwd = new_password()
        # Avoid leaving an orphan store if owner creation fails validation.
        password_hash(pwd)
        sid = create_store(args.db, args.store)
        uid = create_user(args.db, sid, args.owner_email, pwd, "owner")
        print("Store:", sid, "| Owner:", uid, "| sales_enabled: FALSE")
        return 0

    if args.action == "add-user":
        pwd = new_password()
        uid = create_user(args.db, args.store_id, args.email, pwd, args.role)
        print("Created user:", uid, "| role:", args.role)
        return 0

    if args.action == "status":
        with connect(args.db) as db:
            rows = db.execute("""
              SELECT s.id,s.name,s.sales_enabled,
                     (SELECT count(*) FROM users u WHERE u.store_id=s.id AND u.is_active=1) AS users,
                     (SELECT count(*) FROM lots l WHERE l.store_id=s.id) AS lots,
                     (SELECT count(*) FROM sales x WHERE x.store_id=s.id) AS sales
                FROM stores s ORDER BY s.created_at
            """).fetchall()
        for r in rows:
            print(dict(r))
        if not rows:
            print("No stores yet. Run init-store.")
        return 0

    if args.action == "backup":
        target = Path(args.out).expanduser().resolve()
        if target.exists():
            raise ValueError("Backup file already exists, refusing overwrite")
        target.parent.mkdir(parents=True, exist_ok=True)
        with connect(args.db) as source, sqlite3.connect(str(target)) as destination:
            source.backup(destination)
        # Backup contains staff/session information: secure the volume and access.
        checksum = hashlib.sha256(target.read_bytes()).hexdigest()
        print("Backup:", target, "| SHA256:", checksum)
        return 0

    if args.action == "enable-sales":
        if args.confirm != "LICENSE_AND_TESTS_VERIFIED":
            raise ValueError("Compliance and QA confirmation required. Sales remain disabled.")
        with connect(args.db) as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE stores SET sales_enabled=1 WHERE id=?", (args.store_id,)
            ).rowcount
            db.commit()
        if changed != 1:
            raise ValueError("Store not found")
        print("Sales activated for store", args.store_id,
              "— operator bears responsibility for actual legal authorization.")
        return 0

    if args.action == "disable-sales":
        with connect(args.db) as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE stores SET sales_enabled=0 WHERE id=?", (args.store_id,)
            ).rowcount
            db.commit()
        if changed != 1:
            raise ValueError("Store not found")
        print("Sales disabled for", args.store_id)
        return 0

    if args.action in ("disable-user", "reset-password"):
        with connect(args.db) as db:
            user = db.execute("SELECT id FROM users WHERE email=?",
                              (args.email.strip().lower(),)).fetchone()
        if not user:
            raise ValueError("Account not found")
        new_hash = password_hash(new_password()) if args.action == "reset-password" else None
        with connect(args.db) as db:
            db.execute("BEGIN IMMEDIATE")
            if args.action == "reset-password":
                db.execute("UPDATE users SET password_hash=? WHERE id=?",
                           (new_hash, user["id"]))
            else:
                db.execute("UPDATE users SET is_active=0 WHERE id=?", (user["id"],))
            db.execute("UPDATE sessions SET revoked=1 WHERE user_id=?", (user["id"],))
            db.commit()
        print("Account updated and sessions revoked:", args.email.strip().lower())
        return 0

    return 1

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, sqlite3.Error) as exc:
        print("ERROR:", exc, file=sys.stderr)
        sys.exit(1)
