import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../src/backend-api.js';
import {createDeviceAuth} from '../src/device-auth.js';
import {createDeviceStore,deviceKey,pendingDeviceActor} from '../src/device-session.js';
import {createCheckout,pendingKey} from '../src/checkout.js';
import {inventoryPendingKey} from '../src/inventory.js';

const BASE='https://fixture.invalid/ramagan-api',STORE='11111111-1111-4111-8111-111111111111',DEVICE='22222222-2222-4222-8222-222222222222';
const ACTORS={owner:'33333333-3333-4333-8333-333333333333',manager:'44444444-4444-4444-8444-444444444444',staff:'55555555-5555-4555-8555-555555555555'};
const ORIGINAL='66666666-6666-4666-8666-666666666666',SALE='77777777-7777-4777-8777-777777777777',LOT='88888888-8888-4888-8888-888888888888';
const SESSION='ramagan.v1.session.'+BASE,CREDENTIAL='rd1_'+'C'.repeat(64);
class Storage {
  map=new Map();get length(){return this.map.size;}key(i){return [...this.map.keys()][i]??null;}
  getItem(k){return this.map.get(k)??null;}setItem(k,v){this.map.set(k,String(v));}removeItem(k){this.map.delete(k);}
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function saleIntent(actor=ACTORS.staff){return JSON.stringify({version:2,status:'pending',identity:{api:BASE,store:STORE,cashier:actor},payload:{client_sale_id:SALE}});}

function fixture({remember=true,legacy=false,fetchHandler,actors=ACTORS,autoRole=false,configuration={configured:false,roles:[],device_enrollment_contract_version:2}}={}) {
  const oldFetch=globalThis.fetch,oldSession=globalThis.sessionStorage;
  const local=new Storage(),session=new Storage(),calls=[],timers=new Map();let clock=Date.UTC(2026,9,18),nextTimer=0,nextToken=0;
  const metadata={device_id:DEVICE,store:{id:STORE,name:'Synthetic PIN store'},roles:['owner','manager','staff'],expires_at:Math.floor(clock/1000)+86400,
    auto_role_pin:autoRole,auto_role_pin_contract_version:1};
  if(remember)createDeviceStore(local,BASE).save({...metadata,device_credential:CREDENTIAL},actors);
  if(legacy)session.setItem(SESSION,'legacy-password-session');
  globalThis.sessionStorage=session;
  const tokens=new Map([['legacy-password-session',{id:ORIGINAL,role:'owner'}]]);
  globalThis.fetch=async(url,options)=>{
    const path=String(url).slice(BASE.length),body=options.body?JSON.parse(options.body):null;
    const authorization=options.headers.Authorization||'',token=authorization.replace(/^Bearer /,'');
    const call={path,method:options.method,body,authorization,legacyPresent:session.getItem(SESSION)!==null};calls.push(call);
    if(fetchHandler){const handled=await fetchHandler(call,{tokens,clock});if(handled!==undefined)return handled;}
    if(path==='/v1/auth/device/status')return reply(metadata);
    if(path==='/v1/auth/device/unlock'){
      const role=body.role??Object.entries({owner:'6402',manager:'2846',staff:'1729'}).find(([,pin])=>pin===body.pin)?.[0];
      if(!role)return reply({detail:'Invalid role or PIN'},401);
      const issued='memory-pin-'+(++nextToken)+'-'.repeat(50);tokens.set(issued,{id:ACTORS[role],role});
      return reply({token:issued,auth_method:'shared_role_pin',device_id:DEVICE,role,
        expires_at:Math.floor(clock/1000)+300,user:{id:ACTORS[role],email:'shared-'+role+'@role.invalid'}});
    }
    if(path==='/v1/auth/login'){
      const issued='memory-password-'+(++nextToken)+'-'.repeat(40);tokens.set(issued,{id:ORIGINAL,role:'owner'});
      return reply({token:issued,user:{id:ORIGINAL,email:'owner@fixture.invalid'}});
    }
    if(path==='/v1/auth/device/enroll')return reply({...metadata,device_credential:CREDENTIAL});
    if(path==='/v1/auth/device/lock'||path==='/v1/auth/logout'){tokens.delete(token);return reply({ok:true});}
    if(path==='/v1/auth/device/revoke'||path==='/v1/auth/device/pins')return reply({ok:true});
    const actor=tokens.get(token);if(!actor)return reply({detail:'Login required'},401);
    if(path==='/v1/auth/device/configuration')return actor.id===ORIGINAL?reply(configuration):reply({detail:'Owner password required'},403);
    if(path==='/v1/me')return reply({user:{id:actor.id,email:'fixture@role.invalid'},store_id:STORE,role:actor.role,
      store:metadata.store,capabilities:{discounts:true,discount_contract_version:1,shared_role_pin:true,shared_role_pin_contract_version:1}});
    return reply({});
  };
  const api=createClient(BASE),state={busy:false,user:null,role:null,store:null,cart:new Map(),profileLoads:0,clears:0,renders:0,viewerClosed:0,urlsRevoked:0};
  const privateDrafts=new Map([['unchanged-idb-draft',{client_stocktake_id:'original-count',photo:new Uint8Array([1,2,3])}]]);
  const controller=createDeviceAuth({api,storage:local,isBusy:()=>state.busy,currentStore:()=>state.store?.id||STORE,cartEmpty:()=>!state.cart.size,
    canConfigure:()=>state.role==='owner'&&state.user?.id===ORIGINAL,
    clearDisplay:()=>{state.user=null;state.role=null;state.store=null;state.cart.clear();state.clears++;state.viewerClosed++;state.urlsRevoked++;},
    render:()=>{state.renders++;},loadProfile:async(user,{current,role})=>{if(current()){state.user=user;state.role=role;state.store=metadata.store;state.profileLoads++;}},
    now:()=>clock,setTimer:(fn,delay)=>{const id=++nextTimer;timers.set(id,{fn,at:clock+delay});return id;},clearTimer:id=>timers.delete(id)});
  return {api,controller,local,session,calls,state,privateDrafts,timers,metadata,
    advance(ms,fire=true){clock+=ms;if(fire)for(const [id,timer]of timers)if(timer.at<=clock){timers.delete(id);timer.fn();}},
    close(){controller.invalidate();globalThis.fetch=oldFetch;globalThis.sessionStorage=oldSession;}};
}

test('automatic PIN unlock uses exactly one request without a role and learns only the server-confirmed actor',async()=>{
  const f=fixture({autoRole:true,actors:{}});try{
    await f.controller.boot();assert.equal(f.controller.snapshot().autoRolePin,true);
    assert.equal(await f.controller.unlockAuto('1729'),true);assert.equal(f.state.role,'staff');assert.equal(f.state.user.id,ACTORS.staff);
    const attempts=f.calls.filter(call=>call.path==='/v1/auth/device/unlock');assert.equal(attempts.length,1);
    assert.deepEqual(attempts[0].body,{device_credential:CREDENTIAL,pin:'1729'});
    const stored=JSON.parse(f.local.getItem(deviceKey(BASE)));assert.deepEqual(stored.actors,{staff:ACTORS.staff});
    assert.equal(stored.auto_role_pin,undefined);assert(!JSON.stringify(stored).includes('1729'));assert.equal(f.session.length,0);
    await f.controller.lock();assert.equal(f.controller.snapshot().autoRolePin,true);assert.equal(f.privateDrafts.size,1);
  }finally{f.close();}
});
test('automatic unlock requires the advertised exact contract and never probes old servers or guesses roles',async()=>{
  for(const value of [false,'true',undefined]){
    const f=fixture({autoRole:value});try{
      await f.controller.boot();assert.equal(await f.controller.unlockAuto('1729'),false);
      assert.equal(f.calls.filter(call=>call.path==='/v1/auth/device/unlock').length,0);
      assert.equal(await f.controller.unlock('staff','1729'),true);
    }finally{f.close();}
  }
  const f=fixture({autoRole:true});try{f.metadata.auto_role_pin_contract_version=2;await f.controller.boot();assert.equal(await f.controller.unlockAuto('1729'),false);}
  finally{f.close();}
});
test('automatic role mismatch with a frozen pending actor revokes the issued session before loading any profile',async()=>{
  const f=fixture({autoRole:true});try{
    const key=pendingKey({api:BASE,store:STORE}),frozen=saleIntent(ACTORS.staff);f.local.setItem(key,frozen);
    await f.controller.boot();assert.equal(f.controller.snapshot().pendingRole,'staff');
    assert.equal(await f.controller.unlockAuto('6402'),false);assert.equal(f.state.profileLoads,0);assert.equal(f.api.auth.isPinSession(),false);
    assert.equal(f.calls.filter(call=>call.path==='/v1/auth/device/unlock').length,1);assert.equal(f.calls.filter(call=>call.path==='/v1/auth/device/lock').length,1);
    assert.equal(f.local.getItem(key),frozen);assert.equal(f.privateDrafts.size,1);
    assert.equal(await f.controller.unlockAuto('1729'),true);assert.equal(f.state.role,'staff');
  }finally{f.close();}
});
test('automatic unlock ignores duplicate submissions while pending and rejects late cross-window actor changes',async()=>{
  const delayed=deferred(),f=fixture({autoRole:true,fetchHandler:call=>call.path==='/v1/auth/device/unlock'?delayed.promise:undefined});try{
    await f.controller.boot();const attempt=f.controller.unlockAuto('1729');await settle();
    assert.equal(await f.controller.unlockAuto('6402'),false);assert.equal(f.calls.filter(call=>call.path==='/v1/auth/device/unlock').length,1);
    const frozen=saleIntent(ACTORS.manager),key=pendingKey({api:BASE,store:STORE});f.local.setItem(key,frozen);
    delayed.resolve(reply({token:'S'.repeat(64),auth_method:'shared_role_pin',device_id:DEVICE,role:'staff',expires_at:Date.UTC(2026,9,18)/1000+300,user:{id:ACTORS.staff}}));
    assert.equal(await attempt,false);assert.equal(f.api.auth.isPinSession(),false);assert.equal(f.state.profileLoads,0);
    assert.equal(f.calls.filter(call=>call.path==='/v1/auth/device/lock').length,1);assert.equal(f.local.getItem(key),frozen);
  }finally{f.close();}
});

test('remembered device boot removes legacy bearer before status and stays locked without an automatic unlock',async()=>{
  const f=fixture({legacy:true});try{
    assert.equal(await f.controller.boot(),true);assert.equal(f.session.getItem(SESSION),null);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/v1/auth/device/status');
    assert.equal(f.calls[0].authorization,'');assert.equal(f.calls[0].legacyPresent,false);
    assert.equal(f.controller.snapshot().locked,true);assert.equal(f.state.user,null);assert.equal(f.state.profileLoads,0);
    assert.equal(f.privateDrafts.size,1);
  }finally{f.close();}
});

test('PIN role unlock stores only device metadata and actor IDs; expiry timer and visibility recheck clear display and memory token',async()=>{
  const f=fixture({actors:{}});try{
    await f.controller.boot();assert.equal(await f.controller.unlock('staff','1729'),true);
    assert.equal(f.state.user.id,ACTORS.staff);assert.match(f.state.user.display_name,/พนักงาน/);assert.equal(f.api.auth.isPinSession(),true);
    assert.equal(f.session.getItem(SESSION),null);
    const stored=JSON.parse(f.local.getItem(deviceKey(BASE)));
    assert.deepEqual(Object.keys(stored).sort(),['actors','device_credential','device_id','expires_at','roles','store','version']);
    assert.deepEqual(stored.actors,{staff:ACTORS.staff});assert.equal(f.local.length,1);
    const token=f.calls.find(x=>x.path==='/v1/auth/device/unlock');assert.equal(token.authorization,'');
    f.advance(300001);await settle();assert.equal(f.controller.snapshot().locked,true);assert.equal(f.api.auth.isPinSession(),false);
    assert.equal(f.state.user,null);assert(f.state.viewerClosed>0&&f.state.urlsRevoked>0);assert.equal(f.privateDrafts.size,1);
    await f.controller.unlock('owner','2846');f.advance(300001,false);f.controller.checkExpiry();await settle();
    assert.equal(f.controller.snapshot().locked,true);assert.equal(f.api.auth.isPinSession(),false);
  }finally{f.close();}
});

test('current protected 401 locks PIN, while a delayed old-session response cannot lock or populate a newer role',async()=>{
  const old=deferred();let inventoryCalls=0;
  const f=fixture({fetchHandler:call=>call.path==='/v1/inventory'?(++inventoryCalls===1?old.promise:reply({detail:'Expired'},401)):undefined});try{
    await f.controller.boot();await f.controller.unlock('staff','1729');
    const stale=f.api.inventory();await settle();await f.controller.lock();await f.controller.unlock('manager','2846');
    old.resolve(reply({detail:'Old session expired'},401));assert((await stale).error);assert.equal(f.api.auth.isPinSession(),true);
    assert.equal(f.state.user.id,ACTORS.manager);assert.equal(f.controller.snapshot().locked,false);
    assert((await f.api.inventory()).error);await settle();assert.equal(f.controller.snapshot().locked,true);assert.equal(f.state.user,null);
  }finally{f.close();}
});

test('pending sale/intake/count ownership restricts roles and never deletes intent bytes; original-account pending requires password fallback',async()=>{
  const f=fixture();try{
    f.local.setItem(pendingKey({api:BASE,store:STORE}),saleIntent());
    const countKey=inventoryPendingKey({api:BASE,store:STORE,actor:ACTORS.staff},'receive');
    f.local.setItem(countKey,JSON.stringify({identity:{api:BASE,store:STORE,actor:ACTORS.staff}}));
    await f.controller.boot();assert.equal(f.controller.snapshot().pendingRole,'staff');
    const before=new Map(f.local.map);assert.equal(await f.controller.unlock('owner','1729'),false);assert.equal(f.controller.forget(),false);
    assert.equal(f.calls.filter(x=>x.path==='/v1/auth/device/unlock').length,0);assert.deepEqual(f.local.map,before);
    assert.equal(await f.controller.unlock('staff','1729'),true);await f.controller.lock();assert.equal(f.local.getItem(countKey),before.get(countKey));
    f.local.setItem(pendingKey({api:BASE,store:STORE}),saleIntent(ORIGINAL));f.local.removeItem(countKey);
    assert.equal(f.controller.snapshot().pendingRole,'blocked');assert.equal(f.controller.passwordLogin(),true);
    assert.equal(f.controller.snapshot().passwordOverride,true);assert.equal(f.local.getItem(pendingKey({api:BASE,store:STORE})),saleIntent(ORIGINAL));
  }finally{f.close();}
});

test('post-unlock cross-window pending conflict revokes exactly the issued session and preserves original intent',async()=>{
  const delayed=deferred();
  const f=fixture({fetchHandler:call=>call.path==='/v1/auth/device/unlock'?delayed.promise:undefined});try{
    await f.controller.boot();const attempt=f.controller.unlock('staff','1729');await settle();
    f.local.setItem(pendingKey({api:BASE,store:STORE}),saleIntent(ACTORS.manager));
    delayed.resolve(reply({token:'T'.repeat(64),auth_method:'shared_role_pin',device_id:DEVICE,role:'staff',expires_at:Date.UTC(2026,9,18)/1000+300,user:{id:ACTORS.staff}}));
    assert.equal(await attempt,false);assert.equal(f.state.profileLoads,0);assert.equal(f.api.auth.isPinSession(),false);
    assert.equal(f.calls.filter(x=>x.path==='/v1/auth/device/lock').length,1);
    assert.equal(f.local.getItem(pendingKey({api:BASE,store:STORE})),saleIntent(ACTORS.manager));
  }finally{f.close();}
});

test('post-unlock actor-map persistence failure revokes issued PIN authorization once and fails closed',async()=>{
  const f=fixture();try{
    await f.controller.boot();const original=f.local.setItem.bind(f.local);f.local.setItem=(key,value)=>{if(key===deviceKey(BASE))throw new Error('Storage full');original(key,value);};
    assert.equal(await f.controller.unlock('owner','1729'),false);assert.equal(f.api.auth.isPinSession(),false);assert.equal(f.state.user,null);
    assert.equal(f.calls.filter(x=>x.path==='/v1/auth/device/lock').length,1);
    assert.equal(f.state.profileLoads,0);
  }finally{f.close();}
});

test('locking an in-flight real checkout retains the exact UUID and prevents another role until it settles and the original actor returns',async()=>{
  const sent=deferred();let accepted=false;
  const sale={sale_id:SALE,client_sale_id:SALE,subtotal_satang:10000,discount_satang:0,total_satang:10000,duplicate:false,
    payment_method:'cash',payments:[{payment_method:'cash',amount_satang:10000}]};
  const f=fixture({fetchHandler:call=>{
    if(call.path==='/v1/sales'){accepted=true;return sent.promise;}
    if(call.path==='/v1/sales/by-client/'+SALE&&call.authorization&&accepted)return reply({...sale,id:SALE});
    return undefined;
  }});try{
    await f.controller.boot();await f.controller.unlock('staff','1729');
    let allocated=0;const checkout=createCheckout({storage:f.local,identity:{api:BASE,store:STORE,cashier:ACTORS.staff},transport:f.api.checkoutTransport,
      uuid:()=>{allocated++;return SALE;},lock:async(_key,task)=>task()});
    checkout.read();f.state.busy=true;const current=f.controller.guard();
    const operation=checkout.start({items:[{lot_id:LOT,quantity_mg:1000}],payment_method:'cash',authorization_ref:null,discount_satang:0},10000);
    await settle();assert.equal(accepted,true);const frozen=f.local.getItem(checkout.key);await f.controller.lock();
    assert.equal(await f.controller.unlock('owner','2846'),false);sent.resolve(reply(sale));const result=await operation;
    assert.equal(current(),false);assert.equal(result.pending,true);f.state.busy=false;
    assert.equal(f.local.getItem(checkout.key),frozen);assert.equal(allocated,1);assert.equal(f.controller.snapshot().pendingRole,'staff');
    assert.equal(await f.controller.unlock('owner','2846'),false);assert.equal(await f.controller.unlock('staff','1729'),true);
    const verified=await checkout.verify();assert.equal(verified.sale.client_sale_id,SALE);
    assert.equal(f.calls.filter(x=>x.path==='/v1/sales').length,1);assert.equal(allocated,1);
    assert.equal(f.privateDrafts.size,1);
  }finally{f.close();}
});

test('Owner password override stays memory-only and enrollment persists only credential then locks; PIN Owner cannot configure',async()=>{
  const f=fixture({remember:false});try{
    assert.equal(await f.controller.boot(),false);
    const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'fixture-only-password',memoryOnly:true});
    assert.equal(login.error,null);assert.equal(f.session.getItem(SESSION),null);
    f.state.user=login.data.user;f.state.role='owner';f.state.store=f.metadata.store;
    assert.equal(await f.controller.refreshConfiguration(),true);
    assert.equal(await f.controller.enroll({label:'Synthetic desk',owner_password:'fixture-only-password',pins:{owner:'1729',manager:'2846',staff:'3957'}}),true);
    assert.equal(f.controller.snapshot().locked,true);assert.equal(f.session.getItem(SESSION),null);
    const record=JSON.parse(f.local.getItem(deviceKey(BASE)));assert.equal(record.device_credential,CREDENTIAL);assert.deepEqual(record.actors,{});
    assert.equal(await f.controller.unlock('owner','1729'),true);
    const before=f.calls.length;assert.equal(await f.controller.changePins({owner_password:'unused',pins:{}}),false);assert.equal(f.calls.length,before);
    assert.equal(f.controller.passwordLogin(),true);
    await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'fixture-only-password',memoryOnly:true});assert.equal(f.session.getItem(SESSION),null);
    const reloaded=createClient(BASE);assert.equal((await reloaded.auth.getUser()).data.user,null);
  }finally{f.close();}
});
test('fresh device with configured server PINs enrolls without supplying or replacing the three existing PINs, then immediately locks',async()=>{
  const f=fixture({remember:false,configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2}});try{
    await f.controller.boot();const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'synthetic-owner-reauth',memoryOnly:true});
    f.state.user=login.data.user;f.state.role='owner';f.state.store=f.metadata.store;
    assert.equal(await f.controller.refreshConfiguration(),true);assert.equal(f.controller.snapshot().configuration.configured,true);
    assert.equal(f.local.length,0);assert.equal(f.session.getItem(SESSION),null);
    const beforeProfiles=f.state.profileLoads;
    assert.equal(await f.controller.enroll({label:'Synthetic new device',owner_password:'synthetic-owner-reauth',pins:{owner:'unused',manager:'unused',staff:'unused'}}),true);
    const post=f.calls.find(x=>x.path==='/v1/auth/device/enroll');assert.deepEqual(post.body,{label:'Synthetic new device',owner_password:'synthetic-owner-reauth'});
    assert.equal(f.controller.snapshot().locked,true);assert.equal(f.state.profileLoads,beforeProfiles);assert.equal(f.state.user,null);assert.equal(f.api.auth.isPinSession(),false);
    assert.equal(f.controller.snapshot().configuration,null);const saved=JSON.parse(f.local.getItem(deviceKey(BASE)));assert.equal(saved.device_credential,CREDENTIAL);
    assert(!JSON.stringify(saved).includes('owner_password'));assert(!JSON.stringify(saved).includes('unused'));assert.equal(f.privateDrafts.size,1);
    assert.equal(await f.controller.unlock('manager','2846'),true);assert.equal(f.state.user.id,ACTORS.manager);
  }finally{f.close();}
});
test('enrollment cannot proceed before configuration is known and malformed or partial configuration remains blocked',async()=>{
  for(const configuration of [{configured:'true',roles:['owner','manager','staff'],device_enrollment_contract_version:2},
    {configured:true,roles:['owner'],device_enrollment_contract_version:2},
    {configured:false,roles:['staff'],device_enrollment_contract_version:2},
    {configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:1}]){
    const f=fixture({remember:false,configuration});try{
      await f.controller.boot();const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'synthetic-owner-reauth',memoryOnly:true});
      f.state.user=login.data.user;f.state.role='owner';f.state.store=f.metadata.store;
      assert.equal(await f.controller.enroll({label:'Synthetic',owner_password:'synthetic-owner-reauth'}),false);
      assert.equal(await f.controller.refreshConfiguration(),false);assert.equal(f.controller.snapshot().configuration,null);
      assert.equal(await f.controller.enroll({label:'Synthetic',owner_password:'synthetic-owner-reauth'}),false);
      assert.equal(f.calls.filter(x=>x.path==='/v1/auth/device/enroll').length,0);assert.equal(f.local.length,0);assert.equal(f.privateDrafts.size,1);
    }finally{f.close();}
  }
});
test('configuration can be inspected with a pending old account intent but enrollment never clears or migrates it',async()=>{
  const f=fixture({remember:false,configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2}});try{
    await f.controller.boot();const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'synthetic-owner-reauth',memoryOnly:true});
    f.state.user=login.data.user;f.state.role='owner';f.state.store=f.metadata.store;
    const key=pendingKey({api:BASE,store:STORE}),pending=saleIntent(ORIGINAL);f.local.setItem(key,pending);
    assert.equal(await f.controller.refreshConfiguration(),true);assert.equal(await f.controller.enroll({label:'Synthetic',owner_password:'synthetic-owner-reauth'}),false);
    assert.equal(f.local.getItem(key),pending);assert.equal(f.privateDrafts.size,1);assert.equal(f.calls.filter(x=>x.path==='/v1/auth/device/enroll').length,0);
  }finally{f.close();}
});
test('late configuration response after locking cannot restore password mode or cached setup permission',async()=>{
  const delayed=deferred(),f=fixture({remember:false,fetchHandler:call=>call.path==='/v1/auth/device/configuration'?delayed.promise:undefined});try{
    await f.controller.boot();const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'synthetic-owner-reauth',memoryOnly:true});
    f.state.user=login.data.user;f.state.role='owner';f.state.store=f.metadata.store;
    const request=f.controller.refreshConfiguration();await settle();await f.controller.lock();
    delayed.resolve(reply({configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2}));
    assert.equal(await request,false);assert.equal(f.controller.snapshot().configuration,null);assert.equal(f.state.user,null);assert.equal(f.local.length,0);assert.equal(f.privateDrafts.size,1);
  }finally{delayed.resolve(reply({}));f.close();}
});

