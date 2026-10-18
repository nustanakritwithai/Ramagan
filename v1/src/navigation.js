// View navigation only. Business intents, carts and evidence drafts are never reset.
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DRAWER = 'app-navigation-drawer';
const ROUTES = new Set(['sales','receipts','products','settings','apps','support','inventory','stocktake']);
let activeCleanup = null;
export function cleanupNavigation() {
  const cleanup=activeCleanup; activeCleanup=null; cleanup?.();
}
export function navigationHeader({title='RAMAGAN',subtitle='',cartCount=0,showCart=false,triggerId='menu-toggle'}={}) {
  return '<header class="navigation-header"><button id="'+h(triggerId)+'" class="navigation-trigger" type="button" data-navigation-trigger aria-label="เปิดเมนูร้าน" aria-controls="'+DRAWER+'" aria-expanded="false">☰</button><div><strong>'+h(title)+'</strong>'+
    (subtitle?'<small>'+h(subtitle)+'</small>':'')+'</div>'+(showCart?'<button type="button" id="open-ticket" class="navigation-ticket">รายการ <b>'+h(cartCount)+'</b></button>':'')+'</header>';
}
export function mountNavigation(ctx) {
  cleanupNavigation();
  const {root,state}=ctx, doc=root.ownerDocument, win=doc.defaultView;
  for(const trigger of root.querySelectorAll('[data-navigation-trigger]')) {
    trigger.setAttribute('aria-controls',DRAWER);
    trigger.setAttribute('aria-expanded',String(Boolean(state.posMenuOpen)));
    if(trigger.dataset.navigationHandled!=='true') trigger.onclick=()=>{state.posMenuOpen=!state.posMenuOpen;ctx.render();};
  }
  if(!state.user||!state.store||!state.posMenuOpen)return;
  const manager=ctx.canManage(), settings=ctx.canSettings?ctx.canSettings():state.role==='owner',
    dashboard=ctx.canDashboard?ctx.canDashboard():state.role==='owner', view=state.view||'sales';
  const links=[['sales','หน้าขาย','▦'],['receipts','ใบเสร็จ','▤'],['products','สินค้า','□'],
    ...(manager?[['inventory','รับสินค้าเข้า','↓'],['stocktake','นับสต็อก','✓']]:[]),
    ...(settings?[['settings','การตั้งค่า','⚙']]:[]),['apps','แอปพลิเคชัน','⊞'],['support','ช่วยเหลือ','?']];
  const salePending=Boolean(state.pendingId||state.pendingBlocked);
  const stockPending=Boolean(state.inventoryBlocked||Object.values(state.inventoryPending||{}).some(Boolean));
  const pending=salePending||stockPending;
  const backdrop=doc.createElement('div');backdrop.className='navigation-backdrop';backdrop.id='navigation-backdrop';
  const drawer=doc.createElement('aside');drawer.className='navigation-drawer';drawer.id=DRAWER;
  drawer.setAttribute('role','dialog');drawer.setAttribute('aria-modal','true');drawer.setAttribute('aria-labelledby','navigation-title');drawer.tabIndex=-1;
  drawer.innerHTML='<div class="navigation-account"><div class="navigation-account-title"><strong id="navigation-title">RAMAGAN</strong><button type="button" id="close-navigation" aria-label="ปิดเมนู">×</button></div><p>'+h(state.user.display_name||state.user.email||state.user.id)+'</p><strong>'+h(state.store.name)+'</strong><small>'+h(state.role)+'</small></div>'+
    (pending?'<div class="navigation-pending"><p>'+h(salePending?'มีรายการขายที่ต้องตรวจสอบ':'มีรายการสต็อกที่ต้องตรวจสอบ')+'</p><button type="button" id="open-pending-request">กลับไปตรวจสอบรายการค้าง</button></div>':'')+
    '<nav aria-label="หน้าต่าง ๆ ของร้าน">'+links.map(([route,label,icon])=>'<button type="button" id="nav-'+route+'" data-navigation-view="'+route+'" '+(view===route?'aria-current="page"':'')+'><span aria-hidden="true">'+icon+'</span>'+label+'</button>').join('')+
    (dashboard&&ctx.adminUrl?'<a class="navigation-admin" href="'+h(ctx.adminUrl)+'" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">↗</span>รายงานหลังบ้าน</a>':'')+'</nav>'+
    '<div class="navigation-tools">'+(ctx.canLockDevice?.()?'<button type="button" id="nav-lock-device">ล็อก / เปลี่ยนผู้ใช้งาน</button>':'')+
    (settings?'<button type="button" id="nav-change-server">เปลี่ยนเซิร์ฟเวอร์</button>':'')+'<button type="button" id="nav-logout">ออกจากระบบ</button></div>'+
    '<footer><span class="navigation-connection">'+(win.navigator.onLine?'● ออนไลน์':'● ออฟไลน์ · ยืนยันรายการไม่ได้')+'</span><small>'+h(ctx.appVersion||'Ramagan V1')+'</small></footer>';
  const background=[...root.children].map(element=>({element,inert:element.inert,aria:element.getAttribute('aria-hidden')}));
  const oldOverflow=doc.body.style.overflow;
  for(const item of background){item.element.inert=true;item.element.setAttribute('aria-hidden','true');}
  doc.body.style.overflow='hidden';root.append(backdrop,drawer);
  const restoreFocus=()=>root.querySelector('[data-navigation-trigger]')?.focus();
  const close=()=>{state.posMenuOpen=false;cleanupNavigation();ctx.render();restoreFocus();};
  const navigate=route=>{
    if(!ROUTES.has(route)||(!ctx.canManage()&&['inventory','stocktake'].includes(route)))return;
    if(route==='settings'&&!(ctx.canSettings?ctx.canSettings():state.role==='owner'))return;
    state.posMenuOpen=false;cleanupNavigation();ctx.openView(route);
  };
  const keydown=event=>{
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab')return;
    const items=[...drawer.querySelectorAll('button:not(:disabled),a[href]')];
    const first=items[0],last=items.at(-1);
    if(!drawer.contains(doc.activeElement)){event.preventDefault();first?.focus();}
    else if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus();}
  };
  activeCleanup=()=>{
    doc.removeEventListener('keydown',keydown);backdrop.remove();drawer.remove();doc.body.style.overflow=oldOverflow;
    for(const item of background){item.element.inert=item.inert;if(item.aria===null)item.element.removeAttribute('aria-hidden');else item.element.setAttribute('aria-hidden',item.aria);}
  };
  doc.addEventListener('keydown',keydown);backdrop.onclick=close;drawer.querySelector('#close-navigation').onclick=close;
  drawer.querySelectorAll('[data-navigation-view]').forEach(button=>{button.onclick=()=>navigate(button.dataset.navigationView);});
  drawer.querySelector('#open-pending-request')?.addEventListener('click',()=>{
    if(salePending){state.posScreen='payment';navigate('sales');}
    else navigate(manager?(state.inventoryPending?.stocktake?'stocktake':'inventory'):'sales');
  });
  for(const [selector,action] of [['#nav-logout',ctx.logout],['#nav-change-server',ctx.changeServer],['#nav-lock-device',ctx.lockDevice]]){
    const button=drawer.querySelector(selector);if(button&&action)button.onclick=()=>{
      if(selector==='#nav-change-server'&&!(ctx.canSettings?ctx.canSettings():state.role==='owner'))return;
      state.posMenuOpen=false;cleanupNavigation();action();
    };
  }
  drawer.querySelector('a.navigation-admin')?.addEventListener('click',event=>{
    if(!(ctx.canDashboard?ctx.canDashboard():state.role==='owner')){event.preventDefault();return;}
    win.setTimeout(()=>{if(drawer.isConnected)close();},0);
  });
  drawer.querySelector('#close-navigation').focus();
}
