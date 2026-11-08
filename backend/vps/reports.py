"""Ramagan owner/manager sales reports from authoritative SQLite records.

No mutation, no seeded/demo totals, and no unauthenticated export.
Date ranges are interpreted in Asia/Bangkok, stored timestamps are UTC.
Amounts are integer satang, stock quantities are integer milligrams.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

BANGKOK = ZoneInfo("Asia/Bangkok")
MAX_RANGE_DAYS = 93


def utc_range(start: date, end: date) -> tuple[str, str]:
    if end < start or (end - start).days >= MAX_RANGE_DAYS:
        raise ValueError("Date range must be between 1 and 93 days")
    start_utc = datetime.combine(start, time.min, tzinfo=BANGKOK).astimezone(timezone.utc)
    end_utc = datetime.combine(end + timedelta(days=1), time.min,
                               tzinfo=BANGKOK).astimezone(timezone.utc)
    return (start_utc.isoformat(timespec="seconds"),
            end_utc.isoformat(timespec="seconds"))


def to_bangkok_day(value: str) -> str:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        BANGKOK).date().isoformat()


def build_sales_report(db, store_id: str, start: date, end: date,
                       low_stock_mg: int = 10000) -> dict:
    if not 0 <= low_stock_mg <= 1_000_000_000:
        raise ValueError("Invalid low stock threshold")
    lower, upper = utc_range(start, end)

    days = {}
    for i in range((end - start).days + 1):
        day = (start + timedelta(days=i)).isoformat()
        days[day] = {"date": day, "total_satang": 0,
                     "sale_count": 0, "quantity_mg": 0}
    total_satang = 0
    subtotal_satang = 0
    sold_mg = 0
    count = 0
    cash_satang = 0
    transfer_satang = 0
    recent = []

    # Transaction-consistent read snapshot for all report sections.
    db.execute("BEGIN")
    try:
        cursor = db.execute("""
            SELECT s.id, s.created_at, s.total_satang, s.subtotal_satang,
                   s.payment_method, COUNT(sl.id) AS line_count,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg
              FROM sales s LEFT JOIN sale_lines sl ON sl.sale_id = s.id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
             GROUP BY s.id
             ORDER BY s.created_at DESC, s.id DESC
        """, (store_id, lower, upper))
        for row in cursor:
            day = to_bangkok_day(row["created_at"])
            # Keep the server's date-range boundary as the authority.
            if day not in days:
                continue
            amount = int(row["total_satang"])
            qty = int(row["quantity_mg"])
            count += 1
            total_satang += amount
            subtotal_satang += int(row["subtotal_satang"])
            sold_mg += qty
            if row["payment_method"] == "cash":
                cash_satang += amount
            elif row["payment_method"] == "transfer":
                transfer_satang += amount
            days[day]["total_satang"] += amount
            days[day]["sale_count"] += 1
            days[day]["quantity_mg"] += qty
            if len(recent) < 30:
                recent.append({
                    "id": row["id"], "created_at": row["created_at"],
                    "total_satang": amount, "payment_method": row["payment_method"],
                    "line_count": int(row["line_count"]), "quantity_mg": qty
                })

        top_products = [dict(r) for r in db.execute("""
            SELECT p.sku, p.name, p.category,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg,
                   COALESCE(SUM(sl.line_total_satang),0) AS total_satang,
                   COUNT(DISTINCT s.id) AS sale_count
              FROM sale_lines sl
              JOIN sales s ON s.id=sl.sale_id
              JOIN lots l ON l.id=sl.lot_id AND l.store_id=s.store_id
              JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
             GROUP BY p.id
             ORDER BY total_satang DESC, p.name ASC
             LIMIT 10
        """, (store_id, lower, upper))]

        top_categories = [dict(r) for r in db.execute("""
            SELECT p.category,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg,
                   COALESCE(SUM(sl.line_total_satang),0) AS total_satang
              FROM sale_lines sl
              JOIN sales s ON s.id=sl.sale_id
              JOIN lots l ON l.id=sl.lot_id AND l.store_id=s.store_id
              JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
             GROUP BY p.category ORDER BY total_satang DESC, p.category ASC
             LIMIT 10
        """, (store_id, lower, upper))]

        low_stock = [dict(r) for r in db.execute("""
            SELECT p.sku, p.name, l.lot_code, b.quantity_mg, l.expires_on
              FROM lot_balances b
              JOIN lots l ON l.id=b.lot_id
              JOIN products p ON p.id=l.product_id AND p.store_id=l.store_id
             WHERE l.store_id=? AND l.active=1 AND p.active=1
                   AND b.quantity_mg<=?
             ORDER BY b.quantity_mg ASC, p.name ASC
             LIMIT 100
        """, (store_id, low_stock_mg))]
    finally:
        db.rollback()  # End read-only snapshot; does not mutate records.

    return {
        "period": {"from": start.isoformat(), "to": end.isoformat(),
                   "timezone": "Asia/Bangkok"},
        "summary": {
            "sale_count": count,
            "total_satang": total_satang,
            "subtotal_satang": subtotal_satang,
            "cash_satang": cash_satang,
            "transfer_satang": transfer_satang,
            "quantity_mg": sold_mg,
            "average_satang": (total_satang // count if count else 0)
        },
        "daily": list(days.values()),
        "top_products": top_products,
        "top_categories": top_categories,
        "low_stock": low_stock,
        "recent_sales": recent,
        "capabilities": {
            "discounts": False, "promotions": False,
            "shift_reconciliation": False
        }
    }
