#!/usr/bin/env node
/**
 * Runs a plugin the way Latch runs a `plow_run_command`: under /usr/bin/sandbox-exec with
 * the same deny-by-default profile, the same curated environment and the plugin's own
 * directory as cwd. It is a REPLICA of packages/device-core/src/executor.ts (SandboxProfile
 * and the spawn environment) at plow-pbc/latch commit 006f4db79b1234842fe9e525dda0c6352e61030a.
 * If Latch changes those, update this file. It is evidence about the sandbox, not about Latch.
 *
 *   node scripts/sandbox-smoke.mjs <plugin> [--apple-events] -- <plugin args...>
 *
 *   node scripts/sandbox-smoke.mjs reminders -- --help          # allowed: reaches nothing
 *   node scripts/sandbox-smoke.mjs reminders -- doctor          # reads the .sdef, no Apple Event
 *   node scripts/sandbox-smoke.mjs reminders -- lists           # no apple_events: the sandbox must deny it
 *   node scripts/sandbox-smoke.mjs reminders --apple-events -- lists   # REAL call: reads the owner's app
 *   node scripts/sandbox-smoke.mjs reminders --raw -- /usr/bin/osascript ...   # a bare command, same sandbox
 *
 * Without --apple-events no Apple Event can leave the sandbox, so nothing in an app is read.
 * With it, the command really runs against the app (and macOS may ask for Automation).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const head = sep === -1 ? argv : argv.slice(0, sep);
const tail = sep === -1 ? [] : argv.slice(sep + 1);
const plugin = head.find((a) => !a.startsWith('--'));
const appleEvents = head.includes('--apple-events');
const raw = head.includes('--raw'); // run the args after `--` as a bare command (diagnostics)
if (!plugin || !fs.existsSync(path.join(repo, plugin, 'latch-plugin.json'))) {
  console.error('usage: sandbox-smoke.mjs <contacts|reminders|notes|calendar> [--apple-events] -- <plugin args...>');
  process.exit(2);
}

const canonical = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const quote = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const READ_BOILERPLATE = ['/usr', '/bin', '/sbin', '/System', '/Library', '/opt', '/private/etc', '/private/var/db', '/private/var/select'];
const READ_LITERALS = ['/', '/private', '/private/var', '/private/var/run/cupsd', '/private/tmp', '/tmp', '/var', '/etc', '/Users', '/dev/null', '/dev/urandom', '/dev/random', '/dev/zero', '/dev/tty'];

function profile({ scratch, cwd, network = false }) {
  const home = canonical(os.homedir());
  const lines = [
    '(version 1)', '(deny default)', '(allow process-fork)', '(allow process-exec)', '(allow process-info*)',
    '(allow signal (target children))', '(allow sysctl-read)', '(allow mach-lookup)', '(allow lsopen)',
    '(allow file-read-metadata)', '(allow file-ioctl)',
    `(allow file-read* ${[...READ_BOILERPLATE.map((p) => `(subpath ${quote(p)})`), ...READ_LITERALS.map((p) => `(literal ${quote(p)})`), '(subpath "/dev/fd")'].join(' ')})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd"))',
    `(allow file-read* (subpath ${quote(home)}))`,
  ];
  for (const p of [scratch].map(canonical)) {
    lines.push(`(allow file-write* (subpath ${quote(p)}))`, `(allow file-read* (subpath ${quote(p)}))`);
  }
  lines.push(`(allow file-read* (subpath ${quote(canonical(cwd))}))`);
  lines.push(network ? '(allow network*)' : '(deny network*)');
  if (appleEvents) lines.push('(allow appleevent-send)');
  return lines.join('\n');
}

const home = os.homedir();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plow-smoke-'));
const manifest = JSON.parse(fs.readFileSync(path.join(repo, plugin, 'latch-plugin.json'), 'utf8'));
const cwd = canonical(path.join(repo, plugin));
// Latch: runArgv = [exec.argv[0], ...exec.argv.slice(1), ...agentArgv.slice(1)]
const runArgv = raw ? tail : [...manifest.exec.argv, ...tail];
const env = {
  PATH: [`${home}/.local/bin`, `${home}/bin`, `${home}/.cargo/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  HOME: home, TMPDIR: scratch, LANG: 'en_US.UTF-8',
};
try {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', profile({ scratch, cwd }), ...runArgv], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  console.log(JSON.stringify({ plugin, apple_events: appleEvents, argv: runArgv, exit: r.status, signal: r.signal }));
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
