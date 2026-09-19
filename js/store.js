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

  function emptyState() {
    return { version: VERSION, lots: [], events: [] };
  }

  function hasLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage != null;
    } catch (e) {
      return false;
    }
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
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return emptyState();
      if (!Array.isArray(data.lots)) data.lots = [];
      if (!Array.isArray(data.events)) data.events = [];
      data.version = data.version || VERSION;
      return data;
    } catch (e) {
      console.warn('[store] load failed, using empty state', e);
      return emptyState();
    }
  }

  function save(state) {
    if (!state || typeof state !== 'object') {
      throw new Error('store.save: invalid state');
    }
    var payload = {
      version: VERSION,
      lots: state.lots || [],
      events: state.events || []
    };
    var serialized = JSON.stringify(payload);
    if (hasLocalStorage()) {
      localStorage.setItem(STORAGE_KEY, serialized);
    } else {
      memoryRaw = serialized;
    }
    return payload;
  }

  function clear() {
    if (hasLocalStorage()) {
      localStorage.removeItem(STORAGE_KEY);
    }
    memoryRaw = null;
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
    emptyState: emptyState
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.StockStore;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
