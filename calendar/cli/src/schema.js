'use strict';

const { QueryError } = require('./errors');

// Tiny closed-schema validator for what adapters return. Unknown keys are
// rejected so an adapter can never smuggle extra (unreviewed) fields through.
const fail = (path, why) => {
  throw new QueryError('ADAPTER_SCHEMA', `Adapter output invalid at ${path}: ${why}.`);
};

const str = (path, v) => { if (typeof v !== 'string') fail(path, 'expected string'); };
const int = (path, v) => { if (!Number.isInteger(v) || v < 0) fail(path, 'expected non-negative integer'); };
const bool = (path, v) => { if (typeof v !== 'boolean') fail(path, 'expected boolean'); };
const isoZ = (path, v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v) || Number.isNaN(Date.parse(v))) {
    fail(path, 'expected ISO-8601 UTC instant');
  }
};
const nullable = (inner) => (path, v) => { if (v !== null) inner(path, v); };
const arr = (inner) => (path, v) => {
  if (!Array.isArray(v)) fail(path, 'expected array');
  v.forEach((x, i) => inner(`${path}[${i}]`, x));
};
const oneOf = (...values) => (path, v) => { if (!values.includes(v)) fail(path, 'unexpected value'); };
const obj = (shape) => (path, v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected object');
  for (const k of Object.keys(v)) if (!(k in shape)) fail(`${path}.${k}`, 'unexpected key');
  for (const [k, check] of Object.entries(shape)) {
    if (!(k in v)) fail(`${path}.${k}`, 'missing key');
    check(`${path}.${k}`, v[k]);
  }
};

const unavailable = arr(str);

const scanEnvelope = (record) => obj({
  total: int, scanned: int, stopped: nullable(oneOf('time')), records: arr(record),
});

const contact = obj({
  id: str, name: nullable(str), emails: nullable(arr(str)), phones: nullable(arr(str)), unavailable,
});
const reminder = obj({
  id: str, title: nullable(str), list_id: nullable(str), list_name: nullable(str),
  completed: nullable(bool), due: nullable(isoZ), allday_due: nullable(isoZ), unavailable,
});
const reminderFull = obj({
  id: str, title: nullable(str), list_id: nullable(str), list_name: nullable(str),
  completed: nullable(bool), due: nullable(isoZ), allday_due: nullable(isoZ), body: nullable(str), unavailable,
});
const noteBase = {
  id: str, title: nullable(str), folder_id: nullable(str), folder_name: nullable(str),
  account_id: nullable(str), account_name: nullable(str), modified: nullable(isoZ),
  protected: nullable(bool), text: nullable(str), text_length: nullable(int), unavailable,
};
const note = obj(noteBase);
const noteFull = obj({ ...noteBase, created: nullable(isoZ), shared: nullable(bool) });

const eventBase = {
  id: str, title: nullable(str), calendar_id: str, calendar_name: nullable(str), location: nullable(str),
  start: nullable(isoZ), end: nullable(isoZ), all_day: nullable(bool), recurring: nullable(bool), unavailable,
};
const event = obj(eventBase);
const eventFull = obj({ ...eventBase, description: nullable(str) });

const deleted = obj({ id: str, title: nullable(str), verified_gone: bool, remaining_folder: nullable(str) });

const SCHEMAS = {
  'contacts.scan': scanEnvelope(contact),
  'contacts.show': obj({ record: contact }),
  'reminders.lists': obj({
    lists: arr(obj({ id: str, name: nullable(str), account_id: nullable(str), account_name: nullable(str) })),
  }),
  'reminders.scan': scanEnvelope(reminder),
  'reminders.show': obj({ record: reminderFull }),
  'notes.folders': obj({
    folders: arr(obj({
      id: str, name: nullable(str), account_id: nullable(str), account_name: nullable(str),
      shared: nullable(bool),
    })),
  }),
  'notes.scan': scanEnvelope(note),
  'notes.show': obj({ record: noteFull }),
  'notes.create': obj({ record: noteFull }),
  'reminders.create': obj({ record: reminderFull }),
  'calendar.calendars': obj({
    calendars: arr(obj({ id: str, name: nullable(str), writable: nullable(bool) })),
  }),
  'calendar.scan': scanEnvelope(event),
  'calendar.show': obj({ record: eventFull }),
  'calendar.create': obj({ record: eventFull }),
  'calendar.update': obj({ record: eventFull, changed: arr(str) }),
  'reminders.delete': deleted,
  'notes.delete': deleted,
  'calendar.delete': deleted,
};

function validateAdapterResult(app, mode, value) {
  const check = SCHEMAS[`${app}.${mode}`];
  if (!check) throw new QueryError('INTERNAL');
  check('result', value);
  return value;
}

module.exports = { validateAdapterResult };
