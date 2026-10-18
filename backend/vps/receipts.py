"""Private receipt history from immutable sale money, without inventory writes."""
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

from fastapi import Depends, Query
from payments import recorded_payments

BANGKOK = ZoneInfo("Asia/Bangkok")
MAX_RANGE_DAYS = 366
HEADER_FIELDS = """s.id,s.client_sale_id,s.created_at,s.cashier_user_id AS cashier_id,
    s.payment_method,s.subtotal_satang,s.discount_satang,s.total_satang"""


def capabilities() -> dict:
    return {"receipt_history": True, "receipt_contract_version": 1}


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
    return result


def register_receipt_routes(app, path, connect, current, error):
    # One API process owns this key. A restart invalidates paging cursors only;
    # it never changes authorization, stored receipts or checkout idempotency.
    cursor_key = secrets.token_bytes(32)

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
