'use strict';

const { QueryError } = require('./errors');
const { validateAdapterResult } = require('./schema');
const { truncate, norm, includesLiteral, snippetAround } = require('./text');
const dates = require('./dates');

// Facts that could only be proven against the real apps. Flip to true only after
// a real, user-authorised test confirms them.
const VERIFIED_ON_REAL_MAC = { reminders_allday_distinction: false, calendar_recurring_expansion: false };

const SNIPPET_WINDOW = 60;

async function callAdapter(ctx, app, mode, params, opts) {
  const timeoutMs = opts.timeout * 1000;
  const raw = await ctx.adapter.call(
    app, mode, { ...params, soft_deadline_ms: Math.floor(timeoutMs * 0.8) }, { timeoutMs },
  );
  return validateAdapterResult(app, mode, raw);
}

function checkScan(raw, scanLimit) {
  if (raw.scanned > scanLimit || raw.scanned > raw.total || raw.records.length !== raw.scanned) {
    throw new QueryError('ADAPTER_SCHEMA', 'Adapter scan counters are inconsistent with its records.');
  }
}

function scanReasons(raw) {
  const reasons = [];
  if (raw.stopped === 'time') reasons.push('TIME_LIMIT');
  else if (raw.total > raw.scanned) reasons.push('SCAN_LIMIT');
  return reasons;
}

function textOf(value, maxChars, truncatedFields, name) {
  const t = truncate(value, maxChars);
  if (t.truncated) truncatedFields.push(name);
  return t.text;
}

function withTruncation(item, fields) {
  return { ...item, truncated: fields.length > 0, truncated_fields: fields };
}

function scanCoverage(raw, scanLimit, reasons, matched, returned, limit, extra) {
  return {
    scanned: raw.scanned,
    total_in_scope: raw.total,
    scan_limit: scanLimit,
    matched,
    returned,
    limit,
    limit_reached: matched > returned,
    output_truncated: false,
    complete: reasons.length === 0,
    reasons,
    scope_order: 'app-native order, guaranteed only within the scanned scope',
    ...extra,
  };
}

