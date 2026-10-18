"""Integer lot valuation and authenticated, atomic physical stock counts."""
import hashlib
import json
import uuid
from typing import Annotated

from fastapi import Depends
from pydantic import BaseModel, Field, StrictInt, StrictStr
from stocktake_evidence import METADATA_COLUMNS, metadata as evidence_metadata

COST_CONTRACT_VERSION = 1
STOCKTAKE_CONTRACT_VERSION = 2
COST_STOCK_TABLES = frozenset({"receive_requests", "receive_rejections", "stocktakes", "stocktake_lines", "stocktake_rejections"})
COST_STOCK_TRIGGERS = frozenset({
    "receive_requests_no_update", "receive_requests_no_delete",
    "stocktakes_no_update", "stocktakes_no_delete",
    "stocktake_lines_no_update", "stocktake_lines_no_delete", "lots_cost_no_update",
    "stocktake_rejections_no_update", "stocktake_rejections_no_delete",
    "receive_rejections_no_update", "receive_rejections_no_delete",
})

EXTRA_SCHEMA = """
CREATE TABLE IF NOT EXISTS receive_requests (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_receive_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_receive_id)
);
CREATE TABLE IF NOT EXISTS stocktakes (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_stocktake_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  shift_label TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(store_id,client_stocktake_id)
);
CREATE TABLE IF NOT EXISTS stocktake_rejections (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_stocktake_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_stocktake_id)
);
CREATE TABLE IF NOT EXISTS receive_rejections (
  store_id TEXT NOT NULL REFERENCES stores(id),
  client_receive_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(store_id,client_receive_id)
);
CREATE TABLE IF NOT EXISTS stocktake_lines (
  id TEXT PRIMARY KEY,
  stocktake_id TEXT NOT NULL REFERENCES stocktakes(id),
  lot_id TEXT NOT NULL REFERENCES lots(id),
  lot_code TEXT NOT NULL,
  system_quantity_mg INTEGER NOT NULL CHECK(typeof(system_quantity_mg)='integer' AND system_quantity_mg>=0),
  counted_quantity_mg INTEGER NOT NULL CHECK(typeof(counted_quantity_mg)='integer' AND counted_quantity_mg BETWEEN 0 AND 100000000),
  variance_mg INTEGER NOT NULL CHECK(typeof(variance_mg)='integer' AND variance_mg=counted_quantity_mg-system_quantity_mg),
  stock_revision_before INTEGER NOT NULL CHECK(typeof(stock_revision_before)='integer' AND stock_revision_before>=0),
  stock_revision_after INTEGER NOT NULL CHECK(typeof(stock_revision_after)='integer' AND stock_revision_after=stock_revision_before+1),
  inventory_delta_satang INTEGER CHECK(inventory_delta_satang IS NULL OR typeof(inventory_delta_satang)='integer'),
  ledger_event_id TEXT REFERENCES ledger_events(id),
  CHECK((variance_mg=0 AND ledger_event_id IS NULL) OR (variance_mg<>0 AND ledger_event_id IS NOT NULL)),
  UNIQUE(stocktake_id,lot_id)
);
CREATE INDEX IF NOT EXISTS stocktakes_store_created ON stocktakes(store_id,created_at,id);
CREATE TRIGGER IF NOT EXISTS receive_requests_no_update BEFORE UPDATE ON receive_requests
BEGIN SELECT RAISE(ABORT, 'Immutable intake requests'); END;
CREATE TRIGGER IF NOT EXISTS receive_requests_no_delete BEFORE DELETE ON receive_requests
BEGIN SELECT RAISE(ABORT, 'Immutable intake requests'); END;
CREATE TRIGGER IF NOT EXISTS stocktakes_no_update BEFORE UPDATE ON stocktakes
BEGIN SELECT RAISE(ABORT, 'Immutable stocktakes'); END;
CREATE TRIGGER IF NOT EXISTS stocktakes_no_delete BEFORE DELETE ON stocktakes
BEGIN SELECT RAISE(ABORT, 'Immutable stocktakes'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_lines_no_update BEFORE UPDATE ON stocktake_lines
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake lines'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_lines_no_delete BEFORE DELETE ON stocktake_lines
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake lines'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_rejections_no_update BEFORE UPDATE ON stocktake_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake rejections'); END;
CREATE TRIGGER IF NOT EXISTS stocktake_rejections_no_delete BEFORE DELETE ON stocktake_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable stocktake rejections'); END;
CREATE TRIGGER IF NOT EXISTS receive_rejections_no_update BEFORE UPDATE ON receive_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable intake rejections'); END;
CREATE TRIGGER IF NOT EXISTS receive_rejections_no_delete BEFORE DELETE ON receive_rejections
BEGIN SELECT RAISE(ABORT, 'Immutable intake rejections'); END;
CREATE TRIGGER IF NOT EXISTS lots_cost_no_update BEFORE UPDATE OF cost_satang_per_gram ON lots
WHEN NEW.cost_satang_per_gram IS NOT OLD.cost_satang_per_gram
BEGIN SELECT RAISE(ABORT, 'Immutable intake cost'); END;
"""


