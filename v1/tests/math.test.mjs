import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gramsToMilligrams,
  milligramsToGrams,
  lineTotalSatang,
  formatBaht,
  bahtToSatang
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