function unavailableCounts(records) {
  const counts = {};
  for (const r of records) for (const f of r.unavailable) counts[f] = (counts[f] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- contacts

function contactItem(r, maxChars) {
  const tf = [];
  const item = {
    id: r.id,
    name: r.name === null ? null : textOf(r.name, maxChars, tf, 'name'),
    emails: r.emails === null ? null : r.emails.map((e) => textOf(e, maxChars, tf, 'emails')),
    phones: r.phones === null ? null : r.phones.map((p) => textOf(p, maxChars, tf, 'phones')),
  };
  if (r.unavailable.length) item.unavailable = r.unavailable;
  return withTruncation(item, [...new Set(tf)]);
}

async function contactsSearch(opts, ctx) {
  const q = norm(opts.query);
  const raw = await callAdapter(ctx, 'contacts', 'scan', {
    group_id: opts['group-id'] || null, scan_limit: opts['scan-limit'],
  }, opts);
  checkScan(raw, opts['scan-limit']);
  const matches = raw.records.filter((r) => (
    includesLiteral(r.name, q)
    || (r.emails || []).some((e) => includesLiteral(e, q))
    || (r.phones || []).some((p) => includesLiteral(p, q))
  ));
  const unavail = unavailableCounts(raw.records);
  const reasons = scanReasons(raw);
  const searchedFieldsMissing = ['name', 'emails', 'phones'].some((f) => unavail[f]);
  if (searchedFieldsMissing) reasons.push('FIELD_UNAVAILABLE');
  const items = matches.slice(0, opts.limit).map((r) => contactItem(r, opts['max-chars']));
  const warnings = [];
  if (!opts['group-id'] && raw.total > raw.scanned) {
    warnings.push({ code: 'PARTIAL_SCAN', message: 'Only part of the address book was examined; absence of a result is not conclusive.' });
  }
  return {
    source: 'contacts', items, warnings,
    query: { match: 'literal, case-insensitive, accents not folded', fields: ['name', 'phones', 'emails'], group_id: opts['group-id'] || null },
    coverage: scanCoverage(raw, opts['scan-limit'], reasons, matches.length, items.length, opts.limit, {
      unavailable_fields: unavail,
      phone_matching: 'literal; formatting differences (spaces, dashes, +55) are not normalised',
    }),
  };
}

async function contactsShow(opts, ctx) {
  const raw = await callAdapter(ctx, 'contacts', 'show', { id: opts.id }, opts);
  const item = contactItem(raw.record, opts['max-chars']);
  return {
    source: 'contacts', items: [item], warnings: [],
    coverage: { scanned: 1, returned: 1, complete: true, reasons: [], output_truncated: false, fields: ['id', 'name', 'emails', 'phones'], unsupported: ['notes', 'birthday', 'addresses', 'photo'] },
  };
}

// --------------------------------------------------------------- reminders

function dueFields(r, features, tz) {
  const due = dates.parseAdapterInstant(r.due);
  const allday = dates.parseAdapterInstant(r.allday_due);
  if (Number.isNaN(due) || Number.isNaN(allday)) throw new QueryError('ADAPTER_SCHEMA', 'Adapter due date is not a valid instant.');
  if (due === null && allday === null) return { ms: null, all_day: null, due: null, has_due: false };
  let ms;
  let allDay;
  if (!features.includes('all_day_due_date')) { ms = due !== null ? due : allday; allDay = null; }
  else if (allday !== null && due === null) { ms = allday; allDay = true; }
  else if (due !== null && allday === null) { ms = due; allDay = false; }
  else { ms = due; allDay = null; } // both present: distinction cannot be proven
  return {
    ms,
    all_day: allDay,
    due: allDay === true ? dates.dateInTz(ms, tz) : dates.formatInTz(ms, tz),
    has_due: true,
  };
}

function reminderItem(r, maxChars, features, tz, extra) {
  const tf = [];
  const d = dueFields(r, features, tz);
  const item = {
    id: r.id,
    title: r.title === null ? null : textOf(r.title, maxChars, tf, 'title'),
    list: { id: r.list_id, name: r.list_name === null ? null : textOf(r.list_name, maxChars, tf, 'list.name') },
    completed: r.completed,
    due: d.due,
    all_day: d.all_day,
    has_due: d.has_due,
    ...(extra ? extra(tf) : {}),
  };
  if (r.unavailable.length) item.unavailable = r.unavailable;
  return { item: withTruncation(item, [...new Set(tf)]), ms: d.ms };
}

function allDayWarnings(anyDue, features) {
  if (!anyDue) return [];
  if (!features.includes('all_day_due_date')) {
    return [{ code: 'ALL_DAY_UNSUPPORTED', message: 'This Reminders dictionary exposes no all-day due date; date-only reminders cannot be told apart (all_day is null).' }];
  }
  if (!VERIFIED_ON_REAL_MAC.reminders_allday_distinction) {
    return [{ code: 'ALL_DAY_UNVERIFIED', message: 'The dictionary has separate due date / all-day due date properties, but how the app reports them was not proven on this Mac; all_day=null means undetermined.' }];
  }
  return [];
}

async function remindersLists(opts, ctx) {
  const raw = await callAdapter(ctx, 'reminders', 'lists', {}, opts);
  const items = raw.lists.slice(0, opts.limit).map((l) => {
    const tf = [];
    return withTruncation({
      id: l.id,
      name: l.name === null ? null : textOf(l.name, opts['max-chars'], tf, 'name'),
      account: { id: l.account_id, name: l.account_name === null ? null : textOf(l.account_name, opts['max-chars'], tf, 'account.name') },
    }, [...new Set(tf)]);
  });
  return {
    source: 'reminders', items, warnings: [],
    coverage: { scanned: raw.lists.length, matched: raw.lists.length, returned: items.length, limit: opts.limit, limit_reached: raw.lists.length > items.length, output_truncated: false, complete: true, reasons: [], note: 'Lists with the same name have different ids; always pass --list-id.' },
  };
}

async function remindersSearch(opts, ctx) {
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const from = opts['due-from'] ? dates.parseBound(opts['due-from'], 'from', tz, '--due-from') : null;
  const to = opts['due-to'] ? dates.parseBound(opts['due-to'], 'to', tz, '--due-to') : null;
  if (from && to && from.ms >= to.ms) {
    throw new QueryError('INVALID_ARGUMENT', 'The due interval is empty (--due-from is not before --due-to).');
  }
  if (opts['include-undated'] && !from && !to) {
    throw new QueryError('INVALID_ARGUMENT', '--include-undated only makes sense together with --due-from or --due-to.');
  }
  const caps = ctx.capabilities('reminders');
  const features = caps.supported;
  const q = opts.query ? norm(opts.query) : null;
  const raw = await callAdapter(ctx, 'reminders', 'scan', {
    list_id: opts['list-id'] || null, status: opts.status, scan_limit: opts['scan-limit'],
  }, opts);
  checkScan(raw, opts['scan-limit']);

  let undatedExcluded = 0;
  let outOfStatus = 0;
  const rows = [];
  for (const r of raw.records) {
    if ((opts.status === 'pending' && r.completed === true) || (opts.status === 'completed' && r.completed !== true)) {
      outOfStatus++;
      continue;
    }
    if (q && !includesLiteral(r.title, q)) continue;
    const built = reminderItem(r, opts['max-chars'], features, tz);
    if (from || to) {
      if (built.ms === null) {
        if (!opts['include-undated']) { undatedExcluded++; continue; }
      } else if ((from && built.ms < from.ms) || (to && built.ms >= to.ms)) {
        continue;
      }
    }
    rows.push(built);
  }
  // Dated first by due instant, then undated (kept apart at the end).
  rows.sort((a, b) => {
    if (a.ms === null && b.ms === null) return 0;
    if (a.ms === null) return 1;
    if (b.ms === null) return -1;
    return a.ms - b.ms;
  });
  const items = rows.slice(0, opts.limit).map((x) => x.item);
  const unavail = unavailableCounts(raw.records);
  const reasons = scanReasons(raw);
  if (unavail.completed || unavail.due || unavail.title) reasons.push('FIELD_UNAVAILABLE');
  return {
    source: 'reminders', items,
    warnings: allDayWarnings(items.some((i) => i.has_due), features),
    query: {
      tz,
      status: opts.status,
      list_id: opts['list-id'] || null,
      due_from_resolved: from ? dates.formatInTz(from.ms, tz) : null,
      due_to_resolved_exclusive: to ? dates.formatInTz(to.ms, tz) : null,
      interval: 'from inclusive, to exclusive; a bare YYYY-MM-DD names a whole day in tz',
      include_undated: Boolean(opts['include-undated']),
      query_matches: 'title only',
    },
    coverage: scanCoverage(raw, opts['scan-limit'], reasons, rows.length, items.length, opts.limit, {
      undated_excluded_by_date_filter: undatedExcluded,
      outside_status_filter: outOfStatus,
      unavailable_fields: unavail,
    }),
  };
}

async function remindersShow(opts, ctx) {
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const caps = ctx.capabilities('reminders');
  const raw = await callAdapter(ctx, 'reminders', 'show', {
    id: opts.id, read_container: caps.supported.includes('reminder_container'),
  }, opts);
  const hasBody = caps.supported.includes('reminder_body');
  const { item } = reminderItem(raw.record, opts['max-chars'], caps.supported, tz, (tf) => ({
    body: hasBody && raw.record.body !== null ? textOf(raw.record.body, opts['max-chars'], tf, 'body') : null,
    ...(hasBody ? {} : { body_unsupported: true }),
  }));
  return {
    source: 'reminders', items: [item], warnings: allDayWarnings(item.has_due, caps.supported),
    query: { tz },
    coverage: { scanned: 1, returned: 1, complete: true, reasons: [], output_truncated: false },
  };
}

// ------------------------------------------------------------------- notes

function protectionState(r) {
  if (r.protected === true) return 'PASSWORD_PROTECTED';
  if (r.protected === null) return 'PROTECTION_UNKNOWN';
  return null;
}

// Hard guard, independent of the adapter: text may only exist for notes that
// are proven unprotected (protected === false), and only when text was asked for.
function guardNoteText(r, textRequested) {
  if (r.text !== null && (r.protected !== false || !textRequested)) {
    throw new QueryError('INTERNAL', 'Guard tripped: adapter returned note text that was not allowed.');
  }
}

async function notesFolders(opts, ctx) {
  const raw = await callAdapter(ctx, 'notes', 'folders', {}, opts);
  const items = raw.folders.slice(0, opts.limit).map((f) => {
    const tf = [];
    return withTruncation({
      id: f.id,
      name: f.name === null ? null : textOf(f.name, opts['max-chars'], tf, 'name'),
      account: { id: f.account_id, name: f.account_name === null ? null : textOf(f.account_name, opts['max-chars'], tf, 'account.name') },
      shared: f.shared,
    }, [...new Set(tf)]);
  });
  return {
    source: 'notes', items, warnings: [],
    coverage: { scanned: raw.folders.length, matched: raw.folders.length, returned: items.length, limit: opts.limit, limit_reached: raw.folders.length > items.length, output_truncated: false, complete: true, reasons: [], note: 'Folders with the same name have different ids; always pass --folder-id.' },
  };
}

async function notesSearch(opts, ctx) {
  const caps = ctx.capabilities('notes');
  const textScope = opts.scope === 'text';
  if (textScope && !caps.supported.includes('note_text')) {
    throw new QueryError('BLOCKED_MISSING_PROPERTY', 'Text search needs the dictionary to expose both "password protected" and "plaintext"; only title search is available.');
  }
  const q = norm(opts.query);
  const raw = await callAdapter(ctx, 'notes', 'scan', {
    folder_id: opts['folder-id'] || null, account_id: opts['account-id'] || null,
    with_text: textScope, scan_limit: opts['scan-limit'],
  }, opts);
  checkScan(raw, opts['scan-limit']);

  let protectedCount = 0;
  let unknownCount = 0;
  let capped = 0;
  let accountMismatch = 0;
  const rows = [];
  for (const r of raw.records) {
    guardNoteText(r, textScope);
    if (opts['account-id'] && r.account_id !== opts['account-id']) { accountMismatch++; continue; }
    if (r.protected === true) protectedCount++;
    if (r.protected === null) unknownCount++;
    if (r.text !== null && r.text_length !== null && r.text_length > r.text.length) capped++;
    const titleHit = includesLiteral(r.title, q);
    const textHit = textScope && r.text !== null && includesLiteral(r.text, q);
    if (!titleHit && !textHit) continue;
    rows.push({ r, match: titleHit ? 'title' : 'text', textHit });
  }
  const items = rows.slice(0, opts.limit).map(({ r, match, textHit }) => {
    const tf = [];
    const item = {
      id: r.id,
      title: r.title === null ? null : textOf(r.title, opts['max-chars'], tf, 'title'),
      folder: { id: r.folder_id, name: r.folder_name === null ? null : textOf(r.folder_name, opts['max-chars'], tf, 'folder.name') },
      account: { id: r.account_id, name: r.account_name === null ? null : textOf(r.account_name, opts['max-chars'], tf, 'account.name') },
      modified: r.modified,
      protected: r.protected,
      match,
    };
    if (textHit) {
      const snip = snippetAround(r.text, q, Math.min(SNIPPET_WINDOW, Math.max(1, Math.floor(opts['max-chars'] / 2))));
      if (snip) {
        item.snippet = textOf(snip.text, opts['max-chars'], tf, 'snippet');
        item.snippet_cut = { start: snip.cut_start, end: snip.cut_end };
      }
    }
    if (r.unavailable.length) item.unavailable = r.unavailable;
    return withTruncation(item, [...new Set(tf)]);
  });
  const reasons = scanReasons(raw);
  if (textScope && protectedCount + unknownCount > 0) reasons.push('PROTECTED_BODY_SKIPPED');
  if (capped > 0) reasons.push('TEXT_CAPPED');
  const unavail = unavailableCounts(raw.records);
  if (unavail.title || unavail.protected || unavail.text) reasons.push('FIELD_UNAVAILABLE');
  const warnings = [];
  if (textScope && protectedCount + unknownCount > 0) {
    warnings.push({ code: 'PROTECTED_NOTES_NOT_SEARCHED', message: 'Password-protected (or unproven) notes were never read; their text could not be searched, only their titles.' });
  }
  return {
    source: 'notes', items, warnings,
    query: { scope: opts.scope, folder_id: opts['folder-id'] || null, account_id: opts['account-id'] || null, match: 'literal, case-insensitive, accents not folded' },
    coverage: scanCoverage(raw, opts['scan-limit'], reasons, rows.length, items.length, opts.limit, {
      protected_notes: protectedCount,
      protection_unknown_notes: unknownCount,
      protected_bodies_read: 0,
      text_capped_notes: capped,
      excluded_by_account_filter: accountMismatch,
      unavailable_fields: unavail,
      unsupported: ['attachments', 'ocr', 'images', 'checklist_state', 'tags', 'tables'],
    }),
  };
}

async function notesShow(opts, ctx) {
  const caps = ctx.capabilities('notes');
  const canRead = caps.supported.includes('note_text');
  const raw = await callAdapter(ctx, 'notes', 'show', {
    id: opts.id, read_text: canRead, read_folder: caps.supported.includes('note_folder'), text_cap: opts['max-chars'] * 4,
  }, opts);
  const r = raw.record;
  guardNoteText(r, canRead);
  const tf = [];
  let blocked = null;
  let text = null;
  if (!canRead) blocked = 'NO_PROTECTION_MARKER';
  else if (protectionState(r)) blocked = protectionState(r);
  else if (r.text !== null) {
    const t = truncate(r.text, opts['max-chars']);
    text = t.text;
    if (t.truncated || (r.text_length !== null && r.text_length > r.text.length)) tf.push('text');
  }
  const item = {
    id: r.id,
    title: r.title === null ? null : textOf(r.title, opts['max-chars'], tf, 'title'),
    folder: { id: r.folder_id, name: r.folder_name === null ? null : textOf(r.folder_name, opts['max-chars'], tf, 'folder.name') },
    account: { id: r.account_id, name: r.account_name === null ? null : textOf(r.account_name, opts['max-chars'], tf, 'account.name') },
    created: r.created,
    modified: r.modified,
    shared: r.shared,
    protected: r.protected,
    text,
    body_blocked: blocked,
  };
  if (r.unavailable.length) item.unavailable = r.unavailable;
  return {
    source: 'notes', items: [withTruncation(item, [...new Set(tf)])],
    warnings: blocked ? [{ code: 'BODY_NOT_READ', message: 'The note body was not read (' + blocked + ').' }] : [],
    coverage: {
      scanned: 1, returned: 1, complete: !blocked, reasons: blocked ? ['BODY_NOT_READ'] : [], output_truncated: false,
      protected_bodies_read: 0, unsupported: ['attachments', 'ocr', 'images', 'checklist_state', 'tags', 'tables'],
    },
  };
}

// ------------------------------------------------------------------- writes
// Only two exist, both create one new item. After a failure the outcome may be
// unknown (the item might exist), so the error says so instead of inviting a retry.
const WRITE_UNKNOWN = new Set(['TIMEOUT', 'APP_ERROR', 'ADAPTER_SCHEMA', 'INTERNAL', 'APP_UNAVAILABLE', 'METHOD_UNAVAILABLE']);

async function writeCall(ctx, app, mode, params, opts) {
  try {
    return await callAdapter(ctx, app, mode, params, opts);
  } catch (e) {
    if (e instanceof QueryError) {
      const unknown = WRITE_UNKNOWN.has(e.code);
      e.extra = {
        ...e.extra,
        write_outcome: unknown ? 'unknown' : 'not_performed',
        ...(unknown ? { write_hint: 'The item may or may not have been created. Check the app before trying again; never retry blindly.' } : {}),
      };
    }
    throw e;
  }
}

const WRITE_WARNING = (what) => ({ code: 'WRITE_PERFORMED', message: `${what} was created. It can be changed or removed later only through this tool's guarded commands (events: update/delete; reminders and notes: delete) or in the app.` });

async function remindersCreate(opts, ctx) {
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const caps = ctx.capabilities('reminders');
  if (!caps.supported.includes('reminder_create')) {
    throw new QueryError('BLOCKED_MISSING_PROPERTY', 'Creating reminders needs "default list" and "body" in the dictionary.');
  }
  let due = null;
  if (opts.due) {
    const b = dates.parseBound(opts.due, 'from', tz, '--due');
    due = { iso: new Date(b.ms).toISOString(), kind: b.kind === 'day' ? 'day' : 'datetime' };
  }
  const raw = await writeCall(ctx, 'reminders', 'create', {
    title: opts.title,
    body: opts.body === undefined ? null : opts.body,
    list_id: opts['list-id'] || null,
    due_iso: due ? due.iso : null,
    due_kind: due ? due.kind : 'none',
  }, opts);
  const { item } = reminderItem(raw.record, opts['max-chars'], caps.supported, tz, (tf) => ({
    body: raw.record.body === null ? null : textOf(raw.record.body, opts['max-chars'], tf, 'body'),
  }));
  return {
    source: 'reminders', items: [item], warnings: [WRITE_WARNING('A reminder'), ...allDayWarnings(item.has_due, caps.supported)],
    query: { tz, requested_due: due ? { kind: due.kind, instant: due.iso } : null, list: opts['list-id'] ? 'by --list-id' : 'app default list' },
    coverage: {
      returned: 1, complete: true, reasons: [], output_truncated: false, mutation: 'created',
      readback: { title_matches_request: raw.record.title === opts.title, due_matches_request: due ? item.has_due : !item.has_due },
    },
  };
}

// Escaping (not stripping): every character of user text becomes inert HTML text.
const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function noteHtml(title, body) {
  const lines = body === undefined ? [] : body.replace(/\r\n?/g, '\n').split('\n');
  return `<div><h1>${escapeHtml(title)}</h1></div>${lines.map((l) => `<div>${l === '' ? '<br>' : escapeHtml(l)}</div>`).join('')}`;
}

async function notesCreate(opts, ctx) {
  const caps = ctx.capabilities('notes');
  if (!caps.supported.includes('note_create')) {
    throw new QueryError('BLOCKED_MISSING_PROPERTY', 'Creating notes needs "body", "default account" and "default folder" in the dictionary.');
  }
  const raw = await writeCall(ctx, 'notes', 'create', {
    html: noteHtml(opts.title, opts.body), folder_id: opts['folder-id'] || null,
  }, opts);
  const r = raw.record;
  const tf = [];
  const item = withTruncation({
    id: r.id,
    title: r.title === null ? null : textOf(r.title, opts['max-chars'], tf, 'title'),
    folder: { id: r.folder_id, name: r.folder_name === null ? null : textOf(r.folder_name, opts['max-chars'], tf, 'folder.name') },
    account: { id: r.account_id, name: r.account_name === null ? null : textOf(r.account_name, opts['max-chars'], tf, 'account.name') },
    created: r.created, modified: r.modified, protected: r.protected,
    text: null, body_blocked: 'NOT_READ_AFTER_CREATE',
    ...(r.unavailable.length ? { unavailable: r.unavailable } : {}),
  }, [...new Set(tf)]);
  return {
    source: 'notes', items: [item], warnings: [WRITE_WARNING('A note')],
    query: { folder: opts['folder-id'] ? 'by --folder-id' : 'app default folder', body_format: 'plain text escaped into HTML (first line is the title)' },
    coverage: { returned: 1, complete: true, reasons: [], output_truncated: false, mutation: 'created', readback: { title_matches_request: r.title === opts.title } },
  };
}

// ---------------------------------------------------------------- calendar

const MAX_WINDOW_MS = 366 * 86400000;

function eventItem(r, maxChars, tz, extra) {
  const tf = [];
  const startMs = dates.parseAdapterInstant(r.start);
  const endMs = dates.parseAdapterInstant(r.end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new QueryError('ADAPTER_SCHEMA', 'Adapter event date is not a valid instant.');
  const item = {
    id: r.id,
    title: r.title === null ? null : textOf(r.title, maxChars, tf, 'title'),
    calendar: { id: r.calendar_id, name: r.calendar_name === null ? null : textOf(r.calendar_name, maxChars, tf, 'calendar.name') },
    start: startMs === null ? null : dates.formatInTz(startMs, tz),
    end: endMs === null ? null : dates.formatInTz(endMs, tz),
    all_day: r.all_day,
    location: r.location === null ? null : textOf(r.location, maxChars, tf, 'location'),
    recurring: r.recurring,
    ...(extra ? extra(tf) : {}),
  };
  if (r.unavailable.length) item.unavailable = r.unavailable;
  return { item: withTruncation(item, [...new Set(tf)]), startMs, endMs };
}

async function calendarCalendars(opts, ctx) {
  const raw = await callAdapter(ctx, 'calendar', 'calendars', {}, opts);
  const items = raw.calendars.slice(0, opts.limit).map((c) => {
    const tf = [];
    return withTruncation({ id: c.id, name: c.name === null ? null : textOf(c.name, opts['max-chars'], tf, 'name'), writable: c.writable }, [...new Set(tf)]);
  });
  return {
    source: 'calendar', items, warnings: [],
    coverage: { scanned: raw.calendars.length, matched: raw.calendars.length, returned: items.length, limit: opts.limit, limit_reached: raw.calendars.length > items.length, output_truncated: false, complete: true, reasons: [], note: 'Calendars with the same name have different ids; always pass --calendar-id.' },
  };
}

async function calendarSearch(opts, ctx) {
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const from = dates.parseBound(opts.from, 'from', tz, '--from');
  const to = dates.parseBound(opts.to, 'to', tz, '--to');
  if (from.ms >= to.ms) throw new QueryError('INVALID_ARGUMENT', 'The window is empty (--from is not before --to).');
  if (to.ms - from.ms > MAX_WINDOW_MS) throw new QueryError('INVALID_ARGUMENT', 'The window is longer than 366 days; use a narrower --from/--to.');
  const q = opts.query ? norm(opts.query) : null;
  const raw = await callAdapter(ctx, 'calendar', 'scan', {
    calendar_id: opts['calendar-id'] || null,
    from_iso: new Date(from.ms).toISOString(), to_iso: new Date(to.ms).toISOString(),
    scan_limit: opts['scan-limit'],
  }, opts);
  checkScan(raw, opts['scan-limit']);
  let undatable = 0;
  let outside = 0;
  const rows = [];
  for (const r of raw.records) {
    const built = eventItem(r, opts['max-chars'], tz);
    if (built.startMs === null || built.endMs === null) { undatable++; continue; }
    if (!(built.startMs < to.ms && built.endMs > from.ms)) { outside++; continue; }
    if (q && !includesLiteral(r.title, q) && !includesLiteral(r.location, q)) continue;
    rows.push(built);
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  const items = rows.slice(0, opts.limit).map((x) => x.item);
  const reasons = scanReasons(raw);
  if (undatable) reasons.push('FIELD_UNAVAILABLE');
  const warnings = [];
  if (!VERIFIED_ON_REAL_MAC.calendar_recurring_expansion) {
    reasons.push('RECURRING_NOT_EXPANDED');
    warnings.push({ code: 'RECURRING_NOT_EXPANDED', message: 'Repeating events are returned (if at all) as their master entry; individual occurrences are not expanded. Whether Calendar includes them in this window was not proven, so absence of an event is not conclusive.' });
  }
  return {
    source: 'calendar', items, warnings,
    query: {
      tz, calendar_id: opts['calendar-id'] || null,
      from_resolved: dates.formatInTz(from.ms, tz), to_resolved_exclusive: dates.formatInTz(to.ms, tz),
      overlap: 'events overlapping [from, to); from inclusive, to exclusive; a bare YYYY-MM-DD names a whole day in tz',
      query_matches: 'title and location',
    },
    coverage: scanCoverage(raw, opts['scan-limit'], reasons, rows.length, items.length, opts.limit, {
      undatable_events_skipped: undatable, outside_window_after_scan: outside,
      recurring_in_results: items.filter((i) => i.recurring === true).length,
      unsupported: ['attendees', 'alarms', 'recurrence_expansion', 'urls'],
    }),
  };
}

async function calendarShow(opts, ctx) {
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const caps = ctx.capabilities('calendar');
  const raw = await callAdapter(ctx, 'calendar', 'show', { id: opts.id }, opts);
  const hasDesc = caps.supported.includes('event_description');
  const { item } = eventItem(raw.record, opts['max-chars'], tz, (tf) => ({
    description: hasDesc && raw.record.description !== null ? textOf(raw.record.description, opts['max-chars'], tf, 'description') : null,
    ...(hasDesc ? {} : { description_unsupported: true }),
  }));
  return {
    source: 'calendar', items: [item], warnings: [], query: { tz },
    coverage: { scanned: 1, returned: 1, complete: true, reasons: [], output_truncated: false, unsupported: ['attendees', 'alarms', 'urls'] },
  };
}

// ------------------------------------------------- delete / calendar writes

const SELF_RECOVERY = {
  reminders: 'A deleted reminder is not restored by this tool.',
  notes: 'Notes moves a deleted note to its "Recently Deleted" folder (observed on the tested Mac); this tool does not restore or empty it.',
  calendar: 'A deleted event is not restored by this tool.',
};

async function deleteItem(opts, ctx, app) {
  const raw = await writeCall(ctx, app, 'delete', { id: opts.id, expect_title: opts['expect-title'] }, opts);
  const tf = [];
  const item = withTruncation({
    id: raw.id,
    title: raw.title === null ? null : textOf(raw.title, opts['max-chars'], tf, 'title'),
    deleted: raw.verified_gone ? true : null,
    verified_gone: raw.verified_gone,
    remaining_folder: raw.remaining_folder === null ? null : textOf(raw.remaining_folder, opts['max-chars'], tf, 'remaining_folder'),
  }, [...new Set(tf)]);
  const warnings = [{ code: 'DELETE_PERFORMED', message: SELF_RECOVERY[app] }];
  if (!raw.verified_gone && raw.remaining_folder !== null) {
    warnings.push({ code: 'STILL_IN_FOLDER', message: 'The item can still be read, in the folder named in remaining_folder. Notes normally moves a deleted note to a "Recently Deleted" folder, where it can be recovered or removed by hand in the app.' });
  } else if (!raw.verified_gone) {
    warnings.push({ code: 'DELETE_NOT_VERIFIED', message: 'The app did not confirm that the item is gone. Check the app before doing anything else.' });
  }
  return {
    source: app, items: [item], warnings,
    coverage: { returned: 1, complete: raw.verified_gone, reasons: raw.verified_gone ? [] : [raw.remaining_folder !== null ? 'STILL_IN_FOLDER' : 'DELETE_NOT_VERIFIED'], output_truncated: false, mutation: 'deleted', verified_gone: raw.verified_gone },
  };
}

const remindersDelete = (opts, ctx) => deleteItem(opts, ctx, 'reminders');
const notesDelete = (opts, ctx) => deleteItem(opts, ctx, 'notes');

function requireEventWrite(ctx, what) {
  if (!ctx.capabilities('calendar').supported.includes('event_write')) {
    throw new QueryError('BLOCKED_MISSING_PROPERTY', `${what} needs attendee, recurrence, writable and the date properties in the Calendar dictionary.`);
  }
}

const instantOnly = (value, role, tz, flag) => {
  const b = dates.parseBound(value, role, tz, flag);
  if (b.kind !== 'instant') throw new QueryError('INVALID_ARGUMENT', `${flag} must be RFC3339 with an offset (a bare day is only valid with --all-day on create).`);
  return b.ms;
};

async function calendarDelete(opts, ctx) {
  requireEventWrite(ctx, 'Deleting events');
  return deleteItem(opts, ctx, 'calendar');
}

async function calendarCreate(opts, ctx) {
  requireEventWrite(ctx, 'Creating events');
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  let startMs;
  let endMs;
  if (opts['all-day']) {
    const from = dates.parseBound(opts.start, 'from', tz, '--start');
    const to = dates.parseBound(opts.end || opts.start, 'to', tz, '--end');
    if (from.kind !== 'day' || to.kind !== 'day') throw new QueryError('INVALID_ARGUMENT', 'With --all-day, --start and --end must be YYYY-MM-DD (--end is the last day, inclusive).');
    startMs = from.ms;
    endMs = to.ms - 1000; // last second of the last day (convention observed on a synced calendar)
  } else {
    if (!opts.end) throw new QueryError('INVALID_ARGUMENT', '--end is required unless --all-day is used.');
    startMs = instantOnly(opts.start, 'from', tz, '--start');
    endMs = instantOnly(opts.end, 'to', tz, '--end');
  }
  if (endMs <= startMs) throw new QueryError('INVALID_ARGUMENT', 'The event end must be after its start.');
  const raw = await writeCall(ctx, 'calendar', 'create', {
    calendar_id: opts['calendar-id'], title: opts.title,
    start_iso: new Date(startMs).toISOString(), end_iso: new Date(endMs).toISOString(),
    all_day: Boolean(opts['all-day']),
    location: opts.location === undefined ? null : opts.location,
    description: opts.description === undefined ? null : opts.description,
  }, opts);
  const built = eventItem(raw.record, opts['max-chars'], tz, (tf) => ({
    description: raw.record.description === null ? null : textOf(raw.record.description, opts['max-chars'], tf, 'description'),
  }));
  return {
    source: 'calendar', items: [built.item], warnings: [WRITE_WARNING('An event')],
    query: { tz, all_day: Boolean(opts['all-day']), attendees: 'none (nothing is sent to anyone)' },
    coverage: {
      returned: 1, complete: true, reasons: [], output_truncated: false, mutation: 'created',
      readback: { title_matches_request: raw.record.title === opts.title, start_matches_request: built.startMs === startMs, end_matches_request: built.endMs === endMs },
    },
  };
}

async function calendarUpdate(opts, ctx) {
  requireEventWrite(ctx, 'Editing events');
  const tz = dates.validateTimeZone(opts.tz || dates.detectTimeZone());
  const given = ['title', 'start', 'end', 'location', 'description'].filter((k) => opts[k] !== undefined);
  if (given.length === 0) throw new QueryError('INVALID_ARGUMENT', 'Nothing to change: pass at least one of --title, --start, --end, --location, --description.');
  const startMs = opts.start === undefined ? null : instantOnly(opts.start, 'from', tz, '--start');
  const endMs = opts.end === undefined ? null : instantOnly(opts.end, 'to', tz, '--end');
  if (startMs !== null && endMs !== null && endMs <= startMs) throw new QueryError('INVALID_ARGUMENT', 'The event end must be after its start.');
  const raw = await writeCall(ctx, 'calendar', 'update', {
    id: opts.id, expect_title: opts['expect-title'],
    title: opts.title === undefined ? null : opts.title,
    start_iso: startMs === null ? null : new Date(startMs).toISOString(),
    end_iso: endMs === null ? null : new Date(endMs).toISOString(),
    location: opts.location === undefined ? null : opts.location,
    description: opts.description === undefined ? null : opts.description,
  }, opts);
  const built = eventItem(raw.record, opts['max-chars'], tz, (tf) => ({
    description: raw.record.description === null ? null : textOf(raw.record.description, opts['max-chars'], tf, 'description'),
  }));
  const readback = {};
  if (opts.title !== undefined) readback.title_matches_request = raw.record.title === opts.title;
  if (opts.location !== undefined) readback.location_matches_request = raw.record.location === opts.location;
  if (opts.description !== undefined) readback.description_matches_request = raw.record.description === opts.description;
  if (startMs !== null) readback.start_matches_request = built.startMs === startMs;
  if (endMs !== null) readback.end_matches_request = built.endMs === endMs;
  return {
    source: 'calendar', items: [built.item],
    warnings: [{ code: 'WRITE_PERFORMED', message: 'An event was edited. There is no undo here; fix it in the app if needed.' }],
    query: { tz },
    coverage: { returned: 1, complete: true, reasons: [], output_truncated: false, mutation: 'updated', changed: raw.changed, readback },
  };
}

const HANDLERS = {
  'contacts search': contactsSearch,
  'contacts show': contactsShow,
  'reminders lists': remindersLists,
  'reminders search': remindersSearch,
  'reminders show': remindersShow,
  'notes folders': notesFolders,
  'notes search': notesSearch,
  'notes show': notesShow,
  'reminders create': remindersCreate,
  'notes create': notesCreate,
  'calendar calendars': calendarCalendars,
  'calendar search': calendarSearch,
  'calendar show': calendarShow,
  'reminders delete': remindersDelete,
  'notes delete': notesDelete,
  'calendar delete': calendarDelete,
  'calendar create': calendarCreate,
  'calendar update': calendarUpdate,
};

module.exports = { HANDLERS, VERIFIED_ON_REAL_MAC };
