import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Browser IIFE files: load store then ledger (attach to globalThis + CJS export).
require(path.join(root, 'js/store.js'));
const ledger =
  require(path.join(root, 'js/ledger.js')) || globalThis.StockLedger;
const { createLot, appendEvent, balanceAt, validateSale, resetDev } = ledger;

resetDev();
const lot = createLot({
  lot_id: 'LOT-001',
  sku: 'FL-OG-01',
  product_name: 'OG Flower',
  unit: 'g',
});
appendEvent({
  lot_id: lot.lot_id,
  type: 'RECEIVE',
  qty: 100,
  actor_user_id: 'user-owner',
  reason: 'PO-1',
  occurred_at: '2026-09-01T10:00:00.000Z',
});
assert.equal(balanceAt('LOT-001', '2026-09-04T00:00:00.000Z'), 100);
appendEvent({
  lot_id: lot.lot_id,
  type: 'SALE',
  qty: 30,
  actor_user_id: 'user-cashier',
  reason: 'ticket-1',
  occurred_at: '2026-09-05T12:00:00.000Z',
});
assert.equal(balanceAt('LOT-001', '2026-09-05T12:00:00.000Z'), 70);
assert.equal(validateSale('LOT-001', 80).ok, false);
appendEvent({
  lot_id: lot.lot_id,
  type: 'ADJUST',
  qty: 5,
  actor_user_id: 'user-manager',
  reason: 'dry loss',
  occurred_at: '2026-09-10T09:00:00.000Z',
  meta: { adjust_sign: -1 },
});
assert.equal(balanceAt('LOT-001', '2026-09-10T09:00:00.000Z'), 65);
console.log('ledger.smoke: PASS (unified fields)');