test('legacy password-client compatibility remains available only without automatic device unlock, and invalidation ignores late endpoint responses',async()=>{
  const delayed=deferred(),f=fixture({remember:false,legacy:true});try{
    assert.equal(await f.controller.boot(),false);assert.equal((await f.api.auth.getUser()).data.user.id,ORIGINAL);
    const login=await f.api.auth.signInWithPassword({email:'fixture@invalid',password:'legacy-client-fixture'});assert.equal(login.error,null);assert(f.session.getItem(SESSION));
    f.api.auth.forgetSession();
    const saved=createDeviceStore(f.local,BASE).save({...f.metadata,device_credential:CREDENTIAL},ACTORS);
    assert(saved);const originalStatus=f.api.auth.deviceStatus;f.api.auth.deviceStatus=()=>delayed.promise;
    const boot=f.controller.boot();f.controller.invalidate();delayed.resolve({data:f.metadata,error:null});await boot;
    assert.equal(f.state.profileLoads,0);f.api.auth.deviceStatus=originalStatus;
  }finally{f.close();}
});

test('malformed or multiple-actor pending data fails closed and local forgetting never removes IDB or business keys',async()=>{
  const f=fixture();try{
    await f.controller.boot();f.local.setItem(pendingKey({api:BASE,store:STORE}),'broken-json');
    assert.equal(f.controller.snapshot().pendingRole,'blocked');assert.equal(f.controller.forget(),false);
    assert.equal(f.local.getItem(pendingKey({api:BASE,store:STORE})),'broken-json');assert.equal(f.privateDrafts.size,1);
    f.local.removeItem(pendingKey({api:BASE,store:STORE}));assert.equal(f.controller.forget(),true);
    assert.equal(f.local.getItem(deviceKey(BASE)),null);assert.equal(f.privateDrafts.size,1);
    f.local.setItem(pendingKey({api:BASE,store:STORE}),saleIntent());
    f.local.setItem(inventoryPendingKey({api:BASE,store:STORE,actor:ACTORS.owner},'stocktake'),JSON.stringify({identity:{api:BASE,store:STORE,actor:ACTORS.owner}}));
    assert.throws(()=>pendingDeviceActor(f.local,BASE,STORE));
  }finally{f.close();}
});

test('another window forgetting or corrupting its device record locks and removes cached credentials without erasing an intent',async()=>{
  for(const replacement of [null,'invalid-device-record']){
    const f=fixture();try{
      await f.controller.boot();await f.controller.unlock('staff','1729');
      f.local.setItem(pendingKey({api:BASE,store:STORE}),saleIntent());
      if(replacement===null)f.local.removeItem(deviceKey(BASE));else f.local.setItem(deviceKey(BASE),replacement);
      f.controller.storageChanged();await settle();
      assert.equal(f.controller.snapshot().device,null);assert.equal(f.api.auth.isPinSession(),false);assert.equal(f.state.user,null);
      assert.equal(f.local.getItem(pendingKey({api:BASE,store:STORE})),saleIntent());assert.equal(f.privateDrafts.size,1);
    }finally{f.close();}
  }
});
