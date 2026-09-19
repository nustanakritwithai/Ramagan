
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = require(path.join(root, 'js/admin-analytics.js'));

const day = '2026-09-19';
const events = [
  {
    lot_id: 'L1',
    type: 'SALE',
    qty: 7,
    qty_delta: -7,
    occurred_at: '2026-09-19T10:00:00.000+07:00',
    meta: {
      payment: 'cash',
      promo: '5+2',
      qty_paid: 5,
      qty_stock: 7,
      line_total: 100,
      unit_price: 20,
      product_name: 'ใบทริม A',
    },
  },
  {
    lot_id: 'L2',
    type: 'SALE',
    qty: 1,
    qty_delta: -1,
    occurred_at: '2026-09-19T11:00:00.000+07:00',
    meta: {
      payment: 'transfer',
      promo: '5+2',
      qty_paid: 5,
      qty_stock: 7,
      line_total: 400,
      product_name: 'mini 40',
    },
  },
  {
    lot_id: 'L1',
    type: 'ADJUST',
    qty: 2,
    qty_delta: -2,
    occurred_at: '2026-09-19T08:00:00.000+07:00',
    meta: { source: 'shift_count', variance: -2, adjust_sign: -1 },
  },
];
const lots = [
  { lot_id: 'L1', product_name: 'ใบทริม A', category_id: 'leaf-trim', unit: 'g' },
  { lot_id: 'L2', product_name: 'mini 40', category_id: 'mini', unit: 'g' },
];

const s = A.computeAdminStats(events, lots, { fromKey: day, toKey: day }, (id) =>
  id === 'L1' ? 3 : 50
);
assert.equal(s.salesBaht, 500);
assert.equal(s.cashBaht, 100);
assert.equal(s.transferBaht, 400);
assert.equal(s.promoPaidG, 10);
assert.equal(s.promoStockG, 14);
assert.equal(s.promoFreeG, 4);
assert.equal(s.shiftAdjustCount, 1);
assert.equal(s.shiftVarAbs, 2);
assert.ok(s.topProducts.length >= 1);
assert.equal(s.lowStock.length, 1);
assert.equal(s.lowStock[0].lot_id, 'L1');
assert.equal(A.bangkokDateKey('2026-09-19T01:00:00.000Z'), '2026-09-19');
console.log('admin-analytics.smoke: PASS');
