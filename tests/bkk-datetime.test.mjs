
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const start = src.indexOf('function datetimeLocalToIso');
const end = src.indexOf('function toDatetimeLocalValue');
assert.ok(start > 0 && end > start);
// pull datetimeLocalToIso body via Function
const fnSrc = src.slice(src.indexOf('var BKK_OFFSET'), src.indexOf('/* —— forms —— */'));
const fn = new Function(fnSrc + '; return { datetimeLocalToIso, toDatetimeLocalValue };');
const { datetimeLocalToIso, toDatetimeLocalValue } = fn();
assert.equal(datetimeLocalToIso('2026-09-13T00:00'), '2026-09-13T00:00:00+07:00');
assert.equal(datetimeLocalToIso('2026-09-13T12:00'), '2026-09-13T12:00:00+07:00');
assert.ok(!datetimeLocalToIso('2026-09-13T00:00').includes('T14:'));
const wall = toDatetimeLocalValue(new Date('2026-09-13T00:00:00+07:00'));
assert.equal(wall, '2026-09-13T00:00');
console.log('bkk-datetime: PASS');
