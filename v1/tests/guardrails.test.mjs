import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateServerUrl, createClient } from '../src/backend-api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'src/backend-api.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const backend = fs.readFileSync(path.resolve(root, '../backend/vps/app.py'), 'utf8');

test('no Supabase in V1 runtime and all inventory writes use central API', () => {
  assert.doesNotMatch(main + bridge, /supabase-js|VITE_SUPABASE/);
  assert.match(main, /VITE_RAMAGAN_API_URL/);
  assert.match(main, /ramagan_create_product/);
  assert.match(main, /ramagan_receive_lot/);
  assert.match(main, /transport: api\.checkoutTransport/);
  assert.match(bridge, /post: payload => request\('POST', '\/v1\/sales', payload\)/);
  assert.match(bridge, /\/v1\/sales/);
  assert.match(backend, /BEGIN IMMEDIATE/);
  assert.match(backend, /sales_enabled INTEGER NOT NULL DEFAULT 0/);
});

test('URL validation requires HTTPS except loopback development', () => {
  assert.equal(validateServerUrl('https://pos.example.com/ramagan-api/'),
               'https://pos.example.com/ramagan-api');
  assert.equal(validateServerUrl('http://localhost:8766/'), 'http://localhost:8766');
  for (const x of ['http://example.com/api', 'javascript:alert(1)',
    'https://user:pass@example.com', 'https://example.com?token=secret',
    '', 'http://0.0.0.0:8766']) {
    assert.equal(validateServerUrl(x), null);
  }
});

test('cached PWA never caches remote API responses', () => {
  assert.match(sw, /target\.origin !== self\.location\.origin/);
  assert.match(sw, /Offline shell ONLY/);
});

test('the VPS API uses opaque sessions and transaction barriers', () => {
  assert.match(backend, /secrets\.token_urlsafe/);
  assert.match(backend, /UPDATE lot_balances SET quantity_mg=quantity_mg-\?/);
  assert.match(backend, /CHECK\(quantity_mg >= 0\)/);
  assert.match(backend, /ledger_no_update/);
});

test('owner/manager website reports link stays external and has no token in URL', () => {
  assert.match(main, /https:\/\/nustanakritwithai\.github\.io\/Ramagan\/admin\//);
  assert.match(main, /rel="noopener noreferrer"/);
});
