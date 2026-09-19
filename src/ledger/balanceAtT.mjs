export function balanceForLot(events, lotId, at) {
  return events
    .filter((e) => e.lot_id === lotId && e.occurred_at <= at)
    .reduce((sum, e) => sum + e.qty_delta, 0);
}
