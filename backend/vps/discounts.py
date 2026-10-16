"""Integer-only discount allocation and canonical checkout fingerprints.

Largest remainders receive the spare satang first; canonical lot ID order
breaks ties. A stored line keeps its gross, allocated discount and net.
"""
from __future__ import annotations

import hashlib
import json
from typing import NamedTuple, Sequence

DISCOUNT_CONTRACT_VERSION = 1
# Existing limits: 50 lines * 1,000 grams * 100,000,000 satang per gram.
MAX_SALE_SATANG = 5_000_000_000_000


class LineAmounts(NamedTuple):
    lot_id: str
    subtotal_satang: int
    discount_satang: int
    total_satang: int


def _money(value: int, label: str) -> None:
    if type(value) is not int or not 0 <= value <= MAX_SALE_SATANG:
        raise ValueError(f"{label} must be an integer between 0 and {MAX_SALE_SATANG}")


def allocate_discount(
    gross_by_lot: Sequence[tuple[str, int]], discount_satang: int
) -> list[LineAmounts]:
    """Allocate a bill discount exactly, without floating-point arithmetic."""
    _money(discount_satang, "Discount")
    if not gross_by_lot:
        raise ValueError("At least one sale line is required")
    lines = sorted(gross_by_lot, key=lambda line: line[0])
    ids = [lot_id for lot_id, _ in lines]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate lot in one checkout")
    for lot_id, gross in lines:
        if not isinstance(lot_id, str) or not lot_id:
            raise ValueError("Lot ID is required")
        _money(gross, "Line subtotal")
    subtotal = sum(gross for _, gross in lines)
    _money(subtotal, "Sale subtotal")
    if discount_satang > subtotal:
        raise ValueError("Discount exceeds sale subtotal")
    if subtotal == 0:
        return [LineAmounts(lot_id, 0, 0, 0) for lot_id, _ in lines]

    floors = {}
    remainders = []
    for lot_id, gross in lines:
        allocated, remainder = divmod(discount_satang * gross, subtotal)
        floors[lot_id] = allocated
        remainders.append((remainder, lot_id))
    spare = discount_satang - sum(floors.values())
    for _, lot_id in sorted(remainders, key=lambda value: (-value[0], value[1]))[:spare]:
        floors[lot_id] += 1
    return [
        LineAmounts(lot_id, gross, floors[lot_id], gross - floors[lot_id])
        for lot_id, gross in lines
    ]


def checkout_request_hash(
    items: Sequence[dict], payment_method: str, authorization_ref: str,
    discount_satang: int = 0,
) -> str:
    """Omission and explicit zero share the same version-one fingerprint."""
    _money(discount_satang, "Discount")
    payload = _legacy_payload(items, payment_method, authorization_ref)
    payload["discount_satang"] = discount_satang
    return _fingerprint(payload)


def legacy_checkout_request_hash(
    items: Sequence[dict], payment_method: str, authorization_ref: str,
) -> str:
    """Exact original fingerprint, used only to recognize zero-discount retries."""
    return _fingerprint(_legacy_payload(items, payment_method, authorization_ref))


def _legacy_payload(items, payment_method, authorization_ref):
    return {
        "items": sorted([
            {"lot_id": item["lot_id"], "quantity_mg": item["quantity_mg"]}
            for item in items
        ], key=lambda item: item["lot_id"]),
        "payment_method": payment_method,
        "authorization_ref": authorization_ref.strip(),
    }


def _fingerprint(payload):
    return hashlib.sha256(json.dumps(
        payload, sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()
