import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceDraft, supportsEvidence, validatePhoto} from '../src/evidence-draft.js';
import {fakeIndexedDB} from './fake-idb.mjs';
const identity={api:'https://fixture.invalid',store:'shop',actor:'owner'};
const options=()=>({identity,indexedDB:fakeIndexedDB(),uuid:()=>crypto.randomUUID()});
const snapshot=[{id:'lot',stock_revision:3,quantity_mg:100000,lot_code:'LOT',name:'Fixture'}];
const meta={shift_label:'morning',reason:'physical count'};
test('draft UUID and exact photo bytes survive reload without a submitted-mutation intent',async()=>{
  const config=options(),drafts=createEvidenceDraft(config);
  const first=await drafts.ensure(snapshot,meta);await drafts.setCount('lot','100');
  const photo=await drafts.select('lot',new Blob(['exact-photo-bytes'],{type:'image/jpeg'}));
  const restored=await createEvidenceDraft(config).read();
  assert.equal(restored.id,first.id);assert.equal(restored.photos.lot.client_upload_id,photo.photos.lot.client_upload_id);
  assert.equal(await restored.photos.lot.blob.text(),'exact-photo-bytes');
  assert.equal(restored.snapshot[0].stock_revision,3);assert.equal(restored.counts.lot,'100');
});
test('changed count invalidates photo and binding mismatch cannot attach an unrelated photo',async()=>{
  const drafts=createEvidenceDraft(options());await drafts.ensure(snapshot,meta);await drafts.setCount('lot','100');
  const selected=await drafts.select('lot',new Blob(['photo'],{type:'image/png'}));const upload=selected.photos.lot.client_upload_id;
  await assert.rejects(drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:'wrong',lot_id:'lot',evidence_id:'id'}));
  const saved=await drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:selected.id,lot_id:'lot',evidence_id:'id'});
  assert.equal(saved.photos.lot.metadata.evidence_id,'id');
  assert.equal((await drafts.setCount('lot','99.999')).photos.lot,undefined);
});
test('drafts are isolated by API/store/actor and only matching draft UUID may be cleared',async()=>{
  const config=options(),drafts=createEvidenceDraft(config),first=await drafts.ensure(snapshot,meta);
  const other=createEvidenceDraft({...config,identity:{...identity,actor:'other'}});assert.equal(await other.read(),null);
  await assert.rejects(drafts.clear('different'));assert.equal((await drafts.read()).id,first.id);
  await drafts.clear(first.id);assert.equal(await drafts.read(),null);
});
test('missing browser storage, invalid MIME, empty and oversized images fail before network',async()=>{
  await assert.rejects(createEvidenceDraft({...options(),indexedDB:null}).ensure(snapshot,meta));
  for(const photo of [new Blob([],{type:'image/jpeg'}),new Blob(['svg'],{type:'image/svg+xml'}),{type:'image/jpeg',size:5*1024*1024+1}])assert.throws(()=>validatePhoto(photo));
  assert.equal(supportsEvidence({stocktakes:true,stocktake_contract_version:1}),false);
  assert.equal(supportsEvidence({stocktakes:true,stocktake_contract_version:2,stocktake_evidence:true,evidence_contract_version:1}),true);
});
