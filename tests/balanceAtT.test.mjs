import assert from 'node:assert/strict';
import { balanceForLot } from '../src/ledger/balanceAtT.mjs';
const events = [
  { lot_id: 'L1', qty_delta: 100, occurred_at: '2026-09-01T10:00:00+07:00' },
  { lot_id: 'L1', qty_delta: -30, occurred_at: '2026-09-05T12:00:00+07:00' },
];
assert.equal(balanceForLot(events, 'L1', '2026-09-04T23:59:59+07:00'), 100);
assert.equal(balanceForLot(events, 'L1', '2026-09-05T12:00:00+07:00'), 70);
console.log('balanceAtT tests: PASS');
