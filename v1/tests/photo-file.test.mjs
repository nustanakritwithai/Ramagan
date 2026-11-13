import test from 'node:test';
import assert from 'node:assert/strict';
import {photoDimensions,preparePhoto} from '../src/photo-file.js';

test('large phone images become bounded portrait/landscape uploads without upscaling',()=>{
  assert.deepEqual(photoDimensions(6000,8000),{width:1200,height:1600});
  assert.deepEqual(photoDimensions(4032,3024),{width:1600,height:1200});
  assert.deepEqual(photoDimensions(320,240),{width:320,height:240});
  for(const pair of [[0,1],[1.5,10],[10000,10000]])assert.throws(()=>photoDimensions(...pair));
});
test('oversized but supported source is compressed before durable storage and resources are released',async()=>{
  const source=new Blob([new Uint8Array(6*1024*1024)],{type:'image/jpeg'});
  let closed=false,drawn,qualities=[];
  const surface={getContext:()=>({fillRect(){},drawImage(...args){drawn=args.slice(1);}}),
    toBlob(callback,type,quality){qualities.push(quality);callback(new Blob([new Uint8Array(qualities.length===1?1100000:500000)],{type}));}};
  const result=await preparePhoto(source,{decode:async()=>({image:'fixture',width:4032,height:3024,close(){closed=true;}}),canvas:()=>surface});
  assert.equal(result.type,'image/jpeg');assert.equal(result.size,500000);
  assert.deepEqual(drawn,[0,0,1600,1200]);assert.deepEqual(qualities,[.86,.72]);assert.equal(closed,true);assert.equal(surface.width,0);
});
test('bad, empty or excessively large sources never reach the image decoder',async()=>{
  for(const blob of [new Blob([],{type:'image/jpeg'}),new Blob(['bad'],{type:'image/svg+xml'}),{type:'image/jpeg',size:31*1024*1024}]){
    await assert.rejects(preparePhoto(blob,{decode:()=>assert.fail('not decoded')}),/30 MB/);
  }
});
test('decoder/encoder failure is visible and cannot yield a fake upload',async()=>{
  const blob=new Blob(['test'],{type:'image/jpeg'});
  await assert.rejects(preparePhoto(blob,{decode:async()=>{throw new Error('unreadable image');}}),/unreadable/);
  let closed=false;
  await assert.rejects(preparePhoto(blob,{decode:async()=>({image:{},width:100,height:100,close(){closed=true;}}),
    canvas:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob(callback){callback(null);}})}),/ย่อรูปไม่สำเร็จ/);
  assert.equal(closed,true);
});
