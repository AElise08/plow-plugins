'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createJxaAdapter, mapAppError } = require('../src/adapters/jxa');
const { main } = require('../src/cli');
const { probe } = require('./helpers');
const { fakeCapabilities } = require('./fakes/fake-adapter');
const { buildData, BAIT_NOTE_TEXT } = require('./fakes/fake-data');
const { makeWorld, createVmSpawn } = require('./fakes/fake-jxa');

const FAKE_BIN = '/nonexistent/FAKE-OSASCRIPT'; // the real binary is never started in tests

function child(onStart) {
  return () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = null;
    c.kill = (sig) => { c.killed = sig; };
    setImmediate(() => onStart(c));
    return c;
  };
}

test('argv: static code via -e, params only as separate JSON argv, no shell, no stdin', async () => {
  let seen;
  const hostile = { folder_id: '"; evil(); //', account_id: null, with_text: false, scan_limit: 5, soft_deadline_ms: 100, extra: '$(id)\n`id`' };
  const spawnFn = (bin, args, options) => {
    seen = { bin, args, options };
    return child((c) => { c.stdout.emit('data', Buffer.from('{"folders":[]}')); c.emit('close', 0); })();
  };
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  await adapter.call('notes', 'folders', hostile, { timeoutMs: 1000 });
  assert.equal(seen.bin, FAKE_BIN);
  assert.deepEqual(seen.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.equal(seen.args.length, 6);
  assert.equal(seen.args[4], 'folders');
  assert.deepEqual(JSON.parse(seen.args[5]), hostile);
  assert.ok(!seen.args[3].includes('evil()'), 'user data must not be in the code argument');
  assert.ok(!seen.args[3].includes('$(id)'));
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.stdio[0], 'ignore');
});

test('timeout kills the child process and reports TIMEOUT', async () => {
  let c;
  const spawnFn = (...a) => { c = child(() => {})(...a); return c; };
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  await assert.rejects(adapter.call('contacts', 'scan', {}, { timeoutMs: 25 }), (e) => e.code === 'TIMEOUT' && e.exitCode === 4);
  assert.equal(c.killed, 'SIGKILL');
});

test('osascript failures map to distinct states and stderr text is never forwarded', async () => {
  const personal = 'Maria Fictícia 11 99999-0000';
  const cases = [
    [`execution error: Not authorized to send Apple events to Notes ${personal}. (-1743)`, 'PERMISSION_DENIED'],
    ['execution error: Application isn’t running. (-600)', 'APP_UNAVAILABLE'],
    ['execution error: sandboxed sender refused. (-10004)', 'SANDBOX_REFUSED'],
    ['execution error: doesn’t understand the message. (-1708)', 'METHOD_UNAVAILABLE'],
    ['execution error: timed out. (-1712)', 'TIMEOUT'],
    [`execution error: ${personal} (-2700)`, 'APP_ERROR'],
    [`something without a number ${personal}`, 'APP_ERROR'],
  ];
  for (const [stderr, code] of cases) {
    const spawnFn = child((c) => { c.stderr.emit('data', Buffer.from(stderr)); c.emit('close', 1); });
    const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
    await assert.rejects(adapter.call('notes', 'folders', {}, { timeoutMs: 1000 }), (e) => {
      assert.equal(e.code, code);
      assert.ok(!JSON.stringify({ d: e.detail, x: e.extra, m: e.message }).includes('Maria'), 'stderr leaked');
      return true;
    });
  }
});

test('script-reported errors: scope/item -1728 is NOT_FOUND, others are structured', () => {
  assert.equal(mapAppError(-1728, 'scope').code, 'NOT_FOUND');
  assert.equal(mapAppError(-1728, 'item').code, 'NOT_FOUND');
  assert.equal(mapAppError(-1728, 'app').code, 'APP_ERROR');
  assert.equal(mapAppError(-1743, 'item').code, 'PERMISSION_DENIED');
  assert.equal(mapAppError(-10004, 'item').code, 'SANDBOX_REFUSED');
  assert.ok(mapAppError(-1743, 'item').detail.includes('apple_events=true'), 'the denial hint names the Latch requirement');
  assert.ok(!mapAppError(-10004, 'item').detail.includes('Automation permission is'), 'not blamed on a missing permission');
  assert.equal(mapAppError(null, 'unknown').extra.app_error_number, null);
});

