# Query: ยอด ณ เวลา T

```sql
SELECT lot_id, COALESCE(SUM(qty_delta), 0) AS qty
FROM stock_events
WHERE lot_id = :lot_id
  AND occurred_at <= :t
GROUP BY lot_id;
```

JS: `balanceAt(lotId, t)` sums `event.qty_delta` for `event.occurred_at <= t`.
