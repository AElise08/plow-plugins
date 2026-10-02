'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../src/args');
const { run } = require('./helpers');

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('defaults: limit 10, max-chars 400, timeout 15, scan-limit 200', () => {
  const { opts } = parseArgs(['contacts', 'search', '--query', 'ana']);
  assert.equal(opts.limit, 10);
  assert.equal(opts['max-chars'], 400);
  assert.equal(opts.timeout, 15);
  assert.equal(opts['scan-limit'], 200);
});

test('limits are enforced: limit<=50, max-chars<=2000, timeout<=60', () => {
  const q = ['contacts', 'search', '--query', 'a'];
  assert.equal(parseArgs([...q, '--limit', '50']).opts.limit, 50);
  assert.equal(code(() => parseArgs([...q, '--limit', '51'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs([...q, '--limit', '0'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs([...q, '--limit', '1e1'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs([...q, '--max-chars', '2001'])), 'INVALID_ARGUMENT');
  assert.equal(parseArgs([...q, '--max-chars', '2000']).opts['max-chars'], 2000);
  assert.equal(parseArgs([...q, '--timeout', '60']).opts.timeout, 60);
  assert.equal(code(() => parseArgs([...q, '--timeout', '61'])), 'INVALID_ARGUMENT');
});

test('mutating / arbitrary-execution verbs are refused as FORBIDDEN_COMMAND', () => {
  const cases = [
    ['contacts', 'create'],
    ['contacts', 'edit'], ['notes', 'move'], ['notes', 'unlock'], ['notes', 'open', '--id', 'x'],
    ['contacts', 'create', '--title', 'x'], ['contacts', 'delete', '--id', 'x'], ['contacts', 'update', '--id', 'x'],
    ['reminders', 'complete', '--id', 'x'], ['reminders', 'update', '--id', 'x'], ['reminders', 'edit', '--id', 'x'],
    ['notes', 'edit', '--id', 'x'], ['notes', 'update', '--id', 'x'], ['notes', 'unlock', '--id', 'x'],
    ['calendar', 'edit', '--id', 'x'], ['calendar', 'move', '--id', 'x'], ['run'], ['eval', '1+1'], ['execute'], ['osascript'],
    ['bash', '-c', 'id'], ['script'],
  ];
  for (const argv of cases) assert.equal(code(() => parseArgs(argv)), 'FORBIDDEN_COMMAND', argv.join(' '));
});

test('unknown commands, unknown flags and positionals are rejected', () => {
  assert.equal(code(() => parseArgs(['photos', 'search'])), 'UNKNOWN_COMMAND');
  assert.equal(code(() => parseArgs(['notes', 'frobnicate'])), 'UNKNOWN_COMMAND');
  assert.equal(code(() => parseArgs(['notes', 'show', '--id', 'x', '--unlock'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['notes', 'show', '--id', 'x', '--execute', 'x'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['notes', 'show', 'x'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['contacts', 'search'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['contacts', 'search', '--query'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['contacts', 'search', '--query', 'a', '--query', 'b'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['contacts', 'search', '--query', '   '])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['contacts', 'search', '--query', 'a', '--group-id', ''])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['reminders', 'create'])), 'INVALID_ARGUMENT', 'create needs --title');
  assert.equal(code(() => parseArgs(['notes', 'create', '--title', 'x', '--complete'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['calendar', 'search', '--from', '2026-10-01'])), 'INVALID_ARGUMENT', 'needs --to');
  assert.equal(code(() => parseArgs(['reminders', 'search', '--status', 'weird'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['notes', 'search', '--query', 'a', '--scope', 'body'])), 'INVALID_ARGUMENT');
});

test('metacharacters, quotes, newlines and unicode are plain data', () => {
  const nasty = ['"; do shell script "id"; "', '$(id) `id` ${HOME}', "a'b\"c", 'linha1\nlinha2', 'ação ☕ 日本', '--limit', '-x', '\\u0000x'];
  for (const q of nasty) {
    assert.equal(parseArgs(['contacts', 'search', '--query', q]).opts.query, q);
    assert.equal(parseArgs(['contacts', 'search', `--query=${q}`]).opts.query, q);
  }
  assert.equal(code(() => parseArgs(['contacts', 'search', '--query', 'a\u0000b'])), 'INVALID_ARGUMENT');
});

test('ids reject control characters but accept real-looking coredata ids', () => {
  const id = 'x-coredata://ABCD-0123/ICNote/p42';
  assert.equal(parseArgs(['notes', 'show', '--id', id]).opts.id, id);
  assert.equal(code(() => parseArgs(['notes', 'show', '--id', 'a\nb'])), 'INVALID_ARGUMENT');
  assert.equal(code(() => parseArgs(['notes', 'show', '--id', 'x'.repeat(513)])), 'INVALID_ARGUMENT');
});

test('error details never echo user-supplied values', async () => {
  const secret = 'SEGREDO-NO-ARGUMENTO';
  for (const argv of [['contacts', 'search', '--query', 'a', `--${secret}`, 'x'], [secret], ['contacts', secret], ['notes', 'show', '--id', `${secret}\n`]]) {
    const { env } = await run(argv);
    assert.equal(env.ok, false);
    assert.ok(!JSON.stringify(env).includes(secret), JSON.stringify(env));
  }
});

test('the write commands are exactly the enumerated ones; deletes are marked destructive', () => {
  const { COMMANDS } = require('../src/args');
  const writers = Object.entries(COMMANDS).filter(([, c]) => c.write).map(([k]) => k).sort();
  assert.deepEqual(writers, ['calendar create', 'calendar delete', 'calendar update', 'notes create', 'notes delete', 'reminders create', 'reminders delete']);
  const destructive = Object.entries(COMMANDS).filter(([, c]) => c.destructive).map(([k]) => k).sort();
  assert.deepEqual(destructive, ['calendar delete', 'notes delete', 'reminders delete']);
  const { opts } = parseArgs(['reminders', 'create', '--title', 'a"b\n$(id)', '--body', 'x\ny', '--due', '2026-10-03']);
  assert.equal(opts.title, 'a"b\n$(id)');
  assert.equal(opts.body, 'x\ny');
});

test('delete needs an id AND the title the caller saw; there is no delete by search or by name', () => {
  for (const g of ['reminders', 'notes', 'calendar']) {
    assert.equal(code(() => parseArgs([g, 'delete', '--id', 'x'])), 'INVALID_ARGUMENT', `${g}: needs --expect-title`);
    assert.equal(code(() => parseArgs([g, 'delete', '--expect-title', 't'])), 'INVALID_ARGUMENT', `${g}: needs --id`);
    assert.equal(code(() => parseArgs([g, 'delete', '--query', 'x', '--expect-title', 't'])), 'INVALID_ARGUMENT', `${g}: no query`);
    assert.equal(code(() => parseArgs([g, 'delete', '--all', '--expect-title', 't'])), 'INVALID_ARGUMENT', `${g}: no --all`);
    assert.equal(parseArgs([g, 'delete', '--id', 'x', '--expect-title', 't']).opts['expect-title'], 't');
  }
});
