import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'js/store.js'));
const L = require(path.join(root, 'js/ledger.js')) || globalThis.StockLedger;
L.resetDev();
assert.equal(L.seedIfEmpty(), true);
const lots = L.listLots();
assert.equal(lots.length, 25, 'exactly 5 products × 5 categories');
const by = {};
for (const lot of lots) {
  assert.ok(lot.category_id, 'category_id required');
  assert.ok(lot.unit_price > 0, 'unit_price on product');
  assert.ok(lot.unit_cost != null && lot.unit_cost > 0, 'unit_cost on product');
  assert.equal(lot.unit_cost, lot.unit_price * 0.5, 'cost = 50% of price for ' + lot.sku);
  assert.equal(L.balanceAt(lot.lot_id), 30, 'RECEIVE opening 30g for ' + lot.lot_id);
  by[lot.category_id] = (by[lot.category_id] || 0) + 1;
}
for (const id of ['leaf-trim', 'under-machine', 'mini', 'pop', 'top']) {
  assert.equal(by[id], 5, id + ' must have exactly 5, got ' + by[id]);
}
const miniPrices = new Set(lots.filter((l) => l.category_id === 'mini').map((l) => l.unit_price));
assert.ok(miniPrices.has(40) && miniPrices.has(50));
assert.equal(lots.find((l) => l.category_id === 'leaf-trim').unit_price, 20);
assert.equal(lots.find((l) => l.category_id === 'under-machine').unit_price, 25);
assert.equal(lots.find((l) => l.category_id === 'pop').unit_price, 80);
assert.equal(lots.find((l) => l.category_id === 'top').unit_price, 150);
// sale still works
const lot = lots[0];
const v = L.validateSale(lot.lot_id, 1);
assert.equal(v.ok, true);
L.appendEvent({
  lot_id: lot.lot_id,
  type: 'SALE',
  qty: 1,
  actor_user_id: 'cashier',
  reason: 'ขายหน้าร้าน',
  meta: { payment: 'cash', unit_price: lot.unit_price },
});
console.log('categories.smoke: PASS', by);