test('non-JSON stdout and spawn failures are explicit errors, not empty results', async () => {
  const bad = createJxaAdapter({ spawnFn: child((c) => { c.stdout.emit('data', Buffer.from('not json')); c.emit('close', 0); }), osascript: FAKE_BIN });
  await assert.rejects(bad.call('notes', 'folders', {}, { timeoutMs: 1000 }), (e) => e.code === 'ADAPTER_SCHEMA');
  const boom = createJxaAdapter({ spawnFn: () => { throw new Error('ENOENT'); }, osascript: FAKE_BIN });
  await assert.rejects(boom.call('notes', 'folders', {}, { timeoutMs: 1000 }), (e) => e.code === 'RUNTIME_MISSING');
});

// ---------------------------------------------------------------------------
// The REAL JXA scripts, run in a Node vm against a fictional object model.
// Proves our script logic and guards; does NOT prove real Apple/JXA behaviour.
// ---------------------------------------------------------------------------
function vmRun(argv, { data = buildData(), faults } = {}) {
  const world = makeWorld(data, faults);
  const { spawnFn, calls } = createVmSpawn(world);
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  return main(argv, { adapter, capabilities: fakeCapabilities(), probe }).then((r) => ({ ...r, env: r.envelope, data, calls, adapter }));
}

test('[vm] contacts: scan, group scope, show and literal search through the real script', async () => {
  let r = await vmRun(['contacts', 'search', '--query', 'example.com']);
  assert.deepEqual(r.env.items.map((i) => i.id), ['p1', 'p2', 'p4', 'p5']);
  r = await vmRun(['contacts', 'search', '--query', 'a', '--group-id', 'g1']);
  assert.deepEqual(r.env.items.map((i) => i.id), ['p1', 'p3']);
  assert.equal((await vmRun(['contacts', 'search', '--query', 'a', '--group-id', 'nope'])).env.error.code, 'NOT_FOUND');
  r = await vmRun(['contacts', 'show', '--id', 'p1']);
  assert.deepEqual(r.env.items[0].emails, ['ana@example.com', 'ana.souza@trabalho.example']);
  assert.equal((await vmRun(['contacts', 'show', '--id', 'nope'])).env.error.code, 'NOT_FOUND');
});

test('[vm] reminders: lists, status via whose, list scope, dates, show', async () => {
  let r = await vmRun(['reminders', 'lists']);
  assert.equal(r.env.items.length, 3);
  r = await vmRun(['reminders', 'search', '--tz', 'America/Sao_Paulo']);
  assert.deepEqual(r.env.items.map((i) => i.id), ['r3', 'r5', 'r1', 'r7', 'r6', 'r2']);
  assert.equal(r.env.items.find((i) => i.id === 'r5').all_day, true);
  r = await vmRun(['reminders', 'search', '--list-id', 'L2', '--status', 'all']);
  assert.deepEqual(r.env.items.map((i) => i.id).sort(), ['r4', 'r6']);
  assert.equal((await vmRun(['reminders', 'search', '--list-id', 'zz'])).env.error.code, 'NOT_FOUND');
  r = await vmRun(['reminders', 'show', '--id', 'r1', '--tz', 'UTC']);
  assert.equal(r.env.items[0].list.name, 'Casa');
  assert.ok(r.env.items[0].body.startsWith('Vence dia 5.'));
  assert.equal((await vmRun(['reminders', 'show', '--id', 'zz'])).env.error.code, 'NOT_FOUND');
});

