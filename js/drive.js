/**
 * Google Drive OAuth + append-only ledger sync (Ai CPU WEB rules).
 * Client ID: window.RAMAGAN_GOOGLE_CLIENT_ID or localStorage ramagan-google-client-id
 * NEVER commit secrets.
 */
(function (global) {
  'use strict';

  var STORAGE_TOKEN = 'ramagan-drive-token';
  var STORAGE_FILE = 'ramagan-drive-file-id';
  var STORAGE_FOLDER = 'ramagan-drive-folder-id';
  var STORAGE_CLIENT = 'ramagan-google-client-id';
  var STORAGE_LAST_SYNC = 'ramagan-drive-last-sync';
  var LEDGER_FILE_NAME = 'ledger.json';
  var FOLDER_NAME = 'Ramagan';
  var DEBOUNCE_MS = 3000;
  var POLL_MS = 60000;

  var listeners = [];
  var syncState = {
    syncing: false,
    conflict: false,
    conflictInfo: null,
    lastSyncAt: null,
    lastError: '',
    pausedUpload: false
  };
  var debounceTimer = null;
  var pollTimer = null;
  var wiredStore = false;
  var applyingRemote = false;

  /* —— pure merge / conflict (testable) —— */

  function eventId(ev) {
    if (!ev || typeof ev !== 'object') return '';
    return String(ev.event_id || ev.id || '').trim();
  }

  function lotId(lot) {
    if (!lot || typeof lot !== 'object') return '';
    return String(lot.lot_id || lot.id || '').trim();
  }

  function stableStringify(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(obj).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }

  function payloadsEqual(a, b) {
    return stableStringify(a) === stableStringify(b);
  }

  function isEmptySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return true;
    var lots = snap.lots || [];
    var events = snap.events || [];
    return lots.length === 0 && events.length === 0;
  }

  function indexById(list, idFn) {
    var map = {};
    var arr = list || [];
    for (var i = 0; i < arr.length; i++) {
      var id = idFn(arr[i]);
      if (!id) continue;
      map[id] = arr[i];
    }
    return map;
  }

  /**
   * Analyze local vs remote snapshots.
   * Returns:
   *  { action: 'upload_local' | 'adopt_remote' | 'noop' | 'apply_merged' | 'conflict',
   *    merged?, conflicts?, localOnlyIds?, remoteOnlyIds? }
   */
  function analyzeMerge(local, remote) {
    var loc = local && typeof local === 'object' ? local : { lots: [], events: [] };
    var rem = remote && typeof remote === 'object' ? remote : { lots: [], events: [] };
    var localEmpty = isEmptySnapshot(loc);
    var remoteEmpty = isEmptySnapshot(rem);

    if (remoteEmpty && localEmpty) {
      return { action: 'noop', merged: buildSnapshot(loc, rem) };
    }
    if (remoteEmpty) {
      return { action: 'upload_local', merged: buildSnapshot(loc, null) };
    }
    if (localEmpty) {
      return { action: 'adopt_remote', merged: buildSnapshot(rem, null) };
    }

    var localEvents = indexById(loc.events, eventId);
    var remoteEvents = indexById(rem.events, eventId);
    var conflicts = [];
    var localOnlyIds = [];
    var remoteOnlyIds = [];
    var allIds = {};

    Object.keys(localEvents).forEach(function (id) {
      allIds[id] = true;
    });
    Object.keys(remoteEvents).forEach(function (id) {
      allIds[id] = true;
    });

    Object.keys(allIds).forEach(function (id) {
      var L = localEvents[id];
      var R = remoteEvents[id];
      if (L && !R) localOnlyIds.push(id);
      else if (R && !L) remoteOnlyIds.push(id);
      else if (L && R && !payloadsEqual(L, R)) {
        conflicts.push({
          event_id: id,
          local: L,
          remote: R,
          reason: 'same_id_different_payload'
        });
      }
    });

    var localLots = indexById(loc.lots, lotId);
    var remoteLots = indexById(rem.lots, lotId);
    Object.keys(localLots).forEach(function (id) {
      if (remoteLots[id] && !payloadsEqual(localLots[id], remoteLots[id])) {
        conflicts.push({
          lot_id: id,
          local: localLots[id],
          remote: remoteLots[id],
          reason: 'same_lot_different_payload'
        });
      }
    });

    var divergent =
      localOnlyIds.length > 0 && remoteOnlyIds.length > 0;

    if (conflicts.length > 0 || divergent) {
      return {
        action: 'conflict',
        conflicts: conflicts,
        localOnlyIds: localOnlyIds,
        remoteOnlyIds: remoteOnlyIds,
        local: loc,
        remote: rem,
        reason: conflicts.length
          ? 'payload_conflict'
          : 'divergent_histories'
      };
    }

    // Safe auto-union: one side is subset of the other (or equal)
    var merged = unionSnapshots(loc, rem, 'prefer_newer_equal');
    var same =
      payloadsEqual(
        { lots: loc.lots, events: loc.events },
        { lots: merged.lots, events: merged.events }
      );
    if (same) {
      return { action: 'noop', merged: merged };
    }
    return { action: 'apply_merged', merged: merged };
  }

  function pickNewerEqual(a, b) {
    // Prefer newer occurred_at / updated_at when payloads otherwise match after stripping those fields
    var aa = Object.assign({}, a);
    var bb = Object.assign({}, b);
    var ta = String(aa.occurred_at || aa.updated_at || aa.created_at || '');
    var tb = String(bb.occurred_at || bb.updated_at || bb.created_at || '');
    delete aa.occurred_at;
    delete bb.occurred_at;
    delete aa.updated_at;
    delete bb.updated_at;
    delete aa.created_at;
    delete bb.created_at;
    if (payloadsEqual(aa, bb)) {
      return ta >= tb ? a : b;
    }
    return a; // caller should have detected conflict already
  }

  function unionSnapshots(local, remote, mode) {
    mode = mode || 'keep_local_conflicts';
    var loc = local || { lots: [], events: [], products: [], meta: {} };
    var rem = remote || { lots: [], events: [], products: [], meta: {} };

    var eventsMap = {};
    (rem.events || []).forEach(function (ev) {
      var id = eventId(ev);
      if (id) eventsMap[id] = ev;
    });
    (loc.events || []).forEach(function (ev) {
      var id = eventId(ev);
      if (!id) return;
      if (!eventsMap[id]) {
        eventsMap[id] = ev;
      } else if (payloadsEqual(eventsMap[id], ev)) {
        eventsMap[id] = pickNewerEqual(eventsMap[id], ev);
      } else if (mode === 'keep_remote_conflicts') {
        eventsMap[id] = eventsMap[id]; // remote already there
      } else if (mode === 'keep_local_conflicts') {
        eventsMap[id] = ev;
      } else if (mode === 'prefer_newer_equal') {
        eventsMap[id] = pickNewerEqual(eventsMap[id], ev);
      } else {
        eventsMap[id] = ev;
      }
    });
    if (mode === 'keep_remote_conflicts') {
      // re-apply remote winners for conflicts
      (rem.events || []).forEach(function (ev) {
        var id = eventId(ev);
        if (!id) return;
        var L = null;
        (loc.events || []).some(function (e) {
          if (eventId(e) === id) {
            L = e;
            return true;
          }
          return false;
        });
        if (L && !payloadsEqual(L, ev)) eventsMap[id] = ev;
      });
    }

    var lotsMap = {};
    (rem.lots || []).forEach(function (lot) {
      var id = lotId(lot);
      if (id) lotsMap[id] = lot;
    });
    (loc.lots || []).forEach(function (lot) {
      var id = lotId(lot);
      if (!id) return;
      if (!lotsMap[id]) lotsMap[id] = lot;
      else if (payloadsEqual(lotsMap[id], lot)) lotsMap[id] = lot;
      else if (mode === 'keep_local_conflicts') lotsMap[id] = lot;
      else if (mode === 'keep_remote_conflicts') {
        /* keep remote */
      } else lotsMap[id] = lot;
    });

    var productsMap = {};
    function productKey(p) {
      return String((p && (p.product_id || p.sku || p.id)) || '');
    }
    (rem.products || []).forEach(function (p) {
      var k = productKey(p);
      if (k) productsMap[k] = p;
    });
    (loc.products || []).forEach(function (p) {
      var k = productKey(p);
      if (!k) return;
      if (!productsMap[k] || mode !== 'keep_remote_conflicts') {
        if (mode === 'keep_remote_conflicts' && productsMap[k] && !payloadsEqual(productsMap[k], p)) {
          return;
        }
        productsMap[k] = p;
      }
    });

    var meta = Object.assign({}, rem.meta || {}, loc.meta || {});
    if (mode === 'keep_remote_conflicts') {
      meta = Object.assign({}, loc.meta || {}, rem.meta || {});
    }

    var events = Object.keys(eventsMap)
      .map(function (k) {
        return eventsMap[k];
      })
      .sort(function (a, b) {
        var ta = String(a.occurred_at || '');
        var tb = String(b.occurred_at || '');
        if (ta < tb) return -1;
        if (ta > tb) return 1;
        return eventId(a).localeCompare(eventId(b));
      });

    var lots = Object.keys(lotsMap).map(function (k) {
      return lotsMap[k];
    });
    var products = Object.keys(productsMap).map(function (k) {
      return productsMap[k];
    });

    return buildSnapshot({
      version: Math.max(Number(loc.version) || 1, Number(rem.version) || 1),
      lots: lots,
      events: events,
      products: products,
      meta: meta
    });
  }

  function buildSnapshot(base) {
    base = base || {};
    return {
      version: base.version || 1,
      lots: base.lots || [],
      events: base.events || [],
      products: base.products || [],
      meta: base.meta && typeof base.meta === 'object' ? base.meta : {},
      updated_at: new Date().toISOString()
    };
  }

  function resolveMerge(local, remote, choice) {
    var loc = local || { lots: [], events: [] };
    var rem = remote || { lots: [], events: [] };
    if (choice === 'keep_local') return buildSnapshot(loc);
    if (choice === 'keep_remote') return buildSnapshot(rem);
    if (choice === 'merge_keep_local') return unionSnapshots(loc, rem, 'keep_local_conflicts');
    if (choice === 'merge_keep_remote') return unionSnapshots(loc, rem, 'keep_remote_conflicts');
    if (choice === 'merge_union') return unionSnapshots(loc, rem, 'prefer_newer_equal');
    throw new Error('Unknown resolve choice: ' + choice);
  }

  /* —— storage helpers —— */

  function lsGet(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch (e) {
      return '';
    }
  }

  function lsSet(key, val) {
    try {
      if (val) localStorage.setItem(key, val);
      else localStorage.removeItem(key);
    } catch (e) {}
  }

  function clientId() {
    var fromWin = String(global.RAMAGAN_GOOGLE_CLIENT_ID || '').trim();
    if (fromWin) return fromWin;
    return String(lsGet(STORAGE_CLIENT) || '').trim();
  }

  function setClientId(id) {
    lsSet(STORAGE_CLIENT, String(id || '').trim());
    emit();
  }

  function getToken() {
    return lsGet(STORAGE_TOKEN);
  }

  function setToken(token) {
    lsSet(STORAGE_TOKEN, token || '');
    emit();
  }

  function getFileId() {
    return lsGet(STORAGE_FILE);
  }

  function setFileId(id) {
    lsSet(STORAGE_FILE, id || '');
  }

  function getFolderId() {
    return lsGet(STORAGE_FOLDER);
  }

  function setFolderId(id) {
    lsSet(STORAGE_FOLDER, id || '');
  }

  function status() {
    var id = clientId();
    var token = getToken();
    var last = syncState.lastSyncAt || lsGet(STORAGE_LAST_SYNC) || null;
    var phase = 'offline';
    if (syncState.conflict) phase = 'conflict';
    else if (syncState.syncing) phase = 'syncing';
    else if (token) phase = 'connected';
    else if (id) phase = 'ready';
    return {
      configured: !!id,
      connected: !!token,
      clientIdSet: !!id,
      fileId: getFileId(),
      syncing: !!syncState.syncing,
      conflict: !!syncState.conflict,
      conflictInfo: syncState.conflictInfo,
      lastSyncAt: last,
      lastError: syncState.lastError || '',
      pausedUpload: !!syncState.pausedUpload,
      phase: phase,
      label: !id
        ? 'ยังไม่ตั้ง Client ID'
        : syncState.conflict
          ? 'ขัดแย้ง — เลือกรูปแบบรวม'
          : syncState.syncing
            ? 'กำลังซิงค์…'
            : token
              ? 'เชื่อม Drive แล้ว'
              : 'ยังไม่เชื่อม Drive'
    };
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function emit() {
    var s = status();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](s);
      } catch (e) {}
    }
    updateConflictModal(s);
    updateStatusBadge(s);
  }

  function setSyncFlags( partial) {
    Object.assign(syncState, partial || {});
    emit();
  }

  /* —— GIS OAuth —— */

  function loadGis(cb) {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) {
      cb();
      return;
    }
    if (typeof document === 'undefined') {
      cb(new Error('No DOM for GIS'));
      return;
    }
    var existing = document.getElementById('gis-client');
    if (existing) {
      existing.addEventListener('load', function () {
        cb();
      });
      return;
    }
    var s = document.createElement('script');
    s.id = 'gis-client';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = function () {
      cb();
    };
    s.onerror = function () {
      cb(new Error('โหลด Google Identity ไม่สำเร็จ'));
    };
    document.head.appendChild(s);
  }

  function connect() {
    return new Promise(function (resolve, reject) {
      var id = clientId();
      if (!id) {
        reject(
          new Error(
            'ยังไม่มี Google OAuth Client ID — ตั้ง window.RAMAGAN_GOOGLE_CLIENT_ID หรือ localStorage ramagan-google-client-id (ดู docs/DRIVE_SYNC.md)'
          )
        );
        return;
      }
      loadGis(function (err) {
        if (err) {
          reject(err);
          return;
        }
        try {
          var client = global.google.accounts.oauth2.initTokenClient({
            client_id: id,
            scope: 'https://www.googleapis.com/auth/drive.file',
            callback: function (resp) {
              if (resp && resp.error) {
                reject(new Error(resp.error));
                return;
              }
              if (!resp || !resp.access_token) {
                reject(new Error('ไม่ได้รับ access_token'));
                return;
              }
              setToken(resp.access_token);
              ensureFile()
                .then(function () {
                  return syncNow({ reason: 'connect' });
                })
                .then(function () {
                  startPolling();
                  resolve(status());
                })
                .catch(function (e) {
                  // Connected but sync failed — still resolve connected
                  syncState.lastError = String(e.message || e);
                  emit();
                  startPolling();
                  resolve(status());
                });
            }
          });
          client.requestAccessToken({ prompt: 'consent' });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  function disconnect() {
    var token = getToken();
    if (token && global.google && global.google.accounts && global.google.accounts.oauth2) {
      try {
        global.google.accounts.oauth2.revoke(token, function () {});
      } catch (e) {}
    }
    stopPolling();
    setToken('');
    setFileId('');
    setFolderId('');
    setSyncFlags({
      conflict: false,
      conflictInfo: null,
      pausedUpload: false,
      syncing: false,
      lastError: ''
    });
    hideConflictModal();
    return status();
  }

  function authHeaders() {
    var token = getToken();
    if (!token) throw new Error('ยังไม่เชื่อม Google Drive');
    return { Authorization: 'Bearer ' + token };
  }

  function driveFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, authHeaders(), opts.headers || {});
    return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
      return r.text().then(function (text) {
        var j = null;
        if (text) {
          try {
            j = JSON.parse(text);
          } catch (e) {
            j = text;
          }
        }
        if (!r.ok) {
          var msg =
            (j && j.error && j.error.message) ||
            (typeof j === 'string' ? j : r.statusText) ||
            'Drive HTTP ' + r.status;
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  function ensureFolder() {
    var existing = getFolderId();
    if (existing) return Promise.resolve(existing);
    var q =
      "name='" +
      FOLDER_NAME +
      "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    return driveFetch(
      'https://www.googleapis.com/drive/v3/files?q=' +
        encodeURIComponent(q) +
        '&spaces=drive&fields=files(id,name)&pageSize=5'
    ).then(function (res) {
      if (res && res.files && res.files[0] && res.files[0].id) {
        setFolderId(res.files[0].id);
        return res.files[0].id;
      }
      return driveFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: FOLDER_NAME,
          mimeType: 'application/vnd.google-apps.folder'
        })
      }).then(function (created) {
        setFolderId(created.id);
        return created.id;
      });
    });
  }

  function ensureFile() {
    var existing = getFileId();
    if (existing) return Promise.resolve(existing);
    return ensureFolder().then(function (folderId) {
      var q =
        "name='" +
        LEDGER_FILE_NAME +
        "' and '" +
        folderId +
        "' in parents and trashed=false";
      return driveFetch(
        'https://www.googleapis.com/drive/v3/files?q=' +
          encodeURIComponent(q) +
          '&spaces=drive&fields=files(id,name)&pageSize=5'
      ).then(function (res) {
        if (res && res.files && res.files[0] && res.files[0].id) {
          setFileId(res.files[0].id);
          return res.files[0].id;
        }
        var meta = {
          name: LEDGER_FILE_NAME,
          mimeType: 'application/json',
          parents: [folderId]
        };
        var boundary = 'ramagan_' + Date.now();
        var empty = JSON.stringify(
          buildSnapshot({ lots: [], events: [], products: [], meta: {} }),
          null,
          2
        );
        var body =
          '--' +
          boundary +
          '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
          JSON.stringify(meta) +
          '\r\n--' +
          boundary +
          '\r\nContent-Type: application/json\r\n\r\n' +
          empty +
          '\r\n--' +
          boundary +
          '--';
        return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + getToken(),
            'Content-Type': 'multipart/related; boundary=' + boundary
          },
          body: body
        })
          .then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error((j && j.error && j.error.message) || r.statusText);
              return j;
            });
          })
          .then(function (j) {
            if (j && j.id) setFileId(j.id);
            return j.id;
          });
      });
    });
  }

  function uploadJson(filename, jsonText) {
    return new Promise(function (resolve, reject) {
      var token = getToken();
      if (!token) {
        reject(new Error('ยังไม่เชื่อม Google Drive'));
        return;
      }
      ensureFile()
        .then(function (fileId) {
          var meta = {
            name: filename || LEDGER_FILE_NAME,
            mimeType: 'application/json'
          };
          var boundary = 'ramagan_' + Date.now();
          var body =
            '--' +
            boundary +
            '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
            JSON.stringify(meta) +
            '\r\n--' +
            boundary +
            '\r\nContent-Type: application/json\r\n\r\n' +
            jsonText +
            '\r\n--' +
            boundary +
            '--';
          var url =
            'https://www.googleapis.com/upload/drive/v3/files/' +
            encodeURIComponent(fileId) +
            '?uploadType=multipart';
          return fetch(url, {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'multipart/related; boundary=' + boundary
            },
            body: body
          }).then(function (r) {
            return r.json().then(function (j) {
              if (!r.ok) throw new Error((j && j.error && j.error.message) || r.statusText);
              return j;
            });
          });
        })
        .then(resolve)
        .catch(reject);
    });
  }

  function downloadRemote() {
    return ensureFile().then(function (fileId) {
      return fetch(
        'https://www.googleapis.com/drive/v3/files/' +
          encodeURIComponent(fileId) +
          '?alt=media',
        { headers: authHeaders() }
      ).then(function (r) {
        return r.text().then(function (text) {
          if (!r.ok) {
            var msg = text || r.statusText;
            try {
              var j = JSON.parse(text);
              msg = (j && j.error && j.error.message) || msg;
            } catch (e) {}
            throw new Error(msg);
          }
          if (!text || !String(text).trim()) {
            return { lots: [], events: [], products: [], meta: {} };
          }
          var data = JSON.parse(text);
          if (!data || typeof data !== 'object') {
            return { lots: [], events: [], products: [], meta: {} };
          }
          if (!Array.isArray(data.lots)) data.lots = [];
          if (!Array.isArray(data.events)) data.events = [];
          if (!Array.isArray(data.products)) data.products = [];
          if (!data.meta || typeof data.meta !== 'object') data.meta = {};
          return data;
        });
      });
    });
  }

  function localSnapshot() {
    if (global.StockStore && typeof StockStore.load === 'function') {
      var s = StockStore.load();
      return buildSnapshot({
        version: s.version || 1,
        lots: s.lots || [],
        events: s.events || [],
        products: s.products || [],
        meta: s.meta || {}
      });
    }
    return buildSnapshot({ lots: [], events: [] });
  }

  function applySnapshotToStore(snap, opts) {
    opts = opts || {};
    if (!global.StockStore || typeof StockStore.save !== 'function') return;
    applyingRemote = true;
    try {
      StockStore.save({
        version: snap.version || 1,
        lots: snap.lots || [],
        events: snap.events || [],
        products: snap.products || [],
        meta: snap.meta || {}
      });
      if (opts.refresh !== false && typeof global.dispatchEvent === 'function') {
        try {
          global.dispatchEvent(new CustomEvent('ramagan-drive-applied'));
        } catch (e) {}
      }
    } finally {
      applyingRemote = false;
    }
  }

  function markSynced() {
    var iso = new Date().toISOString();
    syncState.lastSyncAt = iso;
    lsSet(STORAGE_LAST_SYNC, iso);
  }

  function uploadSnapshot(snap) {
    var payload = JSON.stringify(snap, null, 2);
    return uploadJson(LEDGER_FILE_NAME, payload).then(function (j) {
      markSynced();
      return j;
    });
  }

  function enterConflict(info) {
    setSyncFlags({
      conflict: true,
      conflictInfo: info,
      pausedUpload: true,
      syncing: false
    });
    showConflictModal(info);
  }

  function syncNow(opts) {
    opts = opts || {};
    if (!getToken()) {
      return Promise.reject(new Error('ยังไม่เชื่อม Google Drive'));
    }
    if (syncState.conflict && !opts.force) {
      return Promise.resolve({ skipped: true, reason: 'conflict' });
    }
    setSyncFlags({ syncing: true, lastError: '' });
    return downloadRemote()
      .then(function (remote) {
        var local = localSnapshot();
        var result = analyzeMerge(local, remote);
        if (result.action === 'conflict') {
          enterConflict(result);
          return { conflict: true, result: result };
        }
        if (result.action === 'upload_local' || result.action === 'noop') {
          if (result.action === 'upload_local' || opts.forceUpload) {
            return uploadSnapshot(result.merged || local).then(function () {
              setSyncFlags({ syncing: false, conflict: false, conflictInfo: null, pausedUpload: false });
              return { uploaded: true };
            });
          }
          markSynced();
          setSyncFlags({ syncing: false });
          return { noop: true };
        }
        if (result.action === 'adopt_remote' || result.action === 'apply_merged') {
          applySnapshotToStore(result.merged);
          return uploadSnapshot(result.merged).then(function () {
            setSyncFlags({ syncing: false, conflict: false, conflictInfo: null, pausedUpload: false });
            return { applied: true, action: result.action };
          });
        }
        setSyncFlags({ syncing: false });
        return { result: result };
      })
      .catch(function (err) {
        // Offline OK: keep local, surface error lightly
        syncState.lastError = String(err.message || err);
        setSyncFlags({ syncing: false });
        return { error: syncState.lastError, offline: true };
      });
  }

  function scheduleUpload() {
    if (!getToken()) return;
    if (syncState.pausedUpload || syncState.conflict) return;
    if (applyingRemote) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      if (!getToken() || syncState.pausedUpload || syncState.conflict) return;
      setSyncFlags({ syncing: true, lastError: '' });
      var snap = localSnapshot();
      // Pull-merge first to avoid clobbering remote-only events
      downloadRemote()
        .then(function (remote) {
          var result = analyzeMerge(snap, remote);
          if (result.action === 'conflict') {
            enterConflict(result);
            return;
          }
          var toUpload =
            result.action === 'adopt_remote' || result.action === 'apply_merged'
              ? result.merged
              : snap;
          if (result.action === 'adopt_remote' || result.action === 'apply_merged') {
            applySnapshotToStore(toUpload);
          }
          return uploadSnapshot(toUpload).then(function () {
            setSyncFlags({ syncing: false });
          });
        })
        .catch(function (err) {
          // Offline: sell stays local; retry later
          syncState.lastError = String(err.message || err);
          setSyncFlags({ syncing: false });
        });
    }, DEBOUNCE_MS);
  }

  function notifyLocalChange() {
    scheduleUpload();
  }

  function resolveConflict(choice) {
    var info = syncState.conflictInfo;
    if (!info) {
      setSyncFlags({ conflict: false, pausedUpload: false });
      hideConflictModal();
      return Promise.resolve(status());
    }
    var merged = resolveMerge(info.local, info.remote, choice);
    applySnapshotToStore(merged);
    setSyncFlags({
      conflict: false,
      conflictInfo: null,
      pausedUpload: false,
      syncing: true
    });
    hideConflictModal();
    return uploadSnapshot(merged)
      .then(function () {
        setSyncFlags({ syncing: false });
        return status();
      })
      .catch(function (err) {
        syncState.lastError = String(err.message || err);
        setSyncFlags({ syncing: false });
        // Local resolved; upload when online
        return status();
      });
  }

  /* —— UI: conflict modal + badge helpers —— */

  function bindConflictActions(el) {
    if (!el || el.dataset.resolveBound === '1') return;
    var actions = el.querySelector('.drive-conflict-actions');
    if (!actions) return;
    el.dataset.resolveBound = '1';
    actions.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-resolve]');
      if (!btn) return;
      var choice = btn.getAttribute('data-resolve');
      resolveConflict(choice).then(function () {
        try {
          global.dispatchEvent(new CustomEvent('ramagan-drive-applied'));
        } catch (err) {}
      });
    });
  }

  function ensureModalDom() {
    if (typeof document === 'undefined') return null;
    var el = document.getElementById('drive-conflict-modal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'drive-conflict-modal';
      el.className = 'drive-conflict-modal hidden';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.innerHTML =
        '<div class="drive-conflict-backdrop"></div>' +
        '<div class="drive-conflict-card">' +
        '<h2>ขัดแย้งข้อมูล Drive / Drive conflict</h2>' +
        '<p class="hint" id="drive-conflict-reason"></p>' +
        '<div class="drive-conflict-list" id="drive-conflict-list"></div>' +
        '<div class="drive-conflict-actions">' +
        '<button type="button" class="btn btn-ghost" data-resolve="keep_local">เก็บฝั่งเครื่อง (Keep local)</button>' +
        '<button type="button" class="btn btn-ghost" data-resolve="keep_remote">เก็บฝั่ง Drive (Keep remote)</button>' +
        '<button type="button" class="btn btn-drive" data-resolve="merge_keep_local">รวม + คงค่าเครื่องเมื่อชน</button>' +
        '<button type="button" class="btn btn-drive" data-resolve="merge_keep_remote">รวม + คงค่า Drive เมื่อชน</button>' +
        '</div>' +
        '<p class="hint">ไม่เดาอัตโนมัติ — เลือกเอง / No auto-guess</p>' +
        '</div>';
      document.body.appendChild(el);
    }
    bindConflictActions(el);
    return el;
  }

  function showConflictModal(info) {
    if (typeof document === 'undefined') return;
    var el = ensureModalDom();
    if (!el) return;
    var reason = el.querySelector('#drive-conflict-reason');
    var list = el.querySelector('#drive-conflict-list');
    var lines = [];
    if (info.reason === 'divergent_histories') {
      if (reason) {
        reason.textContent =
          'เครื่องและ Drive มีเหตุการณ์ที่อีกฝั่งไม่มี (ประวัติแยกทาง) — เลือกวิธีรวม';
      }
    } else if (reason) {
      reason.textContent = 'พบ event/lot id เดียวกันแต่เนื้อหาต่างกัน — เลือกวิธีแก้';
    }
    (info.conflicts || []).slice(0, 12).forEach(function (c) {
      if (c.event_id) {
        lines.push(
          '<div class="drive-conflict-item">event <code>' +
            escapeHtml(c.event_id) +
            '</code> · ' +
            escapeHtml(c.reason || '') +
            '</div>'
        );
      } else if (c.lot_id) {
        lines.push(
          '<div class="drive-conflict-item">lot <code>' +
            escapeHtml(c.lot_id) +
            '</code></div>'
        );
      }
    });
    if ((info.localOnlyIds || []).length) {
      lines.push(
        '<div class="drive-conflict-item">local-only: ' +
          escapeHtml(info.localOnlyIds.slice(0, 8).join(', ')) +
          (info.localOnlyIds.length > 8 ? '…' : '') +
          '</div>'
      );
    }
    if ((info.remoteOnlyIds || []).length) {
      lines.push(
        '<div class="drive-conflict-item">remote-only: ' +
          escapeHtml(info.remoteOnlyIds.slice(0, 8).join(', ')) +
          (info.remoteOnlyIds.length > 8 ? '…' : '') +
          '</div>'
      );
    }
    if (list) list.innerHTML = lines.join('') || '<div class="drive-conflict-item">(no detail)</div>';
    el.classList.remove('hidden');
  }

  function hideConflictModal() {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('drive-conflict-modal');
    if (el) el.classList.add('hidden');
  }

  function updateConflictModal(s) {
    if (s && s.conflict && s.conflictInfo) showConflictModal(s.conflictInfo);
    else hideConflictModal();
  }

  function updateStatusBadge(s) {
    // optional; app.js also refreshes — keep lightweight
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function startPolling() {
    stopPolling();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('online', onOnline);
    }
    pollTimer = setInterval(function () {
      if (getToken() && !syncState.conflict) {
        syncNow({ reason: 'interval' });
      }
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof global.removeEventListener === 'function') {
      global.removeEventListener('online', onOnline);
    }
  }

  function onVisibility() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (getToken() && !syncState.conflict) syncNow({ reason: 'visibility' });
    }
  }

  function onOnline() {
    if (getToken() && !syncState.conflict) syncNow({ reason: 'online' });
  }

  function wireStoreHook() {
    if (wiredStore) return;
    if (global.StockStore && typeof StockStore.onChange === 'function') {
      StockStore.onChange(function () {
        if (applyingRemote) return;
        notifyLocalChange();
      });
      wiredStore = true;
    }
  }

  function init() {
    wireStoreHook();
    if (getToken()) startPolling();
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
          ensureModalDom();
          wireStoreHook();
          emit();
        });
      } else {
        ensureModalDom();
        emit();
      }
    }
    // late wire if store loads after drive
    setTimeout(wireStoreHook, 0);
  }

  var api = {
    status: status,
    connect: connect,
    disconnect: disconnect,
    uploadJson: uploadJson,
    downloadRemote: downloadRemote,
    syncNow: syncNow,
    scheduleUpload: scheduleUpload,
    notifyLocalChange: notifyLocalChange,
    resolveConflict: resolveConflict,
    onChange: onChange,
    getToken: getToken,
    getFileId: getFileId,
    clientId: clientId,
    setClientId: setClientId,
    // pure / testable
    analyzeMerge: analyzeMerge,
    resolveMerge: resolveMerge,
    unionSnapshots: unionSnapshots,
    payloadsEqual: payloadsEqual,
    isEmptySnapshot: isEmptySnapshot,
    buildSnapshot: buildSnapshot,
    DEBOUNCE_MS: DEBOUNCE_MS,
    LEDGER_FILE_NAME: LEDGER_FILE_NAME
  };

  global.RamaganDrive = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  init();
})(typeof window !== 'undefined' ? window : globalThis);
