import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
function fixture(){const handlers={},cached=[];vm.runInNewContext(source,{URL,Promise,
  self:{registration:{scope:'https://shop.test/Ramagan/v1/'},location:{origin:'https://shop.test'},addEventListener:(name,fn)=>{handlers[name]=fn;}},
  caches:{match:async()=>null,open:async()=>({put:(req)=>cached.push(req.url)})},fetch:async()=>new Response('asset',{status:200})});
  return {cached,async hit(path,{auth=false,method='GET',mode='cors'}={}){let response;
    handlers.fetch({request:{url:new URL(path,'https://shop.test').href,method,mode,headers:new Headers(auth?{Authorization:'Bearer fixture'}:{})},respondWith:p=>{response=p;}});
    if(response)await response;return Boolean(response);
  }};}
test('worker never handles authenticated/private/API/off-scope resources even if extension looks cacheable',async()=>{
  const f=fixture();for(const path of ['/ramagan-api/v1/stocktake-evidence/photo.png','/ramagan-test-api/health','/v1/private/image.webp',
    '/Ramagan/v1/private/photo.png','/another/assets/app.js'])assert.equal(await f.hit(path),false,path);
  assert.equal(await f.hit('/Ramagan/v1/assets/app.js',{auth:true}),false);
  assert.equal(await f.hit('/Ramagan/v1/assets/app.js',{method:'POST'}),false);
  assert.deepEqual(f.cached,[]);
});
test('worker caches only its application shell and asset allowlist',async()=>{
  const f=fixture();assert.equal(await f.hit('/Ramagan/v1/index.html',{mode:'navigate'}),true);
  assert.equal(await f.hit('/Ramagan/v1/assets/index-hash.js'),true);
  assert.equal(await f.hit('/Ramagan/v1/icon.svg'),true);
  assert.equal(await f.hit('/Ramagan/v1/anything.html',{mode:'navigate'}),false);
  assert.equal(f.cached.length,3);
});
