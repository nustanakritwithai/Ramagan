import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServerUrl } from '../src/backend-api.js';

test('API URL supports a reverse proxy prefix', () => {
  assert.equal(validateServerUrl('https://your-domain.com/ramagan-api/'),
    'https://your-domain.com/ramagan-api');
});
test('API URL cannot carry credentials or unencrypted public transport', () => {
  assert.equal(validateServerUrl('https://abc:123@host.com'), null);
  assert.equal(validateServerUrl('http://host.com'), null);
});
test('API URL rejects invisible and encoded unsafe suffixes instead of silently choosing another route', () => {
  for (const suffix of ['\u200B', '%E2%80%8B', '\uFEFF', '%EF%BB%BF', '%20', '%0a', '%09', '%3fsecret', '%23fragment', '%255c', '\\other']) {
    assert.equal(validateServerUrl('https://157.85.96.139/ramagan-api' + suffix), null, suffix);
  }
  assert.equal(validateServerUrl('https://157.85.96.139/ramagan-\napi'), null);
  assert.equal(validateServerUrl('https://157.85.96.139/ramagan-api/'), 'https://157.85.96.139/ramagan-api');
  assert.equal(validateServerUrl('https://shop.example.test/custom-api'), 'https://shop.example.test/custom-api');
});
