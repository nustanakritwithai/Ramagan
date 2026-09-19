import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const A = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '../js/admin-analytics.js'));
const events = [
  { type:'SALE', lot_id:'L1', qty:7, qty_delta:-7, occurred_at:'2026-09-18T10:00:00+07:00',
    meta:{ qty_paid:5, qty_stock:7, line_total:100, payment:'cash', promo:'5+2', product_name:'A' } },
  { type:'SALE', lot_id:'L2', qty:7, qty_delta:-7, occurred_at:'2026-09-19T11:00:00+07:00',
    meta:{ qty_paid:5, qty_stock:7, line_total:200, payment:'transfer', promo:'5+2', product_name:'B' } },
  { type:'ADJUST', lot_id:'L1', qty:2, qty_delta:-2, occurred_at:'2026-09-19T08:00:00+07:00',
    meta:{ source:'shift_count', variance:-2 } },
];
const lots = [
  { lot_id:'L1', product_name:'A', category_id:'leaf-trim' },
  { lot_id:'L2', product_name:'B', category_id:'top' },
];
const s = A.buildChartSeries(events, lots, { fromKey:'2026-09-18', toKey:'2026-09-19' });
assert.deepEqual(s.labels, ['2026-09-18','2026-09-19']);
assert.equal(s.salesBahtDaily[0], 100);
assert.equal(s.salesBahtDaily[1], 200);
assert.equal(s.paidGDaily[0], 5);
assert.equal(s.stockGDaily[0], 7);
assert.equal(s.payment.cash, 100);
assert.equal(s.payment.transfer, 200);
assert.equal(s.shiftVarAbsDaily[1], 2);
assert.ok(s.topProducts.length >= 1);
console.log('admin-charts.smoke: PASS');
