"""Private receipt history and append-only, atomic completed-sale voids."""
import base64
import binascii
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import hmac
import json
import secrets
from typing import Annotated
import uuid
from zoneinfo import ZoneInfo

from fastapi import Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from cost_stock import canonical_hash, inventory_value
from payments import recorded_payments

BANGKOK = ZoneInfo("Asia/Bangkok")
MAX_RANGE_DAYS = 366
HEADER_FIELDS = """s.id,s.client_sale_id,s.created_at,s.cashier_user_id AS cashier_id,
    s.payment_method,s.subtotal_satang,s.discount_satang,s.total_satang"""


def capabilities() -> dict:
    return {"receipt_history": True, "receipt_contract_version": 1,
            "sale_voids": True, "sale_void_contract_version": 1}


class SaleVoidIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_void_id: uuid.UUID
    reason: StrictStr = Field(min_length=1, max_length=300)


VOID_FIELDS = "id,client_void_id,sale_id,actor_user_id,actor_email,actor_role,created_at,reason"


def void_metadata(db, sale_id):
    row = db.execute("SELECT " + VOID_FIELDS + " FROM sale_voids WHERE sale_id=?", (sale_id,)).fetchone()
    return dict(row) if row else None


def _void_payments(db, sale_id, sale):
    payments = recorded_payments(db, sale_id, sale["payment_method"], sale["total_satang"])
    if sale["payment_method"] == "split":
        valid = ([row["payment_method"] for row in payments] == ["cash", "transfer"] and
                 all(type(row["amount_satang"]) is int and row["amount_satang"] > 0 for row in payments))
    else:
        valid = payments == [{"payment_method": sale["payment_method"], "amount_satang": sale["total_satang"]}]
    if not valid:
        raise ValueError("Recorded void payment allocations are inconsistent")
    return payments


def _void_result(db, row, *, duplicate):
    sale = db.execute("SELECT client_sale_id,subtotal_satang,discount_satang,total_satang,payment_method "
                      "FROM sales WHERE id=? AND store_id=?", (row["sale_id"], row["store_id"])).fetchone()
    if not sale:
        raise ValueError("Recorded void sale is unavailable")
    return {**{field: row[field] for field in VOID_FIELDS.split(",")}, **dict(sale),
            "status": "voided", "duplicate": duplicate,
            "payments": _void_payments(db, row["sale_id"], sale),
            "restored_items": [dict(item) for item in db.execute("""SELECT sale_line_id,lot_id,quantity_mg,
                quantity_before_mg,quantity_after_mg,stock_revision_before,stock_revision_after,
                inventory_delta_satang,ledger_event_id FROM sale_void_lines WHERE void_id=? ORDER BY lot_id""",
                (row["id"],))]}


def date_window(start: date | None, end: date | None, *, today: date | None = None):
    try:
        if start is None and end is None:
            end = today or datetime.now(BANGKOK).date()
            start = end - timedelta(days=29)
        elif start is None:
            start = end - timedelta(days=29)
        elif end is None:
            end = start + timedelta(days=29)
        if end < start or (end - start).days >= MAX_RANGE_DAYS:
            raise ValueError("Receipt date range must be between 1 and 366 days")
        lower = datetime.combine(start, time.min, tzinfo=BANGKOK).astimezone(timezone.utc)
        upper = datetime.combine(end + timedelta(days=1), time.min,
                                 tzinfo=BANGKOK).astimezone(timezone.utc)
    except OverflowError as exc:
        raise ValueError("Receipt date range is outside supported dates") from exc
    return start, end, lower.isoformat(timespec="seconds"), upper.isoformat(timespec="seconds")


def _binding(actor, start, end, query):
    value = {"store": actor["store_id"], "actor": actor["id"], "role": actor["role"],
             "from_date": start.isoformat(), "to_date": end.isoformat(), "q": query}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()


