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
      unit_price: fields.unit_price != null ? Number(fields.unit_price) : null,
      unit_cost: fields.unit_cost != null ? Number(fields.unit_cost) : (fields.cost != null ? Number(fields.cost) : null),
      for_sale: fields.for_sale === false || fields.for_sale === 0 || fields.for_sale === '0' ? false : true
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
      var copy = Object.assign({}, lot, {
        qty_remaining: balanceAt(lot.lot_id, now)
      });
      if (copy.for_sale === undefined) copy.for_sale = true;
      return copy;
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
    var copy = Object.assign({}, lot, {
      qty_remaining: balanceAt(lotId, new Date().toISOString())
    });
    if (copy.for_sale === undefined) copy.for_sale = true;
    return copy;
  }


  /**
   * Update mutable product fields on a lot. Never deletes lots/events.
   * patch: { product_name?, sku?, category_id?, unit_price?, unit_cost?, cost?, for_sale?, expires_at? }
   */
  function updateLot(lotId, patch) {
    var state = getState();
    var lot = findLot(state, lotId);
    if (!lot) throw new Error('Unknown lot: ' + lotId);
    patch = patch || {};
    if (patch.product_name != null) {
      var name = String(patch.product_name).trim();
      if (!name) throw new Error('product_name required');
      lot.product_name = name;
    }
    if (patch.sku != null) {
      var sku = String(patch.sku).trim();
      if (!sku) throw new Error('sku required');
      lot.sku = sku;
    }
    if (patch.category_id !== undefined) {
      lot.category_id = String(patch.category_id || '').trim() || null;
    }
    if (patch.unit_price !== undefined) {
      if (patch.unit_price === null || patch.unit_price === '') lot.unit_price = null;
      else {
        var p = Number(patch.unit_price);
        if (!isFinite(p) || p < 0) throw new Error('unit_price invalid');
        lot.unit_price = p;
      }
    }
    if (patch.unit_cost !== undefined || patch.cost !== undefined) {
      var rawCost = patch.unit_cost !== undefined ? patch.unit_cost : patch.cost;
      if (rawCost === null || rawCost === '') lot.unit_cost = null;
      else {
        var c = Number(rawCost);
        if (!isFinite(c) || c < 0) throw new Error('unit_cost invalid');
        lot.unit_cost = c;
      }
    }
    if (patch.for_sale !== undefined) {
      lot.for_sale = !(patch.for_sale === false || patch.for_sale === 0 || patch.for_sale === '0');
    }
    if (patch.expires_at !== undefined) {
      lot.expires_at = patch.expires_at || null;
    }
    // migrate older lots missing for_sale
    if (lot.for_sale === undefined) lot.for_sale = true;
    persist(state);
    return Object.assign({}, lot);
  }

  function seedIfEmpty() {
    if (StockStore.hasData()) return false;

    // Go-live / system-test catalog: exactly 5 products per category.
    // Prices locked; unit_cost = 50% of unit_price. Each lot RECEIVE opening 30g.
    var receivedAt = '2026-09-18T09:00:00.000+07:00';
    var catalog = [
      { lot_id: 'LOT-LEAF-001', sku: 'TEST-LEAF-01', product_name: 'ใบทริม Test OG Auto', category_id: 'leaf-trim', unit_price: 20, unit_cost: 10 },
      { lot_id: 'LOT-LEAF-002', sku: 'TEST-LEAF-02', product_name: 'ใบทริม Test Haze Photo', category_id: 'leaf-trim', unit_price: 20, unit_cost: 10 },
      { lot_id: 'LOT-LEAF-003', sku: 'TEST-LEAF-03', product_name: 'ใบทริม Test Gelato Mix', category_id: 'leaf-trim', unit_price: 20, unit_cost: 10 },
      { lot_id: 'LOT-LEAF-004', sku: 'TEST-LEAF-04', product_name: 'ใบทริม Test Cookies', category_id: 'leaf-trim', unit_price: 20, unit_cost: 10 },
      { lot_id: 'LOT-LEAF-005', sku: 'TEST-LEAF-05', product_name: 'ใบทริม Test Premium Trim', category_id: 'leaf-trim', unit_price: 20, unit_cost: 10 },

      { lot_id: 'LOT-SHAKE-001', sku: 'TEST-SHAKE-01', product_name: 'ใต้เครื่อง Test Shake Auto', category_id: 'under-machine', unit_price: 25, unit_cost: 12.5 },
      { lot_id: 'LOT-SHAKE-002', sku: 'TEST-SHAKE-02', product_name: 'ใต้เครื่อง Test Kush Photo', category_id: 'under-machine', unit_price: 25, unit_cost: 12.5 },
      { lot_id: 'LOT-SHAKE-003', sku: 'TEST-SHAKE-03', product_name: 'ใต้เครื่อง Test Skunk Mix', category_id: 'under-machine', unit_price: 25, unit_cost: 12.5 },
      { lot_id: 'LOT-SHAKE-004', sku: 'TEST-SHAKE-04', product_name: 'ใต้เครื่อง Test Diesel', category_id: 'under-machine', unit_price: 25, unit_cost: 12.5 },
      { lot_id: 'LOT-SHAKE-005', sku: 'TEST-SHAKE-05', product_name: 'ใต้เครื่อง Test Premium Shake', category_id: 'under-machine', unit_price: 25, unit_cost: 12.5 },

      { lot_id: 'LOT-MINI-001', sku: 'TEST-MINI-40-01', product_name: 'mini Test Auto 40', category_id: 'mini', unit_price: 40, unit_cost: 20 },
      { lot_id: 'LOT-MINI-002', sku: 'TEST-MINI-40-02', product_name: 'mini Test Photo 40', category_id: 'mini', unit_price: 40, unit_cost: 20 },
      { lot_id: 'LOT-MINI-003', sku: 'TEST-MINI-40-03', product_name: 'mini Test Mix 40', category_id: 'mini', unit_price: 40, unit_cost: 20 },
      { lot_id: 'LOT-MINI-004', sku: 'TEST-MINI-50-01', product_name: 'mini Test Auto 50', category_id: 'mini', unit_price: 50, unit_cost: 25 },
      { lot_id: 'LOT-MINI-005', sku: 'TEST-MINI-50-02', product_name: 'mini Test Photo 50', category_id: 'mini', unit_price: 50, unit_cost: 25 },

      { lot_id: 'LOT-POP-001', sku: 'TEST-POP-01', product_name: 'pop Test OG Pop', category_id: 'pop', unit_price: 80, unit_cost: 40 },
      { lot_id: 'LOT-POP-002', sku: 'TEST-POP-02', product_name: 'pop Test Haze Pop', category_id: 'pop', unit_price: 80, unit_cost: 40 },
      { lot_id: 'LOT-POP-003', sku: 'TEST-POP-03', product_name: 'pop Test Gelato Pop', category_id: 'pop', unit_price: 80, unit_cost: 40 },
      { lot_id: 'LOT-POP-004', sku: 'TEST-POP-04', product_name: 'pop Test Cookies Pop', category_id: 'pop', unit_price: 80, unit_cost: 40 },
      { lot_id: 'LOT-POP-005', sku: 'TEST-POP-05', product_name: 'pop Test Premium Pop', category_id: 'pop', unit_price: 80, unit_cost: 40 },

      { lot_id: 'LOT-TOP-001', sku: 'TEST-TOP-01', product_name: 'Top Test OG Flower', category_id: 'top', unit_price: 150, unit_cost: 75 },
      { lot_id: 'LOT-TOP-002', sku: 'TEST-TOP-02', product_name: 'Top Test Haze Flower', category_id: 'top', unit_price: 150, unit_cost: 75 },
      { lot_id: 'LOT-TOP-003', sku: 'TEST-TOP-03', product_name: 'Top Test Gelato Flower', category_id: 'top', unit_price: 150, unit_cost: 75 },
      { lot_id: 'LOT-TOP-004', sku: 'TEST-TOP-04', product_name: 'Top Test Cookies Flower', category_id: 'top', unit_price: 150, unit_cost: 75 },
      { lot_id: 'LOT-TOP-005', sku: 'TEST-TOP-05', product_name: 'Top Test Premium Top', category_id: 'top', unit_price: 150, unit_cost: 75 }
    ];

    for (var i = 0; i < catalog.length; i++) {
      var row = catalog[i];
      createLot({
        lot_id: row.lot_id,
        sku: row.sku,
        product_name: row.product_name,
        category_id: row.category_id,
        unit: 'g',
        unit_price: row.unit_price,
        unit_cost: row.unit_cost,
        received_at: receivedAt,
        for_sale: true
      });
      appendEvent({
        lot_id: row.lot_id,
        type: 'RECEIVE',
        qty: 30,
        actor_user_id: 'user-owner',
        reason: 'seed รับเข้าหน้าร้าน (test catalog)',
        occurred_at: receivedAt
      });
    }

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
    updateLot: updateLot,
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
