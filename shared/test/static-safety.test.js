'use strict';

// Static guarantees about what the shipped code can do. These are lint-style
// checks over source text: a heuristic safety net, not a proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.name === 'node_modules' || e.name === '.git') return [];
  return e.isDirectory() ? walk(p) : [p];
});
const rel = (p) => path.relative(ROOT, p);
const read = (p) => fs.readFileSync(p, 'utf8');

const LAUNCHER = path.join(ROOT, 'templates', 'launcher.js.tpl');
const shipped = [...walk(path.join(ROOT, 'src')), LAUNCHER];
const jxaFiles = walk(path.join(ROOT, 'src', 'adapters', 'jxa'));
const writeFiles = walk(path.join(ROOT, 'src', 'adapters', 'jxa-write'));

test('no network, sockets, servers, dynamic code or workers anywhere in shipped code', () => {
  const banned = [
    /require\(\s*['"](?:node:)?(?:net|http|https|http2|dgram|tls|dns|worker_threads|cluster|vm|inspector|repl)['"]\s*\)/,
    /\bfetch\s*\(/, /\beval\s*\(/, /new\s+Function\b/, /XMLHttpRequest/, /WebSocket/, /\bimport\s*\(/,
  ];
  for (const f of shipped) {
    const src = read(f);
    for (const re of banned) assert.ok(!re.test(src), `${rel(f)} matches ${re}`);
  }
});

test('child_process only in the osascript adapter and the launcher (plutil for doctor)', () => {
  for (const f of shipped) {
    if (/child_process/.test(read(f))) {
      assert.ok(['src/adapters/jxa.js', 'templates/launcher.js.tpl'].includes(rel(f)), `${rel(f)} spawns processes`);
    }
  }
  const launcher = read(LAUNCHER);
  const execs = [...launcher.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(execs, ['/usr/bin/plutil']);
  assert.ok(!/shell:\s*true/.test(read(path.join(ROOT, 'src', 'adapters', 'jxa.js'))));
});

test('shipped code never writes files (only read-only fs calls are used)', () => {
  const readOnly = new Set(['readFileSync', 'accessSync', 'existsSync', 'constants']);
  for (const f of shipped) {
    const src = read(f);
    assert.ok(!/(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(src), `${rel(f)} destructures fs`);
    assert.ok(!/require\(\s*['"](?:node:)?fs\/promises['"]/.test(src), `${rel(f)} uses fs/promises`);
    for (const m of src.matchAll(/\bfs\.(\w+)/g)) assert.ok(readOnly.has(m[1]), `${rel(f)} calls fs.${m[1]}`);
    assert.ok(!/createWriteStream|process\.stdout\.fd|>>\s*['"`]/.test(src), `${rel(f)} may redirect output to a file`);
  }
});

test('shipped code never references private stores, Keychain, TCC or full-disk access', () => {
  const banned = /NoteStore|sqlite|AddressBook-v|Library\/(?:Group Containers|Messages|Keychains|Application Support)|Keychain|security\s+find|tccutil|TCC\.db|iCloud\.com|caldav|carddav|\.icloud/i;
  for (const f of [...shipped, ...jxaFiles]) assert.ok(!banned.test(read(f)), `${rel(f)} references a forbidden resource`);
});

test('test fakes are unreachable from the production entry points', () => {
  for (const f of shipped) {
    const src = read(f);
    assert.ok(!/fakes?[\\/]|fake-|createFakeAdapter|fake-data/.test(src.replace(/\/\/.*$/gm, '')), `${rel(f)} reaches a fake`);
  }
  for (const f of walk(path.join(ROOT, 'test'))) {
    if (f.endsWith('.test.js')) assert.ok(!/createJxaAdapter\(\s*\)/.test(read(f)), `${rel(f)} would start the real osascript`);
  }
});

test('JXA scripts are getter-only: no setters, make/delete/move, GUI scripting, shell or ObjC', () => {
  assert.ok(jxaFiles.length >= 4);
  const verbs = /\.(make|delete|move|duplicate|open|activate|quit|launch|close|save|unlock|lock|show|set|add|remove|reopen|print|export|import|click|keystroke|perform|complete)\s*\(/;
  const memberAssign = /[\w\])]\s*(?:\.\w+|\[[^\]\n]+\])\s*=(?!=|>)/;
  const banned = /\bObjC\b|\$\.|doShellScript|currentApplication|System Events|SystemEvents|\beval\b|\bFunction\s*\(|\brequire\b|\bdelay\s*\(|Standard Additions|includeStandardAdditions|\bdisplay(?:Dialog|Alert)\b/;
  for (const f of jxaFiles) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.ok(!verbs.test(src), `${rel(f)} calls a mutating/GUI verb`);
    assert.ok(!memberAssign.test(src), `${rel(f)} assigns to a member (possible setter)`);
    assert.ok(!banned.test(src), `${rel(f)} uses a banned construct`);
    for (const m of src.matchAll(/Application\(([^)]*)\)/g)) assert.equal(m[1], 'BUNDLE', `${rel(f)} opens an app by something other than the pinned bundle id`);
  }
});

test('JXA bundle ids are the ones confirmed locally', () => {
  const expect = { 'contacts.js': 'com.apple.AddressBook', 'reminders.js': 'com.apple.reminders', 'notes.js': 'com.apple.Notes', 'calendar.js': 'com.apple.iCal' };
  for (const [file, id] of Object.entries(expect)) {
    assert.ok(read(path.join(ROOT, 'src', 'adapters', 'jxa', file)).includes(`var BUNDLE = '${id}';`), file);
  }
  for (const [file, id] of Object.entries({ 'reminders.js': 'com.apple.reminders', 'notes.js': 'com.apple.Notes' })) {
    assert.ok(read(path.join(ROOT, 'src', 'adapters', 'jxa-write', file)).includes(`var BUNDLE = '${id}';`), file);
  }
});

test('notes script reads plaintext in exactly one guarded place and never the HTML body or attachments', () => {
  const src = read(path.join(ROOT, 'src', 'adapters', 'jxa', 'notes.js')).replace(/\/\/.*$/gm, '');
  assert.equal((src.match(/plaintext/g) || []).length, 1);
  assert.ok(/prot !== false\) \{ return \{ text: null, length: null \}; \}\s*var t = str\(rd\(ref, 'plaintext'/.test(src), 'plaintext must sit behind the prot !== false guard');
  assert.ok(!/['"]body['"]/.test(src), 'HTML body must not be read');
  assert.ok(!/attachment|\.unlock|password\s*\(/i.test(src));
});

test('project contains only code, docs and tests: no data files, databases or logs', () => {
  const allowed = new Set(['.js', '.md', '.tpl', '']);
  for (const f of walk(ROOT)) {
    const base = path.basename(f);
    if (base === 'package.json') continue;
    assert.ok(allowed.has(path.extname(f)), `unexpected file type: ${rel(f)}`);
  }
});

test('READ scripts cannot create: no constructors and no push into app collections', () => {
  for (const f of jxaFiles) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/\.(Reminder|Note|Event|Person|Group|Calendar|Folder)\s*\(/.test(src), `${rel(f)} constructs an object`);
    assert.ok(!/\.(reminders|notes|events|people|calendars|folders|lists)\.push\s*\(/.test(src), `${rel(f)} pushes into an app collection`);
  }
});

// Splits a script into its top-level functions: { name: body }.
function functionsOf(src) {
  const out = {};
  const re = /^function (\w+)\(/gm;
  const marks = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  marks.forEach((m, i) => { out[m.name] = src.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : src.length); });
  return out;
}

// What each write function may do. Everything else is forbidden in write scripts.
const RULES = {
  create: { push: 1, del: 0, assign: false, existingById: false },
  update: { push: 0, del: 0, assign: true, existingById: true },
  destroy: { push: 0, del: 1, assign: false, existingById: true },
};

test('WRITE scripts: per-function allowance (create pushes once, destroy deletes once, only calendar update assigns)', () => {
  assert.deepEqual(writeFiles.map((f) => path.basename(f)).sort(), ['calendar.js', 'notes.js', 'reminders.js']);
  const verbs = /\.(make|duplicate|open|activate|quit|launch|close|save|unlock|lock|show|set|add|remove|reopen|print|export|import|click|keystroke|perform|complete)\s*\(/;
  const memberAssign = /[\w\])]\s*(?:\.\w+|\[[^\]\n]+\])\s*=(?!=|>)/;
  const banned = /\bObjC\b|\$\.|doShellScript|currentApplication|System Events|\beval\b|\bFunction\s*\(|\brequire\b|Standard Additions|\bdisplay(?:Dialog|Alert)\b|plaintext/;
  const allowedFns = { create: 'create', update: 'update', destroy: 'destroy' };
  for (const f of writeFiles) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.ok(!verbs.test(src), `${rel(f)} calls a forbidden verb`);
    assert.ok(!banned.test(src), `${rel(f)} uses a banned construct`);
    for (const m of src.matchAll(/Application\(([^)]*)\)/g)) assert.equal(m[1], 'BUNDLE');
    const fns = functionsOf(src);
    const handlers = /entry\(argv, \{([^}]*)\}\)/.exec(src)[1];
    for (const [name, body] of Object.entries(fns)) {
      const rule = RULES[allowedFns[name]];
      const pushes = (body.match(/\.(reminders|notes|events)\.push\s*\(/g) || []).length;
      const dels = (body.match(/\ba\.delete\s*\(/g) || []).length;
      const anyDelete = (body.match(/\.delete\s*\(/g) || []).length;
      const byId = /\.(reminders|notes|events)\.byId/.test(body) || /locate\(/.test(body);
      if (!rule) {
        assert.ok(pushes === 0 && anyDelete === 0 && !memberAssign.test(body), `${rel(f)}:${name} is a helper and must not mutate`);
        continue;
      }
      assert.equal(pushes, rule.push, `${rel(f)}:${name} push count`);
      assert.equal(dels, rule.del, `${rel(f)}:${name} delete count`);
      assert.equal(anyDelete, rule.del, `${rel(f)}:${name} other delete call`);
      assert.equal(memberAssign.test(body), rule.assign, `${rel(f)}:${name} member assignment`);
      if (!rule.existingById) assert.ok(!byId, `${rel(f)}:${name} must not touch existing items`);
    }
    // only calendar.js may update; update never exists elsewhere
    assert.equal(/\bupdate\b/.test(handlers), path.basename(f) === 'calendar.js', `${rel(f)} update handler`);
    assert.ok(/delete: destroy/.test(handlers), `${rel(f)} delete handler`);
    assert.ok(/create: create/.test(handlers), `${rel(f)} create handler`);
  }
  const notesWrite = read(path.join(ROOT, 'src', 'adapters', 'jxa-write', 'notes.js')).replace(/\/\/.*$/gm, '');
  assert.ok(!/['"]body['"]/.test(notesWrite), 'notes write script must never read a body');
  const destroyNote = functionsOf(notesWrite).destroy;
  assert.ok(destroyNote.indexOf("refuse('protected_note')") < destroyNote.indexOf('a.delete('), 'protection guard must run before the delete');
  assert.ok(destroyNote.indexOf('titleMatches') < destroyNote.indexOf('a.delete('), 'identity guard must run before the delete');
});

test('every mutation in the calendar write script is behind its guards', () => {
  const src = read(path.join(ROOT, 'src', 'adapters', 'jxa-write', 'calendar.js')).replace(/\/\/.*$/gm, '');
  const fns = functionsOf(src);
  for (const name of ['update', 'destroy']) {
    const body = fns[name];
    const guard = body.indexOf('guardExisting(');
    assert.ok(guard !== -1, `${name} must call guardExisting`);
    const firstMutation = Math.min(...[body.indexOf('a.delete('), body.search(/\bref\.\w+ = /)].filter((i) => i !== -1));
    assert.ok(guard < firstMutation, `${name}: guards must run before any mutation`);
  }
  const g = fns.guardExisting;
  for (const reason of ['read_only_calendar', 'title_mismatch', 'recurring_event', 'has_attendees', 'attendees_unknown']) assert.ok(g.includes(`refuse('${reason}')`), reason);
  assert.ok(fns.create.includes("refuse('read_only_calendar')"));
  assert.ok(fns.create.indexOf("refuse('read_only_calendar')") < fns.create.indexOf('.events.push('));
});

test('the adapter keeps write scripts out of every read mode', () => {
  const src = read(path.join(ROOT, 'src', 'adapters', 'jxa.js'));
  assert.ok(/const write = Object\.prototype\.hasOwnProperty\.call\(WRITE_ALLOWED, mode\);/.test(src));
  assert.ok(/create: new Set\(\['reminders', 'notes', 'calendar'\]\)/.test(src));
  assert.ok(/update: new Set\(\['calendar'\]\)/.test(src));
  assert.ok(/delete: new Set\(\['reminders', 'notes', 'calendar'\]\)/.test(src));
  assert.ok(!/jxa-write/.test(read(path.join(ROOT, 'src', 'commands.js'))), 'commands must not pick scripts');
});
