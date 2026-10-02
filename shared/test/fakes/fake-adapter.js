'use strict';

// Fake backend implementing the same adapter contract as src/adapters/jxa.js,
// with the same scope/scan-limit/protection semantics, over fictional data.
// It never touches Contacts, Reminders or Notes.
const { QueryError } = require('../../src/errors');
const { buildData } = require('./fake-data');

const ALL_FEATURES = {
  contacts: [],
  reminders: ['all_day_due_date', 'reminder_body', 'reminder_container', 'reminder_create'],
  notes: ['note_folder', 'note_text', 'note_dates', 'note_create'],
  calendar: ['calendar_writable', 'event_location', 'event_description', 'event_recurrence', 'event_write'],
};

function fakeCapabilities(overrides = {}) {
  return (appKey) => ({
    blocked: false, missing_required: [], unsupported: [], supported: ALL_FEATURES[appKey], dictionary: 'ok',
    ...(overrides[appKey] || {}),
  });
}

/**
 * faults: {
 *   permissionDenied: appKey|true, timeout: true, appError: appKey, notFound: true,
 *   unavailable: { contacts: ['emails'], notes: ['protected'], reminders: ['due'] },
 *   stopAfter: n            // simulate the soft deadline after n scanned items
 *   malformed: appKey,      // return garbage
 *   leakProtected: true     // rogue adapter that returns text of protected notes
 * }
 */
