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
    if ($('adjust-lot')) lotOptions($('adjust-lot'), true, false);
    if ($('destroy-lot')) lotOptions($('destroy-lot'), true, false);
  }

  function refreshAll() {
    renderLots();
    renderEvents();
    refreshSelects();
    renderPosGrid();
    renderPosCart();
    renderShiftCount();
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



  /* —— Loyverse-style POS cart (hides lot from cashier) —— */
  var posCart = []; // { lot_id, product_name, unit, unit_price, qty }
  var posPayment = 'cash'; // cash | transfer

  var PROMO_BUY = 5;
  var PROMO_FREE = 2;
  var PROMO_CODE = '5+2';

  /** qty in cart = grams paid; stock out = paid + free from 5+2 */
  function promoStockQty(qtyPaid) {
    var paid = Number(qtyPaid) || 0;
    if (!(paid > 0)) return 0;
    var sets = Math.floor(paid / PROMO_BUY);
    return Math.round((paid + sets * PROMO_FREE) * 1000) / 1000;
  }

  function promoPaidQty(qtyPaid) {
    return Math.round((Number(qtyPaid) || 0) * 1000) / 1000;
  }


  function fmtBaht(n) {
    var v = Number(n) || 0;
    return '฿' + v.toLocaleString('th-TH', { maximumFractionDigits: 2 });
  }

  function posLineTotal(line) {
    var price = Number(line.unit_price);
    if (!isFinite(price)) price = 0;
    return price * Number(line.qty);
  }

  function posCartTotal() {
    var sum = 0;
    for (var i = 0; i < posCart.length; i++) sum += posLineTotal(posCart[i]);
    return sum;
  }

  function findCartLine(lotId) {
    for (var i = 0; i < posCart.length; i++) {
      if (posCart[i].lot_id === lotId) return posCart[i];
    }
    return null;
  }

  var posCategoryFilter = 'all';

  function categoryLabel(id) {
    var cats = (StockLedger.CATEGORIES || []);
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].id === id) return cats[i].name;
    }
    return id || 'อื่นๆ';
  }

  function renderPosCatChips() {
    var box = $('pos-cat-chips');
    if (!box) return;
    var cats = StockLedger.CATEGORIES || [];
    var html =
      '<button type="button" class="pos-cat-chip' +
      (posCategoryFilter === 'all' ? ' active' : '') +
      '" data-cat="all">ทั้งหมด</button>';
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      var priceHint =
        c.unit_price != null
          ? ' · ฿' + c.unit_price
          : c.id === 'mini'
            ? ' · ฿40/50'
            : '';
      html +=
        '<button type="button" class="pos-cat-chip' +
        (posCategoryFilter === c.id ? ' active' : '') +
        '" data-cat="' +
        escapeHtml(c.id) +
        '">' +
        escapeHtml(c.name) +
        priceHint +
        '</button>';
    }
    box.innerHTML = html;
  }

  function renderPosGrid() {
    var grid = $('pos-product-grid');
    if (!grid) return;
    renderPosCatChips();
    var lots = StockLedger.listLots() || [];
    var cats = StockLedger.CATEGORIES || [];
    var order = cats.map(function (c) { return c.id; });
    var grouped = {};
    var any = false;
    for (var i = 0; i < lots.length; i++) {
      var lot = lots[i];
      var rem = StockLedger.balanceAt(lot.lot_id);
      if (!(rem > 0)) continue;
      var cid = lot.category_id || 'other';
      if (posCategoryFilter !== 'all' && cid !== posCategoryFilter) continue;
      any = true;
      if (!grouped[cid]) grouped[cid] = [];
      grouped[cid].push({ lot: lot, rem: rem });
    }
    if (!any) {
      grid.innerHTML = '<p class="muted">ไม่มีสินค้าคงเหลือในหมวดนี้</p>';
      return;
    }
    var keys = order.filter(function (id) { return grouped[id]; });
    Object.keys(grouped).forEach(function (id) {
      if (keys.indexOf(id) === -1) keys.push(id);
    });
    var html = '';
    for (var k = 0; k < keys.length; k++) {
      var id = keys[k];
      if (posCategoryFilter === 'all') {
        html +=
          '<div class="pos-cat-section">' +
          escapeHtml(categoryLabel(id)) +
          '</div>';
      }
      var items = grouped[id];
      for (var j = 0; j < items.length; j++) {
        var lot = items[j].lot;
        var rem = items[j].rem;
        var price = lot.unit_price != null ? Number(lot.unit_price) : 0;
        html +=
          '<button type="button" class="pos-tile" data-lot-id="' +
          escapeHtml(lot.lot_id) +
          '">' +
          '<span class="pos-tile-name">' +
          escapeHtml(lot.product_name) +
          '</span>' +
          '<span class="pos-tile-price">' +
          fmtBaht(price) +
          '/g</span>' +
          '<span class="pos-tile-promo">โปร ' +
          PROMO_CODE +
          ' · จ่าย5g ได้7g</span>' +
          '<span class="pos-tile-stock">คงเหลือ ' +
          fmtQty(rem, lot.unit || 'g') +
          '</span>' +
          '</button>';
      }
    }
    grid.innerHTML = html;
  }

  function renderPosCart() {
    var box = $('pos-cart-lines');
    var totalEl = $('pos-cart-total');
    var btn = $('btn-pos-checkout');
    if (!box) return;
    if (!posCart.length) {
      box.innerHTML =
        '<p class="muted pos-cart-empty">ยังไม่มีสินค้า — กดกล่องด้านซ้าย</p>';
      if (totalEl) totalEl.textContent = fmtBaht(0);
      if (btn) btn.disabled = true;
      return;
    }
    var html = '';
    for (var i = 0; i < posCart.length; i++) {
      var line = posCart[i];
      html +=
        '<div class="pos-line" data-lot-id="' +
        escapeHtml(line.lot_id) +
        '">' +
        '<div class="pos-line-name">' +
        escapeHtml(line.product_name) +
        '</div>' +
        '<div class="pos-line-meta">' +
        fmtBaht(line.unit_price || 0) +
        '/g · จ่าย ' +
        line.qty +
        'g · ได้ ' +
        promoStockQty(line.qty) +
        'g (โปร ' +
        PROMO_CODE +
        ') · รวม ' +
        fmtBaht(posLineTotal(line)) +
        '</div>' +
        '<div class="pos-line-qty">' +
        '<button type="button" data-act="dec" aria-label="ลด">−</button>' +
        '<input type="number" min="0.001" step="any" value="' +
        line.qty +
        '" data-act="qty" />' +
        '<button type="button" data-act="inc" aria-label="เพิ่ม">+</button>' +
        '</div>' +
        '<button type="button" class="pos-line-remove" data-act="rm">ลบ</button>' +
        '</div>';
    }
    box.innerHTML = html;
    if (totalEl) totalEl.textContent = fmtBaht(posCartTotal());
    if (btn) btn.disabled = false;
  }

  function addToPosCart(lotId) {
    var lot = StockLedger.getLot(lotId);
    if (!lot) return;
    var rem = StockLedger.balanceAt(lotId);
    if (!(rem > 0)) {
      showMsg($('sale-msg'), 'สินค้านี้หมดแล้ว', true);
      return;
    }
    var line = findCartLine(lotId);
    var nextPaid = line ? line.qty + PROMO_BUY : PROMO_BUY;
    var needStock = promoStockQty(nextPaid);
    if (needStock > rem) {
      showMsg(
        $('sale-msg'),
        'โปร ' +
          PROMO_CODE +
          ' ต้องตัดสต็อก ' +
          needStock +
          'g (คงเหลือ ' +
          rem +
          'g)',
        true
      );
      return;
    }
    if (line) {
      line.qty = Math.round(nextPaid * 1000) / 1000;
    } else {
      posCart.push({
        lot_id: lot.lot_id,
        product_name: lot.product_name,
        unit: lot.unit || 'g',
        unit_price: lot.unit_price != null ? Number(lot.unit_price) : 0,
        qty: PROMO_BUY // paid grams
      });
    }
    showMsg($('sale-msg'), '', false);
    renderPosCart();
  }

  function setCartQty(lotId, qty) {
    var rem = StockLedger.balanceAt(lotId);
    var q = Number(qty);
    var line = findCartLine(lotId);
    if (!line) return;
    if (!(q > 0) || !isFinite(q)) {
      posCart = posCart.filter(function (L) {
        return L.lot_id !== lotId;
      });
    } else {
      var need = promoStockQty(q);
      if (need > rem) {
        // max paid such that stock fits
        var maxPaid = rem;
        while (promoStockQty(maxPaid) > rem && maxPaid > 0) {
          maxPaid = Math.round((maxPaid - 0.001) * 1000) / 1000;
        }
        // snap down to whole grams if possible
        maxPaid = Math.floor(rem);
        while (promoStockQty(maxPaid) > rem && maxPaid > 0) maxPaid--;
        q = maxPaid;
        showMsg(
          $('sale-msg'),
          'โปร ' + PROMO_CODE + ' ตัดสต็อกเกินคงเหลือ — ปรับเหลือจ่าย ' + q + 'g',
          true
        );
      }
      line.qty = Math.round(q * 1000) / 1000;
    }
    renderPosCart();
  }

  function onPosCheckout() {
    var msg = $('sale-msg');
    if (!posCart.length) {
      showMsg(msg, 'ตะกร้าว่าง', true);
      return;
    }
    var payment = posPayment === 'transfer' ? 'transfer' : 'cash';
    var actor = 'cashier';
    // Validate stock qty (with promo free grams), not paid qty
    for (var i = 0; i < posCart.length; i++) {
      var line = posCart[i];
      var qtyPaid = promoPaidQty(line.qty);
      var qtyStock = promoStockQty(qtyPaid);
      var check = StockLedger.validateSale(line.lot_id, qtyStock);
      if (!check.ok) {
        showMsg(
          msg,
          (line.product_name || line.lot_id) +
            ': โปร ' +
            PROMO_CODE +
            ' ต้องตัด ' +
            qtyStock +
            'g — ' +
            check.message,
          true
        );
        return;
      }
    }
    try {
      var sold = 0;
      for (var j = 0; j < posCart.length; j++) {
        var L = posCart[j];
        var qtyPaid = promoPaidQty(L.qty);
        var qtyStock = promoStockQty(qtyPaid);
        var lineTotal = posLineTotal(L); // paid * price
        StockLedger.appendEvent({
          lot_id: L.lot_id,
          type: 'SALE',
          qty: qtyStock,
          actor_user_id: actor,
          reason: 'ขายหน้าร้าน · โปร ' + PROMO_CODE,
          meta: {
            payment: payment,
            promo: PROMO_CODE,
            qty_paid: qtyPaid,
            qty_stock: qtyStock,
            unit_price: L.unit_price || 0,
            line_total: lineTotal,
            product_name: L.product_name,
            unit: 'g'
          }
        });
        sold++;
      }
      var payLabel = payment === 'transfer' ? 'โอน' : 'เงินสด';
      showMsg(
        msg,
        'ขายสำเร็จ ' +
          sold +
          ' รายการ · รวม ' +
          fmtBaht(posCartTotal()) +
          ' · ' +
          payLabel +
          ' · โปร ' +
          PROMO_CODE,
        false
      );
      posCart = [];
      renderPosCart();
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
      refreshAll();
    }
  }

  function bindPosUi() {
    var chips = $('pos-cat-chips');
    if (chips) {
      chips.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-cat]');
        if (!btn) return;
        posCategoryFilter = btn.getAttribute('data-cat') || 'all';
        renderPosGrid();
      });
    }
    var grid = $('pos-product-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-lot-id].pos-tile');
        if (!btn || btn.disabled) return;
        addToPosCart(btn.getAttribute('data-lot-id'));
      });
    }
    var lines = $('pos-cart-lines');
    if (lines) {
      lines.addEventListener('click', function (e) {
        var row = e.target.closest('.pos-line');
        if (!row) return;
        var lotId = row.getAttribute('data-lot-id');
        var act = e.target.getAttribute('data-act');
        var line = findCartLine(lotId);
        if (!line) return;
        if (act === 'inc') setCartQty(lotId, line.qty + 1);
        else if (act === 'dec') setCartQty(lotId, line.qty - 1);
        else if (act === 'rm') setCartQty(lotId, 0);
      });
      lines.addEventListener('change', function (e) {
        if (e.target.getAttribute('data-act') !== 'qty') return;
        var row = e.target.closest('.pos-line');
        if (!row) return;
        setCartQty(row.getAttribute('data-lot-id'), e.target.value);
      });
    }
    var payCash = $('pay-cash');
    var payTransfer = $('pay-transfer');
    function setPay(p) {
      posPayment = p;
      if (payCash) payCash.classList.toggle('active', p === 'cash');
      if (payTransfer) payTransfer.classList.toggle('active', p === 'transfer');
    }
    if (payCash) payCash.addEventListener('click', function () { setPay('cash'); });
    if (payTransfer) payTransfer.addEventListener('click', function () { setPay('transfer'); });
    var checkout = $('btn-pos-checkout');
    if (checkout) checkout.addEventListener('click', onPosCheckout);
  }

  /* —— Before-shift physical count → ADJUST on confirm —— */
  function renderShiftCount() {
    var box = $('shift-rows');
    if (!box) return;
    var lots = StockLedger.listLots() || [];
    if (!lots.length) {
      box.innerHTML = '<p class="muted">ยังไม่มี Lot — รับเข้าก่อน</p>';
      var btn0 = $('btn-shift-confirm');
      if (btn0) btn0.disabled = true;
      return;
    }
    var html = '';
    for (var i = 0; i < lots.length; i++) {
      var lot = lots[i];
      var sys = StockLedger.balanceAt(lot.lot_id);
      var unit = lot.unit || '';
      var name = lot.product_name || lot.lot_id;
      var sku = lot.sku || '';
      html +=
        '<div class="shift-row" data-lot-id="' +
        escapeHtml(lot.lot_id) +
        '">' +
        '<div class="shift-row-name">' +
        escapeHtml(name) +
        '</div>' +
        '<div class="shift-row-sku">' +
        escapeHtml(sku) +
        ' · <code>' +
        escapeHtml(lot.lot_id) +
        '</code> · ' +
        escapeHtml(unit) +
        '</div>' +
        '<label>ยอดระบบ<strong class="shift-sys" data-sys="' +
        sys +
        '">' +
        fmtQty(sys, unit) +
        '</strong></label>' +
        '<label>นับจริง<input class="shift-count" type="number" step="any" inputmode="decimal" value="' +
        sys +
        '" oninput="window.__ramaganShiftVar&&window.__ramaganShiftVar()" aria-label="นับจริง ' +
        escapeHtml(name) +
        '" /></label>' +
        '<label>ส่วนต่าง<strong class="shift-var zero" data-var="0">0</strong></label>' +
        '</div>';
    }
    box.innerHTML = html;
    var inputs = box.querySelectorAll('.shift-count');
    for (var ii = 0; ii < inputs.length; ii++) {
      (function (el) {
        el.addEventListener('input', updateShiftVariances);
        el.addEventListener('change', updateShiftVariances);
        el.addEventListener('keyup', updateShiftVariances);
        el.addEventListener('blur', updateShiftVariances);
      })(inputs[ii]);
    }
    updateShiftVariances();
  }

  function updateShiftVariances() {
    var rows = document.querySelectorAll('#shift-rows .shift-row');
    var dirty = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var sysEl = row.querySelector('[data-sys]');
      var input = row.querySelector('.shift-count');
      var varEl = row.querySelector('.shift-var');
      if (!sysEl || !input || !varEl) continue;
      var sys = Number(sysEl.getAttribute('data-sys'));
      var counted = Number(input.value);
      if (!isFinite(counted)) {
        varEl.textContent = '—';
        varEl.className = 'shift-var';
        continue;
      }
      var diff = Math.round((counted - sys) * 1000) / 1000;
      varEl.setAttribute('data-var', String(diff));
      var sign = diff > 0 ? '+' : '';
      varEl.textContent = sign + diff;
      varEl.className =
        'shift-var ' + (diff === 0 ? 'zero' : diff > 0 ? 'pos' : 'neg');
      if (diff !== 0) dirty++;
    }
    var btn = $('btn-shift-confirm');
    if (btn) btn.disabled = dirty === 0;
  }

  function onShiftConfirm() {
    var msg = $('shift-msg');
    var actor = ($('shift-actor') && $('shift-actor').value.trim()) || '';
    var shiftLabel = ($('shift-label') && $('shift-label').value.trim()) || '';
    if (!actor) {
      showMsg(msg, 'ต้องระบุผู้ตรวจนับ', true);
      return;
    }
    if (!shiftLabel) {
      showMsg(msg, 'ต้องระบุกะ / รอบ', true);
      return;
    }
    var rows = document.querySelectorAll('#shift-rows .shift-row');
    var plans = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var lotId = row.getAttribute('data-lot-id');
      var sys = Number(row.querySelector('[data-sys]').getAttribute('data-sys'));
      var counted = Number(row.querySelector('.shift-count').value);
      if (!isFinite(counted)) {
        showMsg(msg, 'ตัวเลขนับจริงไม่ถูกต้อง: ' + lotId, true);
        return;
      }
      var diff = Math.round((counted - sys) * 1000) / 1000;
      if (diff === 0) continue;
      plans.push({
        lot_id: lotId,
        sys: sys,
        counted: counted,
        diff: diff,
        qty: Math.abs(diff),
        sign: diff > 0 ? 1 : -1
      });
    }
    if (!plans.length) {
      showMsg(msg, 'ไม่มีส่วนต่าง — ไม่ต้อง ADJUST', true);
      return;
    }
    var summary = plans
      .map(function (p) {
        return p.lot_id + ' ' + (p.sign > 0 ? '+' : '-') + p.qty;
      })
      .join(', ');
    if (
      !confirm(
        'ยืนยัน ADJUST ตามนับจริง?\nกะ: ' +
          shiftLabel +
          '\nผู้ตรวจ: ' +
          actor +
          '\n' +
          summary
      )
    ) {
      return;
    }
    try {
      for (var j = 0; j < plans.length; j++) {
        var p = plans[j];
        StockLedger.appendEvent({
          lot_id: p.lot_id,
          type: 'ADJUST',
          qty: p.qty,
          actor_user_id: actor,
          reason: 'นับก่อนเข้ากะ · ' + shiftLabel,
          meta: {
            adjust_sign: p.sign,
            shift_label: shiftLabel,
            counted_qty: p.counted,
            system_qty: p.sys,
            variance: p.diff,
            source: 'shift_count'
          }
        });
      }
      showMsg(
        msg,
        'บันทึก ADJUST ' + plans.length + ' รายการ · กะ ' + shiftLabel,
        false
      );
      refreshAll();
    } catch (err) {
      showMsg(msg, String(err.message || err), true);
      refreshAll();
    }
  }

  function bindShiftUi() {
    var box = $('shift-rows');
    if (box && !box.dataset.shiftBound) {
      box.dataset.shiftBound = '1';
      function onCountEdit(e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains('shift-count')) return;
        updateShiftVariances();
      }
      box.addEventListener('input', onCountEdit);
      box.addEventListener('change', onCountEdit);
      box.addEventListener('keyup', onCountEdit);
    }
    var reload = $('btn-shift-reload');
    if (reload && !reload.dataset.bound) {
      reload.dataset.bound = '1';
      reload.addEventListener('click', function () {
        renderShiftCount();
        showMsg($('shift-msg'), 'รีโหลดยอดระบบแล้ว', false);
      });
    }
    var confirmBtn = $('btn-shift-confirm');
    if (confirmBtn && !confirmBtn.dataset.bound) {
      confirmBtn.dataset.bound = '1';
      confirmBtn.addEventListener('click', onShiftConfirm);
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


  function migrateOldDemoSeedIfNeeded() {
    var lots = StockLedger.listLots() || [];
    if (!lots.length) return false;
    var hasCategory = false;
    for (var i = 0; i < lots.length; i++) {
      if (lots[i].category_id) {
        hasCategory = true;
        break;
      }
    }
    // Old V0 seed was 3 flower/oil/gummy lots without category_id
    if (hasCategory && lots.length > 10) return false;
    var looksOld =
      lots.length <= 5 ||
      !hasCategory ||
      lots.some(function (L) {
        var n = String(L.product_name || '');
        return /OG Kush|CBD 10%|กัมมี่|เจลลี่/.test(n);
      });
    if (!looksOld) return false;
    StockStore.clear();
    StockLedger.seedIfEmpty();
    return true;
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
    migrateOldDemoSeedIfNeeded();
    bindTabs();

    $('form-receive').addEventListener('submit', onReceive);
    bindPosUi();
    bindShiftUi();
    window.__ramaganShiftVar = updateShiftVariances;
    document.addEventListener('input', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('shift-count')) {
        updateShiftVariances();
      }
    });
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
