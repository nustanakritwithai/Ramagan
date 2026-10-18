import {gramsToMilligrams, milligramsToGrams, lineTotalSatang, formatBaht, discountSatang} from './math.js';
import {supportsDiscount, supportsSplitPayments, supportsSaleReconciliation} from './checkout.js';
import {mountNavigation} from './navigation.js';
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function paymentPreview(state, total) {
  try {
    if (!Number.isSafeInteger(total) || total < 0) throw new Error('ตรวจสอบยอดสุทธิก่อนชำระเงิน');
    let cash = state.payment === 'cash' ? total : 0, transfer = state.payment === 'transfer' ? total : 0;
    let payments;
    if (state.payment === 'split') {
      if (!supportsSplitPayments(state.capabilities)) throw new Error('เซิร์ฟเวอร์ยังไม่รองรับเงินสดร่วมกับเงินโอน');
      cash = discountSatang(state.splitCash || '', Number.MAX_SAFE_INTEGER);
      transfer = discountSatang(state.splitTransfer || '', Number.MAX_SAFE_INTEGER);
      if (!cash || !transfer || cash + transfer !== total) throw new Error('ยอดเงินสดและโอนต้องมากกว่า 0 และรวมเท่ากับยอดสุทธิ');
      payments = [{payment_method:'cash',amount_satang:cash},{payment_method:'transfer',amount_satang:transfer}];
    }
    const received = cash ? discountSatang(state.cashReceived || '', Number.MAX_SAFE_INTEGER) : 0;
    if (received < cash) throw new Error('เงินสดที่รับต้องไม่น้อยกว่ายอดเงินสดที่ต้องชำระ');
    return {cash, transfer, received, change: received - cash, ...(payments ? {payments} : {})};
  } catch (error) {return {error:error.message};}
}
export function renderPos(ctx) {
  const {root,state} = ctx, totals = ctx.preview(), locked = state.busy || ctx.hasPending(), today = ctx.today();
  const go = screen => {state.posScreen=screen;state.posMenuOpen=false; state.message=''; ctx.render();};
  const screen = state.posScreen || 'catalog';
  if(screen!=='catalog')state.posMenuOpen=false;
  const items = [...state.cart].map(([lot_id,quantity_mg]) => ({lot:state.lots.find(x=>x.id===lot_id),lot_id,quantity_mg}));
  const totalLabel = totals.error ? 'ตรวจสอบรายการ' : formatBaht(totals.total);
  const nav = '<header class="pos-header"><button id="pos-back" class="pos-icon" aria-label="'+(screen==='catalog'?'เมนู':'ย้อนกลับ')+'" '+(screen==='catalog'?'data-navigation-trigger data-navigation-handled="true" aria-controls="app-navigation-drawer" aria-expanded="'+Boolean(state.posMenuOpen)+'"':'')+'>'+ (screen==='catalog'?'☰':'‹')+'</button><div><strong>RAMAGAN</strong><small>'+h(state.store.name)+'</small></div><button id="open-ticket" class="pos-ticket">รายการ <b>'+items.length+'</b></button></header>';
  const notices = (!state.store.sales_enabled?'<p class="alert danger">ร้านยังไม่เปิดระบบขาย</p>':'')+
    (!navigator.onLine?'<p class="alert danger">ออฟไลน์: ยังยืนยันรายการไม่ได้</p>':'')+
    (state.message?'<p class="alert '+(state.error?'danger':'')+'">'+h(state.message)+'</p>':'')+
    (state.lastSale?'<p class="alert success">รายการล่าสุด '+h(state.lastSale.sale_id)+' · ก่อนลด '+h(formatBaht(state.lastSale.subtotal_satang))+' · ส่วนลด '+h(formatBaht(state.lastSale.discount_satang))+' · สุทธิยืนยัน '+h(formatBaht(state.lastSale.total_satang))+'</p>':'');
  let content='';
  if (screen==='catalog') {
    const query=(state.catalogQuery||'').trim().toLowerCase();
    content='<div class="pos-toolbar"><h1>รายการสินค้า</h1><button id="refresh" class="ghost">รีเฟรชสต็อก</button></div><label class="pos-search"><span>ค้นหาสินค้า / Lot</span><input id="catalog-query" value="'+h(state.catalogQuery||'')+'" placeholder="ค้นหาสินค้า" /></label><div class="pos-catalog">'+state.lots.filter(l=>!query||[l.name,l.sku,l.lot_code].some(v=>String(v).toLowerCase().includes(query))).map(l=>{
      const expired=l.expires_on&&l.expires_on<today;
      return '<button class="pos-product" data-add="'+h(l.id)+'" '+(locked||expired||l.quantity_mg<=0?'disabled':'')+'><span class="pos-product-icon">'+h(l.name.slice(0,1))+'</span><span><strong>'+h(l.name)+'</strong><small>'+h(l.lot_code)+' · คงเหลือ '+h(milligramsToGrams(l.quantity_mg))+' กรัม'+(expired?' · หมดอายุ':'')+'</small></span><b>'+h(formatBaht(l.price))+'<small>/ กรัม</small></b></button>';
    }).join('')+'</div><footer class="pos-bottom"><button id="catalog-pay" class="primary" '+(!items.length?'disabled':'')+'>ชำระเงิน <strong>'+h(totalLabel)+'</strong></button></footer>';
  } else if (screen==='quantity') {
    const lot=state.lots.find(x=>x.id===state.quantityLot);
    if (!lot) {state.posScreen='catalog'; return renderPos(ctx);}
    let error='',quantity,amount;
    try {quantity=gramsToMilligrams(state.quantityText); const next=state.quantityEditing?quantity:quantity+(state.cart.get(lot.id)||0); if(next>1000000)throw Error('จำนวนรวมต่อ Lot ต้องไม่เกิน 1,000 กรัม'); if(next>lot.quantity_mg)throw Error('จำนวนมากกว่าสต็อกที่แสดง กรุณารีเฟรช'); amount=lineTotalSatang(lot.price,quantity);}catch(e){error=e.message;}
    content='<section class="pos-quantity"><h1>'+h(lot.name)+'</h1><p class="muted">Lot '+h(lot.lot_code)+' · '+h(formatBaht(lot.price))+' / กรัม</p><label>จำนวน (กรัม)<input id="quantity-input" data-qty="'+h(lot.id)+'" inputmode="decimal" value="'+h(state.quantityText)+'" '+(locked?'disabled':'')+' /></label><p id="quantity-error" class="danger-text">'+h(error)+'</p><div class="pos-quantity-total">'+h(amount===undefined?'—':formatBaht(amount))+'</div><div class="pos-keypad">'+['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k=>'<button type="button" data-key="'+k+'" '+(locked?'disabled':'')+'>'+k+'</button>').join('')+'</div><button id="quantity-confirm" class="primary" '+(locked||error?'disabled':'')+'>ยืนยัน '+h(state.quantityText)+' กรัม</button><button id="quantity-cancel" class="ghost">ยกเลิก</button></section>';
  } else {
    const rows=items.map(({lot,lot_id,quantity_mg})=>lot?'<article class="pos-order-line"><div><strong>'+h(lot.name)+'</strong><small>Lot '+h(lot.lot_code)+' · '+h(milligramsToGrams(quantity_mg))+' กรัม × '+h(formatBaht(lot.price))+'</small><button data-edit="'+h(lot_id)+'" class="ghost" '+(locked?'disabled':'')+'>แก้ไขจำนวน</button></div><div><strong>'+h(formatBaht(lineTotalSatang(lot.price,quantity_mg)))+'</strong><button class="remove" data-remove="'+h(lot_id)+'" '+(locked?'disabled':'')+' aria-label="ลบสินค้า">×</button></div></article>':'').join('');
    if(screen==='ticket') content='<h1>รายการสั่งซื้อ</h1><div class="pos-order">'+(rows||'<p>ยังไม่ได้เลือกสินค้า</p>')+'</div><label>ส่วนลดทั้งบิล (บาท)<input id="discount" inputmode="decimal" value="'+h(state.discount)+'" '+(locked||!supportsDiscount(state.capabilities)?'disabled':'')+' /></label>'+(!supportsDiscount(state.capabilities)?'<p class="footnote">เซิร์ฟเวอร์ยังไม่ประกาศรองรับส่วนลด ใช้ได้เฉพาะส่วนลด 0 บาท</p>':'')+'<div id="preview">'+ctx.previewHtml(totals)+'</div><button id="ticket-more" class="ghost">เพิ่มสินค้า</button><footer class="pos-bottom"><button id="ticket-pay" class="primary" '+(!items.length||totals.error?'disabled':'')+'>ไปชำระเงิน <strong>'+h(totalLabel)+'</strong></button></footer>';
    else {
      const payment=totals.error?{error:totals.error}:paymentPreview(state,totals.total);
      if(state.store.requires_authorization&&!state.authRef.trim()) payment.error ||= 'ระบุรหัสเอกสารอ้างอิงก่อนยืนยันรายการ';
      content='<h1>ชำระเงิน</h1><div class="pos-pay-total"><span>ยอดชำระสุทธิ</span><strong>'+h(totalLabel)+'</strong></div><div class="pos-payment-methods">'+[['cash','เงินสด'],['transfer','โอนเงิน'],['split','เงินสด + โอน']].map(([value,label])=>'<button type="button" data-payment="'+value+'" class="'+(state.payment===value?'selected':'')+'" '+(locked||(value==='split'&&!supportsSplitPayments(state.capabilities))?'disabled':'')+'>'+label+'</button>').join('')+'</div>'+
        (state.payment==='split'?'<div class="admin-grid"><label>ชำระเงินสด (บาท)<input id="split-cash" inputmode="decimal" value="'+h(state.splitCash||'')+'" '+(locked?'disabled':'')+' /></label><label>ชำระเงินโอน (บาท)<input id="split-transfer" inputmode="decimal" value="'+h(state.splitTransfer||'')+'" '+(locked?'disabled':'')+' /></label></div>':'')+
        (state.payment!=='transfer'?'<label>เงินสดที่รับ (บาท)<input id="cash-received" inputmode="decimal" value="'+h(state.cashReceived||'')+'" '+(locked?'disabled':'')+' /></label><p class="pos-change">เงินทอน <strong id="change">'+h(payment.error?'—':formatBaht(payment.change))+'</strong></p>':'<p class="footnote">ตรวจสอบยอดโอนเข้าร้านก่อนยืนยันรายการ</p>')+
        '<label>รหัสอ้างอิงเอกสาร'+(state.store.requires_authorization?'ที่ได้รับอนุญาต':' (ถ้ามี)')+'<input id="auth-ref" maxlength="120" value="'+h(state.authRef)+'" '+(locked?'disabled':'')+' /></label><div id="preview">'+ctx.previewHtml(totals)+'</div><p id="payment-error" class="danger-text">'+h(payment.error||'')+'</p><p class="footnote">ยอดเป็นประมาณการ ใช้ยอดที่เซิร์ฟเวอร์ยืนยัน และบันทึกเป็นหนึ่งบิลเท่านั้น</p>'+
        (state.pendingId?'<div class="alert danger">มีรายการส่งขายที่ยังไม่ทราบผล '+h(state.pendingId)+' ห้ามสร้างรายการใหม่</div>':'')+
        '<div class="checkout-actions"><button id="checkout" class="primary" '+(locked||!state.store.sales_enabled||!navigator.onLine||!items.length||totals.error||payment.error?'disabled':'')+'>ยืนยันรายการผ่านเซิร์ฟเวอร์</button>'+(state.pendingId&&!state.pendingBlocked?'<button id="verify" class="ghost" '+(state.busy?'disabled':'')+'>' + (supportsSaleReconciliation(state.capabilities)?'ตรวจสอบ / ยกเลิกเฉพาะรายการที่ยังไม่บันทึก':'ตรวจสอบรายการค้าง') + '</button><button id="retry" class="ghost" '+(state.busy?'disabled':'')+'>ส่งรายการเดิมซ้ำด้วย ID เดิม</button>':'')+'</div>';
    }
  }
  root.innerHTML='<div class="pos-shell" data-screen="'+screen+'">'+nav+'<main class="pos-content">'+notices+content+'</main></div>';
  root.querySelector('#open-ticket').onclick=()=>go('ticket');
  root.querySelector('#pos-back').onclick=()=>{if(screen==='catalog'){state.posMenuOpen=!state.posMenuOpen;ctx.render();}else go(screen==='payment'?'ticket':'catalog');};
  root.querySelector('#refresh')?.addEventListener('click',ctx.refresh);
  root.querySelector('#catalog-query')?.addEventListener('input',e=>{state.catalogQuery=e.target.value;ctx.render();const n=root.querySelector('#catalog-query');n.focus();n.setSelectionRange(n.value.length,n.value.length);});
  const quantityView=(id,edit)=>{if(locked)return;state.quantityLot=id;state.quantityEditing=edit;state.quantityReplace=edit;state.quantityText=edit?milligramsToGrams(state.cart.get(id)):'';go('quantity');};
  root.querySelectorAll('[data-add]').forEach(n=>n.onclick=()=>quantityView(n.dataset.add,false));
  root.querySelectorAll('[data-edit]').forEach(n=>n.onclick=()=>quantityView(n.dataset.edit,true));
  root.querySelectorAll('[data-remove]').forEach(n=>n.onclick=()=>{if(!locked){state.cart.delete(n.dataset.remove);ctx.render();}});
  root.querySelector('#catalog-pay')?.addEventListener('click',()=>go('ticket'));
  root.querySelector('#ticket-more')?.addEventListener('click',()=>go('catalog'));
  root.querySelector('#ticket-pay')?.addEventListener('click',()=>go('payment'));
  root.querySelector('#quantity-cancel')?.addEventListener('click',()=>go(state.quantityEditing?'ticket':'catalog'));
  root.querySelector('#quantity-input')?.addEventListener('input',e=>{if(!locked){state.quantityText=e.target.value;state.quantityReplace=false;ctx.render();const n=root.querySelector('#quantity-input');n.focus();n.setSelectionRange(n.value.length,n.value.length);}});
  root.querySelectorAll('[data-key]').forEach(n=>n.onclick=()=>{if(locked)return;const k=n.dataset.key;state.quantityText=k==='⌫'?state.quantityText.slice(0,-1):(state.quantityReplace?'':state.quantityText)+(k==='.'&&(state.quantityReplace||!state.quantityText)?'0.':k);state.quantityReplace=false;ctx.render();});
  root.querySelector('#quantity-confirm')?.addEventListener('click',()=>{
    if(locked)return;try{const lot=state.lots.find(x=>x.id===state.quantityLot),q=gramsToMilligrams(state.quantityText),next=state.quantityEditing?q:q+(state.cart.get(lot.id)||0);if(next>1000000)throw Error('จำนวนรวมต่อ Lot ต้องไม่เกิน 1,000 กรัม');if(next>lot.quantity_mg)throw Error('จำนวนมากกว่าสต็อกที่แสดง');state.cart.set(lot.id,next);go('catalog');}catch(e){ctx.message(e.message,true);}
  });
  root.querySelector('#discount')?.addEventListener('input',e=>{if(!locked){state.discount=e.target.value;ctx.render();const n=root.querySelector('#discount');n.focus();n.setSelectionRange(n.value.length,n.value.length);}});
  const method=value=>{if(!locked&&['cash','transfer','split'].includes(value)&&(value!=='split'||supportsSplitPayments(state.capabilities))){state.payment=value;ctx.render();}};
  root.querySelectorAll('[data-payment]').forEach(n=>n.onclick=()=>method(n.dataset.payment));
  for(const [id,key] of [['cash-received','cashReceived'],['split-cash','splitCash'],['split-transfer','splitTransfer'],['auth-ref','authRef']]) root.querySelector('#'+id)?.addEventListener('input',e=>{if(!locked){state[key]=e.target.value;ctx.render();const n=root.querySelector('#'+id);n.focus();n.setSelectionRange(n.value.length,n.value.length);}});
  root.querySelector('#checkout')?.addEventListener('click',ctx.checkout);
  root.querySelector('#verify')?.addEventListener('click',ctx.verify);
  root.querySelector('#retry')?.addEventListener('click',ctx.retry);
  mountNavigation(ctx);
}