function createFakeAdapter({ data = buildData(), faults = {} } = {}) {
  const calls = [];
  const un = (app) => (faults.unavailable && faults.unavailable[app]) || [];
  const scanOut = (all, p, make) => {
    const total = all.length;
    let n = Math.min(total, p.scan_limit);
    let stopped = null;
    if (faults.stopAfter !== undefined && faults.stopAfter < n) { n = faults.stopAfter; stopped = 'time'; }
    return { total, scanned: n, stopped, records: all.slice(0, n).map(make) };
  };
  const notFound = () => new QueryError('NOT_FOUND');

  function contacts(mode, p) {
    const rec = (x) => {
      const u = un('contacts');
      return {
        id: x.id, name: u.includes('name') ? null : x.name,
        emails: u.includes('emails') ? null : x.emails, phones: u.includes('phones') ? null : x.phones,
        unavailable: u,
      };
    };
    if (mode === 'scan') {
      let all = data.contacts.people;
      if (p.group_id) {
        if (!data.contacts.groups.includes(p.group_id)) throw notFound();
        all = all.filter((x) => x.groups.includes(p.group_id));
      }
      return scanOut(all, p, rec);
    }
    const x = data.contacts.people.find((c) => c.id === p.id);
    if (!x) throw notFound();
    return { record: rec(x) };
  }

  function reminders(mode, p) {
    const listOf = (id) => data.reminders.lists.find((l) => l.id === id);
    if (mode === 'lists') return { lists: data.reminders.lists };
    const rec = (x, withBody) => {
      const u = un('reminders');
      const l = listOf(x.list_id);
      return {
        id: x.id, title: x.title, list_id: l ? l.id : null, list_name: l ? l.name : null,
        completed: u.includes('completed') ? null : x.completed,
        due: u.includes('due') ? null : x.due, allday_due: x.allday_due,
        ...(withBody ? { body: x.body } : {}),
        unavailable: u,
      };
    };
    if (mode === 'scan') {
      if (p.list_id && !listOf(p.list_id)) throw notFound();
      let all = data.reminders.items;
      if (p.list_id) all = all.filter((x) => x.list_id === p.list_id);
      if (p.status === 'pending') all = all.filter((x) => !x.completed);
      if (p.status === 'completed') all = all.filter((x) => x.completed);
      return scanOut(all, p, (x) => rec(x, false));
    }
    const x = data.reminders.items.find((r) => r.id === p.id);
    if (!x) throw notFound();
    return { record: rec(x, true) };
  }

  function notes(mode, p) {
    const folderOf = (id) => data.notes.folders.find((f) => f.id === id);
    const acctOf = (id) => data.notes.accounts.find((a) => a.id === id);
    if (mode === 'folders') {
      return { folders: data.notes.folders.map((f) => ({ id: f.id, name: f.name, account_id: f.account_id, account_name: acctOf(f.account_id).name, shared: f.shared })) };
    }
    // Same rule as the real script: text exists only for protected === false.
    const readText = (x, prot, wanted, cap) => {
      if (faults.leakProtected && wanted) {
        const leaked = x.text;
        return { text: leaked === undefined ? null : leaked, length: leaked ? leaked.length : null };
      }
      if (!wanted || prot !== false) return { text: null, length: null };
      return { text: x.text.length > cap ? x.text.slice(0, cap) : x.text, length: x.text.length };
    };
    const rec = (x, extra, wanted, cap) => {
      const u = un('notes');
      const f = folderOf(x.folder_id);
      const prot = u.includes('protected') ? null : x.protected;
      const t = readText(x, prot, wanted, cap);
      return {
        id: x.id, title: x.title, folder_id: f.id, folder_name: f.name,
        account_id: f.account_id, account_name: acctOf(f.account_id).name,
        modified: x.modified, protected: prot,
        text: t.text, text_length: t.length, unavailable: u,
        ...(extra ? { created: x.created, shared: x.shared } : {}),
      };
    };
    if (mode === 'scan') {
      let all = data.notes.items;
      if (p.folder_id) {
        if (!folderOf(p.folder_id)) throw notFound();
        all = all.filter((x) => x.folder_id === p.folder_id);
      } else if (p.account_id) {
        if (!acctOf(p.account_id)) throw notFound();
        all = all.filter((x) => folderOf(x.folder_id).account_id === p.account_id);
      }
      return scanOut(all, p, (x) => rec(x, false, p.with_text, 50000));
    }
    const x = data.notes.items.find((n) => n.id === p.id);
    if (!x) throw notFound();
    return { record: rec(x, true, p.read_text, p.text_cap) };
  }

  function calendar(mode, p) {
    const calOf = (id) => data.calendar.calendars.find((c) => c.id === id);
    if (mode === 'calendars') return { calendars: data.calendar.calendars };
    const rec = (x, withDesc) => {
      const u = un('calendar');
      const c = calOf(x.calendar_id);
      return {
        id: x.id, title: x.title, calendar_id: c.id, calendar_name: c.name, location: x.location,
        start: u.includes('start') ? null : x.start, end: x.end, all_day: x.all_day,
        recurring: x.recurrence === '' ? false : true,
        ...(withDesc ? { description: x.description } : {}), unavailable: u,
      };
    };
    if (mode === 'scan') {
      if (p.calendar_id && !calOf(p.calendar_id)) throw notFound();
      const from = Date.parse(p.from_iso);
      const to = Date.parse(p.to_iso);
      const all = data.calendar.events.filter((x) => (!p.calendar_id || x.calendar_id === p.calendar_id)
        && Date.parse(x.start) < to && Date.parse(x.end) > from);
      return scanOut(all, p, (x) => rec(x, false));
    }
    const x = data.calendar.events.find((e) => e.id === p.id);
    if (!x) throw notFound();
    return { record: rec(x, true) };
  }

  const refuse = (reason) => new QueryError('GUARD_REFUSED', undefined, { reason });
  const startsWith = (title, expected) => title.normalize('NFC').startsWith(expected.normalize('NFC'));

  function guardEvent(x, expectTitle) {
    const cal = data.calendar.calendars.find((c) => c.id === x.calendar_id);
    if (!cal.writable) throw refuse('read_only_calendar');
    if (!startsWith(x.title, expectTitle)) throw refuse('title_mismatch');
    if (x.recurrence !== '') throw refuse('recurring_event');
    if ((x.attendees || 0) > 0) throw refuse('has_attendees');
  }

  function eventRecord(x) {
    const c = data.calendar.calendars.find((q) => q.id === x.calendar_id);
    return { id: x.id, title: x.title, calendar_id: c.id, calendar_name: c.name, location: x.location, start: x.start, end: x.end, all_day: x.all_day, recurring: x.recurrence !== '', description: x.description, unavailable: [] };
  }

  function update(app, p) {
    const x = data.calendar.events.find((e) => e.id === p.id);
    if (!x) throw notFound();
    guardEvent(x, p.expect_title);
    const allDay = x.all_day && (p.start_iso !== null || p.end_iso !== null);
    if (allDay) throw refuse('all_day_time_change');
    const changed = [];
    if (p.title !== null) { x.title = p.title; changed.push('title'); }
    if (p.location !== null) { x.location = p.location; changed.push('location'); }
    if (p.description !== null) { x.description = p.description; changed.push('description'); }
    if (p.start_iso !== null) { x.start = p.start_iso; changed.push('start'); }
    if (p.end_iso !== null) { x.end = p.end_iso; changed.push('end'); }
    data.created.push({ app, id: x.id, mutation: 'update', changed });
    return { record: eventRecord(x), changed };
  }

  function destroy(app, p) {
    const pools = { reminders: data.reminders.items, notes: data.notes.items, calendar: data.calendar.events };
    const x = pools[app].find((e) => e.id === p.id);
    if (!x) throw notFound();
    const title = x.title;
    if (app === 'notes') {
      if (x.protected === null) throw refuse('protection_unknown');
      if (x.protected === true) throw refuse('protected_note');
    }
    if (app === 'calendar') guardEvent(x, p.expect_title);
    else if (!startsWith(title, p.expect_title)) throw refuse('title_mismatch');
    if (!faults.unverifiedDelete) pools[app].splice(pools[app].indexOf(x), 1);
    data.created.push({ app, id: x.id, mutation: 'delete' });
    const trash = faults.unverifiedDelete && app === 'notes' ? 'Recently Deleted' : null;
    return { id: x.id, title, verified_gone: !faults.unverifiedDelete, remaining_folder: trash };
  }

  function create(app, p) {
    const n = data.created.length + 1;
    if (app === 'calendar') {
      const c = data.calendar.calendars.find((q) => q.id === p.calendar_id);
      if (!c) throw notFound();
      if (!c.writable) throw refuse('read_only_calendar');
      const x = { id: `eNew${n}`, calendar_id: c.id, title: p.title, start: p.start_iso, end: p.end_iso, all_day: p.all_day, location: p.location, recurrence: '', description: p.description, attendees: 0 };
      data.calendar.events.push(x);
      data.created.push({ app, id: x.id, mutation: 'create' });
      return { record: eventRecord(x) };
    }
    if (app === 'reminders') {
      const l = p.list_id ? data.reminders.lists.find((q) => q.id === p.list_id) : data.reminders.lists[0];
      if (!l) throw notFound();
      const item = {
        id: `rNew${n}`, title: p.title, list_id: l.id, completed: false,
        due: p.due_kind === 'datetime' ? p.due_iso : null, allday_due: p.due_kind === 'day' ? p.due_iso : null, body: p.body,
      };
      data.reminders.items.push(item);
      data.created.push({ app, id: item.id });
      return { record: { id: item.id, title: item.title, list_id: l.id, list_name: l.name, completed: false, due: item.due, allday_due: item.allday_due, body: item.body, unavailable: [] } };
    }
    const f = p.folder_id ? data.notes.folders.find((q) => q.id === p.folder_id) : data.notes.folders[0];
    if (!f) throw notFound();
    const text = p.html.replace(/<\/div>/g, '\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const item = { id: `nNew${n}`, title: text.split('\n')[0], folder_id: f.id, protected: false, text, modified: '2026-10-02T12:00:00Z', created: '2026-10-02T12:00:00Z', shared: false };
    data.notes.items.push(item);
    data.created.push({ app, id: item.id, html: p.html });
    const a = data.notes.accounts.find((q) => q.id === f.account_id);
    return { record: { id: item.id, title: item.title, folder_id: f.id, folder_name: f.name, account_id: p.folder_id ? null : a.id, account_name: p.folder_id ? null : a.name, modified: item.modified, protected: false, text: null, text_length: null, created: item.created, shared: false, unavailable: [] } };
  }

  return {
    name: 'fake',
    calls,
    data,
    async call(app, mode, params, opts) {
      calls.push({ app, mode, params, opts });
      if (faults.permissionDenied === true || faults.permissionDenied === app) throw new QueryError('PERMISSION_DENIED');
      if (faults.timeout) throw new QueryError('TIMEOUT');
      if (faults.appError === app) throw new QueryError('APP_ERROR', undefined, { app_error_number: -1 });
      if (faults.malformed === app) return { surprise: true };
      if (mode === 'create') return create(app, params);
      if (mode === 'update') return update(app, params);
      if (mode === 'delete') return destroy(app, params);
      if (app === 'calendar') return calendar(mode, params);
      if (app === 'contacts') return contacts(mode, params);
      if (app === 'reminders') return reminders(mode, params);
      return notes(mode, params);
    },
  };
}

module.exports = { createFakeAdapter, fakeCapabilities, ALL_FEATURES };
