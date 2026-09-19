# Cannabis POS V0 — Stock Ledger Schema

**Audience:** aaa01 (schema review) · Ai CPU WEB (stock rules/audit)  
**Scope:** Stock ledger only (not full POS)  
**Storage:** browser `localStorage` (key `cannabis-pos-v0`)  
**Impl:** `js/store.js` + `js/ledger.js` (IIFE, no ES modules)

---

## Locked invariants

1. **Immutable events** — never edit or delete a stock movement; fix mistakes with compensating events (`ADJUST`, `DESTROY`, reverse `TRANSFER_*`, etc.).
2. **Balance at time T** — for each lot, `qty = sum(signed_delta of events where timestamp <= T)`.
3. **Never oversell** — `validateSale` / `appendEvent(SALE)` refuses when requested qty exceeds remaining.
4. **Every event** has `actor`, `reason`, `timestamp` (ISO-8601).
5. **Lot qty is derived** — `qty_remaining` is recomputed from events; not source of truth.

---

## Entity: Lot

| Field | Type | Notes |
|-------|------|--------|
| `lot_id` | string | Stable unique id, e.g. `LOT-OGK-001` |
| `sku` | string | Product SKU |
| `product_name` | string | Display name (Thai OK) |
| `unit` | `"g"` \| `"pcs"` | Grams or pieces |
| `expires_at` | string \| null | ISO date/datetime |
| `received_at` | string | ISO datetime of first receive |
| `qty_remaining` | number | **Derived** in UI via `balanceAt` — not stored as authority |

---

## Entity: StockEvent (immutable)

| Field | Type | Notes |
|-------|------|--------|
| `event_id` | string | Unique, e.g. `EVT-…` |
| `lot_id` | string | FK → Lot |
| `type` | EventType | See below |
| `qty` | number | Always **positive** magnitude |
| `signed_delta` | number | Applied to balance (see sign table) |
| `actor` | string | Who performed the action |
| `reason` | string | Why (required) |
| `timestamp` | string | ISO-8601; ordering key for as-of |
| `meta` | object | Optional (`adjust_sign`, transfer refs) |

### EventType → signed_delta

| Type | signed_delta | Meaning |
|------|--------------|---------|
| `RECEIVE` | `+qty` | New stock into lot |
| `SALE` | `-qty` | Retail sale |
| `ADJUST` | `±qty` | Via `meta.adjust_sign` = `+1` or `-1` |
| `DESTROY` | `-qty` | Spoilage / compliance destroy |
| `TRANSFER_IN` | `+qty` | From another location/lot |
| `TRANSFER_OUT` | `-qty` | To another location/lot |

---

## Balance formulas

```
balanceAt(lotId, T) =
  Σ event.signed_delta
  where event.lot_id = lotId
    and event.timestamp <= T

balanceAllAt(T) =
  map lot_id → balanceAt(lot_id, T) for all lots
```

Equal timestamps: apply in append order for deterministic ties.

---

## Persistence shape (`localStorage`)

```json
{
  "version": 1,
  "lots": [],
  "events": []
}
```

UI must not offer edit/delete on events. Dev reset = clear key / re-seed.

---

## API surface (`js/ledger.js` → `window.StockLedger`)

| Function | Responsibility |
|----------|----------------|
| `createLot(lotFields)` | Register lot metadata |
| `appendEvent(partial)` | Validate + append immutable event |
| `balanceAt(lotId, isoTime)` | Historical balance |
| `balanceAllAt(isoTime)` | Snapshot of all lots |
| `validateSale(lotId, qty, isoTime?)` | `{ ok, remaining, message }` |
| `seedIfEmpty()` | Demo lots + events if storage empty |

---

## Ownership

| Owner | Concern |
|-------|---------|
| **Ai CPU WEB** | Stock rules, audit, invariants |
| **New Bot** | UI polish (later) |
| **aaa01** | Schema review |
| **Tanakrit** | Group project lead |

## Out of scope (V0)

Payments · customers · multi-store sync · auth · editing historical events · GitHub
