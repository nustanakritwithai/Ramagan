import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraPhotoBlob} from '../src/stocktake-camera.js';

test('native capture selects CAMERA explicitly and reads a valid full photo',async()=>{
  let options,reads=0;
  const camera={getPhoto:async value=>{options=value;return {webPath:'https://localhost/_capacitor_file_/fixture.jpg'};},
    chooseFromGallery:()=>assert.fail('Camera must not open album')};
  const blob=await cameraPhotoBlob(camera,async url=>{
    reads++;assert.equal(url,'https://localhost/_capacitor_file_/fixture.jpg');
    return new Response(new Blob(['photo'],{type:'image/jpeg'}));
  });
  assert.equal(await blob.text(),'photo');assert.equal(blob.type,'image/jpeg');assert.equal(reads,1);
  assert.equal(options.saveToGallery,false);assert.equal(options.allowEditing,false);assert.equal(options.source,'CAMERA');assert.equal(options.width,1600);
});

test('camera cancellation returns no replacement and does not read a file',async()=>{
  const photo=await cameraPhotoBlob({getPhoto:async()=>{throw {code:'OS-PLUG-CAMR-0006'};}},()=>assert.fail('No file after cancel'));
  assert.equal(photo,null);
});

test('camera permission and device failures are visible and never open an album',async()=>{
  for(const [code,message] of [['OS-PLUG-CAMR-0003',/อนุญาตกล้อง/],['OS-PLUG-CAMR-0007',/เปิดกล้องไม่สำเร็จ/],['UNIMPLEMENTED',/เปิดกล้องไม่สำเร็จ/]]){
    await assert.rejects(cameraPhotoBlob({getPhoto:async()=>{throw {code};},chooseFromGallery:()=>assert.fail('No fallback')}),message);
  }
});

test('invalid or unreadable native results cannot replace evidence',async()=>{
  await assert.rejects(cameraPhotoBlob({getPhoto:async()=>({})}),/ไม่ได้รับรูป/);
  const camera={getPhoto:async()=>({webPath:'fixture'})};
  await assert.rejects(cameraPhotoBlob(camera,async()=>new Response('',{status:404})),/อ่านรูป/);
  await assert.rejects(cameraPhotoBlob(camera,async()=>new Response(new Blob([],{type:'image/jpeg'}))),/ไม่ได้รับข้อมูลรูป/);
});

test('native album uses PHOTOS explicitly and applies the same size limit',async()=>{
  let options;
  await cameraPhotoBlob({getPhoto:async value=>{options=value;return {webPath:'fixture'};}},async()=>new Response(new Blob(['photo'],{type:'image/jpeg'})),'album');
  assert.equal(options.source,'PHOTOS');assert.equal(options.resultType,'uri');assert.equal(options.width,1600);assert.equal(options.height,1600);
});

test('legacy native cancel is neutral and permission rejection is visible',async()=>{
  assert.equal(await cameraPhotoBlob({getPhoto:async()=>{throw new Error('User cancelled photos app');}}),null);
  await assert.rejects(cameraPhotoBlob({getPhoto:async()=>{throw new Error('Permission denied');}}),/อนุญาตกล้อง/);
});
