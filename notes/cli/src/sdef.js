'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Identifiers confirmed on this Mac from each app's Info.plist (doctor re-checks).
const APPS = {
  contacts: { name: 'Contacts', bundleId: 'com.apple.AddressBook', bundle: '/System/Applications/Contacts.app', sdef: 'Contacts.sdef' },
  reminders: { name: 'Reminders', bundleId: 'com.apple.reminders', bundle: '/System/Applications/Reminders.app', sdef: 'Reminders.sdef' },
  notes: { name: 'Notes', bundleId: 'com.apple.Notes', bundle: '/System/Applications/Notes.app', sdef: 'Notes.sdef' },
  calendar: { name: 'Calendar', bundleId: 'com.apple.iCal', bundle: '/System/Applications/Calendar.app', sdef: 'iCal.sdef' },
};

// What each command needs, as [class, kind, name]. `app` class = application
// (class-extension). Inheritance is followed (e.g. email -> contact info).
// `required` blocks the whole app's commands; `features` are optional pieces that
// show up as "unsupported" when absent.
const REQUIREMENTS = {
  contacts: {
    required: [
      ['application', 'element', 'person'], ['application', 'element', 'group'],
      ['person', 'property', 'id'], ['person', 'property', 'name'],
      ['person', 'element', 'email'], ['person', 'element', 'phone'],
      ['email', 'property', 'value'], ['phone', 'property', 'value'],
      ['group', 'element', 'person'],
    ],
    features: {},
  },
  reminders: {
    required: [
      ['application', 'element', 'account'], ['application', 'element', 'list'],
      ['application', 'element', 'reminder'],
      ['account', 'property', 'id'], ['account', 'property', 'name'], ['account', 'element', 'list'],
      ['list', 'property', 'id'], ['list', 'property', 'name'], ['list', 'element', 'reminder'],
      ['reminder', 'property', 'id'], ['reminder', 'property', 'name'],
      ['reminder', 'property', 'completed'], ['reminder', 'property', 'due date'],
    ],
    features: {
      all_day_due_date: [['reminder', 'property', 'allday due date']],
      reminder_body: [['reminder', 'property', 'body']],
      reminder_container: [['reminder', 'property', 'container']],
      reminder_create: [['application', 'property', 'default list'], ['reminder', 'property', 'body']],
    },
  },
  notes: {
    required: [
      ['application', 'element', 'account'], ['application', 'element', 'folder'],
      ['application', 'element', 'note'],
      ['account', 'property', 'id'], ['account', 'property', 'name'], ['account', 'element', 'folder'],
      ['folder', 'property', 'id'], ['folder', 'property', 'name'],
      ['folder', 'element', 'folder'], ['folder', 'element', 'note'],
      ['note', 'property', 'id'], ['note', 'property', 'name'],
    ],
    features: {
      note_folder: [['note', 'property', 'container']],
      // Both are needed to read any note text safely: without the protection
      // marker we never read a body (title search stays available).
      note_text: [['note', 'property', 'password protected'], ['note', 'property', 'plaintext']],
      note_dates: [['note', 'property', 'modification date']],
      note_create: [
        ['note', 'property', 'body'], ['application', 'property', 'default account'],
        ['account', 'property', 'default folder'],
      ],
    },
  },
  calendar: {
    required: [
      ['application', 'element', 'calendar'],
      ['calendar', 'property', 'name'],
      ['calendar', 'element', 'event'],
      ['event', 'property', 'uid'], ['event', 'property', 'summary'],
      ['event', 'property', 'start date'], ['event', 'property', 'end date'],
      ['event', 'property', 'allday event'],
    ],
    features: {
      calendar_writable: [['calendar', 'property', 'writable']],
      calendar_identifier: [['calendar', 'property', 'calendarIdentifier']],
      // needed to create/update/delete events with the attendee and recurrence guards
      event_write: [
        ['event', 'element', 'attendee'], ['event', 'property', 'recurrence'], ['calendar', 'property', 'writable'],
        ['event', 'property', 'summary'], ['event', 'property', 'start date'], ['event', 'property', 'end date'],
      ],
      event_location: [['event', 'property', 'location']],
      event_description: [['event', 'property', 'description']],
      event_recurrence: [['event', 'property', 'recurrence']],
    },
  },
};

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};

function parseSdef(xml) {
  const classes = {};
  const re = /<(class-extension|class)(?=\s)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, tagName, head, rawBody] = m;
    const body = rawBody || '';
    const name = tagName === 'class-extension' ? attr(head, 'extends') : attr(head, 'name');
    if (!name) continue;
    const c = classes[name] || (classes[name] = { inherits: null, properties: new Set(), elements: new Set() });
    c.inherits = attr(head, 'inherits') || c.inherits;
    for (const p of body.matchAll(/<property\b[^>]*>/g)) {
      const n = attr(p[0], 'name');
      if (n) c.properties.add(n);
    }
    for (const e of body.matchAll(/<element\b[^>]*>/g)) {
      const t = attr(e[0], 'type');
      if (t) c.elements.add(t);
    }
  }
  return classes;
}

function has(classes, cls, kind, name, depth = 0) {
  const c = classes[cls];
  if (!c || depth > 5) return false;
  if ((kind === 'property' ? c.properties : c.elements).has(name)) return true;
  return c.inherits ? has(classes, c.inherits, kind, name, depth + 1) : false;
}

const label = ([c, k, n]) => `${c}.${k === 'element' ? 'elements:' : ''}${n}`;

// Reads only the dictionary shipped inside the app bundle. No Apple Events.
function evaluateCapabilities(appKey, xml) {
  const spec = REQUIREMENTS[appKey];
  const classes = parseSdef(xml);
  const missing = spec.required.filter((r) => !has(classes, r[0], r[1], r[2])).map(label);
  const unsupported = [];
  const supported = [];
  for (const [feature, reqs] of Object.entries(spec.features)) {
    const miss = reqs.filter((r) => !has(classes, r[0], r[1], r[2])).map(label);
    if (miss.length) unsupported.push({ feature, missing: miss });
    else supported.push(feature);
  }
  return { blocked: missing.length > 0, missing_required: missing, unsupported, supported };
}

function loadCapabilities(appKey, { readFile = fs.readFileSync, apps = APPS } = {}) {
  const app = apps[appKey];
  const file = path.join(app.bundle, 'Contents', 'Resources', app.sdef);
  let xml;
  try {
    xml = readFile(file, 'utf8');
  } catch {
    return { blocked: true, missing_required: ['dictionary-not-readable'], unsupported: [], supported: [], dictionary: 'unreadable' };
  }
  return { ...evaluateCapabilities(appKey, xml), dictionary: 'ok' };
}

module.exports = { APPS, REQUIREMENTS, parseSdef, evaluateCapabilities, loadCapabilities };
