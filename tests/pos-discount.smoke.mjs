import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; }
};
const ctx = { console, localStorage: store, window: {}, module: { exports: {} } };
ctx.global = ctx; ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/store.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/ledger.js'), 'utf8'), ctx);
const L = ctx.StockLedger;
store.clear();
L.seedIfEmpty();
const lot = L.listLots().find((x) => x.for_sale !== false && Number(x.unit_price) > 0);
assert.ok(lot);
const balBefore = L.balanceAt(lot.lot_id);
const qtyStock = 7; // 5+2 style
const qtyPaid = 5;
const unit = Number(lot.unit_price);
const lineTotal = qtyPaid * unit;
const subtotal = lineTotal;
const discount = 30;
const payable = subtotal - discount;
assert.ok(payable >= 0);

L.appendEvent({
  lot_id: lot.lot_id,
  type: 'SALE',
  qty: qtyStock,
  actor_user_id: 'cashier',
  reason: 'smoke discount',
  meta: {
    payment: 'cash',
    promo: '5+2',
    qty_paid: qtyPaid,
    qty_stock: qtyStock,
    unit_price: unit,
    line_total: lineTotal,
    product_name: lot.product_name,
    unit: 'g',
    checkout_id: 'CHK-SMOKE',
    subtotal_before_discount: subtotal,
    discount_baht: discount,
    payable_baht: payable
  }
});

assert.equal(L.balanceAt(lot.lot_id), balBefore - qtyStock);
const ev = L.listEvents().filter((e) => e.type === 'SALE').pop();
assert.equal(ev.meta.discount_baht, 30);
assert.equal(ev.meta.subtotal_before_discount, subtotal);
assert.equal(ev.meta.payable_baht, payable);
assert.equal(ev.qty, qtyStock); // stock unchanged by discount

// HTML has discount field
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /id="pos-discount-baht"/);
assert.match(html, /id="pos-cart-subtotal"/);
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
assert.match(app, /function posCartDiscountBaht/);
assert.match(app, /discount_baht:/);
assert.match(app, /subtotal_before_discount:/);
assert.doesNotMatch(app, /function balanceAt\s*\(/); // app must not redefine balanceAt

console.log('pos-discount.smoke: PASS', { payable, stockCut: qtyStock });
