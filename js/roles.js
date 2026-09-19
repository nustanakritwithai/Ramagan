/**
 * Local role gate (owner / manager / staff).
 * PINs live only in localStorage — never shipped in repo defaults as secrets;
 * first run seeds changeable demo PINs on this device only.
 */
(function (global) {
  'use strict';

  var STORAGE_SESSION = 'ramagan.role.session.v1';
  var STORAGE_PINS = 'ramagan.role.pins.v1';

  var ROLES = {
    owner: {
      id: 'owner',
      label: 'เจ้าของ',
      tabs: ['lots', 'shop', 'receive', 'sale', 'shift', 'adjust', 'asof', 'admin', 'events'],
      canResetSeed: true,
      canDriveSetup: true,
      canDriveDisconnect: true,
      canExportImport: true
    },
    manager: {
      id: 'manager',
      label: 'ผู้จัดการ',
      tabs: ['shop', 'sale', 'shift', 'admin'],
      canResetSeed: false,
      canDriveSetup: false,
      canDriveDisconnect: false,
      canExportImport: true
    },
    staff: {
      id: 'staff',
      label: 'พนักงาน',
      tabs: ['sale', 'shift'],
      canResetSeed: false,
      canDriveSetup: false,
      canDriveDisconnect: false,
      canExportImport: false
    }
  };

  function readPins() {
    try {
      var raw = localStorage.getItem(STORAGE_PINS);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  function writePins(pins) {
    localStorage.setItem(STORAGE_PINS, JSON.stringify(pins));
  }

  /** Seed demo PINs once on this browser — user should change them. */
  function ensurePins() {
    var pins = readPins();
    if (pins && pins.owner && pins.manager && pins.staff) return pins;
    pins = { owner: '0000', manager: '1111', staff: '2222' };
    writePins(pins);
    return pins;
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(STORAGE_SESSION);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !ROLES[s.roleId]) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function setSession(roleId) {
    localStorage.setItem(
      STORAGE_SESSION,
      JSON.stringify({ roleId: roleId, at: new Date().toISOString() })
    );
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_SESSION);
  }

  function currentRole() {
    var s = getSession();
    return s ? ROLES[s.roleId] : null;
  }

  function login(roleId, pin) {
    ensurePins();
    var pins = readPins();
    if (!ROLES[roleId]) return { ok: false, message: 'ไม่พบบทบาท' };
    if (String(pin || '') !== String(pins[roleId] || '')) {
      return { ok: false, message: 'PIN ไม่ถูกต้อง' };
    }
    setSession(roleId);
    return { ok: true, role: ROLES[roleId] };
  }

  function logout() {
    clearSession();
  }

  function changePin(roleId, oldPin, newPin) {
    ensurePins();
    var pins = readPins();
    if (!ROLES[roleId]) return { ok: false, message: 'ไม่พบบทบาท' };
    if (String(oldPin || '') !== String(pins[roleId] || '')) {
      return { ok: false, message: 'PIN เดิมไม่ถูกต้อง' };
    }
    var n = String(newPin || '').trim();
    if (!/^\d{4,6}$/.test(n)) {
      return { ok: false, message: 'PIN ใหม่ต้องเป็นตัวเลข 4–6 หลัก' };
    }
    pins[roleId] = n;
    writePins(pins);
    return { ok: true };
  }

  function canOpenTab(tabId) {
    var role = currentRole();
    if (!role) return false;
    return role.tabs.indexOf(tabId) !== -1;
  }

  function defaultTab() {
    var role = currentRole();
    if (!role || !role.tabs.length) return 'sale';
    return role.tabs.indexOf('sale') !== -1 ? 'sale' : role.tabs[0];
  }

  global.RamaganRoles = {
    ROLES: ROLES,
    ensurePins: ensurePins,
    currentRole: currentRole,
    login: login,
    logout: logout,
    changePin: changePin,
    canOpenTab: canOpenTab,
    defaultTab: defaultTab,
    getSession: getSession
  };
})(typeof window !== 'undefined' ? window : globalThis);
