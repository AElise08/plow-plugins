'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, probe } = require('./helpers');
const { main } = require('../src/cli');
const { createJxaAdapter } = require('../src/adapters/jxa');
const { fakeCapabilities } = require('./fakes/fake-adapter');
const { buildData, BAIT_NOTE_TEXT } = require('./fakes/fake-data');
const { makeWorld, createVmSpawn } = require('./fakes/fake-jxa');

const FAKE_BIN = '/nonexistent/FAKE-OSASCRIPT';
const TZ = ['--tz', 'America/Sao_Paulo'];
const del = (g, id, title, ...rest) => [g, 'delete', '--id', id, '--expect-title', title, ...rest];
const mutations = (data) => data.created.filter((c) => c.mutation === 'delete' || c.mutation === 'create' || c.mutation === 'set');

// -------------------------------------------------------------------- delete
test('reminders delete: removes exactly that item, verifies it is gone, says it cannot be restored here', async () => {
  const r = await run(del('reminders', 'r2', 'Ligar para Ana'));
  assert.equal(r.exitCode, 0);
  assert.deepEqual([r.env.items[0].id, r.env.items[0].title, r.env.items[0].verified_gone], ['r2', 'Ligar para Ana', true]);
  assert.equal(r.env.coverage.mutation, 'deleted');
  assert.ok(r.env.warnings.some((w) => w.code === 'DELETE_PERFORMED'));
  assert.deepEqual(r.data.reminders.items.map((i) => i.id), ['r1', 'r3', 'r4', 'r5', 'r6', 'r7']);
  assert.equal(mutations(r.data).length, 1);
});

test('delete identity guard: a stale or wrong id cannot hit another item (nothing changes)', async () => {
  const r = await run(del('reminders', 'r2', 'Pagar conta de luz'));
  assert.equal(r.exitCode, 10);
  assert.equal(r.env.error.code, 'GUARD_REFUSED');
  assert.equal(r.env.error.reason, 'title_mismatch');
  assert.equal(r.env.error.write_outcome, 'not_performed');
  assert.equal(r.env.items, null);
  assert.equal(r.data.reminders.items.length, 7);
  assert.equal((await run(del('reminders', 'nope', 'x'))).exitCode, 5);
  // a prefix of the title that the caller saw is accepted; the full title also is
  assert.equal((await run(del('reminders', 'r2', 'Ligar'))).exitCode, 0);
});

test('delete verification: an item the app still reports is flagged, not claimed deleted', async () => {
  const r = await run(del('reminders', 'r2', 'Ligar para Ana'), { faults: { unverifiedDelete: true } });
  assert.equal(r.env.ok, true);
  assert.equal(r.env.coverage.complete, false);
  assert.ok(r.env.warnings.some((w) => w.code === 'DELETE_NOT_VERIFIED'));
  assert.equal(r.env.items[0].deleted, null);
});

test('notes delete that leaves the note in the trash folder says where it is', async () => {
  const r = await run(del('notes', 'n4', 'Receita'), { faults: { unverifiedDelete: true } });
  assert.equal(r.env.items[0].remaining_folder, 'Recently Deleted');
  assert.equal(r.env.items[0].verified_gone, false);
  assert.ok(r.env.warnings.some((w) => w.code === 'STILL_IN_FOLDER'));
  assert.ok(!r.env.warnings.some((w) => w.code === 'DELETE_NOT_VERIFIED'));
  assert.deepEqual(r.env.coverage.reasons, ['STILL_IN_FOLDER']);
});

test('notes delete: never a protected or unproven note; its text is never read', async () => {
  const data = buildData();
  const prot = await run(del('notes', 'n2', 'Ideias secretas'), { data });
  assert.equal(prot.env.error.reason, 'protected_note');
  const unk = await run(del('notes', 'n5', 'Sem marcador'), { data });
  assert.equal(unk.env.error.reason, 'protection_unknown');
  assert.equal(data.touched.bait, 0);
  assert.equal(data.notes.items.length, 6);
  const ok = await run(del('notes', 'n4', 'Receita'), { data });
  assert.equal(ok.exitCode, 0);
  assert.equal(data.notes.items.length, 5);
  assert.ok(ok.env.warnings.some((w) => w.code === 'DELETE_PERFORMED' && w.message.includes('Recently Deleted')));
});

