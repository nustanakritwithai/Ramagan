import type { StockEvent, QtyAtTimeQuery, QtyAtTimeResult } from '../../schema/types.ts';

/** Pure helper: sum signed deltas with occurredAt <= T */
export function balanceForLot(
  events: StockEvent[],
  lotId: string,
  at: string,
): number {
  return events
    .filter((e) => e.lotId === lotId && e.occurredAt <= at)
    .reduce((sum, e) => sum + e.qtyDelta, 0);
}

export function balanceAtT(
  events: StockEvent[],
  query: QtyAtTimeQuery,
  lotIdBySku?: (sku: string) => string[],
): QtyAtTimeResult {
  if (query.lotId) {
    return {
      key: query.lotId,
      qty: balanceForLot(events, query.lotId, query.at),
      at: query.at,
    };
  }
  if (query.sku && lotIdBySku) {
    const lotIds = lotIdBySku(query.sku);
    const qty = lotIds.reduce(
      (sum, id) => sum + balanceForLot(events, id, query.at),
      0,
    );
    return { key: query.sku, qty, at: query.at };
  }
  throw new Error('QtyAtTimeQuery requires lotId or sku');
}
