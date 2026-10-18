"""Canonical split tenders and exact historical cash/transfer fallback."""
from typing import Literal
from pydantic import BaseModel, Field, StrictInt
from discounts import MAX_SALE_SATANG
from cost_stock import canonical_hash


class PaymentIn(BaseModel):
    payment_method: Literal["cash", "transfer"]
    amount_satang: StrictInt = Field(gt=0, le=MAX_SALE_SATANG)


def normalize_payments(method, payments):
    if method not in ("cash", "transfer", "split"):
        raise ValueError("Invalid payment method")
    if method != "split":
        if payments is not None:
            raise ValueError("Payments are accepted only for split payment")
        return None
    if payments is None or len(payments) != 2:
        raise ValueError("Split payment requires exactly cash and transfer")
    result = sorted([dict(row.model_dump()) for row in payments], key=lambda row: row["payment_method"])
    if [row["payment_method"] for row in result] != ["cash", "transfer"]:
        raise ValueError("Split payment requires one cash and one transfer allocation")
    if sum(row["amount_satang"] for row in result) > MAX_SALE_SATANG:
        raise ValueError("Split payment exceeds supported money range")
    return result


def split_request_hash(items, ref, discount, allocations):
    return canonical_hash({"items": items, "authorization_ref": ref, "discount_satang": discount,
                           "payment_method": "split", "payments": allocations})


def recorded_payments(db, sale_id, method, total):
    rows = [dict(row) for row in db.execute("SELECT payment_method,amount_satang FROM sale_payments "
                                          "WHERE sale_id=? ORDER BY payment_method", (sale_id,))]
    if rows:
        if sum(row["amount_satang"] for row in rows) != total:
            raise ValueError("Recorded payments do not match sale net")
        return rows
    if method not in ("cash", "transfer"):
        raise ValueError("Split sale is missing payment allocations")
    return [{"payment_method": method, "amount_satang": total}]
