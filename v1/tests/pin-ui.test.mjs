import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderPinLock,renderPinSetup,pinSettingsHtml,bindPinSettings} from '../src/pin-ui.js';
const device=()=>({store:{id:'store',name:'Fixture shop'},roles:['owner','manager','staff'],expires_at:Math.floor(Date.now()/1000)+3600,label:'Fixture device'});
function fixture(changes={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/'});
  const root=dom.window.document.querySelector('#app'),calls={unlock:[],enroll:[],forget:0,password:0,lock:0};
  const ctx={root,device:device(),busy:false,error:'',capability:true,passwordSession:true,isOwner:true,
    configuration:{configured:false,roles:[],device_enrollment_contract_version:2},
    onUnlock:async(role,pin)=>{calls.unlock.push({role,pin});},onEnroll:async payload=>{calls.enroll.push(payload);},
    onForget:()=>{calls.forget++;},onPasswordLogin:()=>{calls.password++;},onLock:()=>{calls.lock++;},...changes};
  return {dom,root,ctx,calls,q:s=>root.querySelector(s),
    input(selector,value){this.q(selector).value=value;},
    submit(selector){this.q(selector).dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));},
    settings(){root.innerHTML=pinSettingsHtml(ctx);bindPinSettings(ctx);},
    close(){dom.window.close();}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function keypad(f){renderPinLock(f.ctx);return value=>f.q('[data-pin-key="'+value+'"]').click();}

test('automatic keypad has four masked dots and submits exactly once after the fourth touch',async()=>{
  let release;const received=[],f=fixture({autoRolePin:true,onUnlockAuto:pin=>{received.push(pin);return new Promise(resolve=>{release=resolve;});}});
  try{
    const press=keypad(f);assert.equal(f.q('[name=role]'),null);assert.equal(f.q('input'),null);assert.equal(f.root.querySelectorAll('.pin-dots span').length,4);
    for(const digit of ['2','4','6'])press(digit);
    assert.equal(received.length,0);assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,3);
    press('8');assert.deepEqual(received,['2468']);assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);
    press('1');press('0');assert.equal(received.length,1);assert([...f.root.querySelectorAll('.pin-keypad button')].every(button=>button.disabled));
    assert(!f.root.innerHTML.includes('2468'));assert.equal(f.dom.window.localStorage.length,0);assert.equal(f.dom.window.sessionStorage.length,0);
    release(false);await tick();assert.match(f.q('[data-pin-error]').textContent,/ไม่สำเร็จ/);
    assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);assert([...f.root.querySelectorAll('.pin-keypad button')].every(button=>!button.disabled));
  }finally{f.close();}
});

test('automatic keypad supports keyboard editing, ignores repeat/modifier keys and clears all digits on failure',async()=>{
  const received=[],f=fixture({autoRolePin:true,onUnlockAuto:async pin=>{received.push(pin);throw new Error('Synthetic rejection');}});
  try{
    keypad(f);const card=f.q('.pin-keypad-card');
    const key=(value,extra={})=>card.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));
    key('1');key('1',{repeat:true});key('2',{ctrlKey:true});key('2');key('Backspace');key('3');key('Escape');
    assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);
    for(const digit of ['0','2','7','9'])key(digit);
    await tick();assert.deepEqual(received,['0279']);assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);
    assert.match(f.q('[data-pin-error]').textContent,/ไม่สำเร็จ/);assert.equal(f.dom.window.document.activeElement,card);
    assert(!f.root.innerHTML.includes('0279'));assert.equal(f.dom.window.localStorage.length,0);assert.equal(f.dom.window.sessionStorage.length,0);
  }finally{f.close();}
});

test('automatic keypad never sends partial PINs and clear/backspace and recovery erase local entry',()=>{
  const received=[],f=fixture({autoRolePin:true,onUnlockAuto:async pin=>received.push(pin)});
  try{
    const press=keypad(f);press('7');press('8');press('backspace');assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,1);
    press('clear');assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);press('1');press('2');
    f.q('#pin-password-login').click();assert.equal(f.calls.password,1);assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);
    assert.equal(received.length,0);assert.equal(f.calls.unlock.length,0);
  }finally{f.close();}
});

