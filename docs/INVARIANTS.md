# Stock ledger invariants (locked)

1. **Append-only events** — no edit/delete; correct with new events
2. **Lot is unit of truth** — balances per `lot_id`
3. **Qty at T** — `sum(qty_delta)` where `occurred_at <= T`
4. **Fields (JS = SQL)** — `occurred_at` · `qty_delta` · `actor_user_id`
5. **No oversell** — SALE refused when `qty > balanceAt(lot, T)`
6. **Actor + reason** — every event; ADJUST/DESTROY require reason