test('[vm] notes: protected body is never read by the real script (bait untouched)', async () => {
  const data = buildData();
  let r = await vmRun(['notes', 'search', '--query', 'orçamento', '--scope', 'text'], { data });
  assert.deepEqual(r.env.items.map((i) => i.id), ['n3']);
  r = await vmRun(['notes', 'search', '--query', 'ISCA-SENHA', '--scope', 'text'], { data });
  assert.equal(r.env.items.length, 0);
  assert.equal(r.env.coverage.complete, false);
  r = await vmRun(['notes', 'show', '--id', 'n2'], { data });
  assert.equal(r.env.items[0].body_blocked, 'PASSWORD_PROTECTED');
  r = await vmRun(['notes', 'show', '--id', 'n5'], { data });
  assert.equal(r.env.items[0].body_blocked, 'PROTECTION_UNKNOWN');
  r = await vmRun(['notes', 'search', '--query', 'ideias'], { data });
  assert.deepEqual(r.env.items.map((i) => i.id), ['n2']);
  assert.equal(data.touched.bait, 0, 'plaintext of a protected/unproven note was read');
  for (const c of r.calls) assert.ok(!JSON.stringify(c).includes(BAIT_NOTE_TEXT));
});

test('[vm] notes: folders, id scoping, show with folder/account, unknown ids', async () => {
  let r = await vmRun(['notes', 'folders']);
  assert.deepEqual(r.env.items.map((f) => [f.id, f.account.id]), [['F1', 'NA1'], ['F2', 'NA1'], ['F3', 'NA2']]);
  r = await vmRun(['notes', 'search', '--query', 'receita', '--folder-id', 'F3']);
  assert.deepEqual(r.env.items.map((i) => i.id), ['n4']);
  r = await vmRun(['notes', 'search', '--query', 'receita', '--account-id', 'NA1']);
  assert.equal(r.env.items.length, 0);
  r = await vmRun(['notes', 'show', '--id', 'n4']);
  assert.deepEqual([r.env.items[0].folder.id, r.env.items[0].account.id, r.env.items[0].text], ['F3', 'NA2', 'bolo de cenoura']);
  assert.equal((await vmRun(['notes', 'search', '--query', 'x', '--folder-id', 'nope'])).env.error.code, 'NOT_FOUND');
  assert.equal((await vmRun(['notes', 'show', '--id', 'nope'])).env.error.code, 'NOT_FOUND');
});

test('[vm] permission denied and unavailable properties surface as distinct states', async () => {
  const denied = await vmRun(['notes', 'folders'], { faults: { permissionDenied: 'notes' } });
  assert.equal(denied.env.error.code, 'PERMISSION_DENIED');
  assert.equal(denied.exitCode, 3);
  assert.equal(denied.env.items, null);
  const un = await vmRun(['reminders', 'search'], { faults: { unavailableProps: ['dueDate'] } });
  assert.equal(un.env.ok, true);
  assert.ok(un.env.coverage.reasons.includes('FIELD_UNAVAILABLE'));
  assert.ok(un.env.items.every((i) => i.unavailable.includes('due')));
  const un2 = await vmRun(['contacts', 'show', '--id', 'p1'], { faults: { unavailableProps: ['value'] } });
  assert.equal(un2.env.items[0].emails, null);
});

test('[vm] soft deadline stops the scan and reports TIME_LIMIT instead of failing', async () => {
  const world = makeWorld(buildData());
  const { spawnFn } = createVmSpawn(world);
  const adapter = createJxaAdapter({ spawnFn, osascript: FAKE_BIN });
  const raw = await adapter.call('contacts', 'scan', { group_id: null, scan_limit: 50, soft_deadline_ms: -1 }, { timeoutMs: 1000 });
  assert.deepEqual([raw.stopped, raw.scanned, raw.total], ['time', 0, 5]);
});

test('[vm] isGone: any non-fatal read failure means gone; fatal failures and readable ids do not', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const sandbox = { String, Object, JSON, RegExp, Number, isNaN, Date };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', 'jxa', 'prelude.js'), 'utf8'), sandbox);
  const gone = (fn) => vm.runInContext('isGone', sandbox)({ id: fn });
  assert.equal(gone(() => 'still-here'), false);
  assert.equal(gone(() => { throw new Error('Can’t get object. (-1728)'); }), true);
  assert.equal(gone(() => { throw new Error('Could not convert types. (-1700)'); }), true);
  assert.equal(gone(() => { throw new Error('no number at all'); }), true);
  assert.equal(gone(() => { throw new Error('Not authorized. (-1743)'); }), false);
  assert.equal(gone(() => { throw new Error('timed out. (-1712)'); }), false);
});