def capabilities() -> dict:
    return {"inventory_costs": True, "cost_contract_version": COST_CONTRACT_VERSION,
            "stocktakes": True, "stocktake_contract_version": STOCKTAKE_CONTRACT_VERSION,
            "stocktake_evidence": True, "evidence_contract_version": 1,
            "split_payments": True, "payment_contract_version": 1,
            "sale_reconciliation": True, "sale_reconciliation_contract_version": 1}


def inventory_value(cost: int | None, quantity_mg: int) -> int | None:
    if type(quantity_mg) is not int or quantity_mg < 0:
        raise ValueError("Invalid server stock quantity")
    if cost is None:
        return None
    if type(cost) is not int or not 0 <= cost <= 100_000_000:
        raise ValueError("Invalid server lot cost")
    return (cost * quantity_mg + 500) // 1000


def canonical_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def product_rows(db, store_id: str, *, include_cost: bool) -> list[dict]:
    fields = "id,sku,name,category,price_satang_per_gram,active"
    if include_cost:
        fields += ",default_cost_satang_per_gram"
    return [dict(row) for row in db.execute(
        "SELECT " + fields + " FROM products WHERE store_id=? ORDER BY name,id", (store_id,))]


def inventory_snapshot(db, store_id: str) -> dict:
    db.execute("BEGIN")
    try:
        products = product_rows(db, store_id, include_cost=True)
        lots = []
        known_value = 0
        unknown_count = 0
        total_quantity = 0
        for row in db.execute("""
            SELECT l.id,l.product_id,l.lot_code,l.expires_on,l.active,
                   l.supplier_name,l.supplier_document_ref,l.received_at,
                   p.name,p.sku,p.category,p.price_satang_per_gram,p.active AS product_active,
                   b.quantity_mg,b.stock_revision,l.cost_satang_per_gram
              FROM lots l JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
              JOIN lot_balances b ON b.lot_id=l.id WHERE l.store_id=?
             ORDER BY p.name,l.lot_code,l.id
        """, (store_id,)):
            lot = dict(row)
            value = inventory_value(lot["cost_satang_per_gram"], lot["quantity_mg"])
            lot["inventory_value_satang"] = value
            lots.append(lot)
            total_quantity += lot["quantity_mg"]
            if lot["quantity_mg"] > 0 and value is None:
                unknown_count += 1
            elif value is not None:
                known_value += value
        return {"products": products, "lots": lots, "summary": {
            "quantity_mg": total_quantity, "known_inventory_value_satang": known_value,
            "inventory_value_satang": None if unknown_count else known_value,
            "unknown_cost_lot_count": unknown_count}}
    finally:
        db.rollback()


class StocktakeLineIn(BaseModel):
    lot_id: uuid.UUID
    expected_revision: StrictInt = Field(ge=0, le=9_000_000_000_000_000_000)
    counted_quantity_mg: StrictInt = Field(ge=0, le=100_000_000)
    evidence_id: uuid.UUID | None = None  # Legacy completed retries remain valid.


class StocktakeIn(BaseModel):
    client_stocktake_id: uuid.UUID
    shift_label: str = Field(min_length=1, max_length=80)
    reason: StrictStr = Field(default="", max_length=300)
    items: list[StocktakeLineIn] = Field(min_length=1, max_length=200)


def stocktake_result(db, header, *, duplicate: bool) -> dict:
    fields = ("id", "client_stocktake_id", "shift_label", "reason", "actor_user_id", "actor_email", "created_at")
    result = {key: header[key] for key in fields}
    result["duplicate"] = duplicate
    result["items"] = [dict(row) for row in db.execute("""
        SELECT id,lot_id,lot_code,system_quantity_mg,counted_quantity_mg,variance_mg,
               stock_revision_before,stock_revision_after,inventory_delta_satang
          FROM stocktake_lines WHERE stocktake_id=? ORDER BY lot_id
    """, (header["id"],))]
    for item in result["items"]:
        row = db.execute("SELECT " + ",".join("e." + name for name in METADATA_COLUMNS.split(",")) +
            " FROM stocktake_line_evidence l JOIN stocktake_evidence e ON e.id=l.evidence_id "
            "WHERE l.stocktake_line_id=?", (item.pop("id"),)).fetchone()
        item["evidence"] = evidence_metadata(row) if row else None
    return result


