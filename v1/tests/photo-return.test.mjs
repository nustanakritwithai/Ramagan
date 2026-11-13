import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoReturn,PHOTO_RETURN_KEY} from '../src/photo-return.js';
import {createEvidenceDraft} from '../src/evidence-draft.js';
import {fakeIndexedDB} from './fake-idb.mjs';

async function fixture(){
  const rows=new Map(),storage={getItem:k=>rows.get(k)||null,setItem:(k,v)=>rows.set(k,v),removeItem:k=>rows.delete(k)};
  const identity={api:'https://fixture.invalid',store:'shop',actor:'manager'},idb=fakeIndexedDB();
  const openDraft=identity=>createEvidenceDraft({identity,indexedDB:idb,uuid:()=>crypto.randomUUID()});
  const draftStore=openDraft(identity),draft=await draftStore.ensure([{id:'lot',stock_revision:3}],{shift_label:'test',reason:''});
  await draftStore.setCount('lot','10');await draftStore.select('lot',new Blob(['old'],{type:'image/jpeg'}));
  const config={storage,openDraft,uuid:()=>crypto.randomUUID(),prepare:async x=>x,readNative:async x=>x.blob};
  return {storage,identity,draftStore,draft,config,create:runtime=>createPhotoReturn({...config,runtime})};
}
test('a photo returned after PIN/session loss is saved only to its original actor without a network request',async()=>{
  const f=await fixture(),flow=f.create('before-lock');
  const context=await flow.begin({identity:f.identity,draftId:f.draft.id,lot:'lot',native:true});
  const result=await flow.complete(context,new Blob(['new'],{type:'image/jpeg'}));
  assert.equal(result.draft.counts.lot,'10');assert.equal(result.draft.photoReturn,true);
  assert.equal(await result.draft.photos.lot.blob.text(),'new');assert.equal(result.draft.photos.lot.metadata,null);
  assert.equal(await f.config.openDraft({...f.identity,actor:'other'}).read(),null);
  assert.equal(f.storage.getItem(PHOTO_RETURN_KEY),null);
});
test('Android activity recreation consumes one durable return address and preserves upload UUID across reload',async()=>{
  const f=await fixture(),before=f.create('old');
  const context=await before.begin({identity:f.identity,draftId:f.draft.id,lot:'lot',native:true});
  const event={pluginId:'Camera',methodName:'getPhoto',success:true,data:{blob:new Blob(['returned'],{type:'image/jpeg'})}};
  assert.equal(await before.restore(event),null,'live runtime must not consume restored events');
  const after=f.create('new'),result=await after.restore(event);
  assert.equal(result.draft.photos.lot.client_upload_id,context.request);assert.equal(await result.draft.photos.lot.blob.text(),'returned');
  assert.equal(await after.restore(event),null,'duplicate event cannot duplicate or replace evidence');
  assert.equal((await f.draftStore.read()).id,f.draft.id);
});
test('failed replacement or cancelled picker retains old image; row error survives app restart',async()=>{
  const f=await fixture(),flow=createPhotoReturn({...f.config,runtime:'test',prepare:async()=>{throw new Error('invalid photo');}});
  const context=await flow.begin({identity:f.identity,draftId:f.draft.id,lot:'lot',native:true});
  const result=await flow.complete(context,new Blob(['bad'],{type:'image/jpeg'}));
  assert.equal(await result.draft.photos.lot.blob.text(),'old');assert.equal(result.draft.photoErrors.lot,'invalid photo');
  const cancel=await flow.begin({identity:f.identity,draftId:f.draft.id,lot:'lot'});
  await flow.complete(cancel,null);assert.equal(await (await f.draftStore.read()).photos.lot.blob.text(),'old');
  assert.equal((await f.draftStore.read()).photoErrors.lot,undefined);
});
test('old result cannot overwrite a new selection or a cleared/replaced draft',async()=>{
  const f=await fixture(),flow=f.create('test');
  const first=await flow.begin({identity:f.identity,draftId:f.draft.id,lot:'lot'});
  const second=await flow.begin({identity:f.identity,draftId:f.draft.id,lot:'lot'});
  await assert.rejects(flow.complete(first,new Blob(['late'],{type:'image/jpeg'})),/เปลี่ยนแล้ว/);
  await f.draftStore.clear(f.draft.id);
  await assert.rejects(flow.complete(second,new Blob(['late'],{type:'image/jpeg'})),/ไม่พบแบบร่าง/);
});
