'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateCapabilities, loadCapabilities, parseSdef, APPS } = require('../src/sdef');

// Minimal fictional dictionaries; the real ones are only read by `doctor`.
const NOTES_OK = `<dictionary>
<suite name="Notes">
 <class-extension extends="application"><element type="account"/><element type="folder"/><element type="note"/></class-extension>
 <class name="account" code="acct"><property name="id" code="ID  " type="text" access="r"/><property name="name" code="pnam" type="text"/><element type="folder"/><element type="note"/></class>
 <class name="folder" code="cfol"><property name="id" code="ID  " type="text"/><property name="name" code="pnam" type="text"/><element type="folder"/><element type="note"/></class>
 <class name="note" code="note"><property name="id" code="ID  " type="text"/><property name="name" code="pnam"/><property name="container" code="cntr" type="folder"/>
   <property name="plaintext" code="text" type="text"/><property name="password protected" code="pwpr" type="boolean"/><property name="modification date" code="asmo" type="date"/></class>
</suite></dictionary>`;
const without = (xml, prop) => xml.replace(new RegExp(`<property name="${prop}"[^>]*/>`), '');

test('sdef parser follows class-extension and inheritance', () => {
  const c = parseSdef('<dictionary><class name="contact info"><property name="value"/></class><class name="email" inherits="contact info"/>' +
    '<class-extension extends="application"><element type="person"/></class-extension><class name="person"><property name="id"/></class></dictionary>');
  assert.ok(c.application.elements.has('person'));
  assert.ok(c.person.properties.has('id'));
  assert.equal(c.email.inherits, 'contact info');
});

test('complete dictionary: nothing blocked, text features supported', () => {
  const r = evaluateCapabilities('notes', NOTES_OK);
  assert.equal(r.blocked, false);
  assert.ok(r.supported.includes('note_text'));
  assert.deepEqual(r.missing_required, []);
});

test('missing required property blocks the app; missing optional shows as unsupported', () => {
  const blocked = evaluateCapabilities('notes', without(NOTES_OK, 'id'));
  assert.equal(blocked.blocked, true);
  const noMarker = evaluateCapabilities('notes', without(NOTES_OK, 'password protected'));
  assert.equal(noMarker.blocked, false, 'optional: title search remains');
  assert.ok(noMarker.unsupported.some((u) => u.feature === 'note_text' && u.missing.some((m) => m.includes('password protected'))));
  assert.ok(!noMarker.supported.includes('note_text'));
});

test('unreadable dictionary blocks instead of guessing', () => {
  const r = loadCapabilities('notes', { readFile: () => { throw new Error('nope'); } });
  assert.equal(r.blocked, true);
  assert.equal(r.dictionary, 'unreadable');
});

test('confirmed bundle identifiers are pinned', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(APPS).map(([k, v]) => [k, v.bundleId])), {
    contacts: 'com.apple.AddressBook', reminders: 'com.apple.reminders', notes: 'com.apple.Notes', calendar: 'com.apple.iCal',
  });
});

// ---- process level, over the fake backend only (test/fakes/fake-cli.js)
const FAKE_CLI = path.join(__dirname, 'fakes', 'fake-cli.js');
const exec = (args, faults) => spawnSync(process.execPath, [FAKE_CLI, ...args], {
  encoding: 'utf8', env: { ...process.env, MQ_FAKE_FAULTS: faults ? JSON.stringify(faults) : '' },
});

test('process: exactly one JSON line on stdout, empty stderr, exit 0', () => {
  const r = exec(['contacts', 'search', '--query', 'ana']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).items[0].id, 'p1');
});

test('process: failures exit non-zero, stdout stays one JSON object, stderr is only the code', () => {
  const denied = exec(['contacts', 'search', '--query', 'ana'], { permissionDenied: true });
  assert.equal(denied.status, 3);
  assert.equal(denied.stderr, 'mac-query: PERMISSION_DENIED\n');
  assert.equal(JSON.parse(denied.stdout).ok, false);
  const forbidden = exec(['notes', 'edit', '--id', 'n1']);
  assert.equal(forbidden.status, 2);
  assert.equal(JSON.parse(forbidden.stdout).error.code, 'FORBIDDEN_COMMAND');
  assert.equal(forbidden.stderr, 'mac-query: FORBIDDEN_COMMAND\n');
});

test('process: shell metacharacters in arguments are inert data', () => {
  const r = exec(['contacts', 'search', '--query', '$(echo PWNED); `echo PWNED` "; do shell script "echo PWNED"']);
  assert.equal(r.status, 0);
  assert.ok(!r.stdout.includes('PWNED'));
  assert.equal(JSON.parse(r.stdout).items.length, 0);
});
