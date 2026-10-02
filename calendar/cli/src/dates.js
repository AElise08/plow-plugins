'use strict';

const { invalid } = require('./errors');

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function detectTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function validateTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw invalid('--tz is not a valid IANA time zone name.');
  }
  return tz;
}

const formatters = new Map();
function partsFormatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
    );
  }
  return formatters.get(tz);
}

function wallParts(ms, tz) {
  const o = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second,
  };
}

// Offset (ms) of tz at an instant: wall-clock-as-UTC minus the instant.
function offsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  const floored = Math.floor(ms / 1000) * 1000;
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function validCalendarDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// First instant of a calendar day in tz. Handles DST gaps/folds (e.g. zones
// where clocks jump at midnight): the day starts at the earliest valid instant.
function startOfDay(y, mo, d, tz) {
  const guess = Date.UTC(y, mo - 1, d);
  const target = guess;
  const offsets = new Set([
    offsetMs(guess - 86400000, tz), offsetMs(guess, tz), offsetMs(guess + 86400000, tz),
  ]);
  const wallAsUtc = (t) => {
    const w = wallParts(t, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  };
  const exact = [];
  const after = [];
  for (const o of offsets) {
    const t = guess - o;
    const w = wallAsUtc(t);
    if (w === target) exact.push(t);
    else if (w > target) after.push(t);
  }
  if (exact.length) return Math.min(...exact);
  if (after.length) return Math.min(...after);
  return guess - offsetMs(guess, tz);
}

function nextDay(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d + 1));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Parse a bound for --due-from / --due-to.
 * - RFC3339 with explicit offset (or Z): an exact instant.
 * - YYYY-MM-DD: a whole day in `tz`. As --due-from it contributes the start of
 *   that day; as --due-to it contributes the start of the NEXT day, so the
 *   whole named day is covered (the bound itself stays exclusive).
 * Never assumes UTC for a bare date or a datetime without offset.
 */
function parseBound(value, role, tz, flag) {
  let m = RFC3339.exec(value);
  if (m) {
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    if (!validCalendarDate(y, mo, d) || h > 23 || mi > 59 || s > 59) {
      throw invalid(`${flag} is not a valid RFC3339 date-time.`);
    }
    const off = m[7];
    let offMs = 0;
    if (off.toUpperCase() !== 'Z') {
      const oh = +off.slice(1, 3);
      const om = +off.slice(4, 6);
      if (oh > 23 || om > 59) throw invalid(`${flag} has an invalid UTC offset.`);
      offMs = (off[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60000;
    }
    const frac = /\.(\d+)/.exec(value);
    const msPart = frac ? Math.floor(Number('0.' + frac[1]) * 1000) : 0;
    return { ms: Date.UTC(y, mo - 1, d, h, mi, s, msPart) - offMs, kind: 'instant' };
  }
  m = DAY.exec(value);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    if (!validCalendarDate(y, mo, d)) throw invalid(`${flag} is not a valid calendar date.`);
    if (role === 'from') return { ms: startOfDay(y, mo, d, tz), kind: 'day' };
    const n = nextDay(y, mo, d);
    return { ms: startOfDay(n.y, n.mo, n.d, tz), kind: 'day' };
  }
  throw invalid(`${flag} must be RFC3339 with offset (e.g. 2026-01-31T09:00:00-03:00) or YYYY-MM-DD.`);
}

function formatInTz(ms, tz) {
  const w = wallParts(ms, tz);
  const off = Math.round(offsetMs(ms, tz) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return (
    `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
  );
}

function dateInTz(ms, tz) {
  const w = wallParts(ms, tz);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
}

// ISO string produced by the adapter (UTC, Z) -> epoch ms, or null.
function parseAdapterInstant(iso) {
  if (iso === null || iso === undefined) return null;
  if (typeof iso !== 'string' || !ISO_Z.test(iso)) return NaN;
  return Date.parse(iso);
}

module.exports = {
  detectTimeZone, validateTimeZone, parseBound, formatInTz, dateInTz, startOfDay,
  parseAdapterInstant,
};
