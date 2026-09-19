
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, window: {}, module: { exports: {} } };
ctx.global = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/admin-analytics.js'), 'utf8'), ctx);
const A = ctx.AdminAnalytics;
assert.equal(typeof A.buildChartSeries, 'function');
const series = A.buildChartSeries(
  [
    {
      type: 'SALE',
      lot_id: 'L1',
      qty: 7,
      qty_delta: -7,
      occurred_at: '2026-09-18T10:00:00+07:00',
      meta: { qty_paid: 5, qty_stock: 7, line_total: 100, payment: 'cash', product_name: 'A' }
    },
    {
      type: 'ADJUST',
      lot_id: 'L1',
      qty: 2,
      qty_delta: -2,
      occurred_at: '2026-09-18T08:00:00+07:00',
      meta: { source: 'shift_count', variance: -2 }
    }
  ],
  [{ lot_id: 'L1', product_name: 'A', category_id: 'top' }],
  { fromKey: '2026-09-18', toKey: '2026-09-18' }
);
assert.ok(series.labels.length === 1);
assert.equal(series.salesBahtDaily[0], 100);
assert.equal(series.paidGDaily[0], 5);
assert.equal(series.stockGDaily[0], 7);
assert.equal(series.shiftVarAbsDaily[0], 2);
assert.equal(series.payment.cash, 100);

// App wiring presence
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
assert.match(app, /bindNavDrawer\(\);/);
assert.match(app, /buildChartSeries/);
assert.match(app, /renderAdminCharts/);
assert.match(app, /openKeypad/);
assert.match(app, /photo_data_url|photo_data_url/);
assert.match(app, /source:\s*'shift_count'/);
console.log('shift-keypad.smoke: PASS');
