/** Field names locked to SQL standard */
export type StockEventType =
  | 'RECEIVE'
  | 'SALE'
  | 'DESTROY'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'ADJUST';

export interface StockEvent {
  event_id: string;
  lot_id: string;
  type: StockEventType;
  qty: number; // positive magnitude
  qty_delta: number; // signed
  actor_user_id: string;
  reason: string;
  occurred_at: string;
  created_at: string;
  meta?: Record<string, unknown>;
}
