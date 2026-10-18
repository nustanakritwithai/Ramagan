import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareReport, supportsInventoryCosts, dailyCsv, money, profitMoney,
  signedFixedUnits, costCoverage} from '../admin/lib.js';

// Disposable response fixtures only. No API requests, real stores or credentials.
function fixture({discount = 17550, cost = 8000, unknown = 0} = {}) {
  const net = 30000 - discount;
  const amounts = {subtotal_satang:30000, discount_satang:discount, total_satang:net,
    known_cost_satang:cost, cost_satang:unknown ? null : cost,
    gross_profit_satang:unknown ? null : net - cost,
    unknown_cost_line_count:unknown, cost_complete:unknown === 0};
  return {
    capabilities:{discounts:true, discount_contract_version:1,
      inventory_costs:true, cost_contract_version:1},
    period:{from:'2026-10-14', to:'2026-10-14', timezone:'Asia/Bangkok'},
    summary:{...amounts, sale_count:1, cash_satang:net, transfer_satang:0,
      quantity_mg:2000, average_satang:net},
    daily:[{...amounts, date:'2026-10-14', sale_count:1, quantity_mg:2000}],
    top_products:[{...amounts, sku:'COST-FIXTURE', name:'Synthetic only', quantity_mg:2000}],
    top_categories:[{...amounts, category:'Synthetic', quantity_mg:2000}],
    recent_sales:[{...amounts, id:'fixture', payment_method:'cash', line_count:2,
      created_at:'2026-10-14T00:00:00Z', quantity_mg:2000}],
    low_stock:[]
  };
}
function groups(data) {
  return [data.summary, ...data.daily, ...data.top_products,
    ...data.top_categories, ...data.recent_sales];
}

test('cost capability requires true and integer version 1; old schema2 remains usable', () => {
  for (const capabilities of [undefined, {}, {inventory_costs:false, cost_contract_version:1},
    {inventory_costs:1, cost_contract_version:1}, {inventory_costs:true},
    {inventory_costs:true, cost_contract_version:'1'}, {inventory_costs:true, cost_contract_version:2}]) {
    assert.equal(supportsInventoryCosts(capabilities), false);
    const data = fixture();
    data.capabilities = {...data.capabilities, inventory_costs:undefined, cost_contract_version:undefined,
      ...capabilities};
    for (const row of groups(data)) {
      for (const key of ['known_cost_satang','cost_satang','gross_profit_satang','unknown_cost_line_count','cost_complete']) delete row[key];
    }
    const report = prepareReport(data);
    assert.equal(report.costsSupported, false);
    assert.equal(report.summary.net, 12450);
    for (const row of groups(report)) {
      assert.equal(row.cost, null); assert.equal(row.profit, null);
      assert.match(costCoverage(row), /ยังไม่รองรับ/);
    }
  }
  assert.equal(supportsInventoryCosts({inventory_costs:true, cost_contract_version:1}), true);
});

test('all report groups use server cost snapshots and profit after discount', () => {
  const report = prepareReport(fixture());
  assert.equal(report.costsSupported, true);
  for (const row of groups(report)) {
    assert.equal(row.gross, 30000); assert.equal(row.discount, 17550); assert.equal(row.net, 12450);
    assert.equal(row.knownCost, 8000); assert.equal(row.cost, 8000); assert.equal(row.profit, 4450);
    assert.equal(row.costComplete, true); assert.equal(costCoverage(row), 'ต้นทุนครบ');
  }
});

test('explicit zero cost is known; full discount can create an exact negative profit', () => {
  const freeCost = prepareReport(fixture({cost:0}));
  assert.equal(freeCost.summary.cost, 0); assert.equal(freeCost.summary.profit, 12450);
  const loss = prepareReport(fixture({discount:30000}));
  assert.equal(loss.summary.net, 0); assert.equal(loss.summary.profit, -8000);
  assert.equal(profitMoney(loss.summary.profit), '−฿80.00');
  assert.equal(signedFixedUnits(loss.summary.profit), '-80.00');
  assert.equal(money(-8000), '—'); // Revenue/cost validation has not been relaxed.
});

