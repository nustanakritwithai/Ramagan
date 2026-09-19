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
      unit: unit,
      expires_at: fields.expires_at || null,
      received_at: fields.received_at || new Date().toISOString()
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
      lot_id: 'LOT-OGK-001',
      sku: 'FLOWER-OGK',
      product_name: 'ดอก OG Kush',
      unit: 'g',
      expires_at: '2027-03-01',
      received_at: '2026-09-01T09:00:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-CBD-002',
      sku: 'OIL-CBD10',
      product_name: 'น้ำมัน CBD 10%',
      unit: 'pcs',
      expires_at: '2027-06-15',
      received_at: '2026-09-05T10:30:00.000+07:00'
    });
    createLot({
      lot_id: 'LOT-GEL-003',
      sku: 'EDIBLE-GEL',
      product_name: 'กัมมี่เจลลี่ THC',
      unit: 'pcs',
      expires_at: '2026-12-31',
      received_at: '2026-09-10T14:00:00.000+07:00'
    });

    appendEvent({
      lot_id: 'LOT-OGK-001',
      type: 'RECEIVE',
      qty: 100,
      actor_user_id: 'user-owner',
      reason: 'รับเข้าจากซัพพลายเออร์ A',
      occurred_at: '2026-09-01T09:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-CBD-002',
      type: 'RECEIVE',
      qty: 24,
      actor_user_id: 'user-owner',
      reason: 'รับเข้าล็อตน้ำมัน CBD',
      occurred_at: '2026-09-05T10:30:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-GEL-003',
      type: 'RECEIVE',
      qty: 50,
      actor_user_id: 'user-staff',
      reason: 'รับเข้ากัมมี่',
      occurred_at: '2026-09-10T14:00:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-OGK-001',
      type: 'SALE',
      qty: 15,
      actor_user_id: 'user-cashier-a',
      reason: 'ขายหน้าร้าน',
      occurred_at: '2026-09-12T16:20:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-CBD-002',
      type: 'SALE',
      qty: 2,
      actor_user_id: 'user-cashier-b',
      reason: 'ขายหน้าร้าน',
      occurred_at: '2026-09-14T11:05:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-GEL-003',
      type: 'DESTROY',
      qty: 3,
      actor_user_id: 'user-manager',
      reason: 'ซองเสียหาย — ทำลายตามระเบียบ',
      occurred_at: '2026-09-15T09:45:00.000+07:00'
    });
    appendEvent({
      lot_id: 'LOT-OGK-001',
      type: 'ADJUST',
      qty: 2,
      actor_user_id: 'user-staff',
      reason: 'นับสต็อกได้มากกว่าที่ระบบ (ชดเชย)',
      occurred_at: '2026-09-16T18:00:00.000+07:00',
      meta: { adjust_sign: 1 }
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
