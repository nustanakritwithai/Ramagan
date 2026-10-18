import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentPreview} from '../src/pos.js';
const base={capabilities:{split_payments:true,payment_contract_version:1}};
test('cash received and change remain integer UI values separate from sale allocations',()=>{
  assert.deepEqual(paymentPreview({...base,payment:'cash',cashReceived:'500'},29900),{cash:29900,transfer:0,received:50000,change:20100});
  assert(paymentPreview({...base,payment:'cash',cashReceived:'298.99'},29900).error);
  assert.equal(paymentPreview({...base,payment:'cash',cashReceived:''},0).change,0);
});
test('split is one exact cash/transfer allocation and rejects unsupported, fractional, zero and wrong totals',()=>{
  const split={...base,payment:'split',splitCash:'100',splitTransfer:'199'};
  const result=paymentPreview(split,29900);assert.equal(result.received,10000);assert.equal(result.change,0);
  assert.deepEqual(result.payments,[{payment_method:'cash',amount_satang:10000},{payment_method:'transfer',amount_satang:19900}]);
  for(const change of [{capabilities:{}},{splitCash:'0'},{splitTransfer:'199.001'},{splitCash:'100.01'}])assert(paymentPreview({...split,...change},29900).error);
  assert.deepEqual(paymentPreview({...split,cashReceived:'invalid stale cash-only value'},29900),result);
  assert(paymentPreview({...split,splitCash:'0',splitTransfer:'0'},0).error);
  assert.deepEqual(paymentPreview({...base,payment:'transfer'},29900),{cash:0,transfer:29900,received:0,change:0});
});
