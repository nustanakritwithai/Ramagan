"""Ramagan POS V1 — central API for one self-hosted Windows VPS.

All inventory writes run in SQLite BEGIN IMMEDIATE transactions. This is
single-node software, NOT a multi-primary replica or automatic offline POS.
No live regulated sales until site/license compliance and QA are signed off.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from datetime import date, datetime, timezone, timedelta
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from reports import build_sales_report

APP_VERSION = "1.1.0-vps-preview"
BKK = ZoneInfo("Asia/Bangkok")
ROLES = ("owner", "manager", "staff")
DEFAULT_PATH = str(Path.home() / "Ramagan" / "data" / "ramagan.sqlite3")
PASSWORD_WORK = 2**14
MAX_AMOUNT = 100_000_000  # max price: 1 million baht per gram (satang)
MAX_STOCK_MG = 100_000_000

SCHEMA = """
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

def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def uuid_str() -> str:
    return str(uuid.uuid4())

@contextmanager
def connect(path: str):
    db = sqlite3.connect(path, timeout=20, isolation_level=None, check_same_thread=False)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        yield db
    finally:
        db.close()

def init_database(path: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file():
        target.touch(mode=0o600)
    with connect(path) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)

def password_hash(password: str) -> str:
    if len(password) < 12 or len(password) > 128:
        raise ValueError("Password must contain between 12 and 128 characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=PASSWORD_WORK, r=8, p=1, dklen=32)
    return "scrypt-v1$" + salt.hex() + "$" + digest.hex()

def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt-v1":
            return False
        expected = bytes.fromhex(hash_hex)
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex),
                                n=PASSWORD_WORK, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def create_store(path: str, name: str) -> str:
    if not 1 <= len(name.strip()) <= 120:
        raise ValueError("Store name required")
    sid = uuid_str()
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT INTO stores(id,name,created_at) VALUES(?,?,?)",
                   (sid, name.strip(), now_utc()))
        db.commit()
    return sid

def create_user(path: str, store_id: str, email: str, password: str, role: str) -> str:
    if role not in ROLES or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email.strip()):
        raise ValueError("Invalid role or email")
    hashed = password_hash(password)
    uid = uuid_str()
    with connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO users(id,store_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
            (uid, store_id, email.strip().lower(), hashed, role, now_utc())
        )
        db.commit()
    return uid

class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

class ProductIn(BaseModel):
    sku: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(default="other", min_length=1, max_length=60)
    price_satang_per_gram: int = Field(ge=0, le=MAX_AMOUNT)

class ReceiveIn(BaseModel):
    product_id: uuid.UUID
    lot_code: str = Field(min_length=1, max_length=100)
    supplier_name: str = Field(min_length=1, max_length=200)
    supplier_document_ref: str = Field(min_length=1, max_length=200)
    quantity_mg: int = Field(gt=0, le=MAX_STOCK_MG)
    expires_on: date | None = None
    reason: str = Field(min_length=1, max_length=500)

class SaleLineIn(BaseModel):
    lot_id: uuid.UUID
    quantity_mg: int = Field(gt=0, le=1_000_000)

class SaleIn(BaseModel):
    client_sale_id: uuid.UUID
    items: list[SaleLineIn] = Field(min_length=1, max_length=50)
    payment_method: str
    authorization_ref: str | None = Field(default=None, max_length=120)

def error(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)

def require_manager(actor: dict):
    if actor["role"] not in ("owner", "manager"):
        error(403, "Owner or manager permission required")

