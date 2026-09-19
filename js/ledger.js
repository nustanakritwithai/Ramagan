/**
 * Immutable stock ledger core.
 * Field names locked to SQL (aaa01): occurred_at · qty_delta · actor_user_id
 * Depends on StockStore (store.js). No ES modules — file:// safe.
 */
(function (global) {
  'use strict';

  var EVENT_TYPES = [
    'RECEIVE',
    'SALE',
    'ADJUST',
    'DESTROY',
    'TRANSFER_IN',
    'TRANSFER_OUT'
  ];

  var UNITS = ['g', 'pcs'];

  function uid(prefix) {
    return (
      prefix +
      '-' +
      Date.now().toString(36).toUpperCase() +
      '-' +
      Math.random().toString(36).slice(2, 8).toUpperCase()
    );
  }

  function getState() {
    return StockStore.load();
  }

  function persist(state) {
    StockStore.save(state);
  }

  function findLot(state, lotId) {
    for (var i = 0; i < state.lots.length; i++) {
      if (state.lots[i].lot_id === lotId) return state.lots[i];
    }
    return null;
  }

  function roundQty(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  /** qty = positive magnitude → signed qty_delta */
  function qtyDeltaFor(type, qty, meta) {
    var q = Number(qty);
    if (!(q > 0) || !isFinite(q)) {
      throw new Error('qty must be a positive magnitude');
    }
    meta = meta || {};
    if (type === 'ADJUST') {
      var sign = meta.adjust_sign === -1 || meta.adjust_sign === '-' ? -1 : 1;
      return sign * q;
    }
    if (type === 'RECEIVE' || type === 'TRANSFER_IN') return q;
    if (type === 'SALE' || type === 'DESTROY' || type === 'TRANSFER_OUT') return -q;
    throw new Error('Invalid event type: ' + type);
  }

  /** Balance of one lot at isoTime (inclusive). Tie-break: append order. */
  function balanceAt(lotId, isoTime) {
    var state = getState();
    var t = isoTime || new Date().toISOString();
    var sum = 0;
    for (var i = 0; i < state.events.length; i++) {
      var ev = state.events[i];
      if (ev.lot_id !== lotId) continue;
      if (ev.occurred_at <= t) {
        sum += Number(ev.qty_delta) || 0;
      }
    }
    return roundQty(sum);
  }

  function balanceAllAt(isoTime) {
    var state = getState();
    var t = isoTime || new Date().toISOString();
    var map = {};
    for (var i = 0; i < state.lots.length; i++) {
      map[state.lots[i].lot_id] = 0;
    }
    for (var j = 0; j < state.events.length; j++) {
      var ev = state.events[j];
      if (ev.occurred_at <= t) {
        if (map[ev.lot_id] === undefined) map[ev.lot_id] = 0;
        map[ev.lot_id] += Number(ev.qty_delta) || 0;
      }
    }
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) {
        map[k] = roundQty(map[k]);
      }
    }
    return map;
  }

  function validateSale(lotId, qty, isoTime) {
    var remaining = balanceAt(lotId, isoTime || new Date().toISOString());
    var q = Number(qty);
    if (!(q > 0) || !isFinite(q)) {
      return { ok: false, remaining: remaining, message: 'จำนวนต้องมากกว่า 0 / qty must be > 0' };
    }
    if (q > remaining) {
      return {
        ok: false,
        remaining: remaining,
        message: 'ขายเกินคงเหลือ / oversell: ขอ ' + q + ' แต่เหลือ ' + remaining
      };
    }
    return { ok: true, remaining: remaining, message: 'OK' };
  }


  /** Locked retail categories (aaa01 2026-09-19) */
  var CATEGORIES = [
    { id: 'leaf-trim', name: 'ใบทริม', unit_price: 20 },
    { id: 'under-machine', name: 'ใต้เครื่อง', unit_price: 25 },
    { id: 'mini', name: 'mini', unit_price: null }, // 40 and 50 as separate SKUs
    { id: 'pop', name: 'pop', unit_price: 80 },
    { id: 'top', name: 'Top', unit_price: 150 }
  ];

  function createLot(fields) {
    var state = getState();
    var lotId = fields.lot_id || uid('LOT');
    if (findLot(state, lotId)) {
      throw new Error('Lot already exists: ' + lotId);
    }
    var unit = fields.unit || 'g';
    if (UNITS.indexOf(unit) === -1) {
      throw new Error('unit must be g or pcs');
    }
    var lot = {
      lot_id: lotId,
      sku: String(fields.sku || '').trim(),
      product_name: String(fields.product_name || '').trim(),
      category_id: String(fields.category_id || '').trim() || null,
      unit: unit,
      expires_at: fields.expires_at || null,
      received_at: fields.received_at || new Date().toISOString(),
      unit_price: fields.unit_price != null ? Number(fields.unit_price) : null
    };
    if (!lot.sku || !lot.product_name) {
      throw new Error('sku and product_name are required');
    }
    state.lots.push(lot);
    persist(state);
    return lot;
  }

  /**
   * Append immutable event.
   * partial: { lot_id, type, qty, actor_user_id, reason, occurred_at?, meta? }
   * Input aliases only (not stored): actor → actor_user_id, timestamp → occurred_at,
   * signed_delta → used only if qty missing (migrated into qty_delta).
   */
  function appendEvent(partial) {
    var state = getState();
    var type = partial.type;
    if (EVENT_TYPES.indexOf(type) === -1) {
      throw new Error('Invalid event type: ' + type);
    }
    var lot = findLot(state, partial.lot_id);
    if (!lot) {
      throw new Error('Unknown lot: ' + partial.lot_id);
    }
    var actorUserId = String(
      partial.actor_user_id != null && String(partial.actor_user_id).trim() !== ''
        ? partial.actor_user_id
        : partial.actor || ''
    ).trim();
    var reason = String(partial.reason || '').trim();
    if (!actorUserId) throw new Error('actor_user_id is required');
    if (!reason) throw new Error('reason is required');

    var meta = partial.meta || {};
    var qty = Number(partial.qty);
    var delta;
    if (!(qty > 0) || !isFinite(qty)) {
      if (partial.qty_delta != null && isFinite(Number(partial.qty_delta))) {
        delta = Number(partial.qty_delta);
        qty = Math.abs(delta);
      } else if (partial.signed_delta != null && isFinite(Number(partial.signed_delta))) {
        delta = Number(partial.signed_delta);
        qty = Math.abs(delta);
      } else {
        delta = qtyDeltaFor(type, qty, meta);
      }
    } else {
      delta = qtyDeltaFor(type, qty, meta);
    }
    var occurredAt =
      partial.occurred_at || partial.timestamp || new Date().toISOString();

    if (
      type === 'SALE' ||
      type === 'DESTROY' ||
      type === 'TRANSFER_OUT' ||
      (type === 'ADJUST' && delta < 0)
    ) {
      var remaining = 0;
      for (var i = 0; i < state.events.length; i++) {
        var ev = state.events[i];
        if (ev.lot_id === partial.lot_id && ev.occurred_at <= occurredAt) {
          remaining += Number(ev.qty_delta) || 0;
        }
      }
      remaining = roundQty(remaining);
      var need = Math.abs(delta);
      if (need > remaining) {
        throw new Error(
          'Insufficient stock for ' +
            type +
            ': need ' +
            need +
            ', remaining ' +
            remaining +
            ' (lot ' +
            partial.lot_id +
            ')'
        );
      }
    }

    var event = {
      event_id: uid('EVT'),
      lot_id: partial.lot_id,
      type: type,
      qty: qty,
      qty_delta: delta,
      actor_user_id: actorUserId,
      reason: reason,
      occurred_at: occurredAt,
      created_at: new Date().toISOString(),
      meta: meta
    };

    state.events.push(event);
    persist(state);
    return event;
  }

  function listLots() {
    var state = getState();
    var now = new Date().toISOString();
    return state.lots.map(function (lot) {
      return Object.assign({}, lot, {
        qty_remaining: balanceAt(lot.lot_id, now)
      });
    });
  }

  function listEvents() {
    return getState().events.slice().sort(function (a, b) {
      if (a.occurred_at === b.occurred_at) {
        return a.event_id < b.event_id ? -1 : 1;
      }
      return a.occurred_at < b.occurred_at ? -1 : 1;
    });
  }

  function getLot(lotId) {
    var state = getState();
    var lot = findLot(state, lotId);
    if (!lot) return null;
    return Object.assign({}, lot, {
      qty_remaining: balanceAt(lotId, new Date().toISOString())
    });
  }

  function seedIfEmpty() {
    if (StockStore.hasData()) return false;

    createLot({
      lot_id: 'LOT-LEAF-001',
      sku: 'LEAFTR-20-01',
      product_name: 'ใบทริม ออโต้ A',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-002',
      sku: 'LEAFTR-20-02',
      product_name: 'ใบทริม ออโต้ B',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-003',
      sku: 'LEAFTR-20-03',
      product_name: 'ใบทริม ออโต้ C',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-004',
      sku: 'LEAFTR-20-04',
      product_name: 'ใบทริม ออโต้ D',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-005',
      sku: 'LEAFTR-20-05',
      product_name: 'ใบทริม ออโต้ E',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-006',
      sku: 'LEAFTR-20-06',
      product_name: 'ใบทริม โฟโต้ A',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-007',
      sku: 'LEAFTR-20-07',
      product_name: 'ใบทริม โฟโต้ B',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-008',
      sku: 'LEAFTR-20-08',
      product_name: 'ใบทริม โฟโต้ C',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-009',
      sku: 'LEAFTR-20-09',
      product_name: 'ใบทริม โฟโต้ D',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-010',
      sku: 'LEAFTR-20-10',
      product_name: 'ใบทริม มิกซ์ A',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-011',
      sku: 'LEAFTR-20-11',
      product_name: 'ใบทริม มิกซ์ B',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-LEAF-012',
      sku: 'LEAFTR-20-12',
      product_name: 'ใบทริม พรีเมียม',
      category_id: 'leaf-trim',
      unit: 'pcs',
      unit_price: 20,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-013',
      sku: 'UNDERM-25-01',
      product_name: 'ใต้เครื่อง ออโต้ A',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-014',
      sku: 'UNDERM-25-02',
      product_name: 'ใต้เครื่อง ออโต้ B',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-015',
      sku: 'UNDERM-25-03',
      product_name: 'ใต้เครื่อง ออโต้ C',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-016',
      sku: 'UNDERM-25-04',
      product_name: 'ใต้เครื่อง ออโต้ D',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-017',
      sku: 'UNDERM-25-05',
      product_name: 'ใต้เครื่อง โฟโต้ A',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-018',
      sku: 'UNDERM-25-06',
      product_name: 'ใต้เครื่อง โฟโต้ B',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-019',
      sku: 'UNDERM-25-07',
      product_name: 'ใต้เครื่อง โฟโต้ C',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-020',
      sku: 'UNDERM-25-08',
      product_name: 'ใต้เครื่อง โฟโต้ D',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-021',
      sku: 'UNDERM-25-09',
      product_name: 'ใต้เครื่อง มิกซ์ A',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-022',
      sku: 'UNDERM-25-10',
      product_name: 'ใต้เครื่อง มิกซ์ B',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-UNDE-023',
      sku: 'UNDERM-25-11',
      product_name: 'ใต้เครื่อง พรีเมียม',
      category_id: 'under-machine',
      unit: 'pcs',
      unit_price: 25,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-024',
      sku: 'MINI-40-01',
      product_name: 'mini 40 ออโต้ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-025',
      sku: 'MINI-40-02',
      product_name: 'mini 40 ออโต้ B',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-026',
      sku: 'MINI-40-03',
      product_name: 'mini 40 ออโต้ C',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-027',
      sku: 'MINI-40-04',
      product_name: 'mini 40 โฟโต้ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-028',
      sku: 'MINI-40-05',
      product_name: 'mini 40 โฟโต้ B',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-029',
      sku: 'MINI-40-06',
      product_name: 'mini 40 มิกซ์ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 40,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-030',
      sku: 'MINI-50-01',
      product_name: 'mini 50 ออโต้ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-031',
      sku: 'MINI-50-02',
      product_name: 'mini 50 ออโต้ B',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-032',
      sku: 'MINI-50-03',
      product_name: 'mini 50 ออโต้ C',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-033',
      sku: 'MINI-50-04',
      product_name: 'mini 50 โฟโต้ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-034',
      sku: 'MINI-50-05',
      product_name: 'mini 50 โฟโต้ B',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-MINI-035',
      sku: 'MINI-50-06',
      product_name: 'mini 50 มิกซ์ A',
      category_id: 'mini',
      unit: 'pcs',
      unit_price: 50,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-036',
      sku: 'POP-80-01',
      product_name: 'pop ออโต้ A',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-037',
      sku: 'POP-80-02',
      product_name: 'pop ออโต้ B',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-038',
      sku: 'POP-80-03',
      product_name: 'pop ออโต้ C',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-039',
      sku: 'POP-80-04',
      product_name: 'pop ออโต้ D',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-040',
      sku: 'POP-80-05',
      product_name: 'pop โฟโต้ A',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-041',
      sku: 'POP-80-06',
      product_name: 'pop โฟโต้ B',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-042',
      sku: 'POP-80-07',
      product_name: 'pop โฟโต้ C',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-043',
      sku: 'POP-80-08',
      product_name: 'pop มิกซ์ A',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-044',
      sku: 'POP-80-09',
      product_name: 'pop มิกซ์ B',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-045',
      sku: 'POP-80-10',
      product_name: 'pop พรีเมียม A',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-POP-046',
      sku: 'POP-80-11',
      product_name: 'pop พรีเมียม B',
      category_id: 'pop',
      unit: 'pcs',
      unit_price: 80,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-047',
      sku: 'TOP-150-01',
      product_name: 'Top ออโต้ A',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-048',
      sku: 'TOP-150-02',
      product_name: 'Top ออโต้ B',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-049',
      sku: 'TOP-150-03',
      product_name: 'Top ออโต้ C',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-050',
      sku: 'TOP-150-04',
      product_name: 'Top ออโต้ D',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-051',
      sku: 'TOP-150-05',
      product_name: 'Top โฟโต้ A',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-052',
      sku: 'TOP-150-06',
      product_name: 'Top โฟโต้ B',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-053',
      sku: 'TOP-150-07',
      product_name: 'Top โฟโต้ C',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-054',
      sku: 'TOP-150-08',
      product_name: 'Top มิกซ์ A',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-055',
      sku: 'TOP-150-09',
      product_name: 'Top มิกซ์ B',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-056',
      sku: 'TOP-150-10',
      product_name: 'Top พรีเมียม A',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-TOP-057',
      sku: 'TOP-150-11',
      product_name: 'Top พรีเมียม B',
      category_id: 'top',
      unit: 'pcs',
      unit_price: 150,
      received_at: '2026-09-18T09:00:00.000+07:00'
    });

    appendEvent({
      lot_id: 'LOT-LEAF-001',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-002',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-003',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-004',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-005',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-006',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-007',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-008',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-009',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-010',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-011',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-LEAF-012',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-013',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-014',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-015',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-016',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-017',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-018',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-019',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-020',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-021',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-022',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-UNDE-023',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-024',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-025',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-026',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-027',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-028',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-029',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-030',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-031',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-032',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-033',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-034',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-MINI-035',
      type: 'RECEIVE',
      qty: 30,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-036',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-037',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-038',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-039',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-040',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-041',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-042',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-043',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-044',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-045',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-POP-046',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-047',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-048',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-049',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-050',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-051',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-052',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-053',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-054',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-055',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-056',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-TOP-057',
      type: 'RECEIVE',
      qty: 20,
      actor_user_id: 'user-owner',
      reason: 'seed รับเข้าหน้าร้าน',
      occurred_at: '2026-09-18T09:00:00.000+07:00'
    });

    return true;
  }

  function resetDev() {
    StockStore.clear();
    return StockStore.emptyState();
  }

  var api = {
    EVENT_TYPES: EVENT_TYPES,
    UNITS: UNITS,
    CATEGORIES: CATEGORIES,
    createLot: createLot,
    appendEvent: appendEvent,
    balanceAt: balanceAt,
    balanceAllAt: balanceAllAt,
    validateSale: validateSale,
    listLots: listLots,
    listEvents: listEvents,
    getLot: getLot,
    seedIfEmpty: seedIfEmpty,
    resetDev: resetDev
  };

  global.StockLedger = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