def prepare_stocktake(payload: StocktakeIn, error) -> tuple:
    shift, reason = payload.shift_label.strip(), payload.reason.strip()
    if not shift:
        error(422, "Shift label is required")
    items = sorted([{"lot_id": str(line.lot_id), "expected_revision": line.expected_revision,
                     "counted_quantity_mg": line.counted_quantity_mg,
                     **({"evidence_id": str(line.evidence_id)} if line.evidence_id else {})} for line in payload.items],
                   key=lambda line: line["lot_id"])
    if len({line["lot_id"] for line in items}) != len(items):
        error(422, "Duplicate lot in one stocktake")
    return shift, reason, items, canonical_hash({"shift_label": shift, "reason": reason, "items": items})


def validate_evidence(db, items, actor, client_id, error):
    for item in items:
        if not item.get("evidence_id"):
            error(422, "Scale photo evidence required for every counted lot")
        row = db.execute("SELECT rowid,sha256,byte_size FROM stocktake_evidence WHERE id=? AND store_id=? AND actor_user_id=? "
            "AND lot_id=? AND client_stocktake_id=?", (item["evidence_id"], actor["store_id"], actor["id"],
            item["lot_id"], client_id)).fetchone()
        if not row:
            error(422, "Evidence does not match this count, lot and actor")
        digest = hashlib.sha256()
        length = 0
        with db.blobopen("stocktake_evidence", "image_blob", row["rowid"], readonly=True) as blob:
            while chunk := blob.read(65536):
                digest.update(chunk)
                length += len(chunk)
        if length != row["byte_size"] or digest.hexdigest() != row["sha256"]:
            error(503, "Evidence integrity check failed")
        if db.execute("SELECT stocktake_line_id FROM stocktake_line_evidence WHERE evidence_id=?", (item["evidence_id"],)).fetchone():
            error(409, "Evidence already linked to a completed count")


