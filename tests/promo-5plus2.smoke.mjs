import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(root, 'js/store.js'));
const L = require(path.join(root, 'js/ledger.js')) || globalThis.StockLedger;

function promoStockQty(paid) {
  const sets = Math.floor(paid / 5);
  return Math.round((paid + sets * 2) * 1000) / 1000;
}

assert.equal(promoStockQty(5), 7);
assert.equal(promoStockQty(10), 14);
assert.equal(promoStockQty(4), 4);
assert.equal(promoStockQty(11), 15);

L.resetDev();
L.seedIfEmpty();
const lot = L.listLots().find((x) => x.unit === 'g');
assert.ok(lot, 'seed units are g');
const before = L.balanceAt(lot.lot_id);
const paid = 5;
const stock = promoStockQty(paid);
assert.equal(L.validateSale(lot.lot_id, stock).ok, true);
const ev = L.appendEvent({
  lot_id: lot.lot_id,
  type: 'SALE',
  qty: stock,
  actor_user_id: 'cashier',
  reason: 'ขายหน้าร้าน · โปร 5+2',
  meta: {
    promo: '5+2',
    qty_paid: paid,
    qty_stock: stock,
    payment: 'cash',
    unit_price: lot.unit_price,
    line_total: paid * lot.unit_price,
  },
});
assert.equal(ev.qty, 7);
assert.equal(ev.meta.promo, '5+2');
assert.equal(ev.meta.qty_paid, 5);
assert.equal(ev.meta.qty_stock, 7);
assert.equal(L.balanceAt(lot.lot_id), before - 7);
// money side is UI-only: line_total = 5 * price (not 7)
assert.equal(ev.meta.line_total, 5 * lot.unit_price);
console.log('promo-5plus2.smoke: PASS');