def _encode_cursor(row, binding, key):
    raw = json.dumps({"v": 1, "created_at": row["created_at"], "id": row["id"],
                      "binding": binding}, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(key, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw + signature).rstrip(b"=").decode("ascii")


def _decode_cursor(value, binding, key):
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
        if len(raw) <= 32:
            raise ValueError
        body, signature = raw[:-32], raw[-32:]
        if not hmac.compare_digest(signature, hmac.new(key, body, hashlib.sha256).digest()):
            raise ValueError
        data = json.loads(body)
        if (type(data) is not dict or set(data) != {"v", "created_at", "id", "binding"}
                or type(data["v"]) is not int or data["v"] != 1
                or data["binding"] != binding or type(data["created_at"]) is not str
                or len(data["created_at"]) > 80 or type(data["id"]) is not str
                or str(uuid.UUID(data["id"])) != data["id"]):
            raise ValueError
        stamp = datetime.fromisoformat(data["created_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError
        return data["created_at"], data["id"]
    except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error) as exc:
        raise ValueError("Invalid receipt cursor; reload the first page") from exc


def _where(actor, lower, upper, query):
    clauses = ["s.store_id=?", "s.created_at>=?", "s.created_at<?"]
    parameters = [actor["store_id"], lower, upper]
    if actor["role"] == "staff":
        clauses.append("s.cashier_user_id=?")
        parameters.append(actor["id"])
    if query:
        literal = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        clauses.append("""(s.id LIKE ? ESCAPE '\\' OR s.client_sale_id LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM sale_lines search_line
              JOIN lots search_lot ON search_lot.id=search_line.lot_id AND search_lot.store_id=s.store_id
              JOIN products search_product ON search_product.id=search_lot.product_id
                                           AND search_product.store_id=s.store_id
              WHERE search_line.sale_id=s.id AND
                (search_lot.lot_code LIKE ? ESCAPE '\\' OR search_product.name LIKE ? ESCAPE '\\')))""")
        parameters.extend([literal] * 4)
    return clauses, parameters


def _header(db, row):
    result = dict(row)
    result["payments"] = recorded_payments(db, row["id"], row["payment_method"], row["total_satang"])
    result["void"] = void_metadata(db, row["id"])
    result["status"] = "voided" if result["void"] else "completed"
    return result


def register_receipt_routes(app, path, connect, current, error, *, recheck_actor,
                            require_manager, now_utc, uuid_str, authorize_pos_write):
    # One API process owns this key. A restart invalidates paging cursors only;
    # it never changes authorization, stored receipts or checkout idempotency.
    cursor_key = secrets.token_bytes(32)

    @app.post("/v1/sales/{sale_id}/void")
    def void_sale(sale_id: uuid.UUID, payload: SaleVoidIn, request: Request,
                  actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        reason = payload.reason.strip()
        if not reason:
            error(422, "Void reason is required")
        sale_id, client_id = str(sale_id), str(payload.client_void_id)
        fingerprint = canonical_hash({"sale_id": sale_id, "reason": reason})
        with connect(path) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                # Waiting for another writer must not preserve an expired,
                # revoked or newly demoted session, including shared PIN roles.
                actor = recheck_actor(db, request.headers.get("authorization"), actor)
                require_manager(actor)
                existing = db.execute("SELECT * FROM sale_voids WHERE store_id=? AND client_void_id=?",
                                      (actor["store_id"], client_id)).fetchone()
                if existing:
                    if existing["request_hash"] != fingerprint:
                        error(409, "Void UUID already used with different payload")
                    result = _void_result(db, existing, duplicate=True)
                    db.rollback()
                    return result
                sale = db.execute("SELECT * FROM sales WHERE id=? AND store_id=?",
                                  (sale_id, actor["store_id"])).fetchone()
                if not sale:
                    error(404, "Sale not found")
                if db.execute("SELECT id FROM sale_voids WHERE sale_id=?", (sale_id,)).fetchone():
                    error(409, "Sale already voided")
                actor = authorize_pos_write(db, request.headers.get("authorization"), actor)
                require_manager(actor)
                # Validate recorded proof without recomputing current prices or
                # depending on whether the shop currently permits new sales.
                _void_payments(db, sale_id, sale)
                lines = db.execute("""SELECT sl.*,l.store_id AS lot_store,l.cost_satang_per_gram,
                    p.store_id AS product_store,b.quantity_mg AS current_quantity_mg,b.stock_revision
                    FROM sale_lines sl LEFT JOIN lots l ON l.id=sl.lot_id
                    LEFT JOIN products p ON p.id=l.product_id LEFT JOIN lot_balances b ON b.lot_id=l.id
                    WHERE sl.sale_id=? ORDER BY sl.lot_id,sl.id""", (sale_id,)).fetchall()
                if (not lines or any(sum(line["line_" + field] for line in lines) != sale[field]
                                     for field in ("subtotal_satang", "discount_satang", "total_satang"))):
                    error(503, "Recorded sale lines are inconsistent")
                validated = []
                for line in lines:
                    qty, before, revision = line["quantity_mg"], line["current_quantity_mg"], line["stock_revision"]
                    if (line["lot_store"] != actor["store_id"] or line["product_store"] != actor["store_id"]
                            or type(qty) is not int or qty <= 0 or type(before) is not int
                            or not 0 <= before <= 100_000_000 or type(revision) is not int or revision < 0):
                        error(503, "Recorded sale inventory is unavailable")
                    originals = db.execute("""SELECT quantity_delta_mg,store_id,lot_id,actor_user_id FROM ledger_events
                        WHERE sale_id=? AND lot_id=? AND event_type='SALE'""", (sale_id, line["lot_id"])).fetchall()
                    if (len(originals) != 1 or originals[0]["quantity_delta_mg"] != -qty
                            or originals[0]["store_id"] != actor["store_id"]
                            or originals[0]["actor_user_id"] != sale["cashier_user_id"]):
                        error(503, "Recorded sale stock ledger is inconsistent")
                    if before + qty > 100_000_000:
                        error(409, "Restored stock exceeds supported limit")
                    if revision >= 9_000_000_000_000_000_000:
                        error(409, "Stock revision limit reached")
                    before_cost = inventory_value(line["cost_satang_per_gram"], before)
                    after_cost = inventory_value(line["cost_satang_per_gram"], before + qty)
                    delta = None if before_cost is None else after_cost - before_cost
                    validated.append((line, before, revision, delta))
                actor = authorize_pos_write(db, request.headers.get("authorization"), actor)
                require_manager(actor)
                vid, stamp = uuid_str(), now_utc()
                db.execute("""INSERT INTO sale_voids(id,store_id,sale_id,client_void_id,request_hash,
                    actor_user_id,actor_email,actor_role,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (vid, actor["store_id"], sale_id, client_id, fingerprint, actor["id"], actor["email"],
                     actor["role"], reason, stamp))
                for line, before, revision, delta in validated:
                    qty, lot = line["quantity_mg"], line["lot_id"]
                    changed = db.execute("""UPDATE lot_balances SET quantity_mg=quantity_mg+?,
                        stock_revision=stock_revision+1,updated_at=? WHERE lot_id=? AND quantity_mg=? AND stock_revision=?""",
                        (qty, stamp, lot, before, revision)).rowcount
                    if changed != 1:
                        error(409, "Concurrent stock change")
                    event = uuid_str()
                    db.execute("""INSERT INTO ledger_events(id,store_id,lot_id,actor_user_id,event_type,
                        quantity_delta_mg,reason,sale_id,created_at) VALUES(?,?,?,?,'ADJUST',?,?,?,?)""",
                        (event, actor["store_id"], lot, actor["id"], qty, "Void completed sale · " + reason, sale_id, stamp))
                    db.execute("""INSERT INTO sale_void_lines(sale_line_id,void_id,lot_id,quantity_mg,
                        quantity_before_mg,quantity_after_mg,stock_revision_before,stock_revision_after,
                        inventory_delta_satang,ledger_event_id) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                        (line["id"], vid, lot, qty, before, before + qty, revision, revision + 1, delta, event))
                header = db.execute("SELECT * FROM sale_voids WHERE id=?", (vid,)).fetchone()
                result = _void_result(db, header, duplicate=False)
                db.commit()
                return result
            except ValueError:
                db.rollback()
                error(503, "Recorded sale money or cost is unavailable")
            except Exception:
                db.rollback()
                raise

    @app.get("/v1/sale-voids/by-client/{client_void_id}")
    def lookup_void(client_void_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        require_manager(actor)
        with connect(path) as db:
            db.execute("BEGIN")
            try:
                row = db.execute("SELECT * FROM sale_voids WHERE store_id=? AND client_void_id=?",
                                 (actor["store_id"], str(client_void_id))).fetchone()
                if not row:
                    error(404, "Sale void not found")
                try:
                    return _void_result(db, row, duplicate=True)
                except ValueError:
                    error(503, "Recorded sale void is unavailable")
            finally:
                db.rollback()

    @app.get("/v1/sales")
    def list_receipts(
        actor: Annotated[dict, Depends(current)],
        from_date: date | None = Query(default=None),
        to_date: date | None = Query(default=None),
        q: str = Query(default="", max_length=100),
        cursor: str | None = Query(default=None, min_length=1, max_length=2048),
        limit: int = Query(default=30, ge=1, le=100),
    ):
        query = q.strip()
        try:
            start, end, lower, upper = date_window(from_date, to_date)
            binding = _binding(actor, start, end, query)
            anchor = _decode_cursor(cursor, binding, cursor_key) if cursor is not None else None
        except ValueError as exc:
            error(422, str(exc))
        clauses, parameters = _where(actor, lower, upper, query)
        if anchor:
            clauses.append("(s.created_at<? OR (s.created_at=? AND s.id<?))")
            parameters.extend([anchor[0], anchor[0], anchor[1]])
        with connect(path) as db:
            db.execute("BEGIN")
            try:
                rows = db.execute("SELECT " + HEADER_FIELDS + " FROM sales s WHERE " +
                    " AND ".join(clauses) + " ORDER BY s.created_at DESC,s.id DESC LIMIT ?",
                    [*parameters, limit + 1]).fetchall()
                selected = rows[:limit]
                try:
                    sales = [_header(db, row) for row in selected]
                except ValueError:
                    error(503, "Recorded receipt payments are unavailable")
                next_cursor = _encode_cursor(selected[-1], binding, cursor_key) if len(rows) > limit else None
                return {"sales": sales, "next_cursor": next_cursor,
                        "from_date": start.isoformat(), "to_date": end.isoformat(),
                        "timezone": "Asia/Bangkok", "scope": "own" if actor["role"] == "staff" else "store"}
            finally:
                db.rollback()

    # Registered after existing /by-client/{UUID}; old lookup remains unchanged.
    @app.get("/v1/sales/{sale_id}")
    def receipt_detail(sale_id: uuid.UUID, actor: Annotated[dict, Depends(current)]):
        with connect(path) as db:
            db.execute("BEGIN")
            try:
                row = db.execute("SELECT " + HEADER_FIELDS + ",store.name AS store_name "
                    "FROM sales s JOIN stores store ON store.id=s.store_id "
                    "WHERE s.id=? AND s.store_id=?", (str(sale_id), actor["store_id"])).fetchone()
                if not row:
                    error(404, "Sale not found")
                if actor["role"] == "staff" and row["cashier_id"] != actor["id"]:
                    error(403, "Not permitted to inspect this sale")
                try:
                    result = _header(db, row)
                except ValueError:
                    error(503, "Recorded receipt payments are unavailable")
                lines = [dict(line) for line in db.execute("""
                    SELECT sl.lot_id,l.lot_code,p.name AS product_name,sl.quantity_mg,
                           sl.unit_price_satang_per_gram,
                           sl.line_subtotal_satang AS subtotal_satang,
                           sl.line_discount_satang AS discount_satang,sl.line_total_satang AS total_satang
                      FROM sale_lines sl
                      LEFT JOIN lots l ON l.id=sl.lot_id AND l.store_id=?
                      LEFT JOIN products p ON p.id=l.product_id AND p.store_id=?
                     WHERE sl.sale_id=? ORDER BY sl.lot_id,sl.id
                """, (actor["store_id"], actor["store_id"], str(sale_id)))]
                if (not lines or any(line["lot_code"] is None or line["product_name"] is None for line in lines)
                        or any(sum(line[field] for line in lines) != row[field]
                               for field in ("subtotal_satang", "discount_satang", "total_satang"))):
                    error(503, "Recorded receipt lines are unavailable")
                return {**result, "lines": lines}
            finally:
                db.rollback()
