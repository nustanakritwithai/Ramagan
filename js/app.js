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

  function lotOptions(selectEl, includeEmpty, onlyPositive) {
    var lots = StockLedger.listLots();
    var html = includeEmpty ? '<option value="">— เลือก Lot —</option>' : '';
    var count = 0;
    for (var i = 0; i < lots.length; i++) {
      var L = lots[i];
      if (onlyPositive && !(Number(L.qty_remaining) > 0)) continue;
      count++;
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
    if (onlyPositive && count === 0) {
      html =
        '<option value="">— ไม่มี Lot ที่ขายได้ (คงเหลือ 0) —</option>';
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
    // Sales cashier: only lots with remaining > 0
    lotOptions($('sale-lot'), true, true);
    lotOptions($('adjust-lot'), true, false);
    lotOptions($('destroy-lot'), true, false);
  }

  function refreshAll() {
    renderLots();
    renderEvents();
    refreshSelects();
    updateSalePreview();
  }

  var BKK_OFFSET = '+07:00';

  /** datetime-local wall clock interpreted as Asia/Bangkok → ISO with +07:00 */
  function datetimeLocalToIso(localVal) {
    if (!localVal) return new Date().toISOString();
    var m = String(localVal).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) {
      var fallback = new Date(localVal);
      if (isNaN(fallback.getTime())) return new Date().toISOString();
      return fallback.toISOString();
    }
    var sec = m[6] || '00';
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + sec + BKK_OFFSET;
  }

  /** Format Date/ISO into datetime-local value using Asia/Bangkok wall time */
  function toDatetimeLocalValue(input) {
    var d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) d = new Date();
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);
    var map = {};
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    return map.year + '-' + map.month + '-' + map.day + 'T' + map.hour + ':' + map.minute;
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


  function updateSalePreview() {
    var remEl = $('sale-remaining');
    var afterEl = $('sale-after');
    var checkEl = $('sale-check');
    var btn = $('btn-sell');
    if (!remEl || !StockLedger) return;
    var lotId = $('sale-lot') && $('sale-lot').value;
    var qty = Number($('sale-qty') && $('sale-qty').value);
    if (!lotId) {
      remEl.textContent = '—';
      afterEl.textContent = '—';
      checkEl.textContent = 'เลือก Lot และจำนวนเพื่อตรวจ';
      checkEl.className = 'cashier-check muted';
      if (btn) btn.disabled = true;
      return;
    }
    var remaining = StockLedger.balanceAt(lotId);
    var lot = null;
    var lotsNow = StockLedger.listLots() || [];
    for (var li = 0; li < lotsNow.length; li++) {
      if (lotsNow[li].lot_id === lotId) {
        lot = lotsNow[li];
        break;
      }
    }
    var unit = lot && lot.unit ? lot.unit : '';
    remEl.textContent = remaining + (unit ? ' ' + unit : '');
    if (!(qty > 0)) {
      afterEl.textContent = '—';
      checkEl.textContent = 'ใส่จำนวนที่จะขาย';
      checkEl.className = 'cashier-check muted';
      if (btn) btn.disabled = true;
      return;
    }
    var check = StockLedger.validateSale(lotId, qty);
    afterEl.textContent = check.ok
      ? (check.remaining - qty) + (unit ? ' ' + unit : '')
      : '—';
    checkEl.textContent = check.message;
    checkEl.className = 'cashier-check ' + (check.ok ? 'ok' : 'bad');
    if (btn) btn.disabled = !check.ok;
  }

  function onSale(ev) {
    ev.preventDefault();
    var msg = $('sale-msg');
    try {
      var lotId = $('sale-lot').value;
      var qty = Number($('sale-qty').value);
      var actor = $('sale-actor').value.trim() || 'cashier';
      var reason = $('sale-reason').value.trim() || 'ขายหน้าร้าน';

      if (!lotId) {
        showMsg(msg, 'กรุณาเลือก Lot ที่จะขาย / please pick a lot', true);
        return;
      }
      if (!actor) {
        showMsg(msg, 'ต้องระบุผู้ทำรายการ (actor_user_id)', true);
        return;
      }

      var check = StockLedger.validateSale(lotId, qty);
      if (!check.ok) {
        // Clear Thai oversell / qty error from validateSale
        showMsg(msg, check.message, true);
        return;
      }

      var remainingAfter = Math.round((check.remaining - qty) * 1000) / 1000;
      StockLedger.appendEvent({
        lot_id: lotId,
        type: 'SALE',
        qty: qty,
        actor_user_id: actor,
        reason: reason
      });
      showMsg(
        msg,
        'ขายสำเร็จ · Lot ' +
          lotId +
          ' · ขาย ' +
          qty +
          ' (คงเหลือก่อน ' +
          check.remaining +
          ' → หลัง ' +
          remainingAfter +
          ')',
        false
      );
      $('form-sale').reset();
      $('sale-actor').value = actor;
      refreshAll();
      onAsOf(); // keep as-of audit view in sync
    } catch (err) {
      var raw = String(err.message || err);
      if (/Insufficient stock|oversell/i.test(raw)) {
        showMsg(
          msg,
          'ขายเกินคงเหลือ / ไม่สามารถขายได้: ' + raw,
          true
        );
      } else {
        showMsg(msg, raw, true);
      }
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
        'ยอด Asia/Bangkok: ' + localVal.replace('T', ' ') + ' · stored ' + iso,
        false
      );
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
    }
  }


  function onExportJson() {
    try {
      var state = StockStore.load();
      var payload = {
        version: state.version || 1,
        exported_at: new Date().toISOString(),
        timezone_note: 'UI as-of uses Asia/Bangkok wall time; event occurred_at is ISO-8601',
        lots: state.lots || [],
        events: state.events || []
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      var stamp = toDatetimeLocalValue(new Date()).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(blob);
      a.download = 'cannabis-pos-v0-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 0);
      showMsg($('asof-msg'), 'ส่งออก JSON แล้ว — อัปขึ้น Google Drive ด้วยมือได้', false);
    } catch (err) {
      alert(String(err.message || err));
    }
  }

  function onImportJsonPick() {
    var input = $('import-file');
    if (input) input.click();
  }

  function onImportJsonFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(String(reader.result || ''));
        if (!data || typeof data !== 'object') throw new Error('ไฟล์ไม่ใช่ object JSON');
        if (!Array.isArray(data.lots) || !Array.isArray(data.events)) {
          throw new Error('ต้องมี lots[] และ events[]');
        }
        if (!confirm('นำเข้า JSON จะทับ localStorage ปัจจุบัน\nlots=' + data.lots.length + ' events=' + data.events.length + '\nดำเนินการ?')) {
          return;
        }
        StockStore.save({ version: data.version || 1, lots: data.lots, events: data.events });
        refreshAll();
        onAsOf();
        showMsg($('asof-msg'), 'นำเข้า JSON สำเร็จ', false);
      } catch (err) {
        alert('นำเข้าไม่สำเร็จ: ' + String(err.message || err));
      }
    };
    reader.readAsText(file);
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
    $('sale-lot').addEventListener('change', updateSalePreview);
    $('sale-qty').addEventListener('input', updateSalePreview);
    updateSalePreview();
    $('form-adjust').addEventListener('submit', onAdjust);
    $('form-destroy').addEventListener('submit', onDestroy);
    $('form-asof').addEventListener('submit', onAsOf);
    $('btn-reset').addEventListener('click', onResetSeed);
    $('btn-export').addEventListener('click', onExportJson);
    $('btn-import').addEventListener('click', onImportJsonPick);
    $('import-file').addEventListener('change', onImportJsonFile);

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
