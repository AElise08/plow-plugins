'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, probe } = require('./helpers');
const { main } = require('../src/cli');
const { bytes, MAX_OUTPUT_BYTES } = require('../src/contract');
const { buildData, bulkContacts } = require('./fakes/fake-data');
const { fakeCapabilities } = require('./fakes/fake-adapter');

const REQUIRED = ['schema_version', 'ok', 'source', 'items', 'warnings', 'coverage'];

test('every outcome is exactly one JSON object with the required keys', async () => {
  const outcomes = [
    await run(['contacts', 'search', '--query', 'ana']), await run(['help']), await run(['doctor']),
    await run(['contacts', 'search']), await run(['notes', 'delete']), await run(['contacts', 'show', '--id', 'zz']),
    await run(['contacts', 'search', '--query', 'a'], { faults: { permissionDenied: true } }),
  ];
  for (const o of outcomes) {
    for (const k of REQUIRED) assert.ok(k in o.env, `${k} missing in ${JSON.stringify(o.env).slice(0, 80)}`);
    assert.equal(o.env.schema_version, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(o.env)), o.env);
  }
});

test('errors are never an empty list: items/coverage are null, code is structured, exit != 0', async () => {
  const cases = [
    [{ permissionDenied: true }, 'PERMISSION_DENIED', 3],
    [{ timeout: true }, 'TIMEOUT', 4],
    [{ appError: 'contacts' }, 'APP_ERROR', 7],
    [{ malformed: 'contacts' }, 'ADAPTER_SCHEMA', 8],
  ];
  const seen = new Set();
  for (const [faults, code, exit] of cases) {
    const r = await run(['contacts', 'search', '--query', 'a'], { faults });
    assert.equal(r.env.ok, false);
    assert.equal(r.env.items, null);
    assert.equal(r.env.coverage, null);
    assert.equal(r.env.error.code, code);
    assert.equal(r.exitCode, exit);
    assert.ok(r.env.error.detail.length > 0);
    seen.add(code);
  }
  assert.equal(seen.size, 4, 'permission, timeout, adapter and app errors are distinct states');
  const nf = await run(['contacts', 'show', '--id', 'zz']);
  assert.equal(nf.env.error.code, 'NOT_FOUND');
});

test('an unexpected exception never leaks its message (could contain personal data)', async () => {
  const adapter = { async call() { throw new Error('Conteúdo pessoal: Maria 11 99999-0000'); } };
  const r = await main(['contacts', 'search', '--query', 'a'], { adapter, capabilities: fakeCapabilities(), probe });
  assert.equal(r.envelope.error.code, 'INTERNAL');
  assert.ok(!JSON.stringify(r.envelope).includes('Maria'));
  assert.equal(r.exitCode, 1);
});

test('blocked app: missing required dictionary property blocks that app only', async () => {
  const caps = { notes: { blocked: true, missing_required: ['note.property:id'] } };
  const n = await run(['notes', 'folders'], { caps });
  assert.equal(n.exitCode, 6);
  assert.equal(n.env.error.code, 'BLOCKED_MISSING_PROPERTY');
  assert.deepEqual(n.env.error.missing, ['note.property:id']);
  assert.equal((await run(['contacts', 'search', '--query', 'ana'], { caps })).exitCode, 0);
});

test('output cap: 32 KiB total, still valid JSON, truncation declared', async () => {
  const data = buildData();
  data.contacts.people = bulkContacts(50).map((p) => ({ ...p, name: 'N'.repeat(2000) }));
  const r = await run(['contacts', 'search', '--query', 'N', '--limit', '50', '--max-chars', '2000'], { data });
  assert.ok(bytes(r.env) <= MAX_OUTPUT_BYTES, String(bytes(r.env)));
  assert.equal(r.env.coverage.output_truncated, true);
  assert.ok(r.env.coverage.returned < 50 && r.env.coverage.returned === r.env.items.length);
  assert.ok(r.env.warnings.some((w) => w.code === 'OUTPUT_TRUNCATED'));
  assert.equal(r.env.coverage.matched, 50);
});

test('help lists only the enumerated commands and flags every writer', async () => {
  const { env } = await run(['help']);
  assert.deepEqual(env.items.map((i) => i.command).sort(), [
    'calendar calendars', 'calendar create', 'calendar delete', 'calendar search', 'calendar show', 'calendar update',
    'contacts search', 'contacts show', 'doctor', 'help',
    'notes create', 'notes delete', 'notes folders', 'notes search', 'notes show',
    'reminders create', 'reminders delete', 'reminders lists', 'reminders search', 'reminders show',
  ]);
  assert.deepEqual(env.items.filter((i) => !i.read_only).map((i) => i.command).sort(), [
    'calendar create', 'calendar delete', 'calendar update', 'notes create', 'notes delete', 'reminders create', 'reminders delete',
  ]);
  assert.deepEqual(env.items.filter((i) => i.destructive).map((i) => i.command).sort(), ['calendar delete', 'notes delete', 'reminders delete']);
  assert.ok(env.warnings.some((w) => w.code === 'REMOTE_CONTEXT'));
});

test('doctor reports dictionary state without querying data', async () => {
  const r = await run(['doctor']);
  assert.equal(r.env.ok, true);
  assert.equal(r.adapter.calls.length, 0, 'doctor must not call the adapter');
  assert.ok(r.env.warnings.some((w) => w.code === 'AUTOMATION_NOT_CHECKED'));
  const blocked = await run(['doctor'], { caps: { reminders: { blocked: true, missing_required: ['reminder.property:id'] } } });
  const rem = blocked.env.items.find((i) => i.app === 'reminders');
  assert.equal(rem.commands, 'blocked');
  assert.equal(blocked.env.coverage.complete, false);
});
