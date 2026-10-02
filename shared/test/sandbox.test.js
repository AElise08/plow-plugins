'use strict';

// Runs the real plugin folders under a replica of Latch's sandbox (scripts/sandbox-smoke.mjs,
// pinned to a Latch commit). macOS only. Nothing here reads an app: --help and doctor never
// send an Apple Event, and the "denied" tests only run once a probe has shown that this
// sandbox really blocks Apple Events (and they use reads only, never a write).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const SMOKE = path.join(REPO, 'scripts', 'sandbox-smoke.mjs');
const APPS = ['contacts', 'reminders', 'notes', 'calendar'];

const sandboxUsable = process.platform === 'darwin'
  && fs.existsSync('/usr/bin/sandbox-exec')
  && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)\n(allow default)', '/usr/bin/true']).status === 0;
const t = sandboxUsable ? test : test.skip;

function smoke(plugin, args, flags = []) {
  const r = spawnSync(process.execPath, [SMOKE, plugin, ...flags, '--', ...args], { encoding: 'utf8', timeout: 120000 });
  const lines = r.stdout.split('\n');
  const header = JSON.parse(lines[0]);
  const body = lines[1] ? JSON.parse(lines[1]) : null;
  return { header, body, stderr: r.stderr };
}

t('every plugin starts under the sandbox and answers --help (Node is found on Latch\'s PATH)', () => {
  for (const app of APPS) {
    const { header, body } = smoke(app, ['--help']);
    assert.equal(header.exit, 0, app);
    assert.equal(body.ok, true);
    assert.ok(body.items.length >= 3);
  }
});

t('doctor works under the sandbox: the .sdef is readable and plutil runs', () => {
  for (const app of APPS) {
    const { header, body } = smoke(app, ['doctor']);
    assert.equal(header.exit, 0, app);
    const item = body.items.find((i) => i.kind === 'app');
    assert.deepEqual([item.app, item.dictionary, item.bundle_id_confirmed, item.commands], [app, 'ok', true, 'available']);
  }
});

// The probe: a bare osascript that tries one Apple Event. Under this sandbox without
// appleevent-send it must fail with -600; if it does not, the denial tests do not run.
function sandboxBlocksAppleEvents() {
  const r = spawnSync(process.execPath, [SMOKE, 'reminders', '--raw', '--', '/usr/bin/osascript', '-l', 'JavaScript', '-e',
    'try { Application("com.apple.reminders").accounts(); "reached" } catch (e) { "ERR " + e.errorNumber }'], { encoding: 'utf8', timeout: 60000 });
  return r.stdout.includes('ERR -600');
}
const blocked = sandboxUsable && sandboxBlocksAppleEvents();

(blocked ? test : test.skip)('without apple_events the sandbox stops the call, and the answer says what to do about it', () => {
  const reads = { contacts: ['search', '--query', 'x'], reminders: ['lists'], notes: ['folders'], calendar: ['calendars'] };
  for (const app of APPS) {
    const { header, body } = smoke(app, reads[app]);
    assert.equal(header.exit, 7, app);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'APP_UNAVAILABLE', `${app}: error -600 is reported as APP_UNAVAILABLE, not an opaque APP_ERROR`);
    assert.ok(body.error.detail.includes('apple_events=true'), 'the message names the missing flag');
    assert.equal(body.items, null);
  }
});
