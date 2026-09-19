/**
 * Pure merge/conflict unit tests — no OAuth / network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const drive = require(path.join(root, 'js/drive.js')) || globalThis.RamaganDrive;
const {
  analyzeMerge,
  resolveMerge,
  unionSnapshots,
  payloadsEqual,
  isEmptySnapshot,
  buildSnapshot
} = drive;

assert.equal(typeof analyzeMerge, 'function');
assert.equal(isEmptySnapshot({ lots: [], events: [] }), true);
assert.equal(isEmptySnapshot({ lots: [{ lot_id: 'L1' }], events: [] }), false);

const ev = (id, extra) =>
  Object.assign(
    {
      event_id: id,
      lot_id: 'LOT-A',
      type: 'SALE',
      qty: 1,
      qty_delta: -1,
      actor_user_id: 'cashier',
      reason: 't',
      occurred_at: '2026-09-19T01:00:00.000Z'
    },
    extra || {}
  );

const lot = (id) => ({ lot_id: id, sku: id, product_name: id, unit: 'g' });

// remote empty → upload local
{
  const local = { lots: [lot('LOT-A')], events: [ev('EVT-1')] };
  const r = analyzeMerge(local, { lots: [], events: [] });
  assert.equal(r.action, 'upload_local');
}

// local empty → adopt remote
{
  const remote = { lots: [lot('LOT-A')], events: [ev('EVT-1')] };
  const r = analyzeMerge({ lots: [], events: [] }, remote);
  assert.equal(r.action, 'adopt_remote');
}

// remote subset → safe apply_merged (pull remote-only into local? wait — local has extra only)
{
  const local = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-1'), ev('EVT-2')]
  };
  const remote = { lots: [lot('LOT-A')], events: [ev('EVT-1')] };
  const r = analyzeMerge(local, remote);
  // local-only extras, remote has no unique → not divergent → apply or upload
  assert.ok(r.action === 'apply_merged' || r.action === 'noop' || r.action === 'upload_local');
  // actually merged equals local content for events → may be noop if local already has union
  const merged = r.merged || resolveMerge(local, remote, 'merge_union');
  assert.equal(merged.events.length, 2);
}

// local subset of remote → apply_merged
{
  const local = { lots: [lot('LOT-A')], events: [ev('EVT-1')] };
  const remote = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-1'), ev('EVT-3', { occurred_at: '2026-09-19T02:00:00.000Z' })]
  };
  const r = analyzeMerge(local, remote);
  assert.equal(r.action, 'apply_merged');
  assert.equal(r.merged.events.length, 2);
}

// divergent histories → conflict (no auto-guess)
{
  const local = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-L')]
  };
  const remote = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-R')]
  };
  const r = analyzeMerge(local, remote);
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'divergent_histories');
  assert.ok(r.localOnlyIds.includes('EVT-L'));
  assert.ok(r.remoteOnlyIds.includes('EVT-R'));
}

// same id different payload → conflict
{
  const local = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-X', { qty: 1, qty_delta: -1 })]
  };
  const remote = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-X', { qty: 2, qty_delta: -2 })]
  };
  const r = analyzeMerge(local, remote);
  assert.equal(r.action, 'conflict');
  assert.ok(r.conflicts.some((c) => c.event_id === 'EVT-X'));
}

// resolve keep_local / keep_remote
{
  const local = { lots: [lot('LOT-A')], events: [ev('EVT-L')] };
  const remote = { lots: [lot('LOT-B')], events: [ev('EVT-R')] };
  const kl = resolveMerge(local, remote, 'keep_local');
  assert.equal(kl.events.length, 1);
  assert.equal(kl.events[0].event_id, 'EVT-L');
  const kr = resolveMerge(local, remote, 'keep_remote');
  assert.equal(kr.events[0].event_id, 'EVT-R');
}

// merge_keep_local: union + local wins on conflict
{
  const local = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-1'), ev('EVT-X', { qty: 1, qty_delta: -1, reason: 'local' })]
  };
  const remote = {
    lots: [lot('LOT-A'), lot('LOT-B')],
    events: [ev('EVT-2'), ev('EVT-X', { qty: 9, qty_delta: -9, reason: 'remote' })]
  };
  const m = resolveMerge(local, remote, 'merge_keep_local');
  const ids = m.events.map((e) => e.event_id).sort();
  assert.deepEqual(ids, ['EVT-1', 'EVT-2', 'EVT-X']);
  const x = m.events.find((e) => e.event_id === 'EVT-X');
  assert.equal(x.reason, 'local');
  assert.ok(m.lots.some((l) => l.lot_id === 'LOT-B'));
}

// merge_keep_remote: remote wins on conflict
{
  const local = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-X', { reason: 'local' })]
  };
  const remote = {
    lots: [lot('LOT-A')],
    events: [ev('EVT-X', { reason: 'remote', qty: 3, qty_delta: -3 })]
  };
  const m = resolveMerge(local, remote, 'merge_keep_remote');
  assert.equal(m.events[0].reason, 'remote');
}

// equal payloads → not conflict; preferNewer path
{
  const a = ev('EVT-1');
  const b = ev('EVT-1');
  assert.equal(payloadsEqual(a, b), true);
  const r = analyzeMerge(
    { lots: [lot('LOT-A')], events: [a] },
    { lots: [lot('LOT-A')], events: [b] }
  );
  assert.ok(r.action === 'noop' || r.action === 'apply_merged');
}

// buildSnapshot has updated_at
{
  const s = buildSnapshot({ lots: [], events: [] });
  assert.ok(s.updated_at);
}

// unionSnapshots prefer_newer_equal when bodies match after stripping times
{
  const a = ev('EVT-1', { occurred_at: '2026-09-19T01:00:00.000Z' });
  const b = ev('EVT-1', { occurred_at: '2026-09-19T03:00:00.000Z' });
  // full payloads differ due to occurred_at → analyzeMerge conflicts
  const conflict = analyzeMerge(
    { lots: [lot('LOT-A')], events: [a] },
    { lots: [lot('LOT-A')], events: [b] }
  );
  assert.equal(conflict.action, 'conflict');
  // explicit union helper still picks newer when using prefer_newer_equal on stripped equality
  const u = unionSnapshots(
    { lots: [lot('LOT-A')], events: [a] },
    { lots: [lot('LOT-A')], events: [b] },
    'prefer_newer_equal'
  );
  assert.equal(u.events[0].occurred_at, '2026-09-19T03:00:00.000Z');
}

console.log('drive-merge.smoke: PASS');
