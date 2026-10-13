import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  normalizeApiBase, isReportRole, money, grams, gramsToMgAllowZero,
  bangkokDay, verifyPeriod, escapeCsvCell, dailyCsv
} from '../admin/lib.js';

test('VPS report URL must be HTTPS without secrets or query strings', () => {
  assert.equal(normalizeApiBase('https://157.85.96.139/ramagan-api/'),
    'https://157.85.96.139/ramagan-api');
  for (const input of [
    'http://insecure.example/api',
    'https://name:password@example.com/',
    'https://example.com?secret=value',
    'javascript:alert(1)',
    '',
  ]) assert.equal(normalizeApiBase(input), null);
});

test('owner and manager only (the VPS separately enforces authorization)', () => {
  assert.equal(isReportRole('owner'), true);
  assert.equal(isReportRole('manager'), true);
  assert.equal(isReportRole('staff'), false);
  assert.equal(isReportRole(null), false);
});

test('correct satang, milligram and Bangkok-time formatting', () => {
  assert.match(money(10000), /100/);
  assert.equal(gramsToMgAllowZero('2.345'), 2345);
  assert.equal(gramsToMgAllowZero('0'), 0);
  assert.match(grams(12345), /12/);
  assert.throws(() => gramsToMgAllowZero('1.0001'));
  assert.throws(() => gramsToMgAllowZero('-1'));
  assert.equal(bangkokDay(new Date('2026-10-13T18:00:00Z')), '2026-10-14');
});

test('date filter permits only 1 to 93 days', () => {
  assert.equal(verifyPeriod('2026-10-01','2026-10-14'), true);
  assert.throws(() => verifyPeriod('2026-01-01','2026-10-14'));
  assert.throws(() => verifyPeriod('2026-10-15','2026-10-14'));
});

test('CSV quotes dangerous spreadsheet strings and uses integer money', () => {
  const csv=dailyCsv({daily:[{
    date:'2026-10-14', sale_count:2,
    total_satang:17050, quantity_mg:1500
  }]});
  assert.match(csv,/2026-10-14/);
  assert.match(csv,/170\.50/);
  assert.match(csv,/1\.500/);
  assert.match(escapeCsvCell('=HYPERLINK("x")'), /^"'/);
});

test('public HTML ships without embedded secrets or sales; reports require VPS', () => {
  const html=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
  const script=fs.readFileSync(new URL('../admin/dashboard.js',import.meta.url),'utf8');
  assert.match(html,/Content-Security-Policy/);
  assert.match(html,/login-message/);
  assert.match(script,/\/v1\/me/);
  assert.match(script,/\/v1\/admin\/sales-report/);
  assert.doesNotMatch(script,/sessionStorage\./);
  assert.match(script,/localStorage\.setItem\(endpointKey/);
  assert.doesNotMatch(script,/localStorage\.setItem\([^)]*token/);
  assert.doesNotMatch(script,/service_role|sb_secret_|supabase-js/);
});
