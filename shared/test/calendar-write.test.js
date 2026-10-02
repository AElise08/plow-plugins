'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { run, ids, probe } = require('./helpers');
const { main } = require('../src/cli');
const { createJxaAdapter } = require('../src/adapters/jxa');
const { fakeCapabilities } = require('./fakes/fake-adapter');
const { buildData } = require('./fakes/fake-data');
const { makeWorld, createVmSpawn } = require('./fakes/fake-jxa');

const FAKE_BIN = '/nonexistent/FAKE-OSASCRIPT';
const TZ = ['--tz', 'America/Sao_Paulo'];
const C = (...a) => ['calendar', 'search', ...TZ, ...a];

// ------------------------------------------------------------------ calendar
test('calendars: ids, writable flag, same-named calendars stay distinct', async () => {
  const { env } = await run(['calendar', 'calendars']);
  assert.deepEqual(env.items.map((c) => [c.id, c.name, c.writable]), [['C1', 'Pessoal', true], ['C2', 'Pessoal', false], ['C3', 'Trabalho', true]]);
});

test('search window: overlap semantics, sorted by start, offsets in the chosen tz', async () => {
  const { env } = await run(C('--from', '2026-10-05', '--to', '2026-10-07'));
  assert.deepEqual(ids(env), ['e4', 'e3', 'e1', 'e2', 'e6']);
  assert.equal(env.items[0].start, '2026-09-30T21:00:00-03:00');
  assert.ok(!ids(env).includes('e5'));
  assert.equal(env.query.from_resolved, '2026-10-05T00:00:00-03:00');
  assert.equal(env.query.to_resolved_exclusive, '2026-10-08T00:00:00-03:00');
});

test('window edges: end of an event equal to --from is excluded; --to is exclusive', async () => {
  // e1 ends exactly 2026-10-05T18:00Z = 15:00-03:00
  assert.ok(!ids((await run(C('--calendar-id', 'C1', '--from', '2026-10-05T15:00:00-03:00', '--to', '2026-10-05T16:00:00-03:00', '--query', 'dentista'))).env).includes('e1'));
  assert.ok(ids((await run(C('--from', '2026-10-05T14:59:59-03:00', '--to', '2026-10-05T16:00:00-03:00', '--query', 'dentista'))).env).includes('e1'));
  // e1 starts exactly 14:00-03:00; a window ending then must not include it
  assert.ok(!ids((await run(C('--from', '2026-10-05T10:00:00-03:00', '--to', '2026-10-05T14:00:00-03:00', '--query', 'dentista'))).env).includes('e1'));
});

test('query matches title and location, literally; calendar scope uses ids', async () => {
  assert.deepEqual(ids((await run(C('--from', '2026-10-01', '--to', '2026-10-31', '--query', 'sorriso'))).env), ['e1']);
  assert.deepEqual(ids((await run(C('--from', '2026-10-01', '--to', '2026-10-31', '--query', '$especial\nlinha2'))).env), ['e6']);
  assert.deepEqual(ids((await run(C('--from', '2026-10-01', '--to', '2026-10-31', '--calendar-id', 'C2'))).env), ['e2']);
  assert.equal((await run(C('--from', '2026-10-01', '--to', '2026-10-31', '--calendar-id', 'nope'))).exitCode, 5);
});

test('recurring events are flagged and the result is never called complete', async () => {
  const { env } = await run(C('--from', '2026-10-05', '--to', '2026-10-06'));
  assert.equal(env.items.find((i) => i.id === 'e3').recurring, true);
  assert.equal(env.coverage.complete, false);
  assert.ok(env.coverage.reasons.includes('RECURRING_NOT_EXPANDED'));
  assert.ok(env.warnings.some((w) => w.code === 'RECURRING_NOT_EXPANDED'));
});

test('invalid windows are rejected', async () => {
  for (const argv of [
    C('--from', '2026-10-06', '--to', '2026-10-05'), C('--from', '2026-01-01', '--to', '2027-06-01'),
    C('--from', '2026-10-05T09:00:00', '--to', '2026-10-06'), C('--from', 'amanhã', '--to', '2026-10-06'),
  ]) {
    const r = await run(argv);
    assert.equal(r.env.error.code, 'INVALID_ARGUMENT', argv.join(' '));
  }
});

test('scan limit, soft deadline and unavailable fields are declared', async () => {
  const lim = await run(C('--from', '2026-10-01', '--to', '2026-10-31', '--scan-limit', '2'));
  assert.ok(lim.env.coverage.reasons.includes('SCAN_LIMIT'));
  assert.equal(lim.env.coverage.scanned, 2);
  const soft = await run(C('--from', '2026-10-01', '--to', '2026-10-31'), { faults: { stopAfter: 1 } });
  assert.ok(soft.env.coverage.reasons.includes('TIME_LIMIT'));
  const un = await run(C('--from', '2026-10-01', '--to', '2026-10-31'), { faults: { unavailable: { calendar: ['start'] } } });
  assert.ok(un.env.coverage.reasons.includes('FIELD_UNAVAILABLE'));
  assert.equal(un.env.items.length, 0, 'events without a start cannot be placed in a window');
});

