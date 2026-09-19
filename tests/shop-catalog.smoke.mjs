import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'js/store.js'));
const L = require(path.join(root, 'js/ledger.js'));
L.resetDev();
const lot = L.createLot({
  sku: 'NEW-1',
  product_name: 'สายใหม่',
  category_id: 'top',
  unit: 'g',
  unit_price: 150,
  unit_cost: 75,
  for_sale: true,
});
assert.equal(lot.unit_cost, 75);
L.appendEvent({
  lot_id: lot.lot_id,
  type: 'RECEIVE',
  qty: 50,
  actor_user_id: 'owner',
  reason: 'ยกมา',
});
assert.equal(L.balanceAt(lot.lot_id), 50);
L.updateLot(lot.lot_id, { product_name: 'สายใหม่ v2', unit_price: 160, unit_cost: 80, for_sale: false });
const got = L.getLot(lot.lot_id);
assert.equal(got.product_name, 'สายใหม่ v2');
assert.equal(got.unit_price, 160);
assert.equal(got.unit_cost, 80);
assert.equal(got.for_sale, false);
const sellable = L.listLots().filter((x) => x.for_sale !== false && L.balanceAt(x.lot_id) > 0);
assert.ok(!sellable.some((x) => x.lot_id === lot.lot_id));
L.updateLot(lot.lot_id, { for_sale: true });
const sellable2 = L.listLots().filter((x) => x.for_sale !== false && L.balanceAt(x.lot_id) > 0);
assert.ok(sellable2.some((x) => x.lot_id === lot.lot_id));
console.log('shop-catalog.smoke: PASS');
