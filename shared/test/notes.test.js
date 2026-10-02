'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run, ids } = require('./helpers');
const { buildData, BAIT_NOTE_TEXT } = require('./fakes/fake-data');

const S = (q, ...rest) => ['notes', 'search', '--query', q, ...rest];

test('folders: account + folder + ids; same-named folders have different ids', async () => {
  const { env } = await run(['notes', 'folders']);
  assert.deepEqual(env.items.map((f) => [f.id, f.name, f.account.name]), [
    ['F1', 'Pessoal', 'iCloud'], ['F2', 'Trabalho', 'iCloud'], ['F3', 'Pessoal', 'No meu Mac'],
  ]);
});

test('default scope is title; text is never requested from the adapter', async () => {
  const r = await run(S('compras'));
  assert.deepEqual(ids(r.env), ['n1']);
  assert.equal(r.adapter.calls[0].params.with_text, false);
  assert.equal(r.env.items[0].snippet, undefined);
  assert.equal(r.env.query.scope, 'title');
});

test('protected note: title is searchable, body is never read', async () => {
  const r = await run(S('ideias'));
  assert.deepEqual(ids(r.env), ['n2']);
  assert.equal(r.env.items[0].protected, true);
  assert.equal(r.data.touched.bait, 0);
  assert.ok(!JSON.stringify(r.env).includes(BAIT_NOTE_TEXT));
});

test('text scope: snippet around the match, bait body untouched, coverage admits protected notes', async () => {
  let r = await run(S('orçamento', '--scope', 'text'));
  assert.deepEqual(ids(r.env), ['n3']);
  assert.equal(r.env.items[0].match, 'text');
  assert.ok(r.env.items[0].snippet.includes('orçamento'));
  assert.ok(r.env.items[0].snippet.length < 130);
  assert.equal(r.env.coverage.complete, false);
  assert.ok(r.env.coverage.reasons.includes('PROTECTED_BODY_SKIPPED'));
  assert.equal(r.env.coverage.protected_notes, 1);
  assert.equal(r.env.coverage.protection_unknown_notes, 1);
  assert.equal(r.env.coverage.protected_bodies_read, 0);
  assert.ok(r.env.warnings.some((w) => w.code === 'PROTECTED_NOTES_NOT_SEARCHED'));
  r = await run(S('ISCA-SENHA', '--scope', 'text'));
  assert.equal(r.env.items.length, 0, 'bait text must be unreachable');
  assert.equal(r.data.touched.bait, 0);
  assert.equal(r.env.coverage.complete, false, 'absence is not conclusive');
});

test('text scope also matches titles and keeps quotes/$/accents literal', async () => {
  let r = await run(S('$açúcar', '--scope', 'text'));
  assert.deepEqual(ids(r.env), ['n1']);
  r = await run(S('"aspas"', '--scope', 'text'));
  assert.deepEqual(ids(r.env), ['n1']);
  r = await run(S('reunião', '--scope', 'text'));
  assert.deepEqual(ids(r.env), ['n3']);
  assert.equal(r.env.items[0].match, 'title');
});

test('folder / account scope uses ids (homonymous folders); unknown id is NOT_FOUND', async () => {
  assert.equal((await run(S('receita', '--folder-id', 'F1'))).env.items.length, 0);
  assert.deepEqual(ids((await run(S('receita', '--folder-id', 'F3'))).env), ['n4']);
  assert.deepEqual(ids((await run(S('receita', '--account-id', 'NA2'))).env), ['n4']);
  assert.equal((await run(S('receita', '--account-id', 'NA1'))).env.items.length, 0);
  assert.equal((await run(S('x', '--folder-id', 'nope'))).exitCode, 5);
  assert.equal((await run(S('x', '--account-id', 'nope'))).exitCode, 5);
});

test('show: limited text for normal notes, no text for protected/unproven, with the reason', async () => {
  let r = await run(['notes', 'show', '--id', 'n1']);
  assert.equal(r.env.items[0].text, 'leite\npão\nCafé com $açúcar e "aspas"');
  assert.equal(r.env.items[0].body_blocked, null);
  r = await run(['notes', 'show', '--id', 'n2']);
  assert.equal(r.env.items[0].text, null);
  assert.equal(r.env.items[0].body_blocked, 'PASSWORD_PROTECTED');
  assert.equal(r.env.coverage.complete, false);
  r = await run(['notes', 'show', '--id', 'n5']);
  assert.equal(r.env.items[0].body_blocked, 'PROTECTION_UNKNOWN');
  assert.equal(r.data.touched.bait, 0);
  r = await run(['notes', 'show', '--id', 'n6', '--max-chars', '100']);
  assert.ok(r.env.items[0].text.length <= 100);
  assert.ok(r.env.items[0].truncated_fields.includes('text'));
  assert.equal((await run(['notes', 'show', '--id', 'xx'])).exitCode, 5);
});

test('GUARD: even a rogue adapter returning protected text cannot leak it', async () => {
  for (const argv of [S('isca', '--scope', 'text'), ['notes', 'show', '--id', 'n2']]) {
    const r = await run(argv, { faults: { leakProtected: true } });
    assert.equal(r.env.ok, false);
    assert.equal(r.env.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(r.env).includes(BAIT_NOTE_TEXT));
  }
});

test('missing "password protected" marker: text search blocked, body never read, title search stays', async () => {
  const caps = { notes: { supported: ['note_folder'] } };
  const text = await run(S('orçamento', '--scope', 'text'), { caps });
  assert.equal(text.exitCode, 6);
  assert.equal(text.env.error.code, 'BLOCKED_MISSING_PROPERTY');
  const title = await run(S('reunião'), { caps });
  assert.deepEqual(ids(title.env), ['n3']);
  const show = await run(['notes', 'show', '--id', 'n1'], { caps });
  assert.equal(show.env.items[0].text, null);
  assert.equal(show.env.items[0].body_blocked, 'NO_PROTECTION_MARKER');
  assert.equal(show.adapter.calls[0].params.read_text, false);
});

test('text longer than the read cap is flagged, never reported as fully searched', async () => {
  const data = buildData();
  data.notes.items.push({ id: 'n7', title: 'Enorme', folder_id: 'F2', protected: false, text: `${'y'.repeat(60000)}zzz-final`, modified: null, created: null, shared: false });
  const r = await run(S('zzz-final', '--scope', 'text'), { data });
  assert.equal(r.env.items.length, 0);
  assert.ok(r.env.coverage.reasons.includes('TEXT_CAPPED'));
  assert.equal(r.env.coverage.complete, false);
});

test('scan limit and soft deadline keep complete=false', async () => {
  const lim = await run(S('a', '--scan-limit', '2'));
  assert.deepEqual([lim.env.coverage.scanned, lim.env.coverage.total_in_scope], [2, 6]);
  assert.ok(lim.env.coverage.reasons.includes('SCAN_LIMIT'));
  const soft = await run(S('a'), { faults: { stopAfter: 1 } });
  assert.ok(soft.env.coverage.reasons.includes('TIME_LIMIT'));
});

test('unavailable protection flag is declared and treated as "do not read"', async () => {
  const r = await run(S('orçamento', '--scope', 'text'), { faults: { unavailable: { notes: ['protected'] } } });
  assert.equal(r.env.coverage.complete, false);
  assert.equal(r.env.coverage.protection_unknown_notes, 6);
  assert.deepEqual(r.env.items, [], 'no note had a proven-unprotected state, so no text was read');
});
