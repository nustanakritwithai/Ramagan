import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {JSDOM,VirtualConsole} from 'jsdom';
import {cleanupNavigation} from '../src/navigation.js';
import {createEvidenceDraft} from '../src/evidence-draft.js';
import {pendingKey} from '../src/checkout.js';
import {inventoryPendingKey,assertNoPendingMutation} from '../src/inventory.js';
import {voidPendingKey} from '../src/sale-void.js';
import {deviceKey,pendingDeviceActor,createDeviceStore} from '../src/device-session.js';
import {fakeIndexedDB} from './fake-idb.mjs';

const BASE='https://fixture.invalid/ramagan-api',STORE='11111111-1111-4111-8111-111111111111',DEVICE='22222222-2222-4222-8222-222222222222';
const ACTORS={owner:'33333333-3333-4333-8333-333333333333',manager:'44444444-4444-4444-8444-444444444444',staff:'55555555-5555-4555-8555-555555555555'};
const ORIGINAL='66666666-6666-4666-8666-666666666666',SALE='77777777-7777-4777-8777-777777777777',LOT='88888888-8888-4888-8888-888888888888';
const COUNT='99999999-9999-4999-8999-999999999999',PHOTO='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',RECEIVE='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT_VOID='cccccccc-cccc-4ccc-8ccc-cccccccccccc',PRODUCT='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PW='synthetic-owner-password-private',PW_TOKEN='synthetic-password-token-'+ 'P'.repeat(40),PIN_TOKEN='synthetic-memory-pin-token-'+ 'T'.repeat(40),CREDENTIAL='rd1_'+'C'.repeat(64);
const identity={api:BASE,store:STORE,actor:ORIGINAL};
const configured={configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2};
const caps={shared_role_pin:true,shared_role_pin_contract_version:1,pos_pin_required:true,pin_preserving_enrollment:true,device_enrollment_contract_version:2,
  discounts:true,discount_contract_version:1,sale_reconciliation:true,sale_reconciliation_contract_version:1};
const mainURL=new URL('../src/main.js',import.meta.url);
const mainSource=(await readFile(mainURL,'utf8')).replace(/import '\.\/[^']+\.css';/g,'')
  .replaceAll('import.meta.env.VITE_RAMAGAN_API_URL',"''").replaceAll('import.meta.env.BASE_URL',"'/ramagan-v1/'")
  .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL(path,mainURL).href}'`);
