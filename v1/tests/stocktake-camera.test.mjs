import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraPhotoBlob} from '../src/stocktake-camera.js';

test('native capture calls takePhoto only and reads a valid full photo',async()=>{
  let options,reads=0;
  const camera={takePhoto:async value=>{options=value;return {webPath:'https://localhost/_capacitor_file_/fixture.jpg'};},
    chooseFromGallery:()=>assert.fail('Camera must not open album')};
  const blob=await cameraPhotoBlob(camera,async url=>{
    reads++;assert.equal(url,'https://localhost/_capacitor_file_/fixture.jpg');
    return new Response(new Blob(['photo'],{type:'image/jpeg'}));
  });
  assert.equal(await blob.text(),'photo');assert.equal(blob.type,'image/jpeg');assert.equal(reads,1);
  assert.equal(options.saveToGallery,false);assert.equal(options.editable,'no');
});

test('camera cancellation returns no replacement and does not read a file',async()=>{
  const photo=await cameraPhotoBlob({takePhoto:async()=>{throw {code:'OS-PLUG-CAMR-0006'};}},()=>assert.fail('No file after cancel'));
  assert.equal(photo,null);
});

test('camera permission and device failures are visible and never open an album',async()=>{
  for(const [code,message] of [['OS-PLUG-CAMR-0003',/อนุญาตกล้อง/],['OS-PLUG-CAMR-0007',/เปิดกล้องไม่สำเร็จ/],['UNIMPLEMENTED',/เปิดกล้องไม่สำเร็จ/]]){
    await assert.rejects(cameraPhotoBlob({takePhoto:async()=>{throw {code};},chooseFromGallery:()=>assert.fail('No fallback')}),message);
  }
});

test('invalid or unreadable native results cannot replace evidence',async()=>{
  await assert.rejects(cameraPhotoBlob({takePhoto:async()=>({})}),/ไม่ได้รับรูป/);
  const camera={takePhoto:async()=>({webPath:'fixture'})};
  await assert.rejects(cameraPhotoBlob(camera,async()=>new Response('',{status:404})),/อ่านรูป/);
  for(const blob of [new Blob(['bad'],{type:'text/html'}),new Blob([],{type:'image/jpeg'}),new Blob([new Uint8Array(5*1024*1024+1)],{type:'image/jpeg'})]){
    await assert.rejects(cameraPhotoBlob(camera,async()=>new Response(blob)),/5 MB/);
  }
});
