import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'js/store.js'));
const L = require(path.join(root, 'js/ledger.js')) || globalThis.StockLedger;

L.resetDev();
L.seedIfEmpty();
const lot = L.listLots()[0];
assert.ok(lot, 'seed lot');
const before = L.balanceAt(lot.lot_id);
const counted = before - 3; // physical short 3
const diff = counted - before; // -3
assert.ok(diff < 0);

const check = L.validateSale; // untouched
void check;

L.appendEvent({
  lot_id: lot.lot_id,
  type: 'ADJUST',
  qty: Math.abs(diff),
  actor_user_id: 'น้องร้าน',
  reason: 'นับก่อนเข้ากะ · กะเช้า',
  meta: {
    adjust_sign: diff > 0 ? 1 : -1,
    shift_label: 'กะเช้า',
    counted_qty: counted,
    system_qty: before,
    variance: diff,
    source: 'shift_count',
  },
});

const after = L.balanceAt(lot.lot_id);
assert.equal(after, counted, 'ADJUST should move balance to counted qty');

// surplus path
const before2 = after;
const counted2 = before2 + 1.5;
L.appendEvent({
  lot_id: lot.lot_id,
  type: 'ADJUST',
  qty: 1.5,
  actor_user_id: 'น้องร้าน',
  reason: 'นับก่อนเข้ากะ · กะเช้า',
  meta: {
    adjust_sign: 1,
    shift_label: 'กะเช้า',
    counted_qty: counted2,
    system_qty: before2,
    variance: 1.5,
    source: 'shift_count',
  },
});
assert.equal(L.balanceAt(lot.lot_id), counted2);

console.log('shift-count.smoke: PASS (variance → ADJUST + meta.shift)');