let instance=0;
async function until(check,label='expected synthetic DOM state'){
  for(let n=0;n<250;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Real main.js did not reach '+label);
}
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const saleIntent=()=>({version:2,status:'pending',identity:{api:BASE,store:STORE,cashier:ORIGINAL},preview_subtotal_satang:10000,
  payload:{client_sale_id:SALE,items:[{lot_id:LOT,quantity_mg:1000}],payment_method:'cash',authorization_ref:null,discount_satang:0}});
const stocktakeIntent=()=>({version:1,kind:'stocktake',status:'pending',uncertain:true,identity,
  payload:{client_stocktake_id:COUNT,shift_label:'Synthetic shift',reason:'',items:[{lot_id:LOT,expected_revision:2,counted_quantity_mg:0,evidence_id:PHOTO}]}});
const receiveIntent=()=>({version:1,kind:'receive',status:'pending',uncertain:true,identity,
  payload:{client_receive_id:RECEIVE,product_id:PRODUCT,lot_code:'SYNTHETIC',supplier_name:'Synthetic supplier',supplier_document_ref:'',
    reason:'Synthetic receipt',quantity_mg:1000,cost_satang_per_gram:0,expires_on:null}});
const voidIntent=()=>({version:1,status:'pending',uncertain:true,identity,sale_id:SALE,payload:{client_void_id:CLIENT_VOID,reason:'Synthetic void reason'},
  original:{client_sale_id:SALE,payment_method:'cash',payments:[{payment_method:'cash',amount_satang:10000}],subtotal_satang:10000,discount_satang:0,total_satang:10000,
    items:[{lot_id:LOT,quantity_mg:1000}]}});

async function fixture({role='owner',configuration=configured,configurationStatus=200,capabilities=caps,legacy=false,pending=[],remember=false,fetchHandler}={}){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/',virtualConsole:console}),w=dom.window;
  const indexedDB=fakeIndexedDB();Object.defineProperty(w,'indexedDB',{value:indexedDB});
  Object.defineProperty(w.navigator,'locks',{value:{request:async(key,_options,task)=>task({name:key})}});
  w.localStorage.setItem('ramagan.v1.server.url',BASE);
  if(legacy)w.sessionStorage.setItem('ramagan.v1.session.'+BASE,PW_TOKEN);
  const metadata={device_id:DEVICE,store:{id:STORE,name:'Synthetic PIN store'},roles:['owner','manager','staff'],expires_at:Math.floor(Date.now()/1000)+86400};
  if(remember)createDeviceStore(w.localStorage,BASE).save({...metadata,device_credential:CREDENTIAL},ACTORS);
  for(const [key,op]of pending)w.localStorage.setItem(key,JSON.stringify(op));
  const drafts=createEvidenceDraft({indexedDB,identity,uuid:()=>COUNT});
  await drafts.ensure([{id:LOT,stock_revision:2,quantity_mg:10000,lot_code:'SYNTHETIC',name:'Synthetic lot'}],{shift_label:'Synthetic shift',reason:''});
  await drafts.setCount(LOT,'0');await drafts.select(LOT,new Blob(['private-synthetic-scale-photo'],{type:'image/jpeg'}));
  const beforeDraft=await drafts.read(),requests=[];
  const tokens=new Map([[PW_TOKEN,{id:ORIGINAL,role}],[PIN_TOKEN,{id:ACTORS.manager,role:'manager'}]]);
  const bindings={window:w,document:w.document,navigator:w.navigator,localStorage:w.localStorage,sessionStorage:w.sessionStorage,FormData:w.FormData,
    CSS:{escape:x=>String(x).replace(/[^a-zA-Z0-9_-]/g,'\\$&')},crypto:webcrypto,fetch:async(url,options={})=>{
      assert(String(url).startsWith(BASE+'/'),'All traffic must remain synthetic');
      const path=String(url).slice(BASE.length),body=options.body?JSON.parse(options.body):null,token=(options.headers?.Authorization||'').replace(/^Bearer /,'');
      const call={path,method:options.method||'GET',body,token};requests.push(call);
      if(fetchHandler){const response=await fetchHandler(call);if(response!==undefined)return response;}
      if(path==='/health')return reply({status:'ok'});
      if(path==='/v1/auth/login')return reply({token:PW_TOKEN,user:{id:ORIGINAL,email:'owner@synthetic.invalid'}});
      if(path==='/v1/auth/device/status')return reply(metadata);
      if(path==='/v1/auth/device/enroll')return reply({...metadata,device_credential:CREDENTIAL});
      if(path==='/v1/auth/device/unlock'){
        tokens.set(PIN_TOKEN,{id:ACTORS[body.role],role:body.role});
        return reply({token:PIN_TOKEN,auth_method:'shared_role_pin',device_id:DEVICE,role:body.role,expires_at:Math.floor(Date.now()/1000)+300,
          user:{id:ACTORS[body.role],email:'shared-'+body.role+'@synthetic.invalid'}});
      }
      if(['/v1/auth/device/lock','/v1/auth/logout'].includes(path))return reply({ok:true});
      const actor=tokens.get(token);assert(actor,'Authenticated synthetic route '+path);
      if(path==='/v1/me')return reply({user:{id:actor.id,email:'actor@synthetic.invalid'},store_id:STORE,role:actor.role,
        store:{...metadata.store,sales_enabled:true,requires_authorization:false},capabilities});
      if(path==='/v1/auth/device/configuration')return reply(configuration,configurationStatus);
      if(path==='/v1/catalog')return reply({products:[{id:PRODUCT,sku:'A',name:'Synthetic A',category:'synthetic',price_satang_per_gram:10000,active:true}],
        lots:[{id:LOT,product_id:PRODUCT,sku:'A',name:'Synthetic A',lot_code:'A',price_satang_per_gram:10000,quantity_mg:10000,active:true,product_active:true}]});
      if(path.startsWith('/v1/stocktakes/by-client/')||path.startsWith('/v1/sale-voids/by-client/')||path.startsWith('/v1/sales/by-client/'))return reply({detail:'Synthetic absent'},404);
      if(path==='/v1/stocktakes/reconcile')return reply({status:'pending',client_stocktake_id:body.client_stocktake_id});
      assert.fail('Unexpected synthetic main route '+options.method+' '+path);
    }};
  const originals=new Map(Object.keys(bindings).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  for(const[k,value]of Object.entries(bindings))Object.defineProperty(globalThis,k,{value,configurable:true,writable:true});
  const module=await import('data:text/javascript;base64,'+Buffer.from(mainSource+`\nexport function disposeSyntheticMain(){deviceAuth?.invalidate();}\n// synthetic first PIN ${++instance}`).toString('base64'));
  const app={w,requests,drafts,beforeDraft,q:s=>w.document.querySelector(s),text:()=>w.document.body.textContent,
    click(selector){const node=this.q(selector);assert(node,selector);node.click();},
    input(selector,value){const node=this.q(selector);assert(node,selector);node.value=value;node.dispatchEvent(new w.Event('input',{bubbles:true}));},
    submit(selector){const node=this.q(selector);assert(node,selector);node.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));},
    snapshot:()=>Object.entries(w.localStorage).sort(([a],[b])=>a.localeCompare(b)),
    async login(){await until(()=>this.q('#login-form'),'password login');this.input('[name=email]','owner@synthetic.invalid');this.input('#login-form [name=password]',PW);this.submit('#login-form');await until(()=>this.q('.pin-setup-card'),'mandatory setup');},
    async ready(){await until(()=>this.q('#pin-device-enroll')&&!this.q('#pin-refresh-configuration')?.disabled,'verified PIN status');},
    async enroll(){this.input('#pin-device-label','Synthetic phone');this.input('#pin-owner-password',PW);this.submit('#pin-device-enroll');await until(()=>this.q('#pin-unlock-form')&&!this.q('#pin-unlock-submit').disabled,'post-enrollment PIN lock');},
    async unlock(role='manager'){this.q('[name=role][value='+role+']').checked=true;this.input('#pin-unlock-input','1729');this.submit('#pin-unlock-form');await until(()=>this.q('[data-add]')&&!this.q('.pin-setup-card'),'PIN authorized POS');},
    async assertDraftPreserved(){const after=await drafts.read();assert.deepEqual(after,beforeDraft);assert.equal(await after.photos[LOT].blob.text(),'private-synthetic-scale-photo');},
    assertNoBusiness(){assert.equal(this.q('nav,[data-navigation-trigger],#checkout,#confirm-count,[data-add]'),null);assert.equal(requests.filter(x=>x.path==='/v1/catalog').length,0);},
    assertNoStoredSecrets(){const all=JSON.stringify([...Object.entries(w.localStorage),...Object.entries(w.sessionStorage)]);for(const secret of[PW,PW_TOKEN,PIN_TOKEN,'1729'])assert(!all.includes(secret),'No persisted password, PIN or bearer');},
    close(){module.disposeSyntheticMain();cleanupNavigation();w.close();for(const[k,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}assert.deepEqual(errors,[]);}};
  return app;
}

test('fresh Owner must attach using existing PINs, locks immediately, and only PIN role unlock loads catalog',async()=>{
  const app=await fixture();try{
    await app.login();await app.ready();app.assertNoBusiness();assert.equal(app.requests.filter(x=>x.path==='/v1/auth/device/configuration').length,1);
    const form=app.q('#pin-device-enroll');assert.equal(form.querySelector('[name^=pin_],[name^=confirm_]'),null);
    assert.equal(app.q('details.pin-owner-recovery').open,false);assert.equal(app.q('#pin-change-pins').closest('details'),app.q('details.pin-owner-recovery'));
    app.assertNoStoredSecrets();await app.enroll();app.assertNoBusiness();
    assert.deepEqual(app.requests.find(x=>x.path==='/v1/auth/device/enroll').body,{label:'Synthetic phone',owner_password:PW});
    assert(app.w.localStorage.getItem(deviceKey(BASE)));assert.equal(app.w.sessionStorage.length,0);
    await app.unlock();assert(app.requests.some(x=>x.path==='/v1/catalog'&&x.token===PIN_TOKEN));assert.equal(app.requests.filter(x=>x.path==='/v1/auth/device/unlock').length,1);
    assert.equal(JSON.parse(app.w.localStorage.getItem(deviceKey(BASE))).actors.manager,ACTORS.manager);app.assertNoStoredSecrets();await app.assertDraftPreserved();
  }finally{app.close();}
});

test('remembered device password override remains setup-only across online, storage and history navigation',async()=>{
  const app=await fixture({remember:true});try{
    await until(()=>app.q('#pin-password-login')&&!app.q('#pin-password-login').disabled);app.click('#pin-password-login');await app.login();await app.ready();
    for(const event of['online','storage','popstate']){app.w.dispatchEvent(new app.w.Event(event));await new Promise(setImmediate);app.assertNoBusiness();}
    assert(app.q('#pin-device-enroll'));assert(app.q('#pin-lock-device'));assert.equal(app.requests.filter(x=>x.path==='/v1/auth/device/unlock').length,0);app.assertNoStoredSecrets();
  }finally{app.close();}
});

test('old password zero-count and void intents HOLD without rewriting any pending bytes or private photo draft',async()=>{
  for(const kind of['stocktake','void']){
    const op=kind==='stocktake'?stocktakeIntent():voidIntent(),key=kind==='stocktake'?inventoryPendingKey(identity,kind):voidPendingKey(identity);
    const app=await fixture({legacy:true,pending:[[key,op]]});try{
      await app.ready();const before=app.snapshot();app.assertNoBusiness();assert.equal(app.q('#pin-enroll-submit').disabled,true);assert.equal(app.q('#pin-refresh-configuration').disabled,false);
      app.click('[data-pin-recover='+kind+']');await until(()=>app.q('[data-pin-recover='+kind+']')&&!app.q('[data-pin-recover='+kind+']').disabled);
      assert.deepEqual(app.snapshot(),before);assert.equal(app.w.localStorage.getItem(key),JSON.stringify(op));await app.assertDraftPreserved();
      assert.match(app.text(),/ยังไม่ทราบผลรายการเดิม/);app.assertNoBusiness();
      assert.equal(app.requests.filter(x=>x.method==='POST'&&['/v1/sales','/v1/stocktakes','/v1/lots/receive','/v1/auth/device/enroll'].includes(x.path)).length,0);
      assert.equal(app.requests.some(x=>x.method==='POST'&&x.path.endsWith('/void')),false);
    }finally{app.close();}
  }
});

test('confirmed old sale and cancelled receive archive outside pending prefixes, unblock preserving enrollment and retain old evidence',async()=>{
  for(const kind of['sale','receive']){
    const op=kind==='sale'?saleIntent():receiveIntent(),key=kind==='sale'?pendingKey({api:BASE,store:STORE,cashier:ORIGINAL}):inventoryPendingKey(identity,kind);
    const app=await fixture({legacy:true,pending:[[key,op]],fetchHandler:call=>{
      if(kind==='sale'&&call.path==='/v1/sales/by-client/'+SALE)return reply({id:SALE,client_sale_id:SALE,subtotal_satang:10000,discount_satang:0,total_satang:10000,duplicate:true});
      if(kind==='receive'&&call.path==='/v1/lots/receive/reconcile')return reply({status:'rejected',client_receive_id:RECEIVE,code:'RECEIVE_CANCELLED',committed:false,message:'Synthetic cancellation proven'});
    }});try{
      await app.ready();assert.equal(app.q('#pin-enroll-submit').disabled,true);app.click('[data-pin-recover='+kind+']');
      await until(()=>app.q('#pin-enroll-submit')&&!app.q('#pin-enroll-submit').disabled,'resolved old intent with enrollment unblocked');
      assert.equal(app.w.localStorage.getItem(key),null);const archives=app.snapshot().filter(([k])=>k.startsWith('ramagan.v1.recovery-record.v1.'));
      assert.equal(archives.length,1);const archive=JSON.parse(archives[0][1]);assert.deepEqual(archive.payload,op.payload);assert.deepEqual(archive.identity,op.identity);
      assert.equal(archive.status,kind==='sale'?'confirmed':'rejected');assert.equal(pendingDeviceActor(app.w.localStorage,BASE,STORE),null);
      assert.doesNotThrow(()=>assertNoPendingMutation(app.w.localStorage,identity));await app.assertDraftPreserved();app.assertNoBusiness();
      await app.enroll();assert.equal(app.requests.filter(x=>x.path==='/v1/auth/device/enroll').length,1);await app.unlock();
      assert.equal(app.requests.filter(x=>x.method==='POST'&&['/v1/sales','/v1/lots/receive'].includes(x.path)).length,0);app.assertNoStoredSecrets();
    }finally{app.close();}
  }
});

test('password Manager or Staff cannot open POS or enroll a first device, even with PIN-required capabilities',async()=>{
  for(const role of['manager','staff']){const app=await fixture({role});try{
    await app.login();app.assertNoBusiness();assert.equal(app.q('#pin-device-enroll'),null);assert.equal(app.q('#pin-change-pins'),null);
    assert.equal(app.requests.some(x=>x.path==='/v1/auth/device/configuration'||x.path==='/v1/auth/device/enroll'),false);app.assertNoStoredSecrets();
  }finally{app.close();}}
});

test('unknown, partial, wrong contract and failed configuration status never load POS or offer enrollment',async()=>{
  for(const settings of[
    {configuration:{configured:true,roles:['owner'],device_enrollment_contract_version:2}},
    {configuration:{...configured,device_enrollment_contract_version:1}},
    {configuration:{configured:false,roles:['owner'],device_enrollment_contract_version:2}},
    {configuration:{detail:'Synthetic status conflict'},configurationStatus:409},
    {configuration:null,configurationStatus:503}
  ]){const app=await fixture(settings);try{
    await app.login();await until(()=>app.q('#pin-refresh-configuration')&&!app.q('#pin-refresh-configuration').disabled,'configuration HOLD');
    app.assertNoBusiness();assert.equal(app.q('#pin-device-enroll'),null);assert.equal(app.q('#pin-change-pins'),null);assert.equal(app.requests.filter(x=>x.path==='/v1/auth/device/enroll').length,0);app.assertNoStoredSecrets();await app.assertDraftPreserved();
  }finally{app.close();}}
});