test('automatic keypad stays disabled for busy, expired or blocked pending-actor states',()=>{
  for(const changes of [{busy:true},{device:{...device(),expires_at:1}},{pendingRole:'blocked'}, {device:{...device(),roles:[]}}]){
    const received=[],f=fixture({autoRolePin:true,onUnlockAuto:async pin=>received.push(pin),...changes});
    try{const press=keypad(f);assert([...f.root.querySelectorAll('.pin-keypad button')].every(button=>button.disabled));
      for(const digit of ['1','2','3','4'])press(digit);assert.equal(received.length,0);assert.equal(f.root.querySelectorAll('.pin-dots .filled').length,0);
    }finally{f.close();}
  }
});
function enroll(f,{pins={owner:'1234',manager:'5678',staff:'9012'},password='fixture-password'}={}) {
  f.input('#pin-device-label','  Counter 1  ');f.input('#pin-owner-password',password);
  for(const role of ['owner','manager','staff']){f.input('#pin-enroll-'+role,pins[role]);f.input('#pin-confirm-'+role,pins[role]);}
}
test('PIN lock offers allowed role labels and clears PIN before invoking the unlock callback',async()=>{
  const f=fixture();try{
    let release;f.ctx.onUnlock=(role,pin)=>{assert.equal(f.q('#pin-unlock-input').value,'');f.calls.unlock.push({role,pin});return new Promise(resolve=>{release=resolve;});};
    renderPinLock(f.ctx);const input=f.q('#pin-unlock-input');
    assert.equal(input.type,'password');assert.equal(input.maxLength,4);assert.equal(input.inputMode,'numeric');assert.equal(input.autocomplete,'off');
    assert.equal(f.root.querySelectorAll('[name=role]').length,3);assert.match(f.root.textContent,/ใช้ร่วมกันตามบทบาท/);
    f.q('[name=role][value=manager]').checked=true;f.input('#pin-unlock-input','5678');f.submit('#pin-unlock-form');
    assert.deepEqual(f.calls.unlock,[{role:'manager',pin:'5678'}]);assert.equal(input.value,'');assert.equal(f.q('#pin-unlock-submit').disabled,true);
    f.submit('#pin-unlock-form');assert.equal(f.calls.unlock.length,1);release();await tick();
    assert.equal(f.q('#pin-unlock-submit').disabled,false);assert(!f.root.innerHTML.includes('5678'));
    assert(!f.dom.window.location.search);assert.equal(f.dom.window.localStorage.length,0);assert.equal(f.dom.window.sessionStorage.length,0);
  }finally{f.close();}
});
test('pending role and device role intersection cannot be changed into an elevated unlock',()=>{
  const f=fixture({pendingRole:'staff'});try{
    renderPinLock(f.ctx);assert.equal(f.root.querySelectorAll('[name=role]').length,1);assert.equal(f.q('[name=role]').value,'staff');
    const injected=f.dom.window.document.createElement('input');injected.type='radio';injected.name='role';injected.value='owner';
    f.q('fieldset').append(injected);injected.checked=true;f.input('#pin-unlock-input','1234');f.submit('#pin-unlock-form');
    assert.equal(f.calls.unlock.length,0);assert.equal(f.q('#pin-unlock-input').value,'');assert.match(f.q('[data-pin-error]').textContent,/บทบาท/);
  }finally{f.close();}
  const blocked=fixture({device:{...device(),roles:['staff']},pendingRole:'owner'});try{
    renderPinLock(blocked.ctx);assert.equal(blocked.q('#pin-unlock-submit').disabled,true);
    blocked.submit('#pin-unlock-form');assert.equal(blocked.calls.unlock.length,0);
  }finally{blocked.close();}
});
test('wrong format is cleared without a callback; expired device requires password fallback and forget is explicit',()=>{
  const f=fixture();try{
    renderPinLock(f.ctx);f.q('[value=owner]').checked=true;
    for(const pin of ['123','1a34','１２３４','12345',' 1234']){f.input('#pin-unlock-input',pin);f.submit('#pin-unlock-form');assert.equal(f.q('#pin-unlock-input').value,'');}
    assert.equal(f.calls.unlock.length,0);assert.equal(f.calls.forget,0);
    f.q('#pin-password-login').click();assert.equal(f.calls.password,1);
    f.q('#pin-forget-device').click();assert.equal(f.calls.forget,1);
  }finally{f.close();}
  const old=fixture({device:{...device(),expires_at:1}});try{
    renderPinLock(old.ctx);assert.equal(old.q('#pin-unlock-submit').disabled,true);assert.match(old.root.textContent,/หมดอายุแล้ว/);
    old.submit('#pin-unlock-form');assert.equal(old.calls.unlock.length,0);
  }finally{old.close();}
});
test('only real Owner password sessions see enrollment; PIN sessions and unsupported servers cannot configure',()=>{
  for(const flags of [{passwordSession:false},{isOwner:false},{capability:false},{capability:'true'}]){
    const f=fixture(flags);try{
      f.settings();assert.equal(f.q('#pin-device-enroll'),null);assert.equal(f.calls.enroll.length,0);
      f.q('#pin-lock-device').click();assert.equal(f.calls.lock,1);
      if(f.ctx.isOwner){f.q('#pin-settings-forget').click();assert.equal(f.calls.forget,1);}
      else{assert.equal(f.q('#pin-settings-forget'),null);assert.equal(f.calls.forget,0);}
      if(flags.capability===false)assert.match(f.root.textContent,/เซิร์ฟเวอร์ยังไม่รองรับ/);
    }finally{f.close();}
  }
});
test('enrollment clears password and all PIN confirmations before awaiting the root callback',async()=>{
  const f=fixture();try{
    let release;f.ctx.onEnroll=payload=>{
      for(const input of f.root.querySelectorAll('input[type=password]'))assert.equal(input.value,'');
      f.calls.enroll.push(payload);return new Promise(resolve=>{release=resolve;});
    };
    f.settings();enroll(f);f.submit('#pin-device-enroll');
    assert.deepEqual(f.calls.enroll,[{owner_password:'fixture-password',label:'Counter 1',pins:{owner:'1234',manager:'5678',staff:'9012'}}]);
    assert.equal(f.q('#pin-enroll-submit').disabled,true);f.submit('#pin-device-enroll');assert.equal(f.calls.enroll.length,1);
    f.q('#pin-lock-device').click();assert.equal(f.calls.lock,0);release();await tick();
    assert.equal(f.q('#pin-enroll-submit').disabled,false);
    assert.equal(f.dom.window.localStorage.length,0);assert.equal(f.dom.window.sessionStorage.length,0);
    assert(!f.root.innerHTML.includes('fixture-password'));assert(!f.dom.window.location.search);
  }finally{f.close();}
});
test('all three PINs must be distinct and confirmations must match, without echoing any secret',()=>{
  const f=fixture();try{
    f.settings();enroll(f,{pins:{owner:'1234',manager:'1234',staff:'9012'}});f.submit('#pin-device-enroll');
    assert.equal(f.calls.enroll.length,0);assert.match(f.q('[data-pin-error]').textContent,/แตกต่างกัน/);
    enroll(f);f.input('#pin-confirm-staff','0000');f.submit('#pin-device-enroll');assert.equal(f.calls.enroll.length,0);
    assert.match(f.q('[data-pin-error]').textContent,/ตรงกัน/);
    for(const input of f.root.querySelectorAll('input[type=password]'))assert.equal(input.value,'');
    assert(!f.q('[data-pin-error]').textContent.includes('1234'));
  }finally{f.close();}
});
test('error/store strings are escaped and callback errors produce generic messages without sensitive details',async()=>{
  const f=fixture({error:'<img src=x onerror=alert(1)>',device:{...device(),store:{name:'<svg onload=alert(1)>'}},
    onUnlock:async()=>{throw Error('secret 1234 must never be echoed');}});
  try{
    renderPinLock(f.ctx);assert.equal(f.root.querySelector('img,svg'),null);
    f.q('[value=owner]').checked=true;f.input('#pin-unlock-input','1234');f.submit('#pin-unlock-form');await tick();
    assert.match(f.q('[data-pin-error]').textContent,/ปลดล็อกไม่สำเร็จ/);assert(!f.q('[data-pin-error]').textContent.includes('1234'));
  }finally{f.close();}
});
test('Owner can recover shared PINs with password reauthentication and all sensitive forms clear before await',async()=>{
  let release;const calls=[];
  const f=fixture({configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2},onChangePins:payload=>{for(const input of f.root.querySelectorAll('input[type=password]'))assert.equal(input.value,'');calls.push(payload);return new Promise(resolve=>{release=resolve;});}});
  try{
    f.settings();assert(f.q('#pin-change-pins'));f.input('#pin-device-label','Counter');f.input('#pin-owner-password','unused-reauth');
    f.input('#pin-change-owner-password','owner-reauth');
    for(const [role,pin]of Object.entries({owner:'2345',manager:'6789',staff:'0123'})){f.input('#pin-change-'+role,pin);f.input('#pin-change-confirm-'+role,pin);}
    f.submit('#pin-change-pins');assert.deepEqual(calls,[{owner_password:'owner-reauth',pins:{owner:'2345',manager:'6789',staff:'0123'}}]);
    assert.equal(f.q('#pin-enroll-submit').disabled,true);f.submit('#pin-change-pins');assert.equal(calls.length,1);
    release();await tick();assert.equal(f.q('#pin-change-submit').disabled,false);
  }finally{f.close();}
});
test('current device server revocation needs explicit confirmation and uses its trusted device ID',async()=>{
  let release;const calls=[];
  const f=fixture({device:{...device(),device_id:'current-device'},onRevoke:payload=>{assert.equal(f.q('#pin-revoke-owner-password').value,'');assert.equal(f.q('#pin-revoke-confirm').checked,false);calls.push(payload);return new Promise(resolve=>{release=resolve;});}});
  try{
    f.settings();f.input('#pin-revoke-owner-password','owner-reauth');f.submit('#pin-revoke-device');assert.equal(calls.length,0);
    f.input('#pin-revoke-owner-password','owner-reauth');f.q('#pin-revoke-confirm').checked=true;
    const fake=f.dom.window.document.createElement('input');fake.name='device_id';fake.value='other-device';f.q('#pin-revoke-device').append(fake);
    f.submit('#pin-revoke-device');assert.deepEqual(calls,[{owner_password:'owner-reauth',device_id:'current-device'}]);
    f.q('#pin-settings-forget').click();assert.equal(f.calls.forget,0);release();await tick();
    assert.equal(f.q('#pin-revoke-submit').disabled,false);assert.match(f.root.textContent,/ไม่ได้เพิกถอนสิทธิ์บนเซิร์ฟเวอร์/);
  }finally{f.close();}
});
test('PIN sessions cannot see change/revoke even if role is owner; missing device ID hides revocation',()=>{
  const callbacks={onChangePins:async()=>{},onRevoke:async()=>{}};
  const f=fixture({...callbacks,passwordSession:false,device:{...device(),device_id:'current-device'}});
  try{f.settings();assert.equal(f.q('#pin-device-enroll'),null);assert.equal(f.q('#pin-change-pins'),null);assert.equal(f.q('#pin-revoke-device'),null);assert(f.q('#pin-lock-device'));}finally{f.close();}
  const noID=fixture({...callbacks,configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2}});try{noID.settings();assert(noID.q('#pin-change-pins'));assert.equal(noID.q('#pin-revoke-device'),null);}finally{noID.close();}
});
test('configured store enrolls a fresh device with its existing PINs and no PIN input or PIN payload',async()=>{
  const f=fixture({device:null,configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2}});
  try{
    f.settings();assert.equal(f.root.querySelector('[name^=pin_],[name^=confirm_]'),null);assert.match(f.root.textContent,/PIN ชุดเดิม/);
    f.input('#pin-device-label',' New phone ');f.input('#pin-owner-password','synthetic-owner-reauth');f.submit('#pin-device-enroll');await tick();
    assert.deepEqual(f.calls.enroll,[{owner_password:'synthetic-owner-reauth',label:'New phone'}]);assert.equal(f.q('#pin-owner-password').value,'');
    assert.equal(f.dom.window.localStorage.length,0);assert.equal(f.dom.window.sessionStorage.length,0);
  }finally{f.close();}
});
test('unknown, wrong-version and partial role configuration fails closed until explicit status refresh',async()=>{
  for(const configuration of [null,{configured:true,roles:['owner'],device_enrollment_contract_version:2},
    {configured:'true',roles:['owner','manager','staff'],device_enrollment_contract_version:2},
    {configured:false,roles:[],device_enrollment_contract_version:1}]){
    let refreshed=0;const f=fixture({configuration,onRefreshConfiguration:async()=>{refreshed++;}});
    try{f.settings();assert.equal(f.q('#pin-device-enroll'),null);assert.equal(f.q('#pin-change-pins'),null);
      f.q('#pin-refresh-configuration').click();await tick();assert.equal(refreshed,1);assert.equal(f.calls.enroll.length,0);
    }finally{f.close();}
  }
});
test('mandatory setup keeps PIN recovery closed and separate from preserving enrollment, without business navigation',async()=>{
  const exits=[];const f=fixture({device:null,configuration:{configured:true,roles:['owner','manager','staff'],device_enrollment_contract_version:2},
    onChangePins:async()=>{},onRevoke:async()=>{},onLogout:()=>exits.push('logout'),onChangeServer:()=>exits.push('server')});
  try{renderPinSetup(f.ctx);assert(f.q('.pin-setup-card'));assert(f.q('#pin-device-enroll'));
    const recovery=f.q('details.pin-owner-recovery');assert(recovery);assert.equal(recovery.open,false);assert(recovery.querySelector('#pin-change-pins'));assert.equal(f.q('#pin-revoke-device'),null);
    assert.equal(f.root.querySelector('nav,[data-navigation-trigger],#checkout,#confirm-count'),null);
    assert.equal(f.q('#pin-device-enroll').querySelector('[name^=pin_],[name^=confirm_]'),null);f.q('#pin-setup-server').click();f.q('#pin-setup-logout').click();assert.deepEqual(exits,['server','logout']);
    assert.match(f.root.textContent,/ปลดล็อกด้วย PIN ก่อนเริ่มงาน/);
  }finally{f.close();}
});
