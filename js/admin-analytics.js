/**
 * Admin dashboard aggregations from ledger events only.
 * Numbers come only from events (+ optional balanceAt for low-stock display).
 */
(function (global) {
  'use strict';

  function toNum(n) {
    var v = Number(n);
    return isFinite(v) ? v : 0;
  }

  function bangkokDateKey(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(d);
    } catch (e) {
      return '';
    }
  }

  function inRange(iso, fromKey, toKey) {
    var k = bangkokDateKey(iso);
    if (!k) return false;
    if (fromKey && k < fromKey) return false;
    if (toKey && k > toKey) return false;
    return true;
  }

  function topN(map, n) {
    var arr = [];
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) arr.push(map[k]);
    }
    arr.sort(function (a, b) {
      return b.baht - a.baht;
    });
    return arr.slice(0, n || 5);
  }

  function computeAdminStats(events, lots, range, balanceNowFn) {
    events = events || [];
    lots = lots || [];
    range = range || {};
    var fromKey = range.fromKey || '';
    var toKey = range.toKey || '';
    var lowAt = range.lowStockAt != null ? Number(range.lowStockAt) : 10;

    var salesBaht = 0;
    var salesPaidG = 0;
    var salesStockG = 0;
    var cashBaht = 0;
    var transferBaht = 0;
    var promoPaidG = 0;
    var promoStockG = 0;
    var shiftAdjustCount = 0;
    var shiftVarAbs = 0;
    var byProduct = {};
    var byCategory = {};

    var lotMap = {};
    for (var i = 0; i < lots.length; i++) {
      lotMap[lots[i].lot_id] = lots[i];
    }

    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      if (!inRange(ev.occurred_at, fromKey, toKey)) continue;
      var meta = ev.meta || {};
      var lot = lotMap[ev.lot_id] || {};

      if (ev.type === 'SALE') {
        var paid = toNum(meta.qty_paid != null ? meta.qty_paid : ev.qty);
        var stock = toNum(
          meta.qty_stock != null ? meta.qty_stock : Math.abs(toNum(ev.qty_delta))
        );
        var line = toNum(meta.line_total);
        if (!(line > 0) && meta.unit_price != null) {
          line = paid * toNum(meta.unit_price);
        }
        salesBaht += line;
        salesPaidG += paid;
        salesStockG += stock;
        if (meta.payment === 'transfer') transferBaht += line;
        else cashBaht += line;
        if (meta.promo === '5+2') {
          promoPaidG += paid;
          promoStockG += stock;
        }
        var pname = meta.product_name || lot.product_name || ev.lot_id;
        if (!byProduct[pname]) {
          byProduct[pname] = { name: pname, baht: 0, paid_g: 0, stock_g: 0 };
        }
        byProduct[pname].baht += line;
        byProduct[pname].paid_g += paid;
        byProduct[pname].stock_g += stock;
        var cat = lot.category_id || 'other';
        if (!byCategory[cat]) {
          byCategory[cat] = { id: cat, baht: 0, paid_g: 0, stock_g: 0 };
        }
        byCategory[cat].baht += line;
        byCategory[cat].paid_g += paid;
        byCategory[cat].stock_g += stock;
      }

      if (ev.type === 'ADJUST' && meta.source === 'shift_count') {
        shiftAdjustCount += 1;
        shiftVarAbs += Math.abs(
          toNum(meta.variance != null ? meta.variance : ev.qty)
        );
      }
    }

    var lowStock = [];
    if (typeof balanceNowFn === 'function') {
      for (var li = 0; li < lots.length; li++) {
        var L = lots[li];
        var bal = toNum(balanceNowFn(L.lot_id));
        if (bal <= lowAt) {
          lowStock.push({
            lot_id: L.lot_id,
            product_name: L.product_name,
            category_id: L.category_id,
            unit: L.unit,
            balance: bal
          });
        }
      }
      lowStock.sort(function (a, b) {
        return a.balance - b.balance;
      });
    }

    return {
      fromKey: fromKey,
      toKey: toKey,
      salesBaht: salesBaht,
      salesPaidG: salesPaidG,
      salesStockG: salesStockG,
      cashBaht: cashBaht,
      transferBaht: transferBaht,
      promoPaidG: promoPaidG,
      promoStockG: promoStockG,
      promoFreeG: Math.round((promoStockG - promoPaidG) * 1000) / 1000,
      shiftAdjustCount: shiftAdjustCount,
      shiftVarAbs: Math.round(shiftVarAbs * 1000) / 1000,
      topProducts: topN(byProduct, 8),
      topCategories: topN(byCategory, 8),
      lowStock: lowStock
    };
  }

  var api = {
    bangkokDateKey: bangkokDateKey,
    inRange: inRange,
    computeAdminStats: computeAdminStats
  };
  global.AdminAnalytics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : this
);
