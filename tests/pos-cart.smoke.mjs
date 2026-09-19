
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
const lots = L.listLots().filter((x) => L.balanceAt(x.lot_id) > 0);
assert.ok(lots.length >= 2, 'seed should have sellable lots');

const cart = [
  { lot: lots[0], qty: 2, payment: 'cash' },
  { lot: lots[1], qty: 1, payment: 'transfer' },
];

// Validate then SALE per lot with payment in meta only
for (const line of cart) {
  const check = L.validateSale(line.lot.lot_id, line.qty);
  assert.equal(check.ok, true, check.message);
}
for (const line of cart) {
  const price = Number(line.lot.unit_price) || 0;
  const ev = L.appendEvent({
    lot_id: line.lot.lot_id,
    type: 'SALE',
    qty: line.qty,
    actor_user_id: 'cashier',
    reason: 'ขายหน้าร้าน',
    meta: {
      payment: line.payment,
      unit_price: price,
      line_total: price * line.qty,
      product_name: line.lot.product_name,
    },
  });
  assert.equal(ev.meta.payment, line.payment);
  assert.equal(ev.type, 'SALE');
}

// Oversell still blocked
const big = L.validateSale(lots[0].lot_id, 999999);
assert.equal(big.ok, false);

console.log('pos-cart.smoke: PASS (grid cart → validateSale→SALE + meta.payment)');
