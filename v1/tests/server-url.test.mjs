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
