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
test('count edits preserve exact draft/Lot photo binding while unrelated upload metadata is rejected',async()=>{
  const drafts=createEvidenceDraft(options());await drafts.ensure(snapshot,meta);await drafts.setCount('lot','100');
  const selected=await drafts.select('lot',new Blob(['photo'],{type:'image/png'}));const upload=selected.photos.lot.client_upload_id;
  await assert.rejects(drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:'wrong',lot_id:'lot',evidence_id:'id'}));
  const saved=await drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:selected.id,lot_id:'lot',evidence_id:'id'});
  assert.equal(saved.photos.lot.metadata.evidence_id,'id');
  const edited=await drafts.setCount('lot','99.999');
  assert.equal(edited.photos.lot.client_upload_id,upload);assert.equal(edited.photos.lot.metadata.evidence_id,'id');
  assert.equal(await edited.photos.lot.blob.text(),'photo');
  for(const wrong of [{client_upload_id:'other'},{client_stocktake_id:'other'},{lot_id:'other'}]){
    await assert.rejects(drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:selected.id,lot_id:'lot',evidence_id:'id',...wrong}));
  }
});
test('photo can upload before a count without inventing zero and survives subsequent edits and reload',async()=>{
  const config=options(),drafts=createEvidenceDraft(config);await drafts.ensure(snapshot,meta);
  const selected=await drafts.select('lot',new Blob(['photo-first'],{type:'image/jpeg'}));
  assert.equal(selected.counts.lot,undefined);const upload=selected.photos.lot.client_upload_id;
  await drafts.uploaded('lot',upload,{client_upload_id:upload,client_stocktake_id:selected.id,lot_id:'lot',evidence_id:'photo-first-id'});
  for(const value of ['1','10','100','100.125',''])await drafts.setCount('lot',value);
  const restored=await createEvidenceDraft(config).read();
  assert.equal(restored.counts.lot,'');assert.equal(restored.photos.lot.metadata.evidence_id,'photo-first-id');
  assert.equal(restored.photos.lot.client_upload_id,upload);assert.equal(await restored.photos.lot.blob.text(),'photo-first');
});
test('new photo selection changes upload UUID and rejects the previous delayed upload response',async()=>{
  const drafts=createEvidenceDraft(options());await drafts.ensure(snapshot,meta);
  const first=await drafts.select('lot',new Blob(['first'],{type:'image/jpeg'}));
  const old=first.photos.lot.client_upload_id;
  const second=await drafts.select('lot',new Blob(['second'],{type:'image/jpeg'}));
  assert.notEqual(second.photos.lot.client_upload_id,old);
  await assert.rejects(drafts.uploaded('lot',old,{client_upload_id:old,client_stocktake_id:first.id,lot_id:'lot',evidence_id:'old'}));
  const restored=await drafts.read();assert.equal(restored.photos.lot.metadata,null);assert.equal(await restored.photos.lot.blob.text(),'second');
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