def register_stock_routes(app, path, connect, current, require_manager, error, now_utc, uuid_str):
    @app.get("/v1/inventory")
    def inventory(actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            return inventory_snapshot(db, actor["store_id"])

    @app.post("/v1/stocktakes")
    def stocktake(payload: StocktakeIn, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        shift, reason, items, request_hash = prepare_stocktake(payload, error)
        with connect(path) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT * FROM stocktakes WHERE store_id=? AND client_stocktake_id=?",
                    (actor["store_id"], str(payload.client_stocktake_id))).fetchone()
                if existing:
                    if existing["request_hash"] != request_hash:
                        error(409, "Stocktake UUID already used with different payload")
                    result = stocktake_result(db, existing, duplicate=True)
                    db.rollback()
                    return result
                rejected = db.execute("SELECT request_hash FROM stocktake_rejections "
                    "WHERE store_id=? AND client_stocktake_id=?",
                    (actor["store_id"], str(payload.client_stocktake_id))).fetchone()
                if rejected:
                    if rejected["request_hash"] != request_hash:
                        error(409, "Stocktake UUID already used with different payload")
                    error(409, "Stock changed; reload and recount")
                validated = []
                for item in items:
                    lot = db.execute("""
                        SELECT l.lot_code,l.cost_satang_per_gram,b.quantity_mg,b.stock_revision
                          FROM lots l JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
                          JOIN lot_balances b ON b.lot_id=l.id WHERE l.id=? AND l.store_id=?
                    """, (item["lot_id"], actor["store_id"])).fetchone()
                    if not lot:
                        error(422, "Lot unavailable in this store")
                    if lot["stock_revision"] != item["expected_revision"]:
                        error(409, "Stock changed; reload and recount")
                    if lot["stock_revision"] >= 9_000_000_000_000_000_000:
                        error(409, "Stock revision limit reached")
                    before_value = inventory_value(lot["cost_satang_per_gram"], lot["quantity_mg"])
                    after_value = inventory_value(lot["cost_satang_per_gram"], item["counted_quantity_mg"])
                    delta_value = None if before_value is None else after_value - before_value
                    validated.append((item, lot, delta_value))
                validate_evidence(db, items, actor, str(payload.client_stocktake_id), error)
                sid, stamp = uuid_str(), now_utc()
                db.execute("""INSERT INTO stocktakes(id,store_id,client_stocktake_id,request_hash,
                    shift_label,reason,actor_user_id,actor_email,created_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (sid, actor["store_id"], str(payload.client_stocktake_id), request_hash,
                     shift, reason, actor["id"], actor["email"], stamp))
                for item, lot, delta_value in validated:
                    delta = item["counted_quantity_mg"] - lot["quantity_mg"]
                    event = uuid_str() if delta else None
                    changed = db.execute("""UPDATE lot_balances SET quantity_mg=?,updated_at=?,
                        stock_revision=stock_revision+1 WHERE lot_id=? AND stock_revision=?""",
                        (item["counted_quantity_mg"], stamp, item["lot_id"], lot["stock_revision"])).rowcount
                    if changed != 1:
                        error(409, "Stock changed; reload and recount")
                    if event:
                        db.execute("""INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,
                            event_type,quantity_delta_mg,reason,created_at) VALUES(?,?,?,?,?,?,?,?)""",
                            (event, actor["store_id"], item["lot_id"], actor["id"], "ADJUST", delta,
                             "Physical count · " + shift + " · " + reason, stamp))
                    line_id = uuid_str()
                    db.execute("""INSERT INTO stocktake_lines(id,stocktake_id,lot_id,lot_code,
                        system_quantity_mg,counted_quantity_mg,variance_mg,stock_revision_before,
                        stock_revision_after,inventory_delta_satang,ledger_event_id)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (line_id, sid, item["lot_id"], lot["lot_code"],
                        lot["quantity_mg"], item["counted_quantity_mg"], delta, lot["stock_revision"],
                        lot["stock_revision"] + 1, delta_value, event))
                    db.execute("INSERT INTO stocktake_line_evidence(stocktake_line_id,evidence_id) VALUES(?,?)",
                               (line_id, item["evidence_id"]))
                header = db.execute("SELECT * FROM stocktakes WHERE id=?", (sid,)).fetchone()
                result = stocktake_result(db, header, duplicate=False)
                db.commit()
                return result
            except Exception:
                db.rollback()
                raise

    @app.post("/v1/stocktakes/reconcile")
    def reconcile(payload: StocktakeIn, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        _, _, items, request_hash = prepare_stocktake(payload, error)
        client_id = str(payload.client_stocktake_id)
        with connect(path) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT * FROM stocktakes WHERE store_id=? AND client_stocktake_id=?",
                    (actor["store_id"], client_id)).fetchone()
                if existing:
                    if existing["request_hash"] != request_hash:
                        error(409, "Stocktake UUID already used with different payload")
                    result = {"status": "completed", "result": stocktake_result(db, existing, duplicate=True)}
                    db.rollback()
                    return result
                rejected = db.execute("SELECT request_hash,result_json FROM stocktake_rejections "
                    "WHERE store_id=? AND client_stocktake_id=?", (actor["store_id"], client_id)).fetchone()
                if rejected:
                    if rejected["request_hash"] != request_hash:
                        error(409, "Stocktake UUID already used with different payload")
                    result = json.loads(rejected["result_json"])
                    db.rollback()
                    return result
                stale = False
                for item in items:
                    row = db.execute("SELECT b.stock_revision FROM lots l JOIN lot_balances b ON b.lot_id=l.id "
                        "WHERE l.id=? AND l.store_id=?", (item["lot_id"], actor["store_id"])).fetchone()
                    if row is None or row["stock_revision"] != item["expected_revision"]:
                        stale = True
                if not stale:
                    validate_evidence(db, items, actor, client_id, error)
                    db.rollback()
                    return {"status": "pending", "client_stocktake_id": client_id}
                result = {"status": "rejected", "client_stocktake_id": client_id, "code": "STOCK_CHANGED",
                          "message": "Stock changed; reload and recount", "committed": False}
                db.execute("INSERT INTO stocktake_rejections(store_id,client_stocktake_id,request_hash,"
                    "actor_user_id,result_json,created_at) VALUES(?,?,?,?,?,?)", (actor["store_id"], client_id,
                    request_hash, actor["id"], json.dumps(result, sort_keys=True, separators=(",", ":")), now_utc()))
                db.commit()
                return result
            except Exception:
                db.rollback()
                raise

    @app.get("/v1/stocktakes")
    def history(actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            rows = db.execute("""SELECT s.id,s.client_stocktake_id,s.shift_label,s.reason,
                s.actor_user_id,s.actor_email,s.created_at,count(l.id) AS line_count,
                coalesce(sum(l.variance_mg),0) AS variance_mg FROM stocktakes s
                JOIN stocktake_lines l ON l.stocktake_id=s.id WHERE s.store_id=?
                GROUP BY s.id ORDER BY s.created_at DESC,s.id DESC LIMIT 50""", (actor["store_id"],))
            return {"stocktakes": [dict(row) for row in rows]}

    @app.get("/v1/stocktakes/by-client/{client_stocktake_id}")
    def lookup(client_stocktake_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            db.execute("BEGIN")
            try:
                header = db.execute("SELECT * FROM stocktakes WHERE store_id=? AND client_stocktake_id=?",
                    (actor["store_id"], str(client_stocktake_id))).fetchone()
                if not header:
                    error(404, "Stocktake not found")
                return stocktake_result(db, header, duplicate=True)
            finally:
                db.rollback()
