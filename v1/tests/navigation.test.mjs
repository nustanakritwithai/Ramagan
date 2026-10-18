import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {navigationHeader,mountNavigation,cleanupNavigation} from '../src/navigation.js';
function fixture(changes={}) {
  const dom=new JSDOM('<!doctype html><div id="app"></div>',{url:'https://fixture.invalid/ramagan-v1/'}), doc=dom.window.document,root=doc.querySelector('#app');
  const state={user:{id:'owner',email:'owner@example.test'},store:{id:'store',name:'Fixture shop'},role:'owner',view:'sales',posScreen:'catalog',posMenuOpen:false,
    cart:new Map([['lot',1250]]),checkout:{identity:'frozen'},countDraft:{id:'draft',photos:{lot:{metadata:{evidence_id:'photo'}}}},inventoryPending:{},...changes};
  const calls={render:0,routes:[],logout:0,changeServer:0};
  const ctx={root,state,canManage:()=>['owner','manager'].includes(state.role),adminUrl:'https://admin.example.test/',appVersion:'V1 fixture',
    openView:route=>{calls.routes.push(route);state.view=route;render();},
    logout:()=>{calls.logout++;},changeServer:()=>{calls.changeServer++;},render:()=>render()};
  function render() {
    cleanupNavigation();calls.render++;
    root.innerHTML='<main class="underlying">'+navigationHeader({title:'RAMAGAN',subtitle:'Fixture',cartCount:state.cart.size,showCart:true})+'<button id="background">Background</button></main>';
    mountNavigation(ctx);
  }
  render();
  return {dom,doc,root,state,calls,ctx,render,q:s=>doc.querySelector(s),click(s){this.q(s).click();},
    key(key,shiftKey=false){doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}));},
    open(){this.click('[data-navigation-trigger]');},close(){cleanupNavigation();dom.window.close();}};
}
test('drawer toggles as an accessible modal, traps focus and restores background/focus on Escape',()=>{
  const f=fixture();try{
    f.doc.body.style.overflow='scroll';assert.equal(f.q('#app-navigation-drawer'),null);f.open();
    const shell=f.q('.underlying'), drawer=f.q('#app-navigation-drawer');
    assert.equal(drawer.getAttribute('role'),'dialog');assert.equal(drawer.getAttribute('aria-modal'),'true');
    assert.equal(f.q('[data-navigation-trigger]').getAttribute('aria-expanded'),'true');assert.equal(shell.inert,true);
    assert.equal(shell.getAttribute('aria-hidden'),'true');assert.equal(f.doc.body.style.overflow,'hidden');
    assert.equal(f.doc.activeElement.id,'close-navigation');
    f.q('#nav-logout').focus();f.key('Tab');assert.equal(f.doc.activeElement.id,'close-navigation');
    f.key('Tab',true);assert.equal(f.doc.activeElement.id,'nav-logout');
    f.key('Escape');assert.equal(f.q('#app-navigation-drawer'),null);assert.equal(f.state.posMenuOpen,false);
    assert.equal(shell.inert,undefined);assert.equal(shell.getAttribute('aria-hidden'),null);
    assert.equal(f.doc.body.style.overflow,'scroll');assert.equal(f.doc.activeElement.id,'menu-toggle');
  }finally{f.close();}
});
test('drawer navigation updates only the destination and preserves cart, uncertain sale and evidence identities',()=>{
  const f=fixture({pendingId:'frozen-sale'});try{
    const cart=f.state.cart,checkout=f.state.checkout,draft=f.state.countDraft;
    f.open();f.click('#nav-receipts');assert.equal(f.state.view,'receipts');assert.deepEqual(f.calls.routes,['receipts']);
    assert.equal(f.state.cart,cart);assert.equal(f.state.cart.get('lot'),1250);assert.equal(f.state.checkout,checkout);
    assert.equal(f.state.countDraft,draft);assert.equal(f.state.pendingId,'frozen-sale');assert.equal(f.q('#app-navigation-drawer'),null);
    f.open();assert.equal(f.q('#nav-receipts').getAttribute('aria-current'),'page');f.click('#open-pending-request');
    assert.equal(f.state.view,'sales');assert.equal(f.state.posScreen,'payment');assert.equal(f.state.pendingId,'frozen-sale');
    assert.equal(f.state.cart,cart);assert.equal(f.state.countDraft,draft);
  }finally{f.close();}
});
test('staff retains receipts/products/settings while manager controls and admin links stay absent',()=>{
  for(const role of ['staff','cashier','manager','owner']){
    const f=fixture({role});try{
      f.open();assert(f.q('#nav-receipts'));assert(f.q('#nav-products'));assert(f.q('#nav-settings'));assert(f.q('#nav-apps'));assert(f.q('#nav-support'));
      const manager=['owner','manager'].includes(role);
      assert.equal(Boolean(f.q('#nav-inventory')),manager);assert.equal(Boolean(f.q('#nav-stocktake')),manager);assert.equal(Boolean(f.q('.navigation-admin')),manager);
      if(manager){f.state.role='staff';f.click('#nav-inventory');assert.deepEqual(f.calls.routes,[]);}
    }finally{f.close();}
  }
});
test('pending stocktake returns to the existing count and server/logout invoke existing guarded actions',()=>{
  const operation={payload:{client_stocktake_id:'same-count'}},f=fixture({inventoryPending:{stocktake:operation}});try{
    f.open();f.click('#open-pending-request');assert.equal(f.state.view,'stocktake');assert.equal(f.state.inventoryPending.stocktake,operation);
    f.open();f.click('#nav-change-server');assert.equal(f.calls.changeServer,1);assert.equal(f.q('#app-navigation-drawer'),null);
    f.open();f.click('#nav-logout');assert.equal(f.calls.logout,1);assert.equal(f.q('#app-navigation-drawer'),null);
  }finally{f.close();}
});
test('rerender and explicit cleanup remove modal listeners and restore pre-existing accessibility attributes',()=>{
  const f=fixture();try{
    f.open();f.render();
    assert.equal(f.doc.querySelectorAll('#app-navigation-drawer').length,1);
    const before=f.calls.render;f.key('Escape');assert.equal(f.calls.render,before+1);
    const background=f.q('.underlying');background.setAttribute('aria-hidden','false');background.inert=false;
    f.state.posMenuOpen=true;mountNavigation(f.ctx);cleanupNavigation();assert.equal(f.q('#app-navigation-drawer'),null);
    assert.equal(background.inert,false);assert.equal(background.getAttribute('aria-hidden'),'false');assert.equal(f.doc.body.style.overflow,'');
    const count=f.calls.render;f.key('Escape');assert.equal(f.calls.render,count);
  }finally{f.close();}
});
test('account/version text is escaped and offline status remains visible without disabling read-only navigation',()=>{
  const f=fixture({user:{id:'owner',email:'<img src=x onerror=alert(1)>'}});try{
    Object.defineProperty(f.dom.window.navigator,'onLine',{value:false});f.open();
    assert.equal(f.q('#app-navigation-drawer img'),null);assert.match(f.q('#app-navigation-drawer').textContent,/<img src=x/);
    assert.match(f.q('footer').textContent,/ออฟไลน์/);assert.match(f.q('footer').textContent,/V1 fixture/);
    f.click('#nav-products');assert.equal(f.state.view,'products');
  }finally{f.close();}
});
