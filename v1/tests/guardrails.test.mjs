import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const sql = fs.readFileSync(path.resolve(root, '../backend/sql/001_v1_central.sql'), 'utf8');

test('frontend only holds publishable key and uses checkout RPC', () => {
  assert.match(main, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(main, /service_role|sb_secret_/);
  assert.match(main, /\.rpc\('ramagan_checkout'/);
  assert.doesNotMatch(main, /\.from\('ramagan_ledger_events'\)\.insert/);
});

test('offline shell must not cache remote API responses', () => {
  assert.match(sw, /target\.origin !== self\.location\.origin/);
  assert.match(sw, /Offline shell ONLY/);
});

test('SQL is closed for client writes and gated for release', () => {
  assert.match(sql, /sales_enabled boolean not null default false/);
  assert.match(sql, /alter table public\.ramagan_sales enable row level security;/);
  assert.match(sql, /from public, anon, authenticated;/);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /Checkout ID reused with different request/);
  assert.match(sql, /for update of b;/);
  assert.match(sql, /m\.store_id = public\.ramagan_sales\.store_id/);
  assert.match(sql, /m\.store_id = public\.ramagan_products\.store_id/);
});