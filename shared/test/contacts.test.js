'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, ids } = require('./helpers');
const { buildData, bulkContacts } = require('./fakes/fake-data');

const S = (q, ...rest) => ['contacts', 'search', '--query', q, ...rest];

test('search by name, email and phone; case-insensitive; multiple emails kept', async () => {
  let r = await run(S('ANA'));
  assert.equal(r.exitCode, 0);
  assert.deepEqual(ids(r.env), ['p1']);
  assert.deepEqual(r.env.items[0].emails, ['ana@example.com', 'ana.souza@trabalho.example']);
  assert.deepEqual(r.env.items[0].phones, ['+55 11 90000-0001']);
  r = await run(S('trabalho.example'));
  assert.deepEqual(ids(r.env), ['p1']);
  r = await run(S('90000-0001'));
  assert.deepEqual(ids(r.env), ['p1']);
  r = await run(S('example.com'));
  assert.deepEqual(ids(r.env), ['p1', 'p2', 'p4', 'p5']);
});

test('accents, quotes, $, newlines and NFD input are matched as literal data', async () => {
  assert.deepEqual(ids((await run(S('Ávila'.normalize('NFD')))).env), ['p2']);
  assert.deepEqual(ids((await run(S('avila'))).env), [], 'accents are not folded');
  assert.deepEqual(ids((await run(S('"Mimi" $Silva'))).env), ['p3']);
  assert.deepEqual(ids((await run(S('Linha\nQuebrada'))).env), ['p4']);
  const r = await run(S('Zoë'));
  assert.equal(r.env.items[0].name, 'Zoë Müller');
  assert.equal((await run(S('"; do shell script "id"; "'))).env.items.length, 0);
});

test('item exposes only id, name, emails, phones (no notes/birthday/address/photo)', async () => {
  const { env } = await run(S('ana'));
  const allowed = new Set(['id', 'name', 'emails', 'phones', 'truncated', 'truncated_fields', 'unavailable']);
  for (const k of Object.keys(env.items[0])) assert.ok(allowed.has(k), k);
});

test('group scope and homonym-safe ids; unknown group is NOT_FOUND', async () => {
  const r = await run(S('a', '--group-id', 'g1'));
  assert.deepEqual(ids(r.env), ['p1', 'p3']);
  const bad = await run(S('a', '--group-id', 'nope'));
  assert.equal(bad.exitCode, 5);
  assert.equal(bad.env.error.code, 'NOT_FOUND');
});

test('show returns the same fields; invalid id is NOT_FOUND, not empty', async () => {
  const ok = await run(['contacts', 'show', '--id', 'p1']);
  assert.equal(ok.env.items.length, 1);
  assert.deepEqual(ok.env.items[0].emails.length, 2);
  const bad = await run(['contacts', 'show', '--id', 'does-not-exist']);
  assert.equal(bad.env.ok, false);
  assert.equal(bad.env.items, null);
  assert.equal(bad.exitCode, 5);
});

test('scan limit: partial scan is never reported as complete', async () => {
  const data = buildData();
  data.contacts.people = bulkContacts(300);
  let r = await run(S('Pessoa 0250'), { data });
  assert.equal(r.env.items.length, 0);
  assert.equal(r.env.coverage.complete, false);
  assert.deepEqual([r.env.coverage.scanned, r.env.coverage.scan_limit, r.env.coverage.total_in_scope], [200, 200, 300]);
  assert.ok(r.env.coverage.reasons.includes('SCAN_LIMIT'));
  assert.ok(r.env.warnings.some((w) => w.code === 'PARTIAL_SCAN'));
  r = await run(S('Pessoa 0250', '--scan-limit', '1000'), { data });
  assert.deepEqual(ids(r.env), ['b250']);
  assert.equal(r.env.coverage.complete, true);
});

test('result limit is separate from scan limit and is declared', async () => {
  const data = buildData();
  data.contacts.people = bulkContacts(60);
  const r = await run(S('Pessoa', '--limit', '3'), { data });
  assert.equal(r.env.items.length, 3);
  assert.equal(r.env.coverage.matched, 60);
  assert.equal(r.env.coverage.limit_reached, true);
  assert.equal(r.env.coverage.complete, true, 'whole scope was scanned');
  assert.equal((await run(S('Pessoa'), { data })).env.items.length, 10);
});

test('soft deadline yields an incomplete (not failed, not empty-complete) result', async () => {
  const data = buildData();
  data.contacts.people = bulkContacts(50);
  const r = await run(S('zzz'), { data, faults: { stopAfter: 7 } });
  assert.equal(r.env.ok, true);
  assert.equal(r.env.coverage.scanned, 7);
  assert.equal(r.env.coverage.complete, false);
  assert.ok(r.env.coverage.reasons.includes('TIME_LIMIT'));
});

test('unavailable property is null + declared, never an empty list', async () => {
  const r = await run(S('ana'), { faults: { unavailable: { contacts: ['emails'] } } });
  assert.equal(r.env.coverage.complete, false);
  assert.ok(r.env.coverage.reasons.includes('FIELD_UNAVAILABLE'));
  const show = await run(['contacts', 'show', '--id', 'p1'], { faults: { unavailable: { contacts: ['emails'] } } });
  assert.equal(show.env.items[0].emails, null);
  assert.deepEqual(show.env.items[0].unavailable, ['emails']);
});

test('max-chars truncation is explicit', async () => {
  const data = buildData();
  data.contacts.people[0].name = 'N'.repeat(500);
  const r = await run(['contacts', 'show', '--id', 'p1', '--max-chars', '50'], { data });
  assert.equal(r.env.items[0].name.length, 50);
  assert.equal(r.env.items[0].truncated, true);
  assert.deepEqual(r.env.items[0].truncated_fields, ['name']);
});
