// Shared prelude (getters and guard helpers only). Concatenated (as static source) in
// front of each app script by src/adapters/jxa.js. It contains no setters, no
// make/delete/move, no GUI scripting, no shell and no ObjC bridge.
// Errors are reported as numbers only (never messages, which could carry content).
function fatal(number, where, reason) { return { fatal: true, number: number, where: where, reason: reason === undefined ? null : reason }; }

// A guard refusal: nothing was changed. `reason` is a fixed token, never app content.
function refuse(reason) { return fatal(null, 'guard', reason); }

function errno(e) {
  try {
    var m = /\((-?\d+)\)\s*$/.exec(String(e && e.message));
    if (m) { return Number(m[1]); }
  } catch (x) { /* no number available */ }
  return null;
}

// -1743 not authorised, -600 app not running, -10004 privilege violation,
// -609 connection invalid, -1712 Apple Event timed out.
function isHard(n) { return n === -1743 || n === -600 || n === -10004 || n === -609 || n === -1712; }

// Required read: any failure aborts the command.
function req(ref, name, where) {
  try { return ref[name](); } catch (e) { throw fatal(errno(e), where); }
}

// Optional read: an unavailable property is recorded, not turned into empty.
function rd(ref, name, un, key) {
  try {
    var v = ref[name]();
    return v === undefined ? null : v;
  } catch (e) {
    var n = errno(e);
    if (isHard(n)) { throw fatal(n, 'item'); }
    un.push(key);
    return null;
  }
}

function str(v) { return typeof v === 'string' ? v : null; }
function bool(v) { return typeof v === 'boolean' ? v : null; }
function iso(d) { return (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString() : null; }
// After a delete: true when the item's id can no longer be read. The app reports a
// vanished item with different error numbers (Calendar did not use -1728 on the
// tested Mac), so any non-fatal read failure counts as gone; hard failures
// (permission, app not running, timeout) stay "not verified".
function isGone(ref) {
  try { ref.id(); return false; } catch (e) { return !isHard(errno(e)); }
}

// Identity guard for destructive/editing calls: the current title must start with
// the title the caller saw (so a wrong or stale id cannot hit another item).
function titleMatches(title, expected) {
  return typeof expected === 'string' && expected.length > 0 &&
    title.normalize('NFC').indexOf(expected.normalize('NFC')) === 0;
}

function pastDeadline(deadline) { return Date.now() >= deadline; }

function cacheFind(cache, key) {
  for (var i = 0; i < cache.length; i++) { if (cache[i][0] === key) { return cache[i][1]; } }
  return undefined;
}

function entry(argv, handlers) {
  var out;
  try {
    var params = JSON.parse(argv[1]);
    var mode = argv[0];
    if (!Object.prototype.hasOwnProperty.call(handlers, mode)) { throw fatal(null, 'mode'); }
    out = handlers[mode](params);
  } catch (e) {
    var f = (e && e.fatal === true) ? e : fatal(errno(e), 'unknown');
    out = { error: { number: f.number, where: f.where, reason: f.reason === undefined ? null : f.reason } };
  }
  return JSON.stringify(out);
}