test('calendar delete: refuses read-only calendars, repeating events, events with guests and wrong titles', async () => {
  const data = buildData();
  assert.equal((await run(del('calendar', 'e2', 'Aniversário da Ana'), { data })).env.error.reason, 'read_only_calendar');
  assert.equal((await run(del('calendar', 'e3', 'Reunião semanal'), { data })).env.error.reason, 'recurring_event');
  assert.equal((await run(del('calendar', 'e7', 'Reunião com convidados'), { data })).env.error.reason, 'has_attendees');
  assert.equal((await run(del('calendar', 'e1', 'Outro título'), { data })).env.error.reason, 'title_mismatch');
  assert.equal(data.calendar.events.length, 7, 'nothing was deleted');
  const ok = await run(del('calendar', 'e1', 'Dentista'), { data });
  assert.equal(ok.exitCode, 0);
  assert.equal(data.calendar.events.length, 6);
  assert.equal((await run(del('calendar', 'zz', 'x'))).exitCode, 5);
});

test('failed deletes say the outcome is unknown; guard refusals say not_performed', async () => {
  const t = await run(del('reminders', 'r2', 'Ligar'), { faults: { timeout: true } });
  assert.equal(t.env.error.write_outcome, 'unknown');
  assert.ok(t.env.error.write_hint);
  const denied = await run(del('notes', 'n1', 'Lista'), { faults: { permissionDenied: true } });
  assert.equal(denied.env.error.write_outcome, 'not_performed');
});

