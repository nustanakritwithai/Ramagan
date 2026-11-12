import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesStocktakeSearch} from '../src/management-ui.js';

test('stocktake search matches names, SKU and lot with case, spacing and Unicode normalization',()=>{
  const lot={name:'ชื่อสินค้า Mac1',sku:'TOP-MAC',lot_code:'LOT-001'};
  for(const query of ['', '  ', 'mac1', 'ＭＡＣ１', 'ชื่อสินค้า', ' TOP-mac ', 'mac1  lot-001'])assert.equal(matchesStocktakeSearch(lot,query),true,query);
  assert.equal(matchesStocktakeSearch(lot,'mac1 lot-002'),false);
  assert.equal(matchesStocktakeSearch(lot,'<script>'),false);
});

test('stocktake search never uses private balances or costs as searchable fields',()=>{
  const lot={name:'Example',sku:'EX',lot_code:'L-A',quantity_mg:987654,cost_satang_per_gram:765432};
  assert.equal(matchesStocktakeSearch(lot,'987654'),false);
  assert.equal(matchesStocktakeSearch(lot,'765432'),false);
  assert.equal(matchesStocktakeSearch(lot,'example'),true);
});
