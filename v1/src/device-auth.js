// Device credentials are remembered; unlocked authorization is memory-only.
// This controller never acknowledges, deletes or replaces a business intent.
import {createDeviceStore,pendingDeviceActor} from './device-session.js';

const ROLES=['owner','manager','staff'];
export const roleDisplay=role=>({owner:'เจ้าของร้าน (PIN ร่วม)',manager:'ผู้จัดการ (PIN ร่วม)',staff:'พนักงาน (PIN ร่วม)'}[role]||role);
export function createDeviceAuth({api,storage,isBusy=()=>false,clearDisplay=()=>{},render=()=>{},
  loadProfile=async()=>{},canConfigure=()=>false,currentStore=()=>null,cartEmpty=()=>true,
  exclusive=async task=>task(),now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
  const store=createDeviceStore(storage,api.base);
  let device=null,locked=false,passwordOverride=false,busy=false,error='',epoch=0,timer=null,expires=0,disposed=false,activeActor=null,configuration=null,autoRolePin=false;
  const supportsAuto=data=>data?.auto_role_pin===true&&data?.auto_role_pin_contract_version===1;
  const alive=n=>!disposed&&epoch===n;
  const stopTimer=()=>{if(timer!==null)clearTimer(timer);timer=null;expires=0;};
  const guard=()=>{const n=epoch;return()=>alive(n);};
  const pending=()=>pendingDeviceActor(storage,api.base,device?.store.id||currentStore());
  function restriction(){
    if(!device)return null;
    try{
      const actor=pending();if(!actor)return null;
      const role=ROLES.find(r=>device.actors[r]===actor);
      if(!role){error='มีรายการค้างของบัญชีเดิม กรุณาเข้าด้วยอีเมลและรหัสผ่านบัญชีเดิมเพื่อตรวจสอบ';return 'blocked';}
      return role;
    }catch{error='อ่านเจ้าของรายการค้างไม่ได้ กรุณาเข้าด้วยบัญชีเดิมเพื่อตรวจสอบ';return 'blocked';}
  }
  function snapshot(){const pendingRole=restriction();return {device,locked,passwordOverride,busy:busy||isBusy(),error,pendingRole,configuration,autoRolePin,isPinSession:api.auth.isPinSession()};}
  function fail(message){error=message;render();return false;}
  async function lock(message=''){
    if(disposed)return;
    ++epoch;stopTimer();activeActor=null;configuration=null;locked=Boolean(device);passwordOverride=false;error=message;
    const request=api.auth.isPinSession()?api.auth.lockDevice():api.auth.signOut();
    api.auth.forgetSession();clearDisplay();render();
    await request; // A failed remote lock never restores local authorization.
  }
  async function boot(){
    const n=++epoch;busy=true;error='';configuration=null;autoRolePin=false;
    try{
      // Discard the legacy password-session token BEFORE parsing a remembered
      // device or making its unauthenticated status request.
      if(storage.getItem(store.key)!==null&&api.auth.forgetSession()===false)throw new Error('ลบ session เดิมไม่ได้ กรุณาเข้าด้วยบัญชีเดิมหลังตรวจพื้นที่จัดเก็บ');
      device=store.read();
      if(!device)return false;
      locked=true;passwordOverride=false;clearDisplay();render();
      const response=await api.auth.deviceStatus(device.device_credential);
      if(!alive(n))return true;
      if(response.error)throw response.error;
      if(response.data?.device_id!==device.device_id||response.data?.store?.id!==device.store.id)throw new Error('ข้อมูลเครื่องไม่ตรงกับร้านที่จำไว้');
      autoRolePin=supportsAuto(response.data);
      device=store.save({...response.data,device_credential:device.device_credential},device.actors);
      return true;
    }catch(problem){
      if(alive(n)){error=problem.message||'ตรวจสอบเครื่องไม่สำเร็จ';if(!device){passwordOverride=true;locked=false;}}
      return true;
    }finally{busy=false;if(!disposed)render();}
  }
  async function unlock(role,pin,auto=false){
    if(disposed||busy||isBusy())return fail('รายการเดิมยังทำงานอยู่ กรุณารอให้สิ้นสุดก่อนปลดล็อก');
    if(!device||typeof pin!=='string'||!/^\d{4}$/.test(pin)||(auto?!autoRolePin:!ROLES.includes(role)||!device.roles.includes(role)))return fail('กรอก PIN 4 หลักที่ได้รับอนุญาต');
    const restricted=restriction();if(restricted==='blocked'||(!auto&&restricted&&restricted!==role))return fail('ต้องใช้บทบาทหรือบัญชีเดิมเพื่อตรวจสอบรายการค้าง');
    const n=++epoch;busy=true;error='';render();
    try{
      const response=await api.auth.unlockDevice({device_credential:device.device_credential,...(!auto?{role}:{}),pin});
      if(!alive(n))return false;
      if(response.error)throw response.error;
      const data=response.data;
      if(data?.device_id!==device.device_id||!ROLES.includes(data?.role)||!device.roles.includes(data.role)||(!auto&&data.role!==role)||!data.user?.id||!Number.isSafeInteger(data.expires_at)||data.expires_at*1000<=now())throw new Error('คำตอบปลดล็อกไม่ตรงกับเครื่องหรือบทบาท');
      role=data.role;
      if(restricted&&restricted!==role)throw new Error('ต้องใช้บทบาทเดิมเพื่อตรวจสอบรายการค้าง');
      // Recheck durable bytes AFTER the server unlock: another window may have
      // written an intent while the PIN request was in flight.
      const actor=pending();if(actor&&actor!==data.user.id)throw new Error('มีรายการค้างของบัญชีอื่น กรุณากลับเข้าบัญชีเดิม');
      device=store.save(device,{...device.actors,[role]:data.user.id});
      activeActor=data.user.id;locked=false;passwordOverride=false;expires=Math.min(data.expires_at*1000,now()+300000);
      timer=setTimer(()=>{void lock('ครบเวลาปลดล็อก กรุณาใส่ PIN อีกครั้ง');},Math.max(0,expires-now()));
      await loadProfile({...data.user,display_name:roleDisplay(role)},{current:()=>alive(n),role,store:device.store.id});
      return alive(n);
    }catch(problem){
      if(alive(n)){
        const revoke=api.auth.isPinSession()?api.auth.lockDevice():null;
        api.auth.forgetSession();stopTimer();activeActor=null;locked=true;clearDisplay();error=problem.message||'ปลดล็อกไม่สำเร็จ';
        await revoke;
      }
      return false;
    }finally{busy=false;if(!disposed)render();}
  }
  function passwordLogin(){
    if(busy||isBusy())return fail('รอรายการเดิมให้สิ้นสุดก่อนเปลี่ยนวิธีเข้าสู่ระบบ');
    ++epoch;stopTimer();activeActor=null;configuration=null;api.auth.forgetSession();passwordOverride=true;locked=false;clearDisplay();error='';render();return true;
  }
  async function refreshConfiguration(){
    if(disposed||busy||!canConfigure()||api.auth.isPinSession())return fail('ต้องใช้รหัสผ่านบัญชี Owner เพื่อตรวจการเชื่อมต่อเครื่อง');
    const n=epoch;busy=true;error='';configuration=null;render();
    try{
      const response=await api.auth.deviceConfiguration();
      if(!alive(n))return false;
      if(response.error)throw response.error;
      const data=response.data;
      if(typeof data?.configured!=='boolean'||data.device_enrollment_contract_version!==2||!Array.isArray(data.roles)||
          (data.configured?(data.roles.length!==3||new Set(data.roles).size!==3||ROLES.some(role=>!data.roles.includes(role))):data.roles.length!==0)){
        throw new Error('Incomplete device configuration');
      }
      configuration={configured:data.configured,roles:[...data.roles],device_enrollment_contract_version:2};
      return true;
    }catch(problem){if(alive(n)){configuration=null;error=problem.status===409?'สถานะ PIN ของร้านไม่ครบ กรุณาให้ผู้ดูแลตรวจสอบก่อนเชื่อมต่อเครื่อง':'ตรวจสถานะ PIN ไม่สำเร็จ กรุณาลองใหม่หรือให้ผู้ดูแลตรวจสอบ';}return false;}
    finally{busy=false;if(!disposed)render();}
  }
  async function configure(method,payload){
    if(disposed||busy||isBusy()||!canConfigure()||api.auth.isPinSession())return fail('ต้องใช้รหัสผ่านบัญชี Owner เพื่อจัดการ PIN');
    const n=epoch;busy=true;error='';render();
    try{
      return await exclusive(async()=>{
        if(!alive(n)||!canConfigure()||api.auth.isPinSession()||!cartEmpty()||pending())throw new Error('ต้องไม่มีตะกร้าหรือรายการค้างก่อนจัดการ PIN');
        let request=payload;
        if(method==='enrollDevice'){
          if(!configuration||configuration.device_enrollment_contract_version!==2)throw new Error('ต้องตรวจสถานะ PIN ของร้านให้สำเร็จก่อนเชื่อมต่อเครื่อง');
          request={label:payload.label,owner_password:payload.owner_password,
            ...(!configuration.configured?{pins:payload.pins}:{})};
        }
        const response=await api.auth[method](request);
        if(!alive(n))return false;
        if(response.error)throw response.error;
        if(method==='enrollDevice'){
          autoRolePin=supportsAuto(response.data);
          device=store.save(response.data,{});
          await lock();
        }else if(method==='revokeDevice'){
          store.forget();device=null;autoRolePin=false;error='เพิกถอนเครื่องนี้แล้ว';render();
        }else{error='เปลี่ยน PIN แล้ว บทบาทที่ใช้ PIN ต้องปลดล็อกใหม่';render();}
        return true;
      });
    }catch(problem){if(alive(n))error=problem.message||'จัดการ PIN ไม่สำเร็จ';return false;}
    finally{busy=false;if(!disposed)render();}
  }
  function forget(){
    if(busy||isBusy())return fail('รายการเดิมยังทำงานอยู่ จึงยังลืมเครื่องไม่ได้');
    try{
      if(device&&pending())return fail('ต้องตรวจสอบรายการค้างด้วยบทบาทเดิมก่อนลืมเครื่อง');
      store.forget();device=null;autoRolePin=false;
      if(api.auth.isPinSession()){++epoch;stopTimer();api.auth.lockDevice();clearDisplay();}
      locked=false;passwordOverride=true;error='';render();return true;
    }catch(problem){return fail(problem.message||'ลืมเครื่องไม่สำเร็จ');}
  }
  function checkExpiry(){if(api.auth.isPinSession()&&expires&&now()>=expires)void lock('ครบเวลาปลดล็อก กรุณาใส่ PIN อีกครั้ง');}
  function storageChanged(){
    if(!device)return;
    try{
      const fresh=store.read();
      if(!fresh||fresh.device_id!==device.device_id||fresh.device_credential!==device.device_credential){
        void lock('ข้อมูลเครื่องเปลี่ยนแล้ว กรุณาเข้าด้วยรหัสผ่าน');
        device=fresh;locked=Boolean(fresh);passwordOverride=!fresh;render();return;
      }
      device=fresh;
      const actor=pending();
      if(api.auth.isPinSession()&&actor&&actor!==activeActor)void lock('มีรายการค้างของบัญชีอื่น กรุณาใช้บัญชีเดิม');
      else render();
    }catch{void lock('อ่านข้อมูลเครื่องหรือรายการค้างไม่ได้ กรุณาเข้าด้วยบัญชีเดิม');device=null;locked=false;passwordOverride=true;render();}
  }
  const subscription=api.auth.onAuthStateChange(event=>{if(event==='PIN_LOCKED')void lock('สิทธิ์ PIN หมดอายุหรือถูกเพิกถอน กรุณาปลดล็อกใหม่');});
  return {boot,unlock,unlockAuto:pin=>unlock(null,pin,true),lock,passwordLogin,forget,snapshot,guard,checkExpiry,storageChanged,refreshConfiguration,
    enroll:payload=>configure('enrollDevice',payload),changePins:payload=>configure('changePins',payload),revoke:payload=>configure('revokeDevice',payload),
    pendingActor:pending,
    invalidate(){++epoch;disposed=true;configuration=null;stopTimer();subscription?.data?.subscription?.unsubscribe();api.auth.forgetSession();}};
}
