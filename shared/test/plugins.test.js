'use strict';

// Tests about the plugin folders themselves (the generated CLI, the manifests, the skills).
// Nothing here touches Contacts, Reminders, Notes or Calendar: the CLI copies run over the
// same fictional fake backend as the rest of the suite, and the launcher is only asked for
// `--help` (which never sends an Apple Event).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseManifest, classifyArgv } = require('./support/latch-rules');
const { createFakeAdapter, fakeCapabilities } = require('./fakes/fake-adapter');
const { probe } = require('./helpers');

const REPO = path.join(__dirname, '..', '..');
const APPS = ['contacts', 'reminders', 'notes', 'calendar'];
const BUNDLE = { contacts: 'com.apple.AddressBook', reminders: 'com.apple.reminders', notes: 'com.apple.Notes', calendar: 'com.apple.iCal' };
const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const manifestOf = (app) => parseManifest(read(path.join(REPO, app, 'latch-plugin.json')));

test('every plugin folder is complete: manifest, skill.md, README.md, cli/', () => {
  for (const app of APPS) {
    for (const f of ['latch-plugin.json', 'skill.md', 'README.md', 'cli/package.json', `cli/bin/plow-${app}.js`, `cli/bin/plow-${app}.sh`]) {
      assert.ok(fs.existsSync(path.join(REPO, app, f)), `${app}/${f} missing`);
    }
  }
});

test('manifests satisfy Latch\'s parseManifest rules and name the right Automation permission only', () => {
  for (const app of APPS) {
    const m = manifestOf(app);
    assert.equal(m.name, app, 'directory is named after the manifest');
    assert.equal(m.command, `plow-${app}`);
    assert.deepEqual(m.requires.permissions, [`automation:${BUNDLE[app]}`]);
    assert.deepEqual(m.requires.accounts, []);
    assert.deepEqual(m.binaries, [], 'no downloaded binaries');
    assert.deepEqual(m.exec.argv, ['/bin/sh', `cli/bin/plow-${app}.sh`]);
    assert.equal(m.skill, 'skill.md');
  }
});

test('the allowlist is derived from the CLI: writes are exactly the write commands, nothing else is allowed', () => {
  const { COMMANDS } = require('../src/args');
  for (const app of APPS) {
    const m = manifestOf(app);
    const own = Object.entries(COMMANDS).filter(([, c]) => c.app === app);
    const writes = own.filter(([, c]) => c.write).map(([k]) => k.slice(app.length + 1)).sort();
    const reads = own.filter(([, c]) => !c.write).map(([k]) => k.slice(app.length + 1)).concat(['doctor']).sort();
    assert.deepEqual(m.argv.write.map((p) => p[0]).sort(), writes, `${app} write allowlist`);
    assert.deepEqual(m.argv.read.map((p) => p[0]).filter((t) => t !== '--help').sort(), reads, `${app} read allowlist`);
    assert.equal(classifyArgv(m, [m.command, 'evaluate']).kind, 'refused');
    assert.equal(classifyArgv(m, [m.command, '--store', '/x', 'search']).kind, 'refused');
    for (const w of writes) assert.equal(classifyArgv(m, [m.command, w, '--id', 'x']).kind, 'write');
    for (const r of reads) assert.equal(classifyArgv(m, [m.command, r]).kind, 'read');
  }
  assert.deepEqual(manifestOf('contacts').argv.write, [], 'contacts is read-only');
});

test('skill.md: front matter, and every documented argv is accepted by the allowlist (like Latch\'s own skill test)', () => {
  for (const app of APPS) {
    const m = manifestOf(app);
    const doc = read(path.join(REPO, app, 'skill.md'));
    const fm = /^---\nname: (plow-[a-z-]+)\ndescription: (.+)\n---\n/.exec(doc);
    assert.ok(fm, `${app}: front matter`);
    assert.equal(fm[1], `plow-${app}`);
    assert.ok(fm[2].length > 40);
    const calls = [...doc.matchAll(/argv=(\[[^\]]*\])/g)].map((x) => JSON.parse(x[1]));
    assert.ok(calls.length >= 3, `${app}: needs documented examples`);
    for (const argv of calls) {
      assert.equal(argv[0], m.command);
      assert.notEqual(classifyArgv(m, argv).kind, 'refused', JSON.stringify(argv));
    }
    assert.ok(calls.some((a) => classifyArgv(m, a).kind === 'read'));
    if (m.argv.write.length) assert.ok(calls.some((a) => classifyArgv(m, a).kind === 'write'), `${app}: shows a write example`);
  }
});