test('show: limited description only here; unknown id is NOT_FOUND', async () => {
  const r = await run(['calendar', 'show', '--id', 'e1', ...TZ, '--max-chars', '10']);
  assert.equal(r.env.items[0].description.length, 10);
  assert.ok(r.env.items[0].truncated_fields.includes('description'));
  const s = await run(C('--from', '2026-10-01', '--to', '2026-10-31'));
  assert.ok(s.env.items.every((i) => !('description' in i)));
  assert.equal((await run(['calendar', 'show', '--id', 'zz'])).exitCode, 5);
});

// -------------------------------------------------------------------- writes
test('reminders create: one new item, readback verified, warning that it cannot be undone here', async () => {
  const r = await run(['reminders', 'create', ...TZ, '--title', 'Teste "aspas" $x\nlinha', '--body', 'corpo\nem duas linhas', '--due', '2026-10-09T10:30:00-03:00']);
  assert.equal(r.exitCode, 0);
  assert.equal(r.env.items[0].title, 'Teste "aspas" $x\nlinha');
  assert.equal(r.env.items[0].due, '2026-10-09T10:30:00-03:00');
  assert.equal(r.env.items[0].all_day, false);
  assert.equal(r.env.items[0].body, 'corpo\nem duas linhas');
  assert.equal(r.env.coverage.mutation, 'created');
  assert.deepEqual(r.env.coverage.readback, { title_matches_request: true, due_matches_request: true });
  assert.ok(r.env.warnings.some((w) => w.code === 'WRITE_PERFORMED'));
  assert.equal(r.data.created.length, 1);
  const call = r.adapter.calls.find((c) => c.mode === 'create');
  assert.equal(call.params.due_kind, 'datetime');
  assert.equal(call.params.list_id, null, 'default list when none is given');
});

test('reminders create: bare day becomes an all-day due; list scope uses ids', async () => {
  const r = await run(['reminders', 'create', ...TZ, '--title', 'x', '--due', '2026-10-09', '--list-id', 'L3']);
  assert.equal(r.adapter.calls.at(-1).params.due_kind, 'day');
  assert.equal(r.adapter.calls.at(-1).params.due_iso, '2026-10-09T03:00:00.000Z');
  assert.equal(r.env.items[0].list.id, 'L3');
  assert.equal(r.env.items[0].all_day, true);
  const bad = await run(['reminders', 'create', '--title', 'x', '--list-id', 'nope']);
  assert.equal(bad.env.error.code, 'NOT_FOUND');
  assert.equal(bad.env.error.write_outcome, 'not_performed');
  assert.equal(bad.data.created.length, 0);
  assert.equal((await run(['reminders', 'create', '--title', 'x', '--due', '2026-10-09T10:00:00'])).env.error.code, 'INVALID_ARGUMENT');
});

test('notes create: text is escaped into inert HTML (title first), nothing else is touched', async () => {
  const nasty = '<script>alert(1)</script> & "q" \'s\'';
  const r = await run(['notes', 'create', '--title', `T <b>${nasty}`, '--body', `linha1\n\n${nasty}`]);
  assert.equal(r.exitCode, 0);
  const html = r.adapter.calls.find((c) => c.mode === 'create').params.html;
  assert.ok(!/<script|<b>/i.test(html), html);
  assert.ok(html.startsWith('<div><h1>T &lt;b&gt;'));
  assert.ok(html.includes('<div><br></div>'));
  assert.equal(r.env.items[0].body_blocked, 'NOT_READ_AFTER_CREATE');
  assert.equal(r.env.items[0].text, null);
  assert.equal(r.env.coverage.mutation, 'created');
  assert.equal(r.data.created.length, 1);
  assert.equal((await run(['notes', 'create', '--title', 'x', '--folder-id', 'nope'])).env.error.code, 'NOT_FOUND');
});

test('a failed write says the outcome is unknown instead of inviting a blind retry', async () => {
  for (const [faults, code] of [[{ timeout: true }, 'TIMEOUT'], [{ appError: 'reminders' }, 'APP_ERROR'], [{ malformed: 'reminders' }, 'ADAPTER_SCHEMA']]) {
    const r = await run(['reminders', 'create', '--title', 'x'], { faults });
    assert.equal(r.env.error.code, code);
    assert.equal(r.env.error.write_outcome, 'unknown');
    assert.ok(r.env.error.write_hint.includes('never retry blindly'));
  }
  const denied = await run(['notes', 'create', '--title', 'x'], { faults: { permissionDenied: true } });
  assert.equal(denied.env.error.write_outcome, 'not_performed');
});

