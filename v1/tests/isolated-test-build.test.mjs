import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const appConfig = JSON.parse(read('capacitor.config.json'));
const testConfig = JSON.parse(read('capacitor.test.config.json'));
const index = read('index.html');
const testIndex = read('index.test.html');
const main = read('src/main.js');
const api = read('src/backend-api.js');
const vite = read('vite.test.config.js');

test('TEST package keeps the full app and its existing VPS login/API code', () => {
  assert.equal(testConfig.appId, 'online.ramagan.pos.test');
  assert.notEqual(testConfig.appId, appConfig.appId);
  assert.equal(testConfig.appName, 'Ramagan POS TEST');
  assert.equal(testConfig.webDir, 'dist-test');
  assert.match(testIndex, /src="\/src\/main\.js"/);
  assert.match(testIndex, /Full Ramagan app/);
  assert.match(testIndex, /Do not record real sales or stock changes/);
  assert.match(main, /ramagan\.v1\.server\.url/);
  assert.match(main, /createClient, validateServerUrl/);
  assert.match(main, /createCheckout/);
  assert.match(main, /createInventoryOperation/);
  assert.match(api, /\/v1\/auth\/login/);
  assert.match(api, /\/v1\/sales/);
  assert.match(api, /\/v1\/stocktakes/);
  assert.doesNotMatch(testIndex, /fixture\.invalid|offline-test-token|VITE_RAMAGAN_API_URL/);
  assert.doesNotMatch(vite, /define\s*:/);
  assert.match(vite, /envDir:false/);
});

test('TEST and original app entrypoints remain separate and share no TEST wrapper', () => {
  assert.match(index, /src="\/src\/main\.js"/);
  assert.doesNotMatch(index, /test-build-banner|TEST BUILD/);
  assert.match(vite, /index\.test\.html/);
  assert.match(vite, /dist-test/);
  assert.doesNotMatch(vite, /camera-test\.html/);
  assert.equal(fs.existsSync(path.join(root, 'camera-test.html')), false);
});
