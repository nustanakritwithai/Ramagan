import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gramsToMilligrams,
  milligramsToGrams,
  lineTotalSatang,
  formatBaht,
  bahtToSatang,
  discountSatang,
  sumSatang
} from '../src/math.js';

test('exact milligram scaling, no floats in stored quantity', () => {
  assert.equal(gramsToMilligrams('0.001'), 1);
  assert.equal(gramsToMilligrams('1.234'), 1234);
  assert.equal(gramsToMilligrams('10'), 10000);
  assert.equal(milligramsToGrams(1234), '1.234');
});

test('reject invalid and unbounded quantities', () => {
  for (const q of ['0', '-1', '0.0001', 'NaN', '1e5', '1000.001']) {
    assert.throws(() => gramsToMilligrams(q));
  }
});

test('prices use integer satang rounding', () => {
  assert.equal(lineTotalSatang(10000, 1000), 10000);
  assert.equal(lineTotalSatang(9999, 1500), 14999);
  assert.equal(lineTotalSatang(1, 500), 1);
  assert.match(formatBaht(10000), /100/);
});

test('store product prices as exact integer satang', () => {
  assert.equal(bahtToSatang('0'), 0);
  assert.equal(bahtToSatang('100'), 10000);
  assert.equal(bahtToSatang('100.25'), 10025);
  assert.equal(bahtToSatang('0.01'), 1);
  for (const bad of ['-1', '1e5', '0.001', '101.256', 'NaN', '1000001']) {
    assert.throws(() => bahtToSatang(bad));
  }
});


test('money input requires plain decimal strings with at most two places', () => {
  const invalid = [
    '', ' ', '.', '.50', '1.', '+1', '-1', '-0', '0.001', '175.500',
    '1e2', '0x10', '1,000', 'NaN', 'Infinity',
    true, false, NaN, Infinity, -Infinity, null, undefined, 1, 175.5,
    {}, [], ['1'], { toString: () => '1' },
    '90071992547409.92', '999999999999999999999999999999999999'
  ];
  for (const value of invalid) {
    assert.throws(() => bahtToSatang(value), `product price: ${String(value)}`);
    assert.throws(() => discountSatang(value, Number.MAX_SAFE_INTEGER), `discount: ${String(value)}`);
  }
  assert.equal(bahtToSatang(' 175.50 '), 17550);
  assert.equal(bahtToSatang('0001.5'), 150);
  assert.equal(bahtToSatang('1000000.00'), 100_000_000);
  assert.throws(() => bahtToSatang('1000000.01'));
});

test('discounts are exact and can range from zero through the full subtotal', () => {
  const subtotal = 20000;
  assert.equal(discountSatang('0', subtotal), 0);
  assert.equal(discountSatang('1', subtotal), 100);
  assert.equal(discountSatang('175.50', subtotal), 17550);
  assert.equal(discountSatang('200.00', subtotal), subtotal);
  assert.equal(discountSatang('0', 0), 0);
  assert.throws(() => discountSatang('0.01', 0));
  assert.throws(() => discountSatang('200.01', subtotal));
  // Discounts apply to cart totals, not the per-gram product-price cap.
  assert.equal(discountSatang('1000000.01', 100_000_001), 100_000_001);
  assert.equal(discountSatang('90071992547409.91', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const subtotal of [-1, 0.5, true, '20000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => discountSatang('0', subtotal));
  }
});

test('safe aggregate totals include multiple separately rounded lots', () => {
  const totals = [lineTotalSatang(9999, 1500), lineTotalSatang(7500, 2250), lineTotalSatang(1, 500)];
  assert.deepEqual(totals, [14999, 16875, 1]);
  const subtotal = sumSatang(totals);
  assert.equal(subtotal, 31875);
  assert.equal(subtotal - discountSatang('175.50', subtotal), 14325);
  assert.equal(subtotal - discountSatang('318.75', subtotal), 0);
  assert.equal(sumSatang([]), 0);
  assert.equal(sumSatang([0, Number.MAX_SAFE_INTEGER - 1, 1]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => sumSatang([Number.MAX_SAFE_INTEGER, 1]));
  for (const invalid of [-1, 0.5, true, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => sumSatang([1, invalid]));
  }
  for (const invalid of [null, undefined, true, 1, '100', {}]) {
    assert.throws(() => sumSatang(invalid));
  }
});

test('line totals preserve exact half-up rounding even with large intermediates', () => {
  assert.equal(lineTotalSatang(1, 499), 0);
  assert.equal(lineTotalSatang(1, 500), 1);
  assert.equal(lineTotalSatang(1, 501), 1);
  assert.equal(lineTotalSatang(0, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(lineTotalSatang(Number.MAX_SAFE_INTEGER, 1000), Number.MAX_SAFE_INTEGER);
  assert.equal(lineTotalSatang(Number.MAX_SAFE_INTEGER, 1), 9007199254741);
  assert.throws(() => lineTotalSatang(Number.MAX_SAFE_INTEGER, 1001));
  for (const invalid of [-1, 0.5, true, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => lineTotalSatang(invalid, 1000));
    assert.throws(() => lineTotalSatang(100, invalid));
  }
});

test('money display preserves safe-integer cents without floating conversion', () => {
  assert.match(formatBaht(Number.MAX_SAFE_INTEGER), /90,071,992,547,409\.91/);
  assert.match(formatBaht(-1), /-.*0\.01/);
});
