// PIN/password fields live only in the current form and callback arguments.
// Storage, device credentials, server capabilities and authorization belong to root.
const h=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ROLES=['owner','manager','staff'];
const LABELS={owner:'เจ้าของร้าน',manager:'ผู้จัดการ',staff:'พนักงาน'};
const validPin=pin=>typeof pin==='string'&&/^[0-9]{4}$/.test(pin);
const auditCopy='PIN ใช้ร่วมกันตามบทบาท ประวัติระบุบทบาทที่ใช้ ไม่ได้ยืนยันตัวพนักงานแต่ละคน';
function rolesFor(device,pendingRole) {
  const allowed=ROLES.filter(role=>Array.isArray(device?.roles)&&device.roles.includes(role));
  return pendingRole===undefined||pendingRole===null?allowed:allowed.filter(role=>role===pendingRole);
}
function expiryText(device) {
  if(!Number.isSafeInteger(device?.expires_at)||device.expires_at<=0)return 'ไม่ทราบวันหมดอายุ';
  return new Date(device.expires_at*1000).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'});
}
function expired(device) {return Number.isSafeInteger(device?.expires_at)&&device.expires_at*1000<=Date.now();}
function pinField({id,name,label,required=true}) {
  return '<label>'+h(label)+'<input id="'+h(id)+'" name="'+h(name)+'" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="off" '+(required?'required ':'')+'/></label>';
}
function showError(scope,message) {
  const node=scope.querySelector('[data-pin-error]');if(node)node.textContent=message;
}
export function renderPinLock(ctx) {
  const {root}=ctx,doc=root.ownerDocument,allowed=rolesFor(ctx.device,ctx.pendingRole);
  const busy=ctx.busy===true,dead=expired(ctx.device),available=allowed.length>0&&!dead;
  const info=dead?'การเชื่อมต่อของเครื่องนี้หมดอายุแล้ว กรุณาเข้าด้วยบัญชีและรหัสผ่าน':!allowed.length?'ไม่พบบทบาทที่เปิดใช้บนเครื่องนี้ กรุณาเข้าด้วยบัญชีและรหัสผ่าน':'';
  root.innerHTML='<main class="pin-shell"><section class="pin-card"><div class="pin-brand">RAMAGAN</div><h1>ปลดล็อกด้วย PIN</h1><p class="pin-store">'+h(ctx.device?.store?.name||'ร้านของคุณ')+'</p>'+
    (ctx.pendingRole?'<p class="pin-note">มีรายการค้าง กรุณาใช้บทบาทเดิมเพื่อกลับไปตรวจสอบรายการ</p>':'')+
    '<form id="pin-unlock-form" autocomplete="off"><fieldset class="pin-role-options" '+(busy||!available?'disabled':'')+'><legend>เลือกบทบาท</legend>'+
    allowed.map(role=>'<label><input type="radio" name="role" value="'+role+'" required '+(allowed.length===1?'checked':'')+'/><span>'+LABELS[role]+'</span></label>').join('')+'</fieldset>'+
    pinField({id:'pin-unlock-input',name:'pin',label:'PIN 4 หลัก'})+
    '<p class="pin-error" data-pin-error role="status" aria-live="polite">'+h(ctx.error||info)+'</p><button id="pin-unlock-submit" type="submit" class="pin-primary" '+(busy||!available?'disabled':'')+'>'+(busy?'กำลังตรวจสอบ…':'ปลดล็อก')+'</button></form>'+
    '<p class="pin-note">'+auditCopy+'</p><p class="pin-note">การเชื่อมต่อหมดอายุ '+h(expiryText(ctx.device))+'</p>'+
    '<button type="button" id="pin-password-login" class="pin-secondary" '+(busy?'disabled':'')+'>จัดการเครื่อง / กู้คืนด้วยบัญชี Owner</button>'+
    '<p class="pin-note">รหัสผ่านใช้จัดการเครื่องหรือรายการค้างเดิม การขายและจัดการสต็อกต้องปลดล็อกด้วย PIN</p>'+
    (typeof ctx.onForget==='function'?'<button type="button" id="pin-forget-device" class="pin-text" '+(busy?'disabled':'')+'>ลืมการเชื่อมต่อบนเครื่องนี้</button><p class="pin-note">ลบการเชื่อมต่อในเบราว์เซอร์นี้เท่านั้น ไม่ได้เพิกถอนสิทธิ์เครื่องบนเซิร์ฟเวอร์</p>':'')+'</section></main>';
  const form=root.querySelector('#pin-unlock-form'),input=form.querySelector('#pin-unlock-input');
  input.disabled=busy||!available;
  let submitting=false;
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(submitting||busy||!available)return;
    const role=form.querySelector('[name=role]:checked')?.value,pin=input.value;input.value='';
    if(!allowed.includes(role)){showError(form,'เลือกบทบาทที่ได้รับอนุญาตก่อน');return;}
    if(!validPin(pin)){showError(form,'กรอก PIN เป็นตัวเลข 0–9 จำนวน 4 หลัก');return;}
    submitting=true;form.querySelector('#pin-unlock-submit').disabled=true;input.disabled=true;form.querySelector('fieldset').disabled=true;showError(form,'');
    try{await ctx.onUnlock(role,pin);}catch{if(form.isConnected)showError(form,'ปลดล็อกไม่สำเร็จ กรุณาตรวจสอบ PIN แล้วลองใหม่');}
    finally{if(form.isConnected){submitting=false;form.querySelector('#pin-unlock-submit').disabled=false;input.disabled=false;form.querySelector('fieldset').disabled=false;}}
  });
  root.querySelector('#pin-password-login').onclick=()=>{if(!busy&&!submitting){input.value='';ctx.onPasswordLogin();}};
  root.querySelector('#pin-forget-device')?.addEventListener('click',()=>{if(!busy&&!submitting){input.value='';ctx.onForget();}});
}
export function pinSettingsHtml(ctx) {
  const capability=ctx.capability===true,configure=capability&&ctx.passwordSession===true&&ctx.isOwner===true;
  const device=ctx.device,busy=ctx.busy===true;
  const config=ctx.configuration,known=typeof config?.configured==='boolean'&&config.device_enrollment_contract_version===2&&Array.isArray(config.roles)&&
    (config.configured?config.roles.length===3&&new Set(config.roles).size===3&&ROLES.every(role=>config.roles.includes(role)):config.roles.length===0);
  const initial=known&&!config.configured,recovery=configure&&known&&config.configured;
  return '<section id="pin-settings" class="pin-settings"><h2>PIN และการเชื่อมต่อเครื่องนี้</h2><p class="pin-note">'+auditCopy+'</p>'+
    (!capability?'<p class="pin-notice">เซิร์ฟเวอร์ยังไม่รองรับ PIN สำหรับเครื่องนี้ ต้องอัปเดตระบบก่อนเปิดใช้งาน</p>':'')+
    (device?'<div class="pin-device-status"><strong>'+h(device.label||'เครื่องที่เชื่อมต่อไว้')+'</strong><p>'+h(device.store?.name||'')+'</p><small>หมดอายุ '+h(expiryText(device))+'</small></div>':'<p class="pin-note">ยังไม่ได้บันทึกการเชื่อมต่อแบบ PIN บนเครื่องนี้</p>')+
    '<p class="pin-error" data-pin-error role="status" aria-live="polite">'+h(ctx.error||'')+'</p>'+
    (configure&&known?'<form id="pin-device-enroll" data-initial-setup="'+initial+'" autocomplete="off"><p>'+(initial?'ร้านยังไม่ได้ตั้ง PIN ให้ตั้งทั้งสามบทบาทครั้งแรก แล้วเชื่อมต่อเครื่องนี้':'ร้านตั้ง PIN ไว้แล้ว เชื่อมต่อเครื่องนี้เพื่อใช้ PIN ชุดเดิม โดยไม่ต้องตั้งใหม่')+'</p><label>ชื่อเครื่อง<input id="pin-device-label" name="label" maxlength="80" required placeholder="เช่น เครื่องหน้าร้าน"/></label><label>รหัสผ่านบัญชี Owner<input id="pin-owner-password" name="owner_password" type="password" autocomplete="current-password" required /></label>'+
      (initial?ROLES.map(role=>'<fieldset class="pin-enroll-role"><legend>'+LABELS[role]+'</legend>'+pinField({id:'pin-enroll-'+role,name:'pin_'+role,label:'PIN 4 หลัก'})+pinField({id:'pin-confirm-'+role,name:'confirm_'+role,label:'ยืนยัน PIN อีกครั้ง'})+'</fieldset>').join('')+'<p class="pin-note">ตั้ง PIN ทั้งสามบทบาทให้แตกต่างกัน และเก็บไว้เฉพาะผู้ที่ได้รับสิทธิ์</p>':'<p class="pin-notice">การเชื่อมต่อนี้คง PIN และสิทธิ์เดิมของร้านครบทั้งสามบทบาท</p>')+
      '<button type="submit" id="pin-enroll-submit" class="pin-primary" '+(busy?'disabled':'')+'>'+(initial?'ตั้ง PIN ครั้งแรกและเชื่อมต่อเครื่อง':'เชื่อมต่อเครื่องและใช้ PIN เดิม')+'</button></form>':
      configure?'<p class="pin-notice">'+(busy?'กำลังตรวจสถานะ PIN ของร้าน…':'ต้องตรวจสถานะ PIN ของร้านก่อนเชื่อมต่อเครื่อง หากสถานะไม่ครบ ระบบจะหยุดให้ผู้ดูแลตรวจสอบ')+'</p>':
      capability?'<p class="pin-note">ให้ Owner เข้าด้วยอีเมลและรหัสผ่านเพื่อกำหนด PIN เครื่องนี้ บัญชีที่เข้าด้วย PIN เปลี่ยน PIN หรือเปิดสิทธิ์เครื่องใหม่ไม่ได้</p>':'')+
    (configure&&typeof ctx.onRefreshConfiguration==='function'?'<button type="button" id="pin-refresh-configuration" class="pin-secondary" '+(busy?'disabled':'')+'>ตรวจสถานะ PIN บนเซิร์ฟเวอร์อีกครั้ง</button>':'')+
    (recovery&&ctx.setupOnly===true?'<details class="pin-owner-recovery"><summary>จัดการ / กู้คืน PIN (Owner)</summary><p class="pin-note">ใช้เฉพาะเจ้าของบัญชี Owner ที่ต้องการเปลี่ยน PIN หรือเพิกถอนเครื่อง ต้องยืนยันรหัสผ่าน Owner อีกครั้ง</p>':'')+
    (recovery&&typeof ctx.onChangePins==='function'?'<form id="pin-change-pins" autocomplete="off" class="pin-owner-action"><h3>เปลี่ยน PIN ร่วมทั้งสามบทบาท</h3><p class="pin-note">หากจำ PIN เดิมไม่ได้ ใช้รหัสผ่าน Owner เพื่อตั้ง PIN ชุดใหม่</p><label>รหัสผ่านบัญชี Owner<input id="pin-change-owner-password" name="owner_password" type="password" autocomplete="current-password" required /></label>'+
      ROLES.map(role=>'<fieldset class="pin-enroll-role"><legend>'+LABELS[role]+'</legend>'+pinField({id:'pin-change-'+role,name:'pin_'+role,label:'PIN ใหม่ 4 หลัก'})+pinField({id:'pin-change-confirm-'+role,name:'confirm_'+role,label:'ยืนยัน PIN ใหม่'})+'</fieldset>').join('')+
      '<button type="submit" id="pin-change-submit" class="pin-primary" '+(busy?'disabled':'')+'>เปลี่ยน PIN ทั้งสามบทบาท</button></form>':'')+
    (configure&&known&&(ctx.setupOnly!==true||recovery)&&typeof ctx.onRevoke==='function'&&typeof device?.device_id==='string'&&device.device_id?'<form id="pin-revoke-device" autocomplete="off" class="pin-owner-action"><h3>เพิกถอนเครื่องนี้บนเซิร์ฟเวอร์</h3><p class="pin-note">เครื่องนี้จะใช้การเชื่อมต่อเดิมปลดล็อกไม่ได้ ต้องให้ Owner เชื่อมต่อเครื่องใหม่อีกครั้ง</p><label>รหัสผ่านบัญชี Owner<input id="pin-revoke-owner-password" name="owner_password" type="password" autocomplete="current-password" required /></label><label class="pin-revoke-check"><input id="pin-revoke-confirm" name="confirm_revoke" type="checkbox" required />ยืนยันเพิกถอนการเชื่อมต่อของเครื่องนี้บนเซิร์ฟเวอร์</label><button type="submit" id="pin-revoke-submit" class="pin-secondary" '+(busy?'disabled':'')+'>เพิกถอนเครื่องนี้</button></form>':'')+
    (recovery&&ctx.setupOnly===true?'</details>':'')+
    (device?'<div class="pin-setting-actions"><button type="button" id="pin-lock-device" class="pin-secondary" '+(busy?'disabled':'')+'>ล็อก / เปลี่ยนบทบาท</button><button type="button" id="pin-settings-forget" class="pin-text" '+(busy?'disabled':'')+'>ลืมการเชื่อมต่อบนเครื่องนี้</button><p class="pin-note">ลบการเชื่อมต่อในเบราว์เซอร์นี้เท่านั้น ไม่ได้เพิกถอนสิทธิ์บนเซิร์ฟเวอร์</p></div>':'')+'</section>';
}
export function renderPinSetup(ctx){
  const {root}=ctx;
  root.innerHTML='<main class="pin-shell pin-setup-shell"><section class="pin-card pin-setup-card"><div class="pin-brand">RAMAGAN</div><h1>เชื่อมต่อเครื่องและเปิด PIN ก่อนใช้งาน</h1><p class="pin-store">'+h(ctx.storeName||ctx.device?.store?.name||'ร้านของคุณ')+'</p><p class="pin-note">เข้าสู่บัญชี Owner เพื่อจัดการเครื่องเท่านั้น เมื่อเชื่อมต่อแล้วให้เลือกบทบาทและปลดล็อกด้วย PIN ก่อนเริ่มงาน</p>'+pinSettingsHtml({...ctx,setupOnly:true})+'<div class="pin-setup-actions">'+
    (typeof ctx.onChangeServer==='function'?'<button type="button" id="pin-setup-server" class="pin-secondary" '+(ctx.busy?'disabled':'')+'>เปลี่ยนเซิร์ฟเวอร์</button>':'')+
    (typeof ctx.onLogout==='function'?'<button type="button" id="pin-setup-logout" class="pin-text" '+(ctx.busy?'disabled':'')+'>ออกจากบัญชี Owner</button>':'')+'</div></section></main>';
  bindPinSettings(ctx);
  root.querySelector('#pin-setup-server')?.addEventListener('click',()=>{if(!ctx.busy)ctx.onChangeServer();});
  root.querySelector('#pin-setup-logout')?.addEventListener('click',()=>{if(!ctx.busy)ctx.onLogout();});
}
export function bindPinSettings(ctx) {
  const scope=ctx.root.querySelector('#pin-settings');if(!scope)return;
  const form=scope.querySelector('#pin-device-enroll'),busy=ctx.busy===true;
  let submitting=false;
  const configure=()=>ctx.capability===true&&ctx.passwordSession===true&&ctx.isOwner===true;
  const disableAll=value=>scope.querySelectorAll('input,button').forEach(node=>{node.disabled=value;});
  const clearSensitive=()=>{scope.querySelectorAll('input[type=password]').forEach(input=>{input.value='';});scope.querySelectorAll('input[type=checkbox]').forEach(input=>{input.checked=false;});};
  if(busy)disableAll(true);
  if(form) {
    if(busy)form.querySelectorAll('input').forEach(input=>{input.disabled=true;});
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(busy||submitting||ctx.capability!==true||ctx.passwordSession!==true||ctx.isOwner!==true)return;
      const field=name=>form.querySelector('[name="'+name+'"]'),owner_password=field('owner_password').value,label=field('label').value.trim();
      const initial=form.dataset.initialSetup==='true';
      const pins=initial?Object.fromEntries(ROLES.map(role=>[role,field('pin_'+role).value])):null;
      const confirmations=initial?Object.fromEntries(ROLES.map(role=>[role,field('confirm_'+role).value])):null;
      // Clear every sensitive field before validation callbacks or an awaited IO.
      clearSensitive();
      if(!owner_password||!label||label.length>80){showError(scope,'ระบุชื่อเครื่องและรหัสผ่าน Owner ให้ครบ');return;}
      if(initial&&ROLES.some(role=>!validPin(pins[role])||pins[role]!==confirmations[role])){showError(scope,'PIN แต่ละบทบาทต้องเป็นตัวเลข 4 หลัก และกรอกยืนยันให้ตรงกัน');return;}
      if(initial&&new Set(Object.values(pins)).size!==3){showError(scope,'PIN ของแต่ละบทบาทต้องแตกต่างกัน');return;}
      submitting=true;disableAll(true);showError(scope,'');
      try{await ctx.onEnroll({owner_password,label,...(initial?{pins}:{})});}catch{if(scope.isConnected)showError(scope,'เชื่อมต่อเครื่องไม่สำเร็จ กรุณาเข้าด้วยรหัสผ่าน Owner และลองใหม่');}
      finally{if(form.isConnected){submitting=false;disableAll(false);}}
    });
  }
  const change=scope.querySelector('#pin-change-pins');
  change?.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||submitting||!configure())return;
    const field=name=>change.querySelector('[name="'+name+'"]'),owner_password=field('owner_password').value;
    const pins=Object.fromEntries(ROLES.map(role=>[role,field('pin_'+role).value]));
    const confirmations=Object.fromEntries(ROLES.map(role=>[role,field('confirm_'+role).value]));
    clearSensitive();
    if(!owner_password){showError(scope,'ระบุรหัสผ่านบัญชี Owner ก่อนเปลี่ยน PIN');return;}
    if(ROLES.some(role=>!validPin(pins[role])||pins[role]!==confirmations[role])||new Set(Object.values(pins)).size!==3){showError(scope,'ตั้ง PIN ใหม่สามชุดให้เป็นตัวเลข 4 หลัก ต่างกัน และยืนยันให้ตรงกัน');return;}
    submitting=true;disableAll(true);showError(scope,'');
    try{await ctx.onChangePins({owner_password,pins});}catch{if(scope.isConnected)showError(scope,'เปลี่ยน PIN ไม่สำเร็จ กรุณาตรวจสอบรหัสผ่าน Owner แล้วลองใหม่');}
    finally{if(change.isConnected){submitting=false;disableAll(false);}}
  });
  const revoke=scope.querySelector('#pin-revoke-device');
  revoke?.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||submitting||!configure())return;
    const password=revoke.querySelector('[name=owner_password]'),check=revoke.querySelector('#pin-revoke-confirm');
    const owner_password=password.value,confirmed=check.checked,device_id=ctx.device?.device_id;
    clearSensitive();
    if(!owner_password||!confirmed||typeof device_id!=='string'||!device_id){showError(scope,'กรอกรหัสผ่าน Owner และทำเครื่องหมายยืนยันเพิกถอนเครื่องนี้');return;}
    submitting=true;disableAll(true);showError(scope,'');
    try{await ctx.onRevoke({owner_password,device_id});}catch{if(scope.isConnected)showError(scope,'เพิกถอนเครื่องนี้ไม่สำเร็จ กรุณาตรวจสอบรหัสผ่าน Owner แล้วลองใหม่');}
    finally{if(revoke.isConnected){submitting=false;disableAll(false);}}
  });
  scope.querySelector('#pin-lock-device')?.addEventListener('click',()=>{if(!busy&&!submitting){clearSensitive();ctx.onLock();}});
  scope.querySelector('#pin-settings-forget')?.addEventListener('click',()=>{if(!busy&&!submitting){clearSensitive();ctx.onForget();}});
  scope.querySelector('#pin-refresh-configuration')?.addEventListener('click',async()=>{if(!busy&&!submitting){clearSensitive();submitting=true;disableAll(true);try{await ctx.onRefreshConfiguration();}catch{if(scope.isConnected)showError(scope,'ตรวจสถานะ PIN ไม่สำเร็จ กรุณาลองใหม่');}finally{if(scope.isConnected){submitting=false;disableAll(false);}}}});
}