test('historical unknown costs never become zero costs or full revenue profit', () => {
  const report = prepareReport(fixture({cost:3000, unknown:1}));
  for (const row of groups(report)) {
    assert.equal(row.cost, null); assert.equal(row.profit, null);
    assert.equal(row.knownCost, 3000); assert.equal(row.unknownCostLines, 1);
    assert.equal(row.costComplete, false);
    assert.match(costCoverage(row), /ไม่ทราบต้นทุน 1 บรรทัด/);
  }
  const csv = dailyCsv(report);
  assert.match(csv, /ต้นทุนขายรวม/); assert.match(csv, /กำไรขั้นต้นหลังส่วนลด/);
  assert.match(csv, /"30\.00","—","—","1"/);
});

test('costs and profit stay unavailable when net discount contract is unconfirmed', () => {
  const data = fixture(); data.capabilities.discount_contract_version = 2;
  const report = prepareReport(data);
  assert.equal(report.costsSupported, false);
  assert.equal(report.summary.profit, null); assert.equal(report.summary.net, null);
  assert.doesNotMatch(dailyCsv(report), /44\.50/);
});

test('claimed cost contract rejects missing, inconsistent, coerced and unsafe fields', () => {
  const mutations = [
    data => delete data.daily[0].cost_satang,
    data => data.summary.known_cost_satang++,
    data => data.top_products[0].gross_profit_satang++,
    data => data.top_categories[0].cost_complete = 'true',
    data => data.recent_sales[0].unknown_cost_line_count = -1,
    data => data.summary.cost_satang = true,
    data => data.summary.known_cost_satang = '8000',
    data => data.summary.gross_profit_satang = Number.MAX_SAFE_INTEGER + 1,
    data => data.summary.cost_complete = false,
    data => data.daily[0].unknown_cost_line_count = 1,
  ];
  for (const mutate of mutations) {
    const data = fixture(); mutate(data); assert.throws(() => prepareReport(data));
  }
  const incomplete = fixture({unknown:1});
  incomplete.summary.gross_profit_satang = incomplete.summary.total_satang;
  assert.throws(() => prepareReport(incomplete), /ข้อมูลบางส่วน/);
});

test('daily known cost and unknown coverage must reconcile with the full summary', () => {
  const data = fixture({unknown:1});
  data.summary.known_cost_satang++;
  assert.throws(() => prepareReport(data), /รายวันไม่ตรง/);
  const other = fixture({unknown:1});
  other.summary.unknown_cost_line_count++;
  assert.throws(() => prepareReport(other), /รายวันไม่ตรง/);
});

test('empty complete report has explicit zero cost/profit without inferring historical costs', () => {
  const data = fixture({discount:0, cost:0});
  for (const row of groups(data)) Object.assign(row, {subtotal_satang:0, total_satang:0,
    gross_profit_satang:0, sale_count:0, quantity_mg:0, line_count:0});
  Object.assign(data.summary, {cash_satang:0, average_satang:0});
  data.top_products = []; data.top_categories = []; data.recent_sales = [];
  const report = prepareReport(data);
  assert.equal(report.summary.cost, 0); assert.equal(report.summary.profit, 0);
});

test('CSV preserves satang, exact signed losses and coverage with formula escaping', () => {
  const loss = prepareReport(fixture({discount:30000}));
  const csv = dailyCsv(loss);
  assert.match(csv, /"80\.00","80\.00","'-80\.00","0","ต้นทุนครบ"/);
  assert.equal(signedFixedUnits(-Number.MAX_SAFE_INTEGER), '-90071992547409.91');
  for (const value of [null, undefined, false, '', '100', 0.2, NaN, Infinity]) assert.equal(profitMoney(value), '—');
});
