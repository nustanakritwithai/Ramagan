/**
 * UI for cannabis stock ledger V0.
 * Depends on StockStore + StockLedger. No modules — file:// safe.
 */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function fmtQty(n, unit) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    var s = v % 1 === 0 ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
    return unit ? s + ' ' + unit : s;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    } catch (e) {
      return iso;
    }
  }

  function showMsg(el, text, isError) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'msg' + (isError ? ' msg-error' : text ? ' msg-ok' : '');
  }

  function lotOptions(selectEl, includeEmpty) {
    var lots = StockLedger.listLots();
    var html = includeEmpty ? '<option value="">— เลือก Lot —</option>' : '';
    for (var i = 0; i < lots.length; i++) {
      var L = lots[i];
      html +=
        '<option value="' +
        escapeAttr(L.lot_id) +
        '">' +
        escapeHtml(L.lot_id) +
        ' · ' +
        escapeHtml(L.product_name) +
        ' (' +
        fmtQty(L.qty_remaining, L.unit) +
        ')</option>';
    }
    selectEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function renderLots() {
    var tbody = $('lots-body');
    var lots = StockLedger.listLots();
    if (!lots.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="muted">ยังไม่มี Lot — รับเข้าสต็อกด้านล่าง</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < lots.length; i++) {
      var L = lots[i];
      var low = L.qty_remaining <= 0;
      html +=
        '<tr class="' +
        (low ? 'row-warn' : '') +
        '">' +
        '<td><code>' +
        escapeHtml(L.lot_id) +
        '</code></td>' +
        '<td>' +
        escapeHtml(L.sku) +
        '</td>' +
        '<td>' +
        escapeHtml(L.product_name) +
        '</td>' +
        '<td class="num">' +
        fmtQty(L.qty_remaining, L.unit) +
        '</td>' +
        '<td>' +
        escapeHtml(L.unit) +
        '</td>' +
        '<td>' +
        escapeHtml(L.expires_at || '—') +
        '</td>' +
        '<td>' +
        fmtTime(L.received_at) +
        '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  function renderEvents() {
    var tbody = $('events-body');
    var events = StockLedger.listEvents().slice().reverse();
    if (!events.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="muted">ยังไม่มีเหตุการณ์</td></tr>';
      return;
    }
    var html = '';
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var deltaClass = e.qty_delta >= 0 ? 'delta-pos' : 'delta-neg';
      html +=
        '<tr>' +
        '<td><code>' +
        escapeHtml(e.event_id) +
        '</code></td>' +
        '<td>' +
        fmtTime(e.occurred_at) +
        '</td>' +
        '<td><span class="badge badge-' +
        escapeAttr(e.type) +
        '">' +
        escapeHtml(e.type) +
        '</span></td>' +
        '<td><code>' +
        escapeHtml(e.lot_id) +
        '</code></td>' +
        '<td class="num ' +
        deltaClass +
        '">' +
        (e.qty_delta > 0 ? '+' : '') +
        fmtQty(e.qty_delta) +
        '</td>' +
        '<td>' +
        escapeHtml(e.actor_user_id) +
        '</td>' +
        '<td>' +
        escapeHtml(e.reason) +
        '</td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
  }

  function refreshSelects() {
    lotOptions($('sale-lot'), true);
    lotOptions($('adjust-lot'), true);
    lotOptions($('destroy-lot'), true);
  }

  function refreshAll() {
    renderLots();
    renderEvents();
    refreshSelects();
  }

  function datetimeLocalToIso(localVal) {
    if (!localVal) return new Date().toISOString();
    // datetime-local is wall time without TZ; treat as Bangkok local for demo
    var d = new Date(localVal);
    if (isNaN(d.getTime())) return new Date().toISOString();
    return d.toISOString();
  }

  function toDatetimeLocalValue(d) {
    var pad = function (n) {
      return n < 10 ? '0' + n : '' + n;
    };
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      'T' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  /* —— forms —— */

  function onReceive(ev) {
    ev.preventDefault();
    var msg = $('receive-msg');
    try {
      var sku = $('recv-sku').value.trim();
      var name = $('recv-name').value.trim();
      var unit = $('recv-unit').value;
      var qty = Number($('recv-qty').value);
      var expires = $('recv-expires').value || null;
      var actor = $('recv-actor').value.trim();
      var reason = $('recv-reason').value.trim();
      var useExisting = $('recv-existing-lot').value.trim();

      var lotId;
      if (useExisting) {
        lotId = useExisting;
        if (!StockLedger.getLot(lotId)) {
          throw new Error('ไม่พบ Lot: ' + lotId);
        }
      } else {
        var lot = StockLedger.createLot({
          sku: sku,
          product_name: name,
          unit: unit,
          expires_at: expires,
          received_at: new Date().toISOString()
        });
        lotId = lot.lot_id;
      }

      StockLedger.appendEvent({
        lot_id: lotId,
        type: 'RECEIVE',
        qty: qty,
        actor_user_id: actor,
        reason: reason || 'รับเข้าสต็อก'
      });

      showMsg(msg, 'รับเข้าสำเร็จ · Lot ' + lotId, false);
      $('form-receive').reset();
      $('recv-actor').value = actor;
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }

  function onSale(ev) {
    ev.preventDefault();
    var msg = $('sale-msg');
    try {
      var lotId = $('sale-lot').value;
      var qty = Number($('sale-qty').value);
      var actor = $('sale-actor').value.trim();
      var reason = $('sale-reason').value.trim() || 'ขายหน้าร้าน';

      var check = StockLedger.validateSale(lotId, qty);
      if (!check.ok) {
        showMsg(msg, check.message, true);
        return;
      }

      StockLedger.appendEvent({
        lot_id: lotId,
        type: 'SALE',
        qty: qty,
        actor_user_id: actor,
        reason: reason
      });
      showMsg(msg, 'บันทึกการขายแล้ว (เหลือ ' + check.remaining + ' − ' + qty + ')', false);
      $('form-sale').reset();
      $('sale-actor').value = actor;
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }

  function onAdjust(ev) {
    ev.preventDefault();
    var msg = $('adjust-msg');
    try {
      var lotId = $('adjust-lot').value;
      var qty = Number($('adjust-qty').value);
      var sign = Number($('adjust-sign').value);
      var actor = $('adjust-actor').value.trim();
      var reason = $('adjust-reason').value.trim();

      StockLedger.appendEvent({
        lot_id: lotId,
        type: 'ADJUST',
        qty: qty,
        actor_user_id: actor,
        reason: reason || 'ปรับยอดสต็อก',
        meta: { adjust_sign: sign }
      });
      showMsg(msg, 'ปรับยอดแล้ว (' + (sign > 0 ? '+' : '-') + qty + ')', false);
      $('form-adjust').reset();
      $('adjust-actor').value = actor;
      $('adjust-sign').value = String(sign);
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }

  function onDestroy(ev) {
    ev.preventDefault();
    var msg = $('destroy-msg');
    try {
      var lotId = $('destroy-lot').value;
      var qty = Number($('destroy-qty').value);
      var actor = $('destroy-actor').value.trim();
      var reason = $('destroy-reason').value.trim();

      StockLedger.appendEvent({
        lot_id: lotId,
        type: 'DESTROY',
        qty: qty,
        actor_user_id: actor,
        reason: reason || 'ทำลายสินค้า'
      });
      showMsg(msg, 'บันทึกการทำลายแล้ว', false);
      $('form-destroy').reset();
      $('destroy-actor').value = actor;
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }

  function onAsOf(ev) {
    if (ev) ev.preventDefault();
    var msg = $('asof-msg');
    var tbody = $('asof-body');
    try {
      var localVal = $('asof-time').value;
      var iso = datetimeLocalToIso(localVal);
      var balances = StockLedger.balanceAllAt(iso);
      var lots = StockLedger.listLots();
      var html = '';
      var any = false;
      for (var i = 0; i < lots.length; i++) {
        var L = lots[i];
        var q = balances[L.lot_id];
        if (q === undefined) q = 0;
        any = true;
        html +=
          '<tr>' +
          '<td><code>' +
          escapeHtml(L.lot_id) +
          '</code></td>' +
          '<td>' +
          escapeHtml(L.product_name) +
          '</td>' +
          '<td class="num">' +
          fmtQty(q, L.unit) +
          '</td>' +
          '<td class="num muted">' +
          fmtQty(L.qty_remaining, L.unit) +
          '</td>' +
          '</tr>';
      }
      tbody.innerHTML = any
        ? html
        : '<tr><td colspan="4" class="muted">ไม่มี Lot</td></tr>';
      showMsg(
        msg,
        'ยอด ณ เวลา (Bangkok view): ' + fmtTime(iso) + ' · ISO ' + iso,
        false
      );
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }

  function onResetSeed() {
    if (
      !confirm(
        'ล้างข้อมูล localStorage แล้วใส่ seed ใหม่?\nClear all data and re-seed?'
      )
    ) {
      return;
    }
    StockStore.clear();
    StockLedger.seedIfEmpty();
    refreshAll();
    onAsOf();
    showMsg($('receive-msg'), 'รีเซ็ตและ seed แล้ว', false);
  }

  function bindTabs() {
    var tabs = document.querySelectorAll('[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (e) {
        var id = e.currentTarget.getAttribute('data-tab');
        var panels = document.querySelectorAll('.panel');
        for (var j = 0; j < panels.length; j++) {
          panels[j].classList.remove('active');
        }
        var btns = document.querySelectorAll('[data-tab]');
        for (var k = 0; k < btns.length; k++) {
          btns[k].classList.remove('active');
        }
        e.currentTarget.classList.add('active');
        var panel = document.getElementById('panel-' + id);
        if (panel) panel.classList.add('active');
      });
    }
  }

  function init() {
    StockLedger.seedIfEmpty();
    bindTabs();

    $('form-receive').addEventListener('submit', onReceive);
    $('form-sale').addEventListener('submit', onSale);
    $('form-adjust').addEventListener('submit', onAdjust);
    $('form-destroy').addEventListener('submit', onDestroy);
    $('form-asof').addEventListener('submit', onAsOf);
    $('btn-reset').addEventListener('click', onResetSeed);

    // Default as-of: mid demo timeline so historical qty differs from now
    var demo = new Date('2026-09-13T12:00:00+07:00');
    $('asof-time').value = toDatetimeLocalValue(demo);

    refreshAll();
    onAsOf();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
