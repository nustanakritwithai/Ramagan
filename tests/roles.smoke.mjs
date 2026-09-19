import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
  clear() { this._d = {}; }
};
const ctx = { console, localStorage: store };
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/roles.js'), 'utf8'), ctx);
const R = ctx.RamaganRoles;
assert.ok(R, 'RamaganRoles missing');

R.ensurePins();
assert.equal(R.login('owner', '0000').ok, true);
assert.equal(R.currentRole().id, 'owner');
assert.equal(R.canOpenTab('admin'), true);
assert.equal(R.currentRole().canResetSeed, true);
assert.equal(R.currentRole().canDriveDisconnect, true);

R.logout();
assert.equal(R.login('manager', '1111').ok, true);
assert.equal(R.canOpenTab('admin'), true);
assert.equal(R.canOpenTab('shop'), true);
assert.equal(R.canOpenTab('events'), false);
assert.equal(R.currentRole().canResetSeed, false);
assert.equal(R.currentRole().canDriveDisconnect, false);

R.logout();
assert.equal(R.login('staff', '2222').ok, true);
assert.equal(R.canOpenTab('sale'), true);
assert.equal(R.canOpenTab('shift'), true);
assert.equal(R.canOpenTab('admin'), false);
assert.equal(R.canOpenTab('shop'), false);
assert.equal(R.currentRole().canExportImport, false);

assert.equal(R.login('staff', '9999').ok, false);
assert.equal(R.changePin('staff', '2222', '3333').ok, true);
assert.equal(R.login('staff', '3333').ok, true);

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.match(html, /js\/roles\.js/);
assert.match(html, /id="role-gate"/);
assert.match(html, /data-tab="sale"[^>]*data-roles="[^"]*staff/);

console.log('roles.smoke: PASS');