test('create is blocked when the dictionary lacks what it needs', async () => {
  const r = await run(['reminders', 'create', '--title', 'x'], { caps: { reminders: { supported: [] } } });
  assert.equal(r.env.error.code, 'BLOCKED_MISSING_PROPERTY');
  assert.equal(r.data.created.length, 0);
  assert.equal((await run(['notes', 'create', '--title', 'x'], { caps: { notes: { supported: [] } } })).exitCode, 6);
});

// -------------------------------------------------- real JXA scripts in the vm
function vmMain(argv, data = buildData(), faults) {
  const world = makeWorld(data, faults);
  const { spawnFn, calls } = createVmSpawn(world);
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  return main(argv, { adapter, capabilities: fakeCapabilities(), probe }).then((r) => ({ ...r, env: r.envelope, calls, data }));
}

test('[vm] calendar scripts: calendars, overlap window, show, unknown ids', async () => {
  let r = await vmMain(['calendar', 'calendars']);
  assert.equal(r.env.items.length, 3);
  r = await vmMain(['calendar', 'search', ...TZ, '--from', '2026-10-05', '--to', '2026-10-07']);
  assert.deepEqual(r.env.items.map((i) => i.id), ['e4', 'e3', 'e1', 'e2', 'e6']);
  assert.equal((await vmMain(['calendar', 'search', ...TZ, '--from', '2026-10-05', '--to', '2026-10-07', '--calendar-id', 'zz'])).env.error.code, 'NOT_FOUND');
  r = await vmMain(['calendar', 'show', '--id', 'e1']);
  assert.equal(r.env.items[0].description, 'Levar exames.\nAcesso pela rua $5.');
  assert.equal((await vmMain(['calendar', 'show', '--id', 'zz'])).env.error.code, 'NOT_FOUND');
  assert.equal((await vmMain(['calendar', 'calendars'], buildData(), { permissionDenied: 'calendar' })).env.error.code, 'PERMISSION_DENIED');
});

test('[vm] create scripts run from the write dir and create exactly one item', async () => {
  const data = buildData();
  let r = await vmMain(['reminders', 'create', ...TZ, '--title', 'Via vm', '--body', 'b', '--due', '2026-10-09T10:30:00-03:00'], data);
  assert.equal(r.env.ok, true, JSON.stringify(r.env));
  assert.equal(r.env.items[0].due, '2026-10-09T10:30:00-03:00');
  assert.equal(r.env.items[0].list.name, 'Casa');
  r = await vmMain(['notes', 'create', '--title', 'Nota vm', '--body', 'oi <b>x</b>'], data);
  assert.equal(r.env.ok, true, JSON.stringify(r.env));
  assert.equal(r.env.items[0].title, 'Nota vm');
  assert.equal(data.created.length, 2, 'one item per create call');
  assert.ok(!/<b>/.test(data.created[1].html));
  assert.equal(r.calls.length, 1);
  const bad = await vmMain(['reminders', 'create', '--title', 'x', '--list-id', 'zz'], data);
  assert.equal(bad.env.error.code, 'NOT_FOUND');
  assert.equal(data.created.length, 2);
});

test('[vm] write scripts are only used by create; read modes never load them', async () => {
  const seen = [];
  const world = makeWorld(buildData());
  const { spawnFn } = createVmSpawn(world);
  const spy = (bin, args, o) => { seen.push({ mode: args[4], pushes: /\.(reminders|notes)\.push\(/.test(args[3]) }); return spawnFn(bin, args, o); };
  const adapter = createJxaAdapter({ spawnFn: spy, osascript: FAKE_BIN });
  await main(['reminders', 'search'], { adapter, capabilities: fakeCapabilities(), probe });
  await main(['notes', 'create', '--title', 'x'], { adapter, capabilities: fakeCapabilities(), probe });
  assert.deepEqual(seen.map((s) => [s.mode, s.pushes]), [['scan', false], ['create', true]]);
  const direct = createJxaAdapter({ spawnFn: () => new EventEmitter(), osascript: FAKE_BIN });
  await assert.rejects(direct.call('contacts', 'create', {}, { timeoutMs: 100 }), (e) => e.code === 'INTERNAL');
  await assert.rejects(direct.call('contacts', 'delete', {}, { timeoutMs: 100 }), (e) => e.code === 'INTERNAL');
  await assert.rejects(direct.call('reminders', 'update', {}, { timeoutMs: 100 }), (e) => e.code === 'INTERNAL');
  await assert.rejects(direct.call('notes', 'update', {}, { timeoutMs: 100 }), (e) => e.code === 'INTERNAL');
});
