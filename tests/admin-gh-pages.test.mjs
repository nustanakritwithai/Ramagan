import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  normalizeApiBase, isReportRole, money, grams, gramsToMgAllowZero,
  bangkokDay, verifyPeriod, escapeCsvCell, dailyCsv, fixedUnits, supportsDiscounts, prepareReport
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
  assert.throws(() => verifyPeriod('2026-02-30','2026-03-03'));
});

test('CSV quotes dangerous spreadsheet strings and uses integer money', () => {
  const csv=dailyCsv({capabilities:{discounts:true,discount_contract_version:1},daily:[{
    date:'2026-10-14', sale_count:2,
    subtotal_satang:20000, discount_satang:2950, total_satang:17050, quantity_mg:1500
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
  assert.doesNotMatch(script,/localStorage\./);
  assert.doesNotMatch(script,/localStorage\.setItem\([^)]*token/);
  assert.doesNotMatch(script,/service_role|sb_secret_|supabase-js/);
});

test('Admin connection diagnostic is credential free and explains cross-origin login failures', () => {
  const html=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
  const script=fs.readFileSync(new URL('../admin/dashboard.js',import.meta.url),'utf8');
  assert.match(html,/id="api-check-button"/);
  assert.match(html,/id="health-open-link"/);
  assert.match(script,/async function probeHealth/);
  assert.match(script,/method: 'GET'/);
  assert.match(script,/credentials: 'omit'/);
  assert.match(script,/OPTIONS \/v1\/auth\/login/);
  assert.match(script,/setHealthLink\(normalizeApiBase/);
  assert.doesNotMatch(script,/sessionStorage\./);
  assert.doesNotMatch(script,/localStorage\./);
});

// Synthetic offline fixtures only; no real store sales or credentials.
function fixture(discount = 2950) {
  const amounts = {subtotal_satang:20000, discount_satang:discount, total_satang:20000-discount};
  return {
    capabilities:{discounts:true,discount_contract_version:1},
    period:{from:'2026-10-14',to:'2026-10-14',timezone:'Asia/Bangkok'},
    summary:{...amounts,sale_count:1,cash_satang:20000-discount,transfer_satang:0,quantity_mg:1500,average_satang:20000-discount},
    daily:[{...amounts,date:'2026-10-14',sale_count:1,quantity_mg:1500}],
    top_products:[{...amounts,sku:'OFFLINE',name:'Synthetic fixture',quantity_mg:1500,sale_count:1}],
    top_categories:[{...amounts,category:'Fixture',quantity_mg:1500}],
    recent_sales:[{...amounts,id:'offline-only',payment_method:'cash',created_at:'2026-10-14T00:00:00Z',quantity_mg:1500,line_count:1}],
    low_stock:[]
  };
}
test('discount capability must be explicit and a known version', () => {
  for (const c of [null,{}, {discounts:false,discount_contract_version:1}, {discounts:true}, {discounts:true,discount_contract_version:2}]) assert.equal(supportsDiscounts(c),false);
  assert.equal(supportsDiscounts({discounts:true,discount_contract_version:1}),true);
});
test('gross, discount and net remain separate including zero and 100% discount', () => {
  for (const discount of [0,2950,20000]) {
    const report=prepareReport(fixture(discount));
    assert.equal(report.summary.gross,20000);
    assert.equal(report.summary.discount,discount);
    assert.equal(report.summary.net,20000-discount);
    assert.equal(report.top_products[0].net,20000-discount);
    assert.match(dailyCsv(report),new RegExp(fixedUnits(discount).replace('.', '\\.')));
  }
});
test('legacy gross rankings never become net or zero discount', () => {
  const data=fixture(); delete data.capabilities;
  delete data.daily[0].subtotal_satang; delete data.daily[0].discount_satang;
  data.top_products[0].total_satang=20000;
  const report=prepareReport(data);
  assert.equal(report.summary.net,null);
  assert.equal(report.summary.discount,null);
  assert.equal(report.top_products[0].gross,20000);
  assert.equal(report.top_products[0].net,null);
  assert.equal(report.daily[0].gross,null);
  assert.match(dailyCsv(report),/ไม่รองรับ/);
  assert.doesNotMatch(dailyCsv(report),/170\.50/);
});
test('incomplete, inconsistent, unsafe and wrong-timezone responses fail closed', () => {
  const mutations=[
    d=>delete d.daily,
    d=>delete d.daily[0].discount_satang,
    d=>d.summary.cash_satang++,
    d=>d.top_products[0].total_satang++,
    d=>d.summary.discount_satang=null,
    d=>d.summary.total_satang=Number.MAX_SAFE_INTEGER+1,
    d=>d.period.timezone='UTC',
    d=>d.daily[0].sale_count++,
    d=>d.daily.push({...d.daily[0]}),
    d=>d.summary.average_satang++,
  ];
  for(const mutate of mutations) {const data=fixture();mutate(data);assert.throws(()=>prepareReport(data));}
});
test('integer display does not round high-value satang or coerce missing values', () => {
  assert.equal(fixedUnits(Number.MAX_SAFE_INTEGER),'90071992547409.91');
  assert.equal(money(Number.MAX_SAFE_INTEGER),'฿90,071,992,547,409.91');
  for(const value of [null,undefined,'',false,'100',-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(money(value),'—');
});

test('report snapshot is invalidated on filter edits and controls freeze during requests', () => {
  const script=fs.readFileSync(new URL('../admin/dashboard.js',import.meta.url),'utf8');
  assert.match(script,/\$\('logout'\)\.disabled = value/);
  assert.match(script,/for \(const id of \['from-date', 'to-date', 'low-stock'\]\) \$\(id\)\.disabled = value/);
  assert.match(script,/addEventListener\('input', \(\) => \{\s+if \(!store \|\| busy\) return;\s+wipeReport\(\)/);
});
