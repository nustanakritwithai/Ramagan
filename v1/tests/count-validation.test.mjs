import test from 'node:test';
import assert from 'node:assert/strict';
import {stocktakeMilligrams,countInputIssues,stocktakeSelection} from '../src/count-validation.js';

test('stocktake accepts exact keyboard decimal forms without rounding or changing blank meaning',()=>{
  for(const [value,mg] of [['.5',500],['5.',5000],['1.2300',1230],['๕.๑๒๓',5123],['１２．５',12500],['0.0000',0],['100000.0000',100000000]]){
    assert.equal(stocktakeMilligrams(value),mg,value);
  }
  for(const value of ['', ' ', '1,234', '12,34', '1.2345', '0.0001', '-1', '1e3', '100000.001', '12g', null])assert.throws(()=>stocktakeMilligrams(value));
});
test('all invalid rows are identified independently of filters and without inventing quantities',()=>{
  const lots=[{id:'one',name:'Example A'},{id:'two',name:'Example B'}];
  const counts=new Map([['one','1,234'],['two','2.3456'],['blank','  '],['valid','.5']]);
  const problems=countInputIssues(lots,counts);
  assert.deepEqual(problems.map(x=>x.lotId),['one','two']);assert.equal(problems[0].row.name,'Example A');
  assert.equal(problems[0].value,'1,234');assert.match(problems[0].message,/คอมมา/);
  assert.equal(counts.get('one'),'1,234','Inspection does not alter the entered value');
});


test('ready selection isolates zero, photo-only, missing-photo, invalid, stale and unsaved rows without changing them',()=>{
  const counts=new Map([['zero','0'],['blank',''],['missing','2'],['invalid','1,2'],['stale','3'],['unsaved','4']]);
  const snapshot=[...counts.keys(),'photo-only'].map(id=>({id,stock_revision:1}));
  const photos=Object.fromEntries(['zero','invalid','stale','unsaved','photo-only'].map(id=>[id,{blob:new Blob(['bytes']),metadata:{evidence_id:id}}]));
  const draft={counts:{...Object.fromEntries(counts),unsaved:'3'},snapshot,photos};
  const before=structuredClone(draft);
  const result=stocktakeSelection(counts,draft,snapshot.map(row=>row.id==='stale'?{...row,stock_revision:2}:row));
  assert.deepEqual(result.items,[{lot_id:'zero',expected_revision:1,counted_quantity_mg:0,evidence_id:'zero'}]);
  assert.deepEqual(result.remaining.map(x=>x.lotId),['missing','invalid','stale','unsaved','photo-only']);
  assert.deepEqual(draft,before);
});
