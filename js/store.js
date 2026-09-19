/**
 * localStorage persistence for cannabis-pos-v0 stock ledger.
 * Key: cannabis-pos-v0
 * Node/smoke: in-memory fallback when localStorage is unavailable.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cannabis-pos-v0';
  var VERSION = 1;
  var memoryRaw = null;
  var listeners = [];

  function emptyState() {
    return { version: VERSION, lots: [], events: [], products: [], meta: {} };
  }

  function hasLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage != null;
    } catch (e) {
      return false;
    }
  }

  function normalize(data) {
    if (!data || typeof data !== 'object') return emptyState();
    if (!Array.isArray(data.lots)) data.lots = [];
    if (!Array.isArray(data.events)) data.events = [];
    if (!Array.isArray(data.products)) data.products = data.products || [];
    if (!data.meta || typeof data.meta !== 'object') data.meta = data.meta || {};
    data.version = data.version || VERSION;
    return data;
  }

  function load() {
    try {
      var raw;
      if (hasLocalStorage()) {
        raw = localStorage.getItem(STORAGE_KEY);
      } else {
        raw = memoryRaw;
      }
      if (!raw) return emptyState();
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.warn('[store] load failed, using empty state', e);
      return emptyState();
    }
  }

  function emit(payload) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](payload);
      } catch (e) {}
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function off() {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function save(state) {
    if (!state || typeof state !== 'object') {
      throw new Error('store.save: invalid state');
    }
    var payload = {
      version: state.version || VERSION,
      lots: state.lots || [],
      events: state.events || [],
      products: state.products || [],
      meta: state.meta && typeof state.meta === 'object' ? state.meta : {}
    };
    var serialized = JSON.stringify(payload);
    if (hasLocalStorage()) {
      localStorage.setItem(STORAGE_KEY, serialized);
    } else {
      memoryRaw = serialized;
    }
    emit(payload);
    return payload;
  }

  function clear() {
    if (hasLocalStorage()) {
      localStorage.removeItem(STORAGE_KEY);
    }
    memoryRaw = null;
    emit(emptyState());
  }

  function hasData() {
    var s = load();
    return s.lots.length > 0 || s.events.length > 0;
  }

  global.StockStore = {
    STORAGE_KEY: STORAGE_KEY,
    load: load,
    save: save,
    clear: clear,
    hasData: hasData,
    emptyState: emptyState,
    onChange: onChange
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.StockStore;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