test('generated trees are in sync with shared/ (run `node scripts/build-plugins.mjs`)', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-plugins.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('each plugin ships only its own app: its JXA scripts, no other app\'s', () => {
  for (const app of APPS) {
    const jxa = walk(path.join(REPO, app, 'cli', 'src', 'adapters')).map((f) => path.basename(f)).filter((f) => f !== 'jxa.js').sort();
    const expected = ['prelude.js', `${app}.js`, ...(app === 'calendar' ? ['calendar-common.js', 'calendar.js'] : [])].sort();
    const unique = [...new Set(jxa)].sort();
    for (const f of unique) assert.ok(f === 'prelude.js' || f.startsWith(app), `${app} ships ${f}`);
    assert.ok(unique.includes(`${app}.js`), `${app} script`);
    void expected;
    const writeDir = path.join(REPO, app, 'cli', 'src', 'adapters', 'jxa-write');
    assert.equal(fs.existsSync(writeDir), app !== 'contacts', `${app}: write scripts only where there are write commands`);
  }
});

test('the plugin copy of the CLI runs over the fake backend and refuses every other app', async () => {
  for (const app of APPS) {
    const { main } = require(path.join(REPO, app, 'cli', 'src', 'cli.js'));
    const deps = { adapter: createFakeAdapter(), capabilities: fakeCapabilities(), probe, apps: [app], bare: true };
    const help = await main(['help'], deps);
    assert.ok(help.envelope.items.every((i) => !i.command.includes(' ') || i.command === 'help'), `${app}: bare names`);
    assert.ok(!help.envelope.items.some((i) => ['contacts', 'reminders', 'notes', 'calendar'].some((o) => o !== app && i.command.startsWith(`${o} `))));
    for (const other of APPS.filter((o) => o !== app)) {
      const r = await main([other, 'search', '--query', 'x'], deps);
      assert.equal(r.envelope.error.code, 'UNKNOWN_COMMAND', `${app} must not serve ${other}`);
    }
    const doctor = await main(['doctor'], deps);
    assert.deepEqual(doctor.envelope.items.filter((i) => i.kind === 'app').map((i) => i.app), [app]);
  }
  const { main } = require(path.join(REPO, 'reminders', 'cli', 'src', 'cli.js'));
  const r = await main(['reminders', 'search', '--tz', 'America/Sao_Paulo'], { adapter: createFakeAdapter(), capabilities: fakeCapabilities(), probe, apps: ['reminders'], bare: true });
  assert.equal(r.envelope.ok, true);
  assert.ok(r.envelope.items.length > 0);
});

test('the launcher prepends the app group, serves help/doctor itself, and `--help` works end to end', () => {
  for (const app of APPS) {
    const sh = path.join(REPO, app, 'cli', 'bin', `plow-${app}.sh`);
    const r = spawnSync('/bin/sh', [sh, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, true);
    assert.ok(env.items.length >= 3);
    assert.ok(env.items.every((i) => !/^(contacts|reminders|notes|calendar) /.test(i.command)));
    const bad = spawnSync('/bin/sh', [sh, 'edit', '--id', 'x'], { encoding: 'utf8' });
    assert.equal(bad.status, 2, bad.stdout);
    assert.equal(JSON.parse(bad.stdout).error.code, 'FORBIDDEN_COMMAND');
    assert.equal(bad.stderr, `plow-${app}: FORBIDDEN_COMMAND\n`);
    assert.equal(JSON.parse(bad.stdout).source, `plow-${app}`);
  }
});

test('shim: a missing Node is a JSON error envelope with exit 9, never prose', () => {
  for (const app of APPS) {
    const original = read(path.join(REPO, app, 'cli', 'bin', `plow-${app}.sh`));
    // Replace the candidate list so no real node can be found on this machine.
    const hobbled = original.replace(/for c in .*; do/, 'for c in "/nonexistent/node"; do');
    assert.notEqual(hobbled, original);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plow-shim-'));
    try {
      const f = path.join(dir, 'shim.sh');
      fs.writeFileSync(f, hobbled);
      const r = spawnSync('/bin/sh', [f, '--help'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: '/nonexistent' } });
      assert.equal(r.status, 9);
      const env = JSON.parse(r.stdout);
      assert.deepEqual([env.ok, env.source, env.error.code, env.items, env.coverage], [false, app, 'RUNTIME_MISSING', null, null]);
      assert.equal(r.stderr, `plow-${app}: RUNTIME_MISSING\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the shipped CLI copies obey the same bans: no network, no file writes, getter-only read scripts', () => {
  const banned = [/require\(\s*['"](?:node:)?(?:net|http|https|http2|dgram|tls|dns|worker_threads|cluster|vm)['"]\s*\)/, /\bfetch\s*\(/, /\beval\s*\(/, /new\s+Function\b/];
  const readOnlyFs = new Set(['readFileSync', 'accessSync', 'existsSync', 'constants']);
  for (const app of APPS) {
    for (const f of walk(path.join(REPO, app, 'cli')).filter((x) => x.endsWith('.js'))) {
      const src = read(f);
      for (const re of banned) assert.ok(!re.test(src), `${path.relative(REPO, f)} matches ${re}`);
      for (const m of src.matchAll(/\bfs\.(\w+)/g)) assert.ok(readOnlyFs.has(m[1]), `${path.relative(REPO, f)} calls fs.${m[1]}`);
    }
    for (const f of walk(path.join(REPO, app, 'cli', 'src', 'adapters', 'jxa'))) {
      const src = read(f).replace(/\/\/.*$/gm, '');
      assert.ok(!/\.(Reminder|Note|Event|Person|Group|Calendar|Folder)\s*\(/.test(src), `${f} constructs`);
      assert.ok(!/\.(make|delete|move|duplicate|open|activate|quit|launch|close|save|unlock|lock|show|set|add|remove)\s*\(/.test(src), `${f} mutates`);
    }
  }
});
