import {formatBaht, milligramsToGrams, sumSatang} from './math.js';
import {navigationHeader, mountNavigation} from './navigation.js';

const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paymentName = method => ({cash:'เงินสด', transfer:'โอนเงิน', split:'เงินสด + โอน'}[method] || 'ไม่ระบุ');
const dayFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit'});
const dateFormat = new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok', dateStyle:'long'});
const timeFormat = new Intl.DateTimeFormat('th-TH', {timeZone:'Asia/Bangkok', hour:'2-digit', minute:'2-digit', hour12:false});
const titles = {receipts:'ใบเสร็จรับเงิน', products:'รายการสินค้า', settings:'การตั้งค่า', apps:'แอป', support:'การสนับสนุน'};

export function supportsReceipts(capabilities) {
  return capabilities?.receipt_history === true && capabilities?.receipt_contract_version === 1;
}
export function createPageState() {
  return {receiptQuery:'', receiptFrom:'', receiptTo:'', receipts:[], receiptCursor:null,
    receiptsLoaded:false, receiptLoading:false, receiptError:'', receiptDetail:null,
    receiptDetailLoading:false, receiptDetailError:'', receiptRequest:0, detailRequest:0,
    productScreen:'menu', productQuery:'', productCategory:'', productId:null, health:null, healthError:'', healthBusy:false};
}
function shell(ctx, title, html) {
  const {root,state} = ctx;
  root.innerHTML = '<div class="pos-shell menu-page">'+navigationHeader({title,subtitle:state.store.name,
    cartCount:state.cart.size,showCart:true})+'<main class="pos-content menu-content">'+html+'</main></div>';
  root.querySelector('#open-ticket')?.addEventListener('click',()=>{state.posScreen='ticket';ctx.openView('sales');});
  mountNavigation(ctx);
}
function safeDate(value) {
  if(typeof value!=='string'||!value.trim())throw new Error('วันเวลาใบเสร็จไม่ถูกต้อง');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('วันเวลาใบเสร็จไม่ถูกต้อง');
  return date;
}
export function validateReceipt(receipt, detail = false) {
  if (!receipt || typeof receipt.id !== 'string' || typeof receipt.client_sale_id !== 'string' ||
      !['cash','transfer','split'].includes(receipt.payment_method) ||
      ['subtotal_satang','discount_satang','total_satang'].some(k => !Number.isSafeInteger(receipt[k]) || receipt[k] < 0) ||
      receipt.subtotal_satang - receipt.discount_satang !== receipt.total_satang) throw new Error('ข้อมูลยอดใบเสร็จจากเซิร์ฟเวอร์ไม่ถูกต้อง');
  safeDate(receipt.created_at);
  const split=receipt.payment_method==='split';
  if (!Array.isArray(receipt.payments) || receipt.payments.length!==(split?2:1) ||
      receipt.payments.some(p => !['cash','transfer'].includes(p.payment_method)) ||
      (split ? new Set(receipt.payments.map(p=>p.payment_method)).size!==2 || receipt.payments.some(p=>p.amount_satang<=0) :
        receipt.payments[0].payment_method!==receipt.payment_method) ||
      sumSatang(receipt.payments.map(p=>p.amount_satang)) !== receipt.total_satang) throw new Error('ยอดช่องทางชำระไม่ตรงใบเสร็จ');
  if (detail) {
    if (!Array.isArray(receipt.lines) || !receipt.lines.length || receipt.lines.some(line =>
      !Number.isSafeInteger(line.quantity_mg) || line.quantity_mg <= 0 ||
      ['unit_price_satang_per_gram','subtotal_satang','discount_satang','total_satang'].some(k=>!Number.isSafeInteger(line[k]) || line[k]<0) ||
      line.subtotal_satang-line.discount_satang!==line.total_satang) ||
      ['subtotal_satang','discount_satang','total_satang'].some(k=>sumSatang(receipt.lines.map(line=>line[k]))!==receipt[k])) {
      throw new Error('ยอดรายละเอียดสินค้าไม่ตรงใบเสร็จ');
    }
  }
  return receipt;
}
function liveGuard(ctx, pages, key, request) {
  const {state,api} = ctx, user=state.user?.id, store=state.store?.id, role=state.role;
  return () => state.pages===pages && pages[key]===request && state.user?.id===user && state.store?.id===store &&
    state.role===role && ctx.currentApi()===api;
}
export async function loadReceipts(ctx, more=false) {
  const {state,api} = ctx, p=state.pages;
  if (!supportsReceipts(state.capabilities) || (more&&p.receiptLoading)) return;
  const req=++p.receiptRequest, current=liveGuard(ctx,p,'receiptRequest',req);
  p.receiptLoading=true;p.receiptError='';
  if (!more) {p.receipts=[];p.receiptsLoaded=false;p.receiptCursor=null;p.receiptDetail=null;p.receiptDetailError='';++p.detailRequest;p.receiptDetailLoading=false;}
  ctx.render();
  try {
    const result=await api.receipts({q:p.receiptQuery,from_date:p.receiptFrom,to_date:p.receiptTo,
      ...(more?{cursor:p.receiptCursor}:{}),limit:30});
    if (!current()) return;
    if (result.error) throw result.error;
    const data=result.data;
    if (!Array.isArray(data?.sales) || (data.next_cursor!==null && typeof data.next_cursor!=='string')) throw new Error('ข้อมูลรายการใบเสร็จไม่ครบ');
    data.sales.forEach(x=>validateReceipt(x));
    p.receipts=more?[...p.receipts,...data.sales.filter(x=>!p.receipts.some(old=>old.id===x.id))]:data.sales;
    p.receiptCursor=data.next_cursor;p.receiptsLoaded=true;p.receiptFrom=data.from_date;p.receiptTo=data.to_date;
  } catch(error) {if(current())p.receiptError=error.status===422?'ช่วงวันหรือข้อมูลหน้าถัดไปไม่ถูกต้อง กรุณาค้นหาใหม่':error.message;}
  finally {if(current()){p.receiptLoading=false;ctx.render();}}
}
async function loadReceipt(ctx,id) {
  const {state,api}=ctx,p=state.pages,req=++p.detailRequest,current=liveGuard(ctx,p,'detailRequest',req);
  p.receiptDetail=null;p.receiptDetailLoading=true;p.receiptDetailError='';ctx.render();
  try {
    const result=await api.receipt(id);
    if(!current())return;
    if(result.error)throw result.error;
    if(result.data?.id!==id)throw new Error('เลขใบเสร็จในคำตอบไม่ตรงกับรายการที่เลือก');
    p.receiptDetail=validateReceipt(result.data,true);
  }catch(error){if(current())p.receiptDetailError=error.message;}
  finally{if(current()){p.receiptDetailLoading=false;ctx.render();}}
}
function receiptDetailHtml(receipt) {
  const date=safeDate(receipt.created_at);
  return '<section class="receipt-detail"><div class="receipt-heading"><h1>รายละเอียดใบเสร็จ</h1><strong>'+h(receipt.store_name)+'</strong><p>'+h(dateFormat.format(date))+' · '+h(timeFormat.format(date))+' (เวลาไทย)</p><p class="receipt-id">เลขรายการ '+h(receipt.id)+'</p></div>'+receipt.lines.map(line=>
    '<article class="receipt-line"><div><strong>'+h(line.product_name)+'</strong><small>Lot '+h(line.lot_code)+' · '+h(milligramsToGrams(line.quantity_mg))+' กรัม × '+h(formatBaht(line.unit_price_satang_per_gram))+'</small><small>ก่อนลด '+h(formatBaht(line.subtotal_satang))+' · ส่วนลด '+h(formatBaht(line.discount_satang))+'</small></div><b>'+h(formatBaht(line.total_satang))+'</b></article>').join('')+
    '<dl class="menu-facts"><div><dt>ยอดก่อนลด</dt><dd>'+h(formatBaht(receipt.subtotal_satang))+'</dd></div><div><dt>ส่วนลด</dt><dd>'+h(formatBaht(receipt.discount_satang))+'</dd></div><div class="net"><dt>สุทธิ</dt><dd>'+h(formatBaht(receipt.total_satang))+'</dd></div>'+receipt.payments.map(x=>'<div><dt>'+h(paymentName(x.payment_method))+'</dt><dd>'+h(formatBaht(x.amount_satang))+'</dd></div>').join('')+'</dl><p class="footnote">ยอดเงินเป็นข้อมูลที่บันทึกในบิล ชื่อสินค้าและชื่อร้านเป็นข้อมูลปัจจุบัน · ไม่ใช่ใบกำกับภาษี</p><p class="receipt-id">รหัสอ้างอิงเครื่อง '+h(receipt.client_sale_id)+'</p></section>';
}
function renderReceipts(ctx) {
  const {state,root}=ctx,p=state.pages;
  let content;
  if(!supportsReceipts(state.capabilities))content='<h1>ใบเสร็จรับเงิน</h1><p class="alert">API นี้ยังไม่รองรับประวัติใบเสร็จ กรุณาให้ผู้ดูแลอัปเดตระบบก่อน</p>';
  else if(p.receiptDetail || p.receiptDetailLoading || p.receiptDetailError) {
    content='<button id="receipt-back" class="ghost">‹ กลับรายการใบเสร็จ</button>'+(p.receiptDetailLoading?'<p role="status">กำลังอ่านใบเสร็จ…</p>':
      p.receiptDetailError?'<p class="alert danger" role="alert">'+h(p.receiptDetailError)+'</p>':receiptDetailHtml(p.receiptDetail));
  }else{
    let lastDay='';
    const rows=p.receipts.map(sale=>{
      const date=safeDate(sale.created_at),day=dayFormat.format(date),heading=lastDay===day?'':'<h2 class="receipt-day">'+h(dateFormat.format(date))+'</h2>';lastDay=day;
      return heading+'<button class="receipt-row" data-receipt="'+h(sale.id)+'"><span class="receipt-method" aria-label="'+h(paymentName(sale.payment_method))+'">'+(sale.payment_method==='cash'?'฿':sale.payment_method==='transfer'?'↗':'⇄')+'</span><span><strong>'+h(formatBaht(sale.total_satang))+'</strong><small>'+h(timeFormat.format(date))+' · '+h(paymentName(sale.payment_method))+'</small></span><span class="receipt-short">#'+h(sale.id.slice(0,8))+'</span></button>';
    }).join('');
    content='<form id="receipt-search" class="receipt-search"><label>ค้นหาใบเสร็จ / สินค้า / Lot<input name="q" value="'+h(p.receiptQuery)+'" maxlength="100" placeholder="ค้นหา" /></label><div class="menu-date-range"><label>ตั้งแต่<input name="from" type="date" value="'+h(p.receiptFrom)+'" /></label><label>ถึง<input name="to" type="date" value="'+h(p.receiptTo)+'" /></label></div><button class="primary" '+(p.receiptLoading?'disabled':'')+'>ค้นหา / รีเฟรช</button></form><p class="footnote">เวลาไทย · '+(ctx.canManage()?'ใบเสร็จในร้านนี้':'ใบเสร็จที่บัญชีนี้เป็นผู้ขาย')+' · เปิดอ่านรายละเอียดได้</p>'+
      (p.receiptError?'<p class="alert danger" role="alert">'+h(p.receiptError)+'</p>':'')+'<div class="receipt-list">'+rows+'</div>'+
      (p.receiptLoading?'<p role="status">กำลังอ่านรายการ…</p>':!p.receipts.length&&p.receiptsLoaded?'<p class="menu-empty">ไม่พบใบเสร็จในช่วงที่เลือก</p>':'')+
      (p.receiptCursor?'<button id="receipt-more" class="ghost" '+(p.receiptLoading?'disabled':'')+'>โหลดใบเสร็จถัดไป</button>':'');
  }
  shell(ctx,titles.receipts,content);
  root.querySelector('#receipt-search')?.addEventListener('submit',e=>{
    e.preventDefault();const form=new FormData(e.currentTarget);p.receiptQuery=String(form.get('q')).trim();p.receiptFrom=String(form.get('from'));p.receiptTo=String(form.get('to'));loadReceipts(ctx);
  });
  root.querySelector('#receipt-more')?.addEventListener('click',()=>loadReceipts(ctx,true));
  root.querySelectorAll('[data-receipt]').forEach(n=>n.addEventListener('click',()=>loadReceipt(ctx,n.dataset.receipt)));
  root.querySelector('#receipt-back')?.addEventListener('click',()=>{++p.detailRequest;p.receiptDetail=null;p.receiptDetailError='';p.receiptDetailLoading=false;ctx.render();});
}
export function productLots(state,product) {
  return (state.inventory?.lots || state.lots).filter(lot=>lot.product_id?lot.product_id===product.id:lot.sku===product.sku);
}
function renderProducts(ctx) {
  const {state,root}=ctx,p=state.pages,products=state.products;
  const go=screen=>{p.productScreen=screen;ctx.render();};
  let title=titles.products,html='';
  const row=(target,icon,label,note='')=>'<button class="menu-row" data-product-screen="'+target+'"><span class="menu-row-icon" aria-hidden="true">'+icon+'</span><span><strong>'+label+'</strong>'+(note?'<small>'+note+'</small>':'')+'<span class="menu-chevron">›</span></span></button>';
  if(p.productScreen==='menu')html='<div class="menu-options">'+row('list','☷','รายการสินค้า')+row('categories','▣','หมวดหมู่')+row('extras','⊕','ตัวเลือกเพิ่มเติม')+row('discounts','◇','ส่วนลด')+'</div>';
  else if(p.productScreen==='categories'){
    title='หมวดหมู่';const cats=[...new Set(products.map(x=>x.category||'other'))].sort((a,b)=>a.localeCompare(b,'th'));
    html='<div class="menu-options">'+cats.map(cat=>'<button class="menu-row" data-category="'+h(cat)+'"><span class="menu-row-icon">▣</span><span><strong>'+h(cat)+'</strong><small>'+products.filter(x=>(x.category||'other')===cat).length+' สินค้า</small></span><span>›</span></button>').join('')+'</div>'+(cats.length?'':'<p class="menu-empty">ยังไม่มีหมวดหมู่</p>');
  }else if(p.productScreen==='extras'){
    title='ตัวเลือกเพิ่มเติม';html='<h1>ตัวเลือกสินค้า</h1><div class="menu-options">'+row('list','☷','เลือกสินค้าและดู Lot','ดูราคา วันหมดอายุ และยอดคงเหลือราย Lot')+'</div><p class="footnote">ระบบนี้ขายตามน้ำหนักกรัม ทศนิยมได้ 3 ตำแหน่ง ยังไม่มีตัวเลือกเสริมหรือราคาท็อปปิ้ง</p>';
  }else if(p.productScreen==='discounts'){
    title='ส่วนลด';html='<h1>ส่วนลดท้ายบิล</h1><p>ระบุส่วนลดเป็นบาทในหน้าตรวจออร์เดอร์ ตั้งแต่ 0 ถึงยอดก่อนลด</p><p class="footnote">ส่วนลดบิลจะกระจายลงสินค้าและรายงานตามยอดที่เซิร์ฟเวอร์บันทึก</p><button id="discount-ticket" class="primary">ไปส่วนลดในตั๋วออร์เดอร์</button>';
  }else if(p.productScreen==='detail'){
    const product=products.find(x=>x.id===p.productId);
    if(!product){p.productScreen='list';return renderProducts(ctx);}
    title=product.name;const lots=productLots(state,product);
    html='<h1>'+h(product.name)+'</h1><p class="muted">'+h(product.sku)+' · '+h(product.category)+'</p><dl class="menu-facts"><div><dt>ราคาขาย / กรัม</dt><dd>'+h(formatBaht(product.price_satang_per_gram))+'</dd></div><div><dt>สถานะสินค้า</dt><dd>'+(product.active?'ใช้งาน':'ปิดใช้งาน')+'</dd></div></dl><h2>Lot และยอดคงเหลือ</h2>'+lots.map(lot=>'<article class="product-lot"><div><strong>'+h(lot.lot_code)+'</strong><small>'+(lot.expires_on?'หมดอายุ '+h(lot.expires_on):'ไม่ระบุวันหมดอายุ')+'</small></div><b>'+h(milligramsToGrams(lot.quantity_mg))+' กรัม</b></article>').join('')+(lots.length?'':'<p class="menu-empty">ยังไม่มี Lot ที่แสดงได้</p>')+(ctx.canManage()?'<button id="product-receive" class="primary">รับสินค้าเข้า Lot</button>':'');
  }else{
    title=p.productCategory||'รายการทั้งหมด';const query=p.productQuery.trim().toLowerCase();
    const selected=products.filter(x=>(!p.productCategory||(x.category||'other')===p.productCategory)&&(!query||[x.name,x.sku,x.category].some(v=>String(v).toLowerCase().includes(query))));
    html='<div class="product-filters"><label>ค้นหา<input id="product-query" value="'+h(p.productQuery)+'" placeholder="ชื่อสินค้า / SKU" /></label><label>หมวดหมู่<select id="product-category"><option value="">รายการทั้งหมด</option>'+[...new Set(products.map(x=>x.category||'other'))].sort().map(cat=>'<option '+(cat===p.productCategory?'selected ':'')+'value="'+h(cat)+'">'+h(cat)+'</option>').join('')+'</select></label></div><div class="product-list">'+selected.map(product=>{
      const lots=productLots(state,product),quantity=sumSatang(lots.map(x=>x.quantity_mg));
      return '<button class="product-list-row" data-product="'+h(product.id)+'"><span class="pos-product-icon">'+h(product.name.slice(0,1))+'</span><span><strong>'+h(product.name)+'</strong><small>'+h(milligramsToGrams(quantity))+' กรัมในสต็อก'+(!product.active?' · ปิดใช้งาน':'')+'</small></span><b>'+h(formatBaht(product.price_satang_per_gram))+'</b></button>';
    }).join('')+'</div>'+(!selected.length?'<p class="menu-empty">ไม่พบสินค้า</p>':'')+(ctx.canManage()?'<button id="product-add" class="product-add" aria-label="เพิ่มสินค้าใหม่">+</button>':'');
  }
  if(p.productScreen!=='menu')html='<button id="product-back" class="ghost">‹ '+(p.productScreen==='detail'?'กลับรายการสินค้า':'เมนูรายการสินค้า')+'</button>'+html;
  shell(ctx,title,html);
  root.querySelector('#product-back')?.addEventListener('click',()=>go(p.productScreen==='detail'?'list':'menu'));
  root.querySelectorAll('[data-product-screen]').forEach(n=>n.addEventListener('click',()=>{if(n.dataset.productScreen==='list')p.productCategory='';go(n.dataset.productScreen);}));
  root.querySelectorAll('[data-category]').forEach(n=>n.addEventListener('click',()=>{p.productCategory=n.dataset.category;p.productQuery='';go('list');}));
  root.querySelectorAll('[data-product]').forEach(n=>n.addEventListener('click',()=>{p.productId=n.dataset.product;go('detail');}));
  root.querySelector('#product-query')?.addEventListener('input',e=>{p.productQuery=e.target.value;ctx.render();const n=root.querySelector('#product-query');n.focus();n.setSelectionRange(n.value.length,n.value.length);});
  root.querySelector('#product-category')?.addEventListener('change',e=>{p.productCategory=e.target.value;ctx.render();});
  root.querySelector('#product-add')?.addEventListener('click',()=>ctx.openInventory(null,'new-product'));
  root.querySelector('#product-receive')?.addEventListener('click',()=>ctx.openInventory(p.productId,'receive-lot'));
  root.querySelector('#discount-ticket')?.addEventListener('click',()=>{state.posScreen='ticket';ctx.openView('sales');});
}
function renderInformation(ctx,view) {
  const {state,root,api}=ctx,p=state.pages;
  let html='';
  if(view==='settings')html='<h1>บัญชีและเครื่องนี้</h1><dl class="menu-facts"><div><dt>บัญชี</dt><dd>'+h(state.user.email||state.user.id)+'</dd></div><div><dt>ร้าน</dt><dd>'+h(state.store.name)+'</dd></div><div><dt>สิทธิ์</dt><dd>'+h(state.role)+'</dd></div><div><dt>เซิร์ฟเวอร์</dt><dd>'+h(api.base)+'</dd></div><div><dt>ระบบขาย</dt><dd>'+(state.store.sales_enabled?'เปิดใช้งาน':'ยังไม่เปิด')+'</dd></div></dl><button id="settings-health" class="ghost" '+(p.healthBusy?'disabled':'')+'>ตรวจการเชื่อมต่อ</button>'+(p.health?'<p class="alert">เชื่อมต่อสำเร็จ · API '+h(p.health.version)+' · schema '+h(p.health.schema_version)+'</p>':'')+(p.healthError?'<p class="alert danger">'+h(p.healthError)+'</p>':'')+'<div class="settings-actions"><button id="settings-server" class="ghost">เปลี่ยนเซิร์ฟเวอร์</button><button id="settings-logout" class="ghost">ออกจากระบบ</button></div>';
  if(view==='apps')html='<h1>RAMAGAN บนเครื่องนี้</h1><p>ใช้เว็บไซต์ร้านใน Chrome แล้วเลือกเมนู “เพิ่มลงในหน้าจอหลัก” หรือ “ติดตั้งแอป” เพื่อเปิดใช้งานครั้งถัดไป</p><p class="footnote">เว็บไซต์และ Android ใช้ข้อมูลกลางจากเซิร์ฟเวอร์ร้านเดียวกัน</p><dl class="menu-facts"><div><dt>รุ่นหน้าร้าน</dt><dd>'+h(ctx.appVersion)+'</dd></div><div><dt>แพลตฟอร์ม</dt><dd>'+(window.Capacitor?.isNativePlatform?.()?'Android':'เว็บเบราว์เซอร์')+'</dd></div></dl>';
  if(view==='support')html='<h1>ช่วยเหลือการใช้งาน</h1><details open><summary>ติดต่อเซิร์ฟเวอร์ไม่ได้</summary><p>ตรวจอินเทอร์เน็ตและ URL ในการตั้งค่า เปิด Health ผ่าน HTTPS โดยไม่ข้ามคำเตือนใบรับรอง</p></details><details><summary>รายการขายค้างหรือยังไม่ทราบผล</summary><p>กลับหน้าขายเพื่อดูรายการค้าง ใช้การตรวจสอบหรือส่งรายการเดิมด้วย ID เดิม ห้ามสร้างบิลใหม่เพื่อแทนรายการที่ยังไม่ทราบผล</p></details><details><summary>นับสต็อกและแนบรูป</summary><p>Owner/Manager ระบุกะ เหตุผล ยอดนับ และรูปตราชั่งให้ครบทุก Lot ที่นับ ตรวจส่วนต่างแล้วจึงยืนยัน รายการที่ยอดเท่าเดิมยังบันทึกประวัติได้</p></details><details><summary>แจ้งปัญหาให้ผู้ดูแลร้าน</summary><p>ส่งเวลาเกิดปัญหา รุ่นแอป และเลขรายการ พร้อมภาพหน้าจอที่ไม่แสดงรหัสผ่าน PIN หรือ token</p></details>';
  if(view==='settings')html+=ctx.pinSettingsHtml?.()||'';
  shell(ctx,titles[view],html);
  if(view==='settings')ctx.bindPinSettings?.();
  root.querySelector('#settings-server')?.addEventListener('click',ctx.changeServer);
  root.querySelector('#settings-logout')?.addEventListener('click',ctx.logout);
  root.querySelector('#settings-health')?.addEventListener('click',async()=>{
    const current=liveGuard(ctx,p,'receiptRequest',p.receiptRequest);p.healthBusy=true;p.health=null;p.healthError='';ctx.render();
    const result=await api.health();if(!current())return;p.healthBusy=false;
    if(result.error)p.healthError=result.error.message;else if(result.data?.status==='ok')p.health=result.data;else p.healthError='ปลายทางไม่ใช่ Ramagan API';ctx.render();
  });
}
export function renderSidePage(ctx) {
  if(ctx.state.view==='receipts')return renderReceipts(ctx);
  if(ctx.state.view==='products')return renderProducts(ctx);
  return renderInformation(ctx,ctx.state.view);
}
