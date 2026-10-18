"""Ramagan owner/manager sales reports from authoritative SQLite records.

No mutation, no seeded/demo totals, and no unauthenticated export.
Date ranges are interpreted in Asia/Bangkok, stored timestamps are UTC.
Amounts are integer satang, stock quantities are integer milligrams. Stored
subtotals are gross, discounts are allocated receipt amounts, and totals are net.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from payments import recorded_payments

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


def add_cost_totals(row: dict) -> dict:
    """Never treat an unknown historical cost as a known zero or full profit."""
    known = int(row["known_cost_satang"])
    missing = int(row["unknown_cost_line_count"])
    row["cost_complete"] = missing == 0
    row["cost_satang"] = known if missing == 0 else None
    row["gross_profit_satang"] = int(row["total_satang"]) - known if missing == 0 else None
    return row


def build_sales_report(db, store_id: str, start: date, end: date,
                       low_stock_mg: int = 10000) -> dict:
    if not 0 <= low_stock_mg <= 1_000_000_000:
        raise ValueError("Invalid low stock threshold")
    lower, upper = utc_range(start, end)

    days = {}
    for i in range((end - start).days + 1):
        day = (start + timedelta(days=i)).isoformat()
        days[day] = {"date": day, "total_satang": 0,
                     "subtotal_satang": 0, "discount_satang": 0,
                     "sale_count": 0, "quantity_mg": 0,
                     "known_cost_satang": 0, "unknown_cost_line_count": 0}
    total_satang = 0
    subtotal_satang = 0
    discount_satang = 0
    sold_mg = 0
    count = 0
    cash_satang = 0
    transfer_satang = 0
    known_cost_satang = 0
    unknown_cost_line_count = 0
    recent = []
    voided = {"sale_count": 0, "subtotal_satang": 0, "discount_satang": 0,
              "total_satang": 0, "quantity_mg": 0}
    void_activity = {"basis": "void_created_at", "sale_count": 0, "subtotal_satang": 0,
                     "discount_satang": 0, "total_satang": 0, "quantity_mg": 0,
                     "cash_satang": 0, "transfer_satang": 0,
                     "known_cost_satang": 0, "unknown_cost_line_count": 0}
    recent_voids = []
    for day in days.values():
        day.update({"voided_" + key: 0 for key in voided})

    # Transaction-consistent read snapshot for all report sections.
    db.execute("BEGIN")
    try:
        has_voids = bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_voids'").fetchone())
        active_only = " AND NOT EXISTS(SELECT 1 FROM sale_voids v WHERE v.sale_id=s.id)" if has_voids else ""
        if has_voids:
            void_columns = """s.id,s.created_at,s.subtotal_satang,s.discount_satang,s.total_satang,
                s.payment_method,coalesce(sum(sl.quantity_mg),0) AS quantity_mg,
                coalesce(sum(sl.line_cost_satang),0) AS known_cost_satang,
                count(sl.id)-count(sl.line_cost_satang) AS unknown_cost_line_count"""
            # Financial sections are restated on the ORIGINAL sale day at this
            # read snapshot. Separate activity is attributed to the void day.
            for row in db.execute("SELECT " + void_columns + " FROM sales s JOIN sale_voids v ON v.sale_id=s.id "
                    "LEFT JOIN sale_lines sl ON sl.sale_id=s.id WHERE s.store_id=? AND s.created_at>=? AND s.created_at<? "
                    "GROUP BY s.id", (store_id, lower, upper)):
                day = to_bangkok_day(row["created_at"])
                if day in days:
                    for key in voided:
                        amount = 1 if key == "sale_count" else int(row[key])
                        voided[key] += amount
                        days[day]["voided_" + key] += amount
            activity = db.execute("SELECT " + void_columns + ",v.id AS void_id,v.client_void_id,v.reason,"
                "v.actor_user_id,v.actor_email,v.actor_role,v.created_at AS voided_at FROM sale_voids v "
                "JOIN sales s ON s.id=v.sale_id LEFT JOIN sale_lines sl ON sl.sale_id=s.id "
                "WHERE v.store_id=? AND s.store_id=? AND v.created_at>=? AND v.created_at<? "
                "GROUP BY v.id ORDER BY v.created_at DESC,v.id DESC", (store_id, store_id, lower, upper))
            for row in activity:
                payments = recorded_payments(db, row["id"], row["payment_method"], row["total_satang"])
                void_activity["sale_count"] += 1
                for key in ("subtotal_satang", "discount_satang", "total_satang", "quantity_mg",
                            "known_cost_satang", "unknown_cost_line_count"):
                    void_activity[key] += int(row[key])
                for payment in payments:
                    void_activity[payment["payment_method"] + "_satang"] += payment["amount_satang"]
                if len(recent_voids) < 30:
                    recent_voids.append({**dict(row), "sale_id": row["id"], "payments": payments})
        payment_rows = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_payments'").fetchone():
            for row in db.execute("""SELECT p.sale_id,p.payment_method,p.amount_satang
                FROM sale_payments p JOIN sales s ON s.id=p.sale_id
                WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
                ORDER BY p.sale_id,p.payment_method""", (store_id, lower, upper)):
                payment_rows.setdefault(row["sale_id"], []).append({
                    "payment_method": row["payment_method"], "amount_satang": row["amount_satang"]})
        cursor = db.execute("""
            SELECT s.id, s.created_at, s.total_satang, s.subtotal_satang,
                   s.discount_satang,
                   s.payment_method, COUNT(sl.id) AS line_count,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg,
                   COALESCE(SUM(sl.line_cost_satang),0) AS known_cost_satang,
                   COUNT(sl.id)-COUNT(sl.line_cost_satang) AS unknown_cost_line_count
              FROM sales s LEFT JOIN sale_lines sl ON sl.sale_id = s.id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
        """ + active_only + """
             GROUP BY s.id
             ORDER BY s.created_at DESC, s.id DESC
        """, (store_id, lower, upper))
        for row in cursor:
            day = to_bangkok_day(row["created_at"])
            # Keep the server's date-range boundary as the authority.
            if day not in days:
                continue
            amount = int(row["total_satang"])
            subtotal = int(row["subtotal_satang"])
            discount = int(row["discount_satang"])
            qty = int(row["quantity_mg"])
            known_cost = int(row["known_cost_satang"])
            missing_cost = int(row["unknown_cost_line_count"])
            count += 1
            total_satang += amount
            subtotal_satang += subtotal
            discount_satang += discount
            sold_mg += qty
            known_cost_satang += known_cost
            unknown_cost_line_count += missing_cost
            payments = payment_rows.get(row["id"])
            if payments is None and row["payment_method"] in ("cash", "transfer"):
                payments = [{"payment_method": row["payment_method"], "amount_satang": amount}]
            if (not payments or sum(p["amount_satang"] for p in payments) != amount or
                    (row["payment_method"] == "split" and
                     ([p["payment_method"] for p in payments] != ["cash", "transfer"] or
                      any(type(p["amount_satang"]) is not int or p["amount_satang"] <= 0 for p in payments)))):
                raise ValueError("Recorded sale payment allocations are inconsistent")
            for payment in payments:
                if payment["payment_method"] == "cash":
                    cash_satang += payment["amount_satang"]
                elif payment["payment_method"] == "transfer":
                    transfer_satang += payment["amount_satang"]
            days[day]["total_satang"] += amount
            days[day]["subtotal_satang"] += subtotal
            days[day]["discount_satang"] += discount
            days[day]["sale_count"] += 1
            days[day]["quantity_mg"] += qty
            days[day]["known_cost_satang"] += known_cost
            days[day]["unknown_cost_line_count"] += missing_cost
            if len(recent) < 30:
                recent.append(add_cost_totals({
                    "id": row["id"], "created_at": row["created_at"],
                    "total_satang": amount, "subtotal_satang": subtotal,
                    "discount_satang": discount,
                    "payment_method": row["payment_method"],
                    "payments": payments,
                    "line_count": int(row["line_count"]), "quantity_mg": qty,
                    "known_cost_satang": known_cost,
                    "unknown_cost_line_count": missing_cost
                }))

        top_products = [add_cost_totals(dict(r)) for r in db.execute("""
            SELECT p.sku, p.name, p.category,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg,
                   COALESCE(SUM(sl.line_subtotal_satang),0) AS subtotal_satang,
                   COALESCE(SUM(sl.line_discount_satang),0) AS discount_satang,
                   COALESCE(SUM(sl.line_total_satang),0) AS total_satang,
                   COALESCE(SUM(sl.line_cost_satang),0) AS known_cost_satang,
                   COUNT(sl.id)-COUNT(sl.line_cost_satang) AS unknown_cost_line_count,
                   COUNT(DISTINCT s.id) AS sale_count
              FROM sale_lines sl
              JOIN sales s ON s.id=sl.sale_id
              JOIN lots l ON l.id=sl.lot_id AND l.store_id=s.store_id
              JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
        """ + active_only + """
             GROUP BY p.id
             ORDER BY total_satang DESC, p.name ASC
             LIMIT 10
        """, (store_id, lower, upper))]

        top_categories = [add_cost_totals(dict(r)) for r in db.execute("""
            SELECT p.category,
                   COALESCE(SUM(sl.quantity_mg),0) AS quantity_mg,
                   COALESCE(SUM(sl.line_subtotal_satang),0) AS subtotal_satang,
                   COALESCE(SUM(sl.line_discount_satang),0) AS discount_satang,
                   COALESCE(SUM(sl.line_total_satang),0) AS total_satang,
                   COALESCE(SUM(sl.line_cost_satang),0) AS known_cost_satang,
                   COUNT(sl.id)-COUNT(sl.line_cost_satang) AS unknown_cost_line_count
              FROM sale_lines sl
              JOIN sales s ON s.id=sl.sale_id
              JOIN lots l ON l.id=sl.lot_id AND l.store_id=s.store_id
              JOIN products p ON p.id=l.product_id AND p.store_id=s.store_id
             WHERE s.store_id=? AND s.created_at>=? AND s.created_at<?
        """ + active_only + """
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
        "summary": add_cost_totals({
            **{"voided_" + key: value for key, value in voided.items()},
            "sale_count": count,
            "total_satang": total_satang,
            "subtotal_satang": subtotal_satang,
            "discount_satang": discount_satang,
            "cash_satang": cash_satang,
            "transfer_satang": transfer_satang,
            "quantity_mg": sold_mg,
            "average_satang": (total_satang // count if count else 0),
            "known_cost_satang": known_cost_satang,
            "unknown_cost_line_count": unknown_cost_line_count
        }),
        "daily": [add_cost_totals(row) for row in days.values()],
        "top_products": top_products,
        "top_categories": top_categories,
        "low_stock": low_stock,
        "recent_sales": recent,
        "voids": add_cost_totals(void_activity),
        "recent_voids": recent_voids,
        "sales_basis": "original_sale_created_at_excluding_voided_at_snapshot",
        "capabilities": {
            "discounts": True, "discount_contract_version": 1,
            "inventory_costs": True, "cost_contract_version": 1,
            "stocktakes": True, "stocktake_contract_version": 2,
            "stocktake_evidence": True, "evidence_contract_version": 1,
            "split_payments": True, "payment_contract_version": 1,
            "sale_reconciliation": True, "sale_reconciliation_contract_version": 1,
            "sale_voids": has_voids, "sale_void_contract_version": 1,
            "promotions": False,
            "shift_reconciliation": False
        }
    }
