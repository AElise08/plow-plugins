'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, ids } = require('./helpers');

const TZ = ['--tz', 'America/Sao_Paulo'];
const S = (...a) => ['reminders', 'search', ...TZ, ...a];

test('lists keep account and distinct ids for same-named lists', async () => {
  const { env } = await run(['reminders', 'lists']);
  assert.deepEqual(env.items.map((l) => [l.id, l.name, l.account.name]), [
    ['L1', 'Casa', 'iCloud'], ['L2', 'Casa', 'No meu Mac'], ['L3', 'Trabalho', 'iCloud'],
  ]);
});

test('default: pending only, dated first by due, undated last, offsets in the chosen tz', async () => {
  const { env } = await run(S());
  assert.deepEqual(ids(env), ['r3', 'r5', 'r1', 'r7', 'r6', 'r2']);
  assert.equal(env.items[0].due, '2026-10-03T00:00:00-03:00');
  assert.equal(env.items[5].due, null);
  assert.equal(env.items[5].has_due, false);
  assert.equal(env.query.status, 'pending');
  const utc = await run(['reminders', 'search', '--tz', 'UTC']);
  assert.equal(utc.env.items[0].due, '2026-10-03T03:00:00+00:00');
});

test('status filter: pending / completed / all', async () => {
  assert.deepEqual(ids((await run(S('--status', 'completed'))).env), ['r4']);
  assert.equal((await run(S('--status', 'all'))).env.items.length, 7);
});

test('interval is from-inclusive / to-exclusive with exact instants (midnight edges)', async () => {
  // r3 is exactly 2026-10-03T00:00-03:00, r7 exactly 2026-10-06T00:00-03:00
  const a = await run(S('--due-from', '2026-10-03T00:00:00-03:00', '--due-to', '2026-10-06T00:00:00-03:00'));
  assert.deepEqual(ids(a.env), ['r3', 'r5', 'r1'], 'start included, end excluded');
  const b = await run(S('--due-from', '2026-10-03T00:00:00.001-03:00', '--due-to', '2026-10-06T00:00:00.001-03:00'));
  assert.deepEqual(ids(b.env), ['r5', 'r1', 'r7']);
  const c = await run(S('--due-from', '2026-10-06T00:00:00-03:00'));
  assert.ok(ids(c.env).includes('r7'));
});

test('bare days mean whole days in the declared tz; resolved bounds are echoed', async () => {
  const { env } = await run(S('--due-from', '2026-10-03', '--due-to', '2026-10-05'));
  assert.deepEqual(ids(env), ['r3', 'r5', 'r1']);
  assert.equal(env.query.due_from_resolved, '2026-10-03T00:00:00-03:00');
  assert.equal(env.query.due_to_resolved_exclusive, '2026-10-06T00:00:00-03:00');
  // same bare days read in UTC would select different reminders: the tz matters
  const utc = await run(['reminders', 'search', '--tz', 'UTC', '--due-from', '2026-10-03', '--due-to', '2026-10-03']);
  assert.deepEqual(ids(utc.env), ['r3']);
});

test('undated reminders only enter a date filter with --include-undated', async () => {
  const without = await run(S('--due-from', '2026-10-01'));
  assert.ok(!ids(without.env).includes('r2'));
  assert.equal(without.env.coverage.undated_excluded_by_date_filter, 1);
  const withIt = await run(S('--due-from', '2026-10-01', '--include-undated'));
  assert.equal(ids(withIt.env).at(-1), 'r2');
});

test('invalid date arguments are INVALID_ARGUMENT', async () => {
  for (const argv of [
    S('--due-from', '2026-10-03T09:00:00'), S('--due-from', 'amanhã'), S('--due-from', '2026-10-06', '--due-to', '2026-10-03'),
    S('--due-from', '2026-10-03T00:00:00-03:00', '--due-to', '2026-10-03T00:00:00-03:00'),
    ['reminders', 'search', '--tz', 'Nowhere/Land'], S('--include-undated'),
  ]) {
    const r = await run(argv);
    assert.equal(r.exitCode, 2, argv.join(' '));
    assert.equal(r.env.error.code, 'INVALID_ARGUMENT');
  }
});

test('homonymous lists are separated by id, never by name', async () => {
  assert.deepEqual(ids((await run(S('--list-id', 'L1'))).env), ['r1', 'r7', 'r2']);
  assert.deepEqual(ids((await run(S('--list-id', 'L2'))).env), ['r6']);
  assert.equal((await run(S('--list-id', 'nope'))).exitCode, 5);
  assert.equal((await run(['reminders', 'search', '--list-name', 'Casa'])).exitCode, 2);
});

test('title text with quotes, $, emoji and newlines survives untouched; query is literal', async () => {
  let { env } = await run(S('--status', 'all', '--query', 'segunda linha'));
  assert.deepEqual(ids(env), ['r6']);
  assert.equal(env.items[0].title, 'Aspas "duplas" e \'simples\'\nsegunda linha');
  ({ env } = await run(S('--status', 'all', '--query', '$$ café ☕')));
  assert.deepEqual(ids(env), ['r4']);
  ({ env } = await run(S('--query', '"); delete every reminder; ("')));
  assert.equal(env.ok, true);
  assert.equal(env.items.length, 0);
});

test('all-day vs timed: shown when the dictionary allows, flagged as unproven otherwise', async () => {
  const { env } = await run(S());
  const r5 = env.items.find((i) => i.id === 'r5');
  const r1 = env.items.find((i) => i.id === 'r1');
  assert.deepEqual([r5.all_day, r5.due], [true, '2026-10-04']);
  assert.equal(r1.all_day, false);
  assert.ok(env.warnings.some((w) => w.code === 'ALL_DAY_UNVERIFIED'));
  const noFeature = await run(S(), { caps: { reminders: { supported: [] } } });
  assert.ok(noFeature.env.items.every((i) => i.all_day === null));
  assert.ok(noFeature.env.warnings.some((w) => w.code === 'ALL_DAY_UNSUPPORTED'));
});

test('show: body only here, truncated explicitly; unknown id is NOT_FOUND', async () => {
  const r = await run(['reminders', 'show', '--id', 'r6', '--tz', 'America/Sao_Paulo', '--max-chars', '100']);
  assert.equal(r.env.items[0].body.length, 100);
  assert.ok(r.env.items[0].truncated_fields.includes('body'));
  const search = await run(S('--status', 'all'));
  assert.ok(search.env.items.every((i) => !('body' in i)));
  const bad = await run(['reminders', 'show', '--id', 'x']);
  assert.equal(bad.exitCode, 5);
});

test('scan limit and soft deadline mark the result incomplete', async () => {
  const lim = await run(S('--scan-limit', '3'));
  assert.equal(lim.env.coverage.complete, false);
  assert.deepEqual([lim.env.coverage.scanned, lim.env.coverage.total_in_scope], [3, 6]);
  const soft = await run(S(), { faults: { stopAfter: 2 } });
  assert.ok(soft.env.coverage.reasons.includes('TIME_LIMIT'));
  assert.equal((await run(S('--scan-limit', '10'))).env.coverage.complete, true);
});

test('unavailable due date is declared, not treated as "no due date"', async () => {
  const r = await run(S(), { faults: { unavailable: { reminders: ['due'] } } });
  assert.equal(r.env.coverage.complete, false);
  assert.ok(r.env.coverage.reasons.includes('FIELD_UNAVAILABLE'));
  assert.ok(r.env.items.every((i) => i.unavailable.includes('due')));
});
