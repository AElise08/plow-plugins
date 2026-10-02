'use strict';

// Real backend: one short-lived `osascript -l JavaScript` process per query.
// The JXA source is static (prelude + per-app script read from this repo). User
// input only travels as separate argv elements and is parsed as JSON data on the
// other side: it is never concatenated into code.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { QueryError } = require('../errors');
const { APPS } = require('../sdef');

const OSASCRIPT = '/usr/bin/osascript';
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const SCRIPT_DIR = path.join(__dirname, 'jxa');
const WRITE_DIR = path.join(__dirname, 'jxa-write');
// Which write modes each app supports. Anything else is refused before spawning.
const WRITE_ALLOWED = {
  create: new Set(['reminders', 'notes', 'calendar']),
  update: new Set(['calendar']),
  delete: new Set(['reminders', 'notes', 'calendar']),
};
const GUARD_REASONS = new Set([
  'title_mismatch', 'title_unreadable', 'protected_note', 'protection_unknown', 'recurring_event',
  'has_attendees', 'attendees_unknown', 'read_only_calendar', 'all_day_time_change',
]);

// Write modes only ever load scripts from jxa-write/; read modes only from jxa/.
// Read-only helper files (prelude, <app>-common) are shared by both.
const sources = new Map();
function sourceFor(app, mode) {
  const write = Object.prototype.hasOwnProperty.call(WRITE_ALLOWED, mode);
  if (write && !WRITE_ALLOWED[mode].has(app)) throw new QueryError('INTERNAL');
  const key = `${write ? 'w' : 'r'}:${app}`;
  if (!sources.has(key)) {
    const parts = [fs.readFileSync(path.join(SCRIPT_DIR, 'prelude.js'), 'utf8')];
    const common = path.join(SCRIPT_DIR, `${app}-common.js`);
    if (fs.existsSync(common)) parts.push(fs.readFileSync(common, 'utf8'));
    parts.push(fs.readFileSync(path.join(write ? WRITE_DIR : SCRIPT_DIR, `${app}.js`), 'utf8'));
    sources.set(key, parts.join('\n'));
  }
  return sources.get(key);
}

// Numbers only. Error messages from apps may contain personal content and are
// never forwarded.
function mapAppError(number, where, reason) {
  if (where === 'guard') {
    return new QueryError('GUARD_REFUSED', undefined, { reason: GUARD_REASONS.has(reason) ? reason : 'unspecified' });
  }
  switch (number) {
    case -1743: case -10004:
      return new QueryError('PERMISSION_DENIED');
    case -1712:
      return new QueryError('TIMEOUT', 'The app did not answer the Apple Event in time (error -1712).');
    case -600: case -609:
      return new QueryError('APP_UNAVAILABLE');
    case -1708:
      return new QueryError('METHOD_UNAVAILABLE');
    case -1728: case -1719:
      if (where === 'scope' || where === 'item') return new QueryError('NOT_FOUND');
      return new QueryError('APP_ERROR', undefined, { app_error_number: number });
    default:
      return new QueryError('APP_ERROR', undefined, { app_error_number: Number.isInteger(number) ? number : null });
  }
}

function lastErrorNumber(stderr) {
  const all = [...stderr.matchAll(/\((-?\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

function createJxaAdapter({ spawnFn = spawn, osascript = OSASCRIPT } = {}) {
  return {
    name: 'jxa',
    call(app, mode, params, { timeoutMs }) {
      if (!APPS[app]) return Promise.reject(new QueryError('INTERNAL'));
      let source;
      try { source = sourceFor(app, mode); } catch (e) { return Promise.reject(e instanceof QueryError ? e : new QueryError('INTERNAL')); }
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnFn(
            osascript,
            ['-l', 'JavaScript', '-e', source, mode, JSON.stringify(params)],
            { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
          );
        } catch {
          reject(new QueryError('RUNTIME_MISSING', 'osascript could not be started.'));
          return;
        }
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          finish(reject, new QueryError('TIMEOUT'));
        }, timeoutMs);
        const out = [];
        let outBytes = 0;
        let err = '';
        child.stdout.on('data', (b) => {
          outBytes += b.length;
          if (outBytes > MAX_STDOUT_BYTES) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            finish(reject, new QueryError('ADAPTER_SCHEMA', 'Adapter output exceeded the internal buffer limit.'));
            return;
          }
          out.push(b);
        });
        child.stderr.on('data', (b) => { if (err.length < 8192) err += b.toString('utf8'); });
        child.on('error', () => finish(reject, new QueryError('RUNTIME_MISSING', 'osascript could not be started.')));
        child.on('close', (code) => {
          const text = Buffer.concat(out).toString('utf8').trim();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          if (parsed && parsed.error && typeof parsed.error === 'object') {
            finish(reject, mapAppError(parsed.error.number, parsed.error.where, parsed.error.reason));
            return;
          }
          if (code !== 0 || parsed === null) {
            if (code !== 0) {
              finish(reject, mapAppError(lastErrorNumber(err), 'unknown'));
            } else {
              finish(reject, new QueryError('ADAPTER_SCHEMA', 'Adapter did not return JSON.'));
            }
            return;
          }
          finish(resolve, parsed);
        });
      });
    },
  };
}

module.exports = { createJxaAdapter, mapAppError, OSASCRIPT };
