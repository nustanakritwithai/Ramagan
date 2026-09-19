/**
 * Google Drive OAuth hook (client-side).
 * Set window.RAMAGAN_GOOGLE_CLIENT_ID before load to enable real OAuth.
 * Sync/conflict rules are owned by Ai CPU WEB — this module only auth + file IO hooks.
 */
(function (global) {
  'use strict';

  var STORAGE_TOKEN = 'ramagan-drive-token';
  var STORAGE_FILE = 'ramagan-drive-file-id';
  var listeners = [];

  function clientId() {
    var fromWindow = String(global.RAMAGAN_GOOGLE_CLIENT_ID || '').trim();
    if (fromWindow) return fromWindow;
    try {
      return String(localStorage.getItem('ramagan-google-client-id') || '').trim();
    } catch (e) {
      return '';
    }
  }

  function setClientId(id) {
    id = String(id || '').trim();
    try {
      if (id) localStorage.setItem('ramagan-google-client-id', id);
      else localStorage.removeItem('ramagan-google-client-id');
    } catch (e) {}
    global.RAMAGAN_GOOGLE_CLIENT_ID = id;
    emit();
    return status();
  }

  function getToken() {
    try {
      return localStorage.getItem(STORAGE_TOKEN) || '';
    } catch (e) {
      return '';
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(STORAGE_TOKEN, token);
      else localStorage.removeItem(STORAGE_TOKEN);
    } catch (e) {}
    emit();
  }

  function getFileId() {
    try {
      return localStorage.getItem(STORAGE_FILE) || '';
    } catch (e) {
      return '';
    }
  }

  function setFileId(id) {
    try {
      if (id) localStorage.setItem(STORAGE_FILE, id);
      else localStorage.removeItem(STORAGE_FILE);
    } catch (e) {}
  }

  function status() {
    var id = clientId();
    var token = getToken();
    return {
      configured: !!id,
      connected: !!token,
      clientIdSet: !!id,
      fileId: getFileId(),
      label: !id
        ? 'ยังไม่ตั้ง Client ID'
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
  }

  function loadGis(cb) {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) {
      cb();
      return;
    }
    var existing = document.getElementById('gis-client');
    if (existing) {
      existing.addEventListener('load', cb);
      return;
    }
    var s = document.createElement('script');
    s.id = 'gis-client';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = cb;
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
            'ยังไม่มี Google OAuth Client ID — ตั้ง window.RAMAGAN_GOOGLE_CLIENT_ID ก่อน (Ai CPU WEB)'
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
              resolve(status());
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
    setToken('');
    setFileId('');
    return status();
  }

  /** Upload JSON string to Drive appData folder file (create or update). Hook for sync layer. */
  function uploadJson(filename, jsonText) {
    return new Promise(function (resolve, reject) {
      var token = getToken();
      if (!token) {
        reject(new Error('ยังไม่เชื่อม Google Drive'));
        return;
      }
      var meta = {
        name: filename || 'ramagan-ledger.json',
        mimeType: 'application/json'
      };
      var fileId = getFileId();
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
      var url = fileId
        ? 'https://www.googleapis.com/upload/drive/v3/files/' +
          encodeURIComponent(fileId) +
          '?uploadType=multipart'
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      var method = fileId ? 'PATCH' : 'POST';
      fetch(url, {
        method: method,
        headers: {
          Authorization: 'Bearer ' + token,
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
          resolve(j);
        })
        .catch(reject);
    });
  }

  global.RamaganDrive = {
    status: status,
    connect: connect,
    disconnect: disconnect,
    uploadJson: uploadJson,
    onChange: onChange,
    getToken: getToken,
    getFileId: getFileId,
    setClientId: setClientId,
    getClientId: clientId
  };
})(typeof window !== 'undefined' ? window : globalThis);