def create_app(db_path: str | None = None, origins: list[str] | None = None) -> FastAPI:
    path = str(db_path or os.environ.get("RAMAGAN_DB_PATH") or DEFAULT_PATH)
    init_database(path)
    allowed = origins if origins is not None else [
        o.strip() for o in os.environ.get(
            "RAMAGAN_CORS_ORIGINS",
            "https://localhost,https://nustanakritwithai.github.io,http://localhost:5173"
        ).split(",") if o.strip()
    ]
    app = FastAPI(title="Ramagan POS Central API", version=APP_VERSION,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db_path = path
    app.state.login_failures = {}
    app.add_middleware(CORSMiddleware, allow_origins=allowed,
                       allow_credentials=False,
                       allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])

    @app.middleware("http")
    async def no_store_response(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def current(authorization: Annotated[str | None, Header()] = None) -> dict:
        if not authorization or not authorization.startswith("Bearer "):
            error(401, "Login required")
        token = authorization[7:].strip()
        if len(token) < 32 or len(token) > 256:
            error(401, "Invalid session")
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with connect(path) as db:
            row = db.execute("""
              SELECT u.id,u.store_id,u.email,u.role,u.is_active,s.expires_at
                FROM sessions s JOIN users u ON u.id=s.user_id
               WHERE s.token_hash=? AND s.revoked=0
            """, (token_hash,)).fetchone()
        if not row or not row["is_active"] or row["expires_at"] <= int(time.time()):
            error(401, "Session expired or revoked")
        return dict(row)

    @app.get("/health")
    def health():
        try:
            with connect(path) as db:
                db.execute("SELECT 1").fetchone()
        except sqlite3.Error:
            error(503, "Database unavailable")
        return {"status": "ok", "version": APP_VERSION, "production_sales": "controlled_by_store"}

    @app.post("/v1/auth/login")
    def login(payload: LoginIn, request: Request):
        email = payload.email.strip().lower()
        ip = (request.client.host if request.client else "unknown")[:70]
        key = (ip, email)
        recent = [t for t in app.state.login_failures.get(key, []) if time.monotonic() - t < 600]
        if len(recent) >= 8:
            error(429, "Too many sign-in attempts; wait 10 minutes")
        with connect(path) as db:
            user = db.execute(
                "SELECT * FROM users WHERE email=? AND is_active=1", (email,)
            ).fetchone()
        good = bool(user and verify_password(payload.password, user["password_hash"]))
        if not good:
            recent.append(time.monotonic())
            app.state.login_failures[key] = recent
            error(401, "Invalid email or password")
        app.state.login_failures.pop(key, None)
        token = secrets.token_urlsafe(48)
        expires = int(time.time()) + 8 * 3600
        with connect(path) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM sessions WHERE expires_at < ?", (int(time.time()),))
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
                       (hashlib.sha256(token.encode()).hexdigest(), user["id"], expires))
            db.commit()
        return {"token": token, "expires_at": expires,
                "user": {"id": user["id"], "email": user["email"]}}

    @app.post("/v1/auth/logout")
    def logout(authorization: Annotated[str | None, Header()] = None):
        if authorization and authorization.startswith("Bearer "):
            h = hashlib.sha256(authorization[7:].strip().encode()).hexdigest()
            with connect(path) as db:
                db.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (h,))
        return {"ok": True}

    @app.get("/v1/me")
    def me(actor: Annotated[dict, Depends(current)]):
        with connect(path) as db:
            store = db.execute(
                "SELECT id,name,sales_enabled,requires_authorization FROM stores WHERE id=?",
                (actor["store_id"],)
            ).fetchone()
        if not store:
            error(403, "Store unavailable")
        return {
            "user": {"id": actor["id"], "email": actor["email"]},
            "store_id": actor["store_id"],
            "role": actor["role"],
            "store": {**dict(store),
                      "sales_enabled": bool(store["sales_enabled"]),
                      "requires_authorization": bool(store["requires_authorization"])}
        }

    @app.get("/v1/catalog")
    def catalog(actor: Annotated[dict, Depends(current)]):
        with connect(path) as db:
            products = [dict(r) for r in db.execute(
                "SELECT id,sku,name,category,price_satang_per_gram,active FROM products WHERE store_id=? ORDER BY name",
                (actor["store_id"],))]
            lots = [dict(r) for r in db.execute("""
             SELECT l.id,l.lot_code,l.expires_on,l.active,
                    p.name,p.sku,p.price_satang_per_gram,p.active AS product_active,
                    b.quantity_mg
               FROM lots l
               JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
               JOIN lot_balances b ON b.lot_id=l.id
              WHERE l.store_id=? AND l.active=1
              ORDER BY p.name,l.lot_code
            """, (actor["store_id"],))]
        return {"products": products, "lots": lots}

    @app.post("/v1/products")
    def add_product(payload: ProductIn, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        if not payload.sku.strip() or not payload.name.strip() or not payload.category.strip():
            error(422, "SKU, name and category are required")
        pid = uuid_str()
        try:
            with connect(path) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("""
                    INSERT INTO products(id,store_id,sku,name,category,price_satang_per_gram,created_at)
                    VALUES(?,?,?,?,?,?,?)
                """, (pid, actor["store_id"], payload.sku.strip(), payload.name.strip(),
                      payload.category.strip(), payload.price_satang_per_gram, now_utc()))
                db.commit()
        except sqlite3.IntegrityError:
            error(409, "Duplicate SKU or invalid product")
        return {"product_id": pid, "created": True}

    @app.post("/v1/lots/receive")
    def receive(payload: ReceiveIn, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        if not all(x.strip() for x in (
            payload.lot_code, payload.supplier_name, payload.supplier_document_ref, payload.reason
        )):
            error(422, "Lot code, supplier, document reference and reason are required")
        if payload.expires_on and payload.expires_on < datetime.now(BKK).date():
            error(422, "Expired stock cannot be received")
        lot_id, event_id = uuid_str(), uuid_str()
        try:
            with connect(path) as db:
                db.execute("BEGIN IMMEDIATE")
                product = db.execute(
                    "SELECT id FROM products WHERE id=? AND store_id=? AND active=1",
                    (str(payload.product_id), actor["store_id"])
                ).fetchone()
                if not product:
                    error(422, "Product unavailable in this store")
                stamp = now_utc()
                db.execute("""
                    INSERT INTO lots(id,store_id,product_id,lot_code,supplier_name,
                                     supplier_document_ref,expires_on,received_at)
                    VALUES(?,?,?,?,?,?,?,?)
                """, (lot_id, actor["store_id"], str(payload.product_id),
                      payload.lot_code.strip(), payload.supplier_name.strip(),
                      payload.supplier_document_ref.strip(),
                      payload.expires_on.isoformat() if payload.expires_on else None, stamp))
                db.execute("INSERT INTO lot_balances(lot_id,quantity_mg,updated_at) VALUES(?,?,?)",
                           (lot_id, payload.quantity_mg, stamp))
                db.execute("""
                    INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,
                                              quantity_delta_mg,reason,created_at)
                    VALUES(?,?,?,?,?,?,?,?)
                """, (event_id, actor["store_id"], lot_id, actor["id"], "RECEIVE",
                      payload.quantity_mg, payload.reason.strip(), stamp))
                db.commit()
        except sqlite3.IntegrityError:
            error(409, "Duplicate lot code or invalid stock record")
        return {"lot_id": lot_id, "event_id": event_id, "quantity_mg": payload.quantity_mg}

    @app.post("/v1/sales")
    def checkout(payload: SaleIn, actor: Annotated[dict, Depends(current)]):
        if payload.payment_method not in ("cash", "transfer"):
            error(422, "Invalid payment method")
        ref = (payload.authorization_ref or "").strip()
        ids = [str(x.lot_id) for x in payload.items]
        if len(set(ids)) != len(ids):
            error(422, "Duplicate lot in one checkout")
        items = sorted([
            {"lot_id": str(x.lot_id), "quantity_mg": x.quantity_mg}
            for x in payload.items
        ], key=lambda x: x["lot_id"])
        request_hash = hashlib.sha256(json.dumps({
            "items": items, "payment_method": payload.payment_method,
            "authorization_ref": ref
        }, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        sid = uuid_str()
        with connect(path) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("""
                  SELECT id,total_satang,request_hash,cashier_user_id FROM sales
                   WHERE store_id=? AND client_sale_id=?
                """, (actor["store_id"], str(payload.client_sale_id))).fetchone()
                if existing:
                    if existing["cashier_user_id"] != actor["id"]:
                        error(403, "Checkout belongs to another cashier")
                    if existing["request_hash"] != request_hash:
                        error(409, "Checkout ID reused with different payload")
                    db.rollback()
                    return {"sale_id": existing["id"],
                            "total_satang": existing["total_satang"], "duplicate": True}
                store = db.execute("""
                   SELECT sales_enabled,requires_authorization FROM stores WHERE id=?
                """, (actor["store_id"],)).fetchone()
                if not store or not store["sales_enabled"]:
                    error(403, "Sales are not activated for this store")
                if store["requires_authorization"] and not ref:
                    error(422, "Authorized document reference required")
                total = 0
                stamp = now_utc()
                validated = []
                # Preflight every line before inserting the immutable sale.
                # BEGIN IMMEDIATE already serializes concurrent SQLite writers.
                for item in items:
                    lot = db.execute("""
                       SELECT b.quantity_mg,p.price_satang_per_gram,l.expires_on
                         FROM lots l JOIN products p ON p.id=l.product_id
                           JOIN lot_balances b ON b.lot_id=l.id
                        WHERE l.id=? AND l.store_id=? AND p.store_id=?
                          AND l.active=1 AND p.active=1
                    """, (item["lot_id"], actor["store_id"], actor["store_id"])).fetchone()
                    if not lot:
                        error(422, "Lot unavailable or inactive")
                    if lot["expires_on"] and lot["expires_on"] < datetime.now(BKK).date().isoformat():
                        error(422, "Expired lot cannot be sold")
                    qty = item["quantity_mg"]
                    if lot["quantity_mg"] < qty:
                        error(409, "Insufficient stock")
                    price = lot["price_satang_per_gram"]
                    line_satang = (price * qty + 500) // 1000
                    total += line_satang
                    validated.append((item["lot_id"], qty, price, line_satang))
                db.execute("""
                  INSERT INTO sales(id,store_id,client_sale_id,request_hash,cashier_user_id,
                                    payment_method,authorization_ref,subtotal_satang,
                                    total_satang,created_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?)
                """, (sid, actor["store_id"], str(payload.client_sale_id), request_hash,
                      actor["id"], payload.payment_method, ref or None, total, total, stamp))
                for lot_id, qty, price, line_satang in validated:
                    changed = db.execute("""
                      UPDATE lot_balances SET quantity_mg=quantity_mg-?,updated_at=?
                       WHERE lot_id=? AND quantity_mg>=?
                    """, (qty, stamp, lot_id, qty)).rowcount
                    if changed != 1:
                        error(409, "Concurrent stock change")
                    db.execute("""
                      INSERT INTO sale_lines(id,sale_id,lot_id,quantity_mg,
                                             unit_price_satang_per_gram,line_total_satang)
                      VALUES(?,?,?,?,?,?)
                    """, (uuid_str(), sid, lot_id, qty, price, line_satang))
                    db.execute("""
                      INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,
                                                event_type,quantity_delta_mg,reason,
                                                sale_id,created_at)
                      VALUES(?,?,?,?,?,?,?,?,?)
                    """, (uuid_str(), actor["store_id"], lot_id, actor["id"],
                          "SALE", -qty, "POS checkout", sid, stamp))
                db.commit()
            except Exception:
                db.rollback()
                raise
        return {"sale_id": sid, "total_satang": total, "duplicate": False}

    @app.get("/v1/sales/by-client/{client_sale_id}")
    def sale_lookup(client_sale_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        with connect(path) as db:
            row = db.execute("""
              SELECT id,total_satang,cashier_user_id FROM sales
               WHERE store_id=? AND client_sale_id=?
            """, (actor["store_id"], str(client_sale_id))).fetchone()
        if not row:
            error(404, "Sale not found")
        if row["cashier_user_id"] != actor["id"] and actor["role"] == "staff":
            error(403, "Not permitted to inspect this sale")
        return {"id": row["id"], "total_satang": row["total_satang"]}

    @app.get("/v1/admin/sales-report")
    def sales_report(
        actor: Annotated[dict, Depends(current)],
        from_date: date | None = Query(default=None, alias="from"),
        to_date: date | None = Query(default=None, alias="to"),
        low_stock_mg: int = Query(default=10000, ge=0, le=1_000_000_000),
    ):
        # The static GitHub Pages dashboard contains NO data or service key.
        # Every report must be authenticated and authorized against the VPS.
        require_manager(actor)
        actual_to = to_date or datetime.now(BKK).date()
        actual_from = from_date or (actual_to - timedelta(days=6))
        try:
            with connect(path) as db:
                return build_sales_report(db, actor["store_id"], actual_from,
                                          actual_to, low_stock_mg)
        except ValueError as exc:
            error(422, str(exc))

    @app.get("/v1/ledger")
    def ledger(actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            rows = db.execute("""
              SELECT id,lot_id,actor_user_id,event_type,quantity_delta_mg,
                     reason,sale_id,created_at FROM ledger_events
               WHERE store_id=? ORDER BY created_at DESC LIMIT 100
            """, (actor["store_id"],)).fetchall()
        return {"events": [dict(r) for r in rows]}

    return app

app = create_app()
