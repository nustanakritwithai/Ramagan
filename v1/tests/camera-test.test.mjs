import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {fakeIndexedDB} from './fake-idb.mjs';
import {createTestPhotoStore, mountCameraTest, TEST_DB_NAME, validateTestPhoto} from '../src/camera-test.js';

test('TEST camera photo persists locally across page instances and never creates a network client', async () => {
  const indexedDB = fakeIndexedDB();
  const file = new Blob(['synthetic image bytes'], {type: 'image/jpeg'});
  const first = createTestPhotoStore(indexedDB);
  const stored = await first.save(file);
  assert.equal(stored.mime, 'image/jpeg');
  const reopened = await createTestPhotoStore(indexedDB).read();
  assert.equal(reopened.mime, 'image/jpeg');
  assert.equal(reopened.blob.size, file.size);
  assert.equal(reopened.blob.type, file.type);

  const source = await readFile(new URL('../src/camera-test.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../camera-test.html', import.meta.url), 'utf8');
  const testConfig = JSON.parse(await readFile(new URL('../capacitor.test.config.json', import.meta.url), 'utf8'));
  const appConfig = JSON.parse(await readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/);
  assert.doesNotMatch(source, /backend-api|ramagan-api|stocktake-evidence/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /camera-test\.js/);
  assert.equal(testConfig.appId, 'online.ramagan.pos.test');
  assert.notEqual(testConfig.appId, appConfig.appId);
  assert.match(testConfig.appName, /TEST/);
  assert.equal(testConfig.webDir, 'dist-test');
});

test('TEST camera UI keeps separate capture/file inputs, preserves photo on cancel, and reloads preview', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url: 'https://localhost/'});
  const {window} = dom;
  const idb = fakeIndexedDB();
  let nextUrl = 0;
  window.URL.createObjectURL = () => `blob:test-${++nextUrl}`;
  window.URL.revokeObjectURL = () => {};
  const root = window.document.getElementById('app');
  const firstMount = await mountCameraTest({root, indexedDB: idb, URL: window.URL});
  const camera = root.querySelector('[data-test-photo-source="camera"]');
  const picker = root.querySelector('[data-test-photo-source="file"]');
  assert.equal(camera.accept, 'image/*');
  assert.equal(camera.getAttribute('capture'), 'environment');
  assert.equal(picker.accept, 'image/jpeg,image/png,image/webp');
  assert.equal(picker.hasAttribute('capture'), false);
  let cameraClicks = 0, pickerClicks = 0;
  camera.click = () => { cameraClicks++; };
  picker.click = () => { pickerClicks++; };
  root.querySelector('[data-test-photo-trigger="camera"]').click();
  root.querySelector('[data-test-photo-trigger="file"]').click();
  assert.equal(cameraClicks, 1);
  assert.equal(pickerClicks, 1);

  const photo = new Blob(['synthetic photo'], {type: 'image/jpeg'});
  Object.defineProperty(camera, 'files', {configurable: true, value: [photo]});
  camera.dispatchEvent(new window.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(root.querySelector('[data-test-status]').textContent, /ไม่ได.*ส่งไปเซิร์ฟเวอร์/);
  assert.equal(root.querySelector('[data-test-preview] img')?.alt.includes('ไม่ส่งไปเซิร์ฟเวอร์'), true);

  camera.dispatchEvent(new window.Event('cancel'));
  assert.match(root.querySelector('[data-test-status]').textContent, /เก็บรูปเดิมไว้/);
  assert.equal(await firstMount.store.read().then(record => record.blob.size), photo.size);
  firstMount.dispose();

  await mountCameraTest({root, indexedDB: idb, URL: window.URL});
  assert.ok(root.querySelector('[data-test-preview] img'), 'saved photo preview returns after app-page restart');
  assert.match(root.querySelector('[data-test-status]').textContent, /โหลดรูปทดสอบเดิม/);
  dom.window.close();
});

test('TEST photo store rejects invalid files without replacing the previously saved photo', async () => {
  const store = createTestPhotoStore(fakeIndexedDB());
  const first = new Blob(['first'], {type: 'image/jpeg'});
  await store.save(first);
  assert.throws(() => validateTestPhoto(new Blob(['bad'], {type: 'text/plain'})));
  assert.throws(() => validateTestPhoto(new Blob([], {type: 'image/png'})));
  const retained = await store.read();
  assert.equal(retained.blob.size, first.size);
  assert.equal(retained.mime, 'image/jpeg');
  assert.equal(TEST_DB_NAME, 'ramagan-camera-test-v1');
});
