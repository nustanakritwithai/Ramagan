// Completed receipts remain immutable. This durable intent only appends a void;
// a network timeout must never create a second reversal or a replacement sale.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=message=>{throw new Error(message);};
const money=n=>Number.isSafeInteger(n)&&n>=0;
export const supportsSaleVoids=c=>c?.sale_voids===true&&c?.sale_void_contract_version===1;
export const voidPendingKey=identity=>'ramagan.v1.sale-void.v1.'+encodeURIComponent(identity.api)+'.'+identity.store;
export function validateVoid(data,op){
  const p=op.payload,s=op.original;
  if(!UUID.test(data?.id)||data.status!=='voided'||data.client_void_id!==p.client_void_id||
      data.sale_id!==op.sale_id||data.client_sale_id!==s.client_sale_id||data.reason!==p.reason||
      data.actor_user_id!==op.identity.actor||!UUID.test(data.actor_user_id)||!['owner','manager'].includes(data.actor_role)||
      typeof data.actor_email!=='string'||typeof data.created_at!=='string'||!Number.isFinite(Date.parse(data.created_at))||
      typeof data.duplicate!=='boolean'||['subtotal_satang','discount_satang','total_satang'].some(k=>data[k]!==s[k])||
      data.payment_method!==s.payment_method||!Array.isArray(data.payments)||
      JSON.stringify([...data.payments].sort((a,b)=>a.payment_method.localeCompare(b.payment_method)))!==
      JSON.stringify([...s.payments].sort((a,b)=>a.payment_method.localeCompare(b.payment_method)))||
      !Array.isArray(data.restored_items)||data.restored_items.length!==s.items.length||
      new Set(data.restored_items.map(x=>x.lot_id)).size!==s.items.length)fail('ผลยกเลิกไม่ตรงใบเสร็จ ต้องตรวจสอบรายการเดิม');
  for(const item of data.restored_items){
    const original=s.items.find(x=>x.lot_id===item.lot_id);
    if(!original||item.quantity_mg!==original.quantity_mg||!UUID.test(item.sale_line_id)||!UUID.test(item.ledger_event_id)||
        !money(item.quantity_before_mg)||!money(item.quantity_after_mg)||
        BigInt(item.quantity_after_mg)!==BigInt(item.quantity_before_mg)+BigInt(item.quantity_mg)||
        !money(item.stock_revision_before)||item.stock_revision_after!==item.stock_revision_before+1||
        !(item.inventory_delta_satang===null||money(item.inventory_delta_satang)))fail('ยอดคืนสต็อกไม่ตรงใบเสร็จ ต้องตรวจสอบรายการเดิม');
  }
  return data;
}
export function createSaleVoid({storage,identity,transport,uuid,lock}){
  const key=voidPendingKey(identity);
  function validate(op){
    if(op?.version!==1||!['pending','confirmed','rejected'].includes(op.status)||typeof op.uncertain!=='boolean'||
        op.identity?.api!==identity.api||op.identity?.store!==identity.store||op.identity?.actor!==identity.actor||
        !UUID.test(op.sale_id)||!UUID.test(op.payload?.client_void_id)||typeof op.payload.reason!=='string'||
        !op.payload.reason.trim()||op.payload.reason!==op.payload.reason.trim()||op.payload.reason.length>300)
      fail('รายการยกเลิกค้างเป็นของบัญชีอื่นหรือข้อมูลไม่ครบ ต้องใช้บัญชีเดิมตรวจสอบ');
    const s=op.original;
    if(!UUID.test(s?.client_sale_id)||['subtotal_satang','discount_satang','total_satang'].some(k=>!money(s[k]))||
        s.subtotal_satang-s.discount_satang!==s.total_satang||!['cash','transfer','split'].includes(s.payment_method)||
        !Array.isArray(s.payments)||!s.payments.length||s.payments.some(x=>!['cash','transfer'].includes(x.payment_method)||!money(x.amount_satang))||
        s.payments.reduce((n,x)=>n+BigInt(x.amount_satang),0n)!==BigInt(s.total_satang)||
        !Array.isArray(s.items)||!s.items.length||new Set(s.items.map(x=>x.lot_id)).size!==s.items.length||
        s.items.some(x=>!UUID.test(x.lot_id)||!Number.isSafeInteger(x.quantity_mg)||x.quantity_mg<=0))fail('หลักฐานใบเสร็จค้างไม่ครบ ต้องให้ผู้ดูแลตรวจสอบ');
    if(op.status==='confirmed')validateVoid(op.result,op);
    return op;
  }
  const read=()=>{const raw=storage.getItem(key);return raw===null?null:validate(JSON.parse(raw));};
  function persist(op){validate(op);const raw=JSON.stringify(op);storage.setItem(key,raw);if(storage.getItem(key)!==raw)fail('บันทึกเลขยกเลิกไม่ได้ จึงยังไม่ส่งคำขอ');return JSON.parse(raw);}
  function exclusive(task){if(!lock)fail('อุปกรณ์นี้ยังล็อกรายการอย่างปลอดภัยไม่ได้');return lock(key,task);}
  async function capabilities(){if(!supportsSaleVoids(await transport.capabilities(identity)))fail('API ยังไม่รองรับการยกเลิกใบเสร็จรุ่นนี้');}
  function confirmed(data,op){const result=validateVoid(data,op);return {result,op:persist({...op,status:'confirmed',result})};}
  async function lookup(op){
    if(op.status==='confirmed')return {result:validateVoid(op.result,op),op};
    if(op.status==='rejected')return {rejected:true,op,error:new Error(op.rejection)};
    const result=await transport.lookup(op.payload.client_void_id);
    return result?confirmed(result,op):{pending:true,op};
  }
  async function post(op){
    await capabilities();
    if(JSON.stringify(read())!==JSON.stringify(op))fail('รายการค้างเปลี่ยนไป กรุณาตรวจสอบรายการเดิม');
    const sending=persist({...op,uncertain:true});
    try{return confirmed(await transport.post(op.sale_id,op.payload),sending);}
    catch(error){
      let absent=false;
      try{const found=await lookup(sending);if(found.result)return found;absent=true;}catch{/* retain frozen intent */}
      if(!op.uncertain&&absent&&[400,401,403,404,409,422].includes(error.status))
        return {rejected:true,error,op:persist({...sending,status:'rejected',rejection:error.message})};
      return {pending:true,error,op:sending};
    }
  }
  return {key,read,
    start:(receipt,reason)=>exclusive(async()=>{
      if(read())fail('มีคำขอยกเลิกค้าง ต้องตรวจสอบรายการเดิมก่อน');
      if(receipt.status==='voided')fail('ใบเสร็จนี้ยกเลิกแล้ว');
      if(typeof reason!=='string')fail('ระบุเหตุผลการยกเลิก');
      await capabilities();
      const original={client_sale_id:receipt.client_sale_id,payment_method:receipt.payment_method,
        payments:receipt.payments.map(x=>({payment_method:x.payment_method,amount_satang:x.amount_satang})),
        subtotal_satang:receipt.subtotal_satang,discount_satang:receipt.discount_satang,total_satang:receipt.total_satang,
        items:receipt.lines.map(x=>({lot_id:x.lot_id,quantity_mg:x.quantity_mg}))};
      return post(persist({version:1,status:'pending',uncertain:false,identity:{...identity},sale_id:receipt.id,
        payload:{client_void_id:uuid(),reason:reason.trim()},original}));
    }),
    retry:()=>exclusive(async()=>{const op=read();if(!op)fail('ไม่พบรายการยกเลิกค้าง');const found=await lookup(op);return found.result||found.rejected?found:post(op);}),
    verify:()=>exclusive(async()=>{const op=read();return op?lookup(op):null;}),
    acknowledge:()=>exclusive(async()=>{const op=read();if(!op||!['confirmed','rejected'].includes(op.status))fail('ยังไม่ทราบผล ห้ามล้างคำขอยกเลิก');
      storage.removeItem(key);if(storage.getItem(key)!==null)fail('ล้างคำขอไม่สำเร็จ กรุณาตรวจสอบรายการเดิม');})
  };
}
