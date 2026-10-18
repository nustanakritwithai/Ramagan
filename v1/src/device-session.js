// Remember only a scoped device credential. PINs/passwords/unlocked tokens never
// enter this store. Business authorization always comes from the server.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES=['owner','manager','staff'];
export const deviceKey=base=>'ramagan.v1.device.v1.'+encodeURIComponent(base);
export const supportsSharedPin=c=>c?.shared_role_pin===true&&c?.shared_role_pin_contract_version===1;
export function createDeviceStore(storage,base){
  const key=deviceKey(base);
  function validate(x){
    if(x?.version!==1||typeof x.device_credential!=='string'||!/^[A-Za-z0-9_-]{40,256}$/.test(x.device_credential)||
      !UUID.test(x.device_id)||!UUID.test(x.store?.id)||typeof x.store?.name!=='string'||
      !Array.isArray(x.roles)||x.roles.length!==3||new Set(x.roles).size!==3||x.roles.some(r=>!ROLES.includes(r))||
      !Number.isSafeInteger(x.expires_at)||!x.actors||Object.entries(x.actors).some(([role,id])=>!ROLES.includes(role)||!UUID.test(id)))throw new Error('ข้อมูลเครื่องที่จำไว้ไม่ครบ กรุณาเข้าด้วยรหัสผ่านเพื่อตรวจสอบ');
    return x;
  }
  return {key,read(){const raw=storage.getItem(key);return raw===null?null:validate(JSON.parse(raw));},
    save(data,actors={}){const value=validate({version:1,device_credential:data.device_credential,device_id:data.device_id,
      store:data.store,roles:data.roles,expires_at:data.expires_at,actors});const text=JSON.stringify(value);storage.setItem(key,text);
      if(storage.getItem(key)!==text)throw new Error('จำเครื่องไม่ได้ กรุณาตรวจพื้นที่จัดเก็บ');return value;},
    forget(){storage.removeItem(key);if(storage.getItem(key)!==null)throw new Error('ลบการจำเครื่องไม่สำเร็จ');}
  };
}
export function pendingDeviceActor(storage,base,store){
  if(!store)return null;
  const ids=new Set(),sale='ramagan.v1.pending.v2.'+encodeURIComponent(base)+'.'+store;
  const inventory='ramagan.v1.inventory.v1.'+encodeURIComponent(base)+'.'+store+'.';
  const add=(text,kind)=>{const op=JSON.parse(text),actor=op?.identity?.[kind];
    if(!UUID.test(actor)||op.identity.api!==base||op.identity.store!==store)throw new Error('อ่านเจ้าของรายการค้างไม่ได้ ต้องเข้าบัญชีเดิมเพื่อตรวจสอบ');ids.add(actor);};
  const raw=storage.getItem(sale);if(raw!==null)add(raw,'cashier');
  if(storage.getItem('ramagan.v1.pending.'+store)!==null)throw new Error('มีรายการค้างรุ่นเก่า ต้องเข้าบัญชีเดิมก่อน');
  if(!Number.isSafeInteger(storage.length)||storage.length<0)throw new Error('อ่านพื้นที่เก็บรายการค้างไม่ได้');
  for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(inventory)&&!key.endsWith('.completed')){const value=storage.getItem(key);if(value!==null)add(value,'actor');}}
  if(ids.size>1)throw new Error('มีรายการค้างมากกว่าหนึ่งบัญชี ให้ผู้ดูแลตรวจสอบก่อนสลับสิทธิ์');
  return [...ids][0]||null;
}
