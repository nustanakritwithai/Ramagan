import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const A = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '../js/admin-analytics.js'));

const lots = [
  { lot_id: 'L1', product_name: 'OG Auto', category_id: 'top' },
  { lot_id: 'L2', product_name: 'Haze Photo', category_id: 'pop' }
];
const events = [
  {
    type: 'SALE',
    lot_id: 'L1',
    qty: 7,
    qty_delta: -7,
    occurred_at: '2026-09-19T10:00:00+07:00',
    meta: {
      qty_paid: 5,
      qty_stock: 7,
      line_total: 100,
      payment: 'cash',
      promo: '5+2',
      product_name: 'OG Auto',
      subtotal_before_discount: 100,
      discount_baht: 10,
      payable_baht: 90,
      checkout_id: 'CHK1'
    }
  },
  {
    type: 'SALE',
    lot_id: 'L2',
    qty: 7,
    qty_delta: -7,
    occurred_at: '2026-09-19T11:00:00+07:00',
    meta: {
      qty_paid: 5,
      qty_stock: 7,
      line_total: 100,
      payment: 'transfer',
      promo: '5+2',
      product_name: 'Haze Photo',
      subtotal_before_discount: 100,
      discount_baht: 0,
      payable_baht: 100,
      checkout_id: 'CHK2'
    }
  }
];

const stats = A.computeAdminStats(events, lots, { fromKey: '2026-09-19', toKey: '2026-09-19' });
assert.equal(stats.salesBaht, 190);
assert.equal(stats.salesBahtGross, 200);
assert.equal(stats.cashBaht, 90);
assert.equal(stats.transferBaht, 100);
assert.equal(stats.salesPaidG, 10);
assert.equal(stats.salesStockG, 14);

const series = A.buildChartSeries(events, lots, { fromKey: '2026-09-19', toKey: '2026-09-19' });
assert.equal(series.payment.cash, 90);
assert.equal(series.payment.transfer, 100);
assert.equal(series.salesBahtDaily[0], 190);

console.log('admin-payable.smoke: PASS', {
  salesBaht: stats.salesBaht,
  gross: stats.salesBahtGross,
  cash: stats.cashBaht,
  transfer: stats.transferBaht
});
