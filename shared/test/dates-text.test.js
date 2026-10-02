'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../src/dates');
const { truncate, norm, snippetAround } = require('../src/text');

const SP = 'America/Sao_Paulo';
const iso = (ms) => new Date(ms).toISOString();

test('RFC3339 with offset parses to the exact instant; Z and offsets agree', () => {
  const a = dates.parseBound('2026-10-03T00:00:00-03:00', 'from', SP, '--due-from').ms;
  const b = dates.parseBound('2026-10-03T03:00:00Z', 'from', SP, '--due-from').ms;
  assert.equal(a, b);
  assert.equal(iso(a), '2026-10-03T03:00:00.000Z');
  assert.equal(iso(dates.parseBound('2026-10-03T05:30:00+05:30', 'to', SP, '--due-to').ms), '2026-10-03T00:00:00.000Z');
});

test('datetime without offset, impossible dates and junk are rejected (never assume UTC)', () => {
  for (const bad of ['2026-10-03T09:00:00', '2026-02-30', '2026-13-01', '2026-10-03T25:00:00Z', '03/10/2026', '2026-10-03 09:00:00Z', '']) {
    assert.throws(() => dates.parseBound(bad, 'from', SP, '--due-from'), (e) => e.code === 'INVALID_ARGUMENT', bad);
  }
});

test('a bare day means the whole day in the given tz, not in UTC', () => {
  const from = dates.parseBound('2026-10-03', 'from', SP, '--due-from').ms;
  const to = dates.parseBound('2026-10-03', 'to', SP, '--due-to').ms;
  assert.equal(iso(from), '2026-10-03T03:00:00.000Z');
  assert.equal(iso(to), '2026-10-04T03:00:00.000Z');
  assert.equal(iso(dates.parseBound('2026-10-03', 'from', 'UTC', '--due-from').ms), '2026-10-03T00:00:00.000Z');
  assert.equal(iso(dates.parseBound('2026-10-03', 'from', 'Asia/Tokyo', '--due-from').ms), '2026-10-02T15:00:00.000Z');
});

test('day start survives a DST gap at midnight (Sao Paulo, 2018-11-04) and month ends', () => {
  const start = dates.startOfDay(2018, 11, 4, SP);
  assert.equal(iso(start), '2018-11-04T03:00:00.000Z'); // 00:00 never existed; day starts at the jump
  assert.equal(dates.formatInTz(start, SP), '2018-11-04T01:00:00-02:00');
  assert.equal(iso(dates.parseBound('2026-12-31', 'to', 'UTC', '--due-to').ms), '2027-01-01T00:00:00.000Z');
  assert.equal(iso(dates.parseBound('2028-02-29', 'to', 'UTC', '--due-to').ms), '2028-03-01T00:00:00.000Z');
});

test('formatting keeps the offset; half-hour zones work', () => {
  const ms = Date.parse('2026-10-03T03:00:00Z');
  assert.equal(dates.formatInTz(ms, SP), '2026-10-03T00:00:00-03:00');
  assert.equal(dates.formatInTz(ms, 'UTC'), '2026-10-03T03:00:00+00:00');
  assert.equal(dates.formatInTz(ms, 'Asia/Kolkata'), '2026-10-03T08:30:00+05:30');
  assert.equal(dates.dateInTz(ms, SP), '2026-10-03');
  assert.throws(() => dates.validateTimeZone('Mars/Olympus'), (e) => e.code === 'INVALID_ARGUMENT');
});

test('truncation is explicit and never splits graphemes', () => {
  assert.deepEqual(truncate('abc', 5), { text: 'abc', truncated: false });
  assert.deepEqual(truncate('abcdef', 3), { text: 'abc', truncated: true });
  const nfd = 'ééé'; // three "é" as base+combining
  assert.deepEqual(truncate(nfd, 2), { text: 'éé', truncated: true });
  assert.equal(truncate('👩‍👩‍👧‍👦👩‍👩‍👧‍👦', 1).text, '👩‍👩‍👧‍👦');
});

test('matching is literal and case-insensitive; NFC/NFD agree; accents are not folded', () => {
  assert.equal(norm('Ávila'), norm('Ávila'));
  assert.notEqual(norm('Avila'), norm('Ávila'));
  assert.equal(norm('SILVA'), 'silva');
});

test('snippet is a small window around the first match', () => {
  const text = `${'a'.repeat(200)} ALVO ${'b'.repeat(200)}`;
  const s = snippetAround(text, 'alvo', 10);
  assert.equal(s.text, `${'a'.repeat(9)} ALVO ${'b'.repeat(9)}`);
  assert.deepEqual([s.cut_start, s.cut_end], [true, true]);
  assert.equal(snippetAround('nada aqui', 'alvo', 10), null);
});