// ------------------------------------------------------------ calendar create
test('calendar create: timed event in a writable calendar, no guests, readback verified', async () => {
  const r = await run(['calendar', 'create', ...TZ, '--calendar-id', 'C1', '--title', 'Almoço "com aspas" $x', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00', '--location', 'Centro', '--description', 'linha1\nlinha2']);
  assert.equal(r.exitCode, 0, JSON.stringify(r.env));
  assert.equal(r.env.items[0].title, 'Almoço "com aspas" $x');
  assert.equal(r.env.items[0].start, '2026-10-09T12:00:00-03:00');
  assert.equal(r.env.items[0].description, 'linha1\nlinha2');
  assert.equal(r.env.query.attendees, 'none (nothing is sent to anyone)');
  assert.deepEqual(r.env.coverage.readback, { title_matches_request: true, start_matches_request: true, end_matches_request: true });
  assert.equal(r.data.calendar.events.at(-1).attendees, 0);
});

test('calendar create: all-day uses whole days (end inclusive); validation and read-only refusals', async () => {
  const r = await run(['calendar', 'create', ...TZ, '--calendar-id', 'C3', '--title', 'Feriado', '--all-day', '--start', '2026-10-12', '--end', '2026-10-13']);
  const ev = r.adapter.calls.find((c) => c.mode === 'create').params;
  assert.equal(ev.start_iso, '2026-10-12T03:00:00.000Z');
  assert.equal(ev.end_iso, '2026-10-14T02:59:59.000Z');
  assert.equal(ev.all_day, true);
  assert.equal(r.env.coverage.readback.end_matches_request, true);
  const base = ['calendar', 'create', ...TZ, '--calendar-id', 'C1', '--title', 'x'];
  for (const extra of [
    ['--start', '2026-10-09T12:00:00-03:00'], // no end
    ['--start', '2026-10-09', '--end', '2026-10-10'], // bare day without --all-day
    ['--start', '2026-10-09T13:00:00-03:00', '--end', '2026-10-09T12:00:00-03:00'],
    ['--all-day', '--start', '2026-10-09T09:00:00-03:00'],
    ['--start', '2026-10-09T12:00:00', '--end', '2026-10-09T13:00:00'], // no offset
  ]) assert.equal((await run([...base, ...extra])).env.error.code, 'INVALID_ARGUMENT', extra.join(' '));
  const ro = await run(['calendar', 'create', '--calendar-id', 'C2', '--title', 'x', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00']);
  assert.equal(ro.env.error.reason, 'read_only_calendar');
  assert.equal(ro.env.error.write_outcome, 'not_performed');
  assert.equal((await run(['calendar', 'create', '--calendar-id', 'nope', '--title', 'x', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00'])).exitCode, 5);
});

// ------------------------------------------------------------ calendar update
test('calendar update: only the given fields change, with readback of each', async () => {
  const data = buildData();
  const r = await run(['calendar', 'update', ...TZ, '--id', 'e1', '--expect-title', 'Dentista', '--title', 'Dentista (remarcado)', '--start', '2026-10-06T10:00:00-03:00', '--end', '2026-10-06T11:00:00-03:00', '--location', 'Outra clínica'], { data });
  assert.equal(r.exitCode, 0, JSON.stringify(r.env));
  assert.deepEqual(r.env.coverage.changed.sort(), ['end', 'location', 'start', 'title']);
  assert.deepEqual(Object.values(r.env.coverage.readback), [true, true, true, true]);
  const x = data.calendar.events.find((e) => e.id === 'e1');
  assert.deepEqual([x.title, x.location, x.start, x.end], ['Dentista (remarcado)', 'Outra clínica', '2026-10-06T13:00:00.000Z', '2026-10-06T14:00:00.000Z']);
  assert.equal(x.description, 'Levar exames.\nAcesso pela rua $5.', 'untouched field stays');
});

test('calendar update guards: identity, read-only, repeating, guests, all-day time changes, empty change', async () => {
  const data = buildData();
  const U = (id, title, ...rest) => run(['calendar', 'update', ...TZ, '--id', id, '--expect-title', title, ...rest], { data });
  assert.equal((await U('e1', 'Errado', '--title', 'N')).env.error.reason, 'title_mismatch');
  assert.equal((await U('e2', 'Aniversário', '--title', 'N')).env.error.reason, 'read_only_calendar');
  assert.equal((await U('e3', 'Reunião semanal', '--title', 'N')).env.error.reason, 'recurring_event');
  assert.equal((await U('e7', 'Reunião com', '--title', 'N')).env.error.reason, 'has_attendees');
  data.calendar.events.push({ id: 'ed', calendar_id: 'C1', title: 'Dia inteiro', start: '2026-10-20T03:00:00Z', end: '2026-10-21T02:59:59Z', all_day: true, location: null, recurrence: '', description: null });
  assert.equal((await U('ed', 'Dia inteiro', '--start', '2026-10-21T09:00:00-03:00')).env.error.reason, 'all_day_time_change');
  assert.equal((await U('ed', 'Dia inteiro', '--title', 'Dia inteiro 2')).exitCode, 0, 'text fields of an all-day event can change');
  assert.equal((await U('e1', 'Dentista')).env.error.code, 'INVALID_ARGUMENT');
  assert.equal((await U('e1', 'Dentista', '--start', '2026-10-06')).env.error.code, 'INVALID_ARGUMENT');
  assert.equal((await U('zz', 'x', '--title', 'N')).exitCode, 5);
  assert.equal(data.calendar.events.find((e) => e.id === 'e1').title, 'Dentista', 'refused calls changed nothing');
});

test('event writes are blocked when the dictionary lacks the guard properties', async () => {
  const caps = { calendar: { supported: ['event_description'] } };
  for (const argv of [
    ['calendar', 'create', '--calendar-id', 'C1', '--title', 'x', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00'],
    ['calendar', 'update', '--id', 'e1', '--expect-title', 'D', '--title', 'N'], del('calendar', 'e1', 'D'),
  ]) {
    const r = await run(argv, { caps });
    assert.equal(r.env.error.code, 'BLOCKED_MISSING_PROPERTY');
    assert.equal(mutations(r.data).length, 0);
  }
});

// ----------------------------------------- the REAL write scripts, in the vm
function vmMain(argv, data = buildData(), faults) {
  const world = makeWorld(data, faults);
  const { spawnFn } = createVmSpawn(world);
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  return main(argv, { adapter, capabilities: fakeCapabilities(), probe }).then((r) => ({ ...r, env: r.envelope, data }));
}

test('[vm] delete scripts: identity guard, protection guard, verification', async () => {
  const data = buildData();
  assert.equal((await vmMain(del('reminders', 'r2', 'Outro'), data)).env.error.reason, 'title_mismatch');
  assert.equal(data.reminders.items.length, 7);
  let r = await vmMain(del('reminders', 'r2', 'Ligar para Ana'), data);
  assert.equal(r.env.ok, true, JSON.stringify(r.env));
  assert.equal(r.env.items[0].verified_gone, true);
  assert.equal(data.reminders.items.length, 6);
  assert.equal((await vmMain(del('reminders', 'r2', 'Ligar para Ana'), data)).env.error.code, 'NOT_FOUND', 'already gone');
  assert.equal((await vmMain(del('notes', 'n2', 'Ideias secretas'), data)).env.error.reason, 'protected_note');
  assert.equal((await vmMain(del('notes', 'n5', 'Sem marcador'), data)).env.error.reason, 'protection_unknown');
  assert.equal(data.touched.bait, 0, 'protected note text must stay unread');
  r = await vmMain(del('notes', 'n4', 'Receita'), data);
  assert.equal(r.env.ok, true);
  assert.equal(data.notes.items.some((n) => n.id === 'n4'), false);
  const unverified = await vmMain(del('reminders', 'r1', 'Pagar conta'), buildData(), { unverifiedDelete: true });
  assert.equal(unverified.env.items[0].verified_gone, false);
  assert.ok(unverified.env.warnings.some((w) => w.code === 'DELETE_NOT_VERIFIED'));
});

test('[vm] calendar scripts: guards run before any change; create/update/delete work through the real code', async () => {
  const data = buildData();
  const before = JSON.stringify(data.calendar.events);
  for (const [argv, reason] of [
    [del('calendar', 'e2', 'Aniversário da Ana'), 'read_only_calendar'],
    [del('calendar', 'e3', 'Reunião semanal'), 'recurring_event'],
    [del('calendar', 'e7', 'Reunião com convidados'), 'has_attendees'],
    [del('calendar', 'e1', 'Errado'), 'title_mismatch'],
    [['calendar', 'update', '--id', 'e3', '--expect-title', 'Reunião', '--title', 'X'], 'recurring_event'],
    [['calendar', 'update', '--id', 'e7', '--expect-title', 'Reunião', '--title', 'X'], 'has_attendees'],
    [['calendar', 'create', '--calendar-id', 'C2', '--title', 'x', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00'], 'read_only_calendar'],
  ]) {
    const r = await vmMain(argv, data);
    assert.equal(r.env.error.reason, reason, argv.join(' '));
    assert.equal(r.env.error.write_outcome, 'not_performed');
  }
  assert.equal(JSON.stringify(data.calendar.events), before, 'a refused call must not change anything');
  assert.equal(mutations(data).length, 0);

  let r = await vmMain(['calendar', 'create', ...TZ, '--calendar-id', 'C1', '--title', 'Novo evento', '--start', '2026-10-09T12:00:00-03:00', '--end', '2026-10-09T13:00:00-03:00', '--location', 'Sala'], data);
  assert.equal(r.env.ok, true, JSON.stringify(r.env));
  const id = r.env.items[0].id;
  assert.deepEqual(r.env.coverage.readback, { title_matches_request: true, start_matches_request: true, end_matches_request: true });
  r = await vmMain(['calendar', 'update', ...TZ, '--id', id, '--expect-title', 'Novo', '--title', 'Novo (editado)', '--end', '2026-10-09T14:00:00-03:00'], data);
  assert.equal(r.env.ok, true, JSON.stringify(r.env));
  assert.deepEqual(r.env.coverage.changed.sort(), ['end', 'title']);
  assert.equal(r.env.items[0].title, 'Novo (editado)');
  assert.equal(r.env.items[0].location, 'Sala', 'untouched field stays');
  r = await vmMain(del('calendar', id, 'Novo (editado)'), data);
  assert.equal(r.env.ok, true);
  assert.equal(r.env.items[0].verified_gone, true);
  assert.equal(data.calendar.events.some((e) => e.id === id), false);
  assert.equal((await vmMain(del('calendar', id, 'Novo'), data)).env.error.code, 'NOT_FOUND');
});

test('[vm] no mutation without matching guards even if the title merely looks similar', async () => {
  const data = buildData();
  const r = await vmMain(del('notes', 'n1', 'lista de compras'), data); // case differs: guard is exact
  assert.equal(r.env.error.reason, 'title_mismatch');
  assert.equal(data.notes.items.length, 6);
  assert.ok(!JSON.stringify(r.env).includes(BAIT_NOTE_TEXT));
});

test('a sandbox refusal is not_performed: the app said no before changing anything', async () => {
  const { QueryError } = require('../src/errors');
  const adapter = { async call() { throw new QueryError('SANDBOX_REFUSED'); } };
  for (const argv of [['reminders', 'create', '--title', 'x'], del('notes', 'n1', 'Lista')]) {
    const r = await run(argv, { adapter });
    assert.equal(r.env.error.code, 'SANDBOX_REFUSED');
    assert.equal(r.exitCode, 3);
    assert.equal(r.env.error.write_outcome, 'not_performed');
  }
});
