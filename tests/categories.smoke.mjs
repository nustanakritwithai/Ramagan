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
assert.ok(lots.length > 50);
const by = {};
for (const lot of lots) {
  assert.ok(lot.category_id, 'category_id required');
  assert.ok(lot.unit_price > 0, 'unit_price on product');
  by[lot.category_id] = (by[lot.category_id] || 0) + 1;
}
for (const id of ['leaf-trim', 'under-machine', 'mini', 'pop', 'top']) {
  assert.ok(by[id] > 10, id + ' must have >10, got ' + by[id]);
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
