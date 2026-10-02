'use strict';

// Runs the REAL JXA scripts (prelude + per-app script) inside a Node vm against a
// fictional object model that mimics the shape of JXA specifiers
// (ref.prop(), collection(), collection.byId(), collection.whose(), .value()).
// This exercises our production script logic only. It does NOT prove how
// Contacts/Reminders/Notes or the real JXA bridge behave.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const JXA_DIR = path.join(__dirname, '..', '..', 'src', 'adapters', 'jxa');
const RAW = Symbol('raw');

const appleError = (n, msg = 'Fictional apple event error') => new Error(`${msg}. (${n})`);

function makeWorld(data, faults = {}) {
  const denied = (app) => faults.permissionDenied === true || faults.permissionDenied === app;
  const gate = (app) => { if (denied(app)) throw appleError(-1743, 'Not authorized to send Apple events'); };
  const hide = faults.unavailableProps || [];

  const DEL = Symbol('delete');

  function ref(app, raw, props, collections = {}, missing = false, del = null) {
    const r = { [RAW]: raw, [DEL]: del };
    for (const [name, get] of Object.entries(props)) {
      r[name] = () => {
        gate(app);
        if (missing || (typeof raw._gone === 'function' && raw._gone())) throw appleError(-1728, "Can't get object");
        if (hide.includes(name)) throw appleError(-1728, "Can't get property");
        return get();
      };
    }
    for (const [name, c] of Object.entries(collections)) r[name] = c;
    return r;
  }

  function matches(raw, cond) {
    return Object.entries(cond).every(([k, v]) => {
      if (k === '_and') return v.every((c) => matches(raw, c));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('_lessThan' in v) return raw[k] < v._lessThan;
        if ('_greaterThan' in v) return raw[k] > v._greaterThan;
      }
      return raw[k] === v;
    });
  }

  function collection(app, getRefs, mkMissing, onPush) {
    const f = () => { gate(app); return getRefs(); };
    f.push = (obj) => {
      gate(app);
      if (!onPush) throw appleError(-10000, 'Not allowed');
      onPush(obj);
    };
    f.byId = (id) => {
      const found = getRefs().find((x) => x[RAW] && x[RAW].id === id);
      return found || mkMissing();
    };
    f.whose = (cond) => collection(app, () => getRefs().filter((x) => matches(x[RAW], cond)), mkMissing);
    f.value = () => { gate(app); return getRefs().map((x) => x.value()); };
    return f;
  }

  const missingRef = (app) => () => ref(app, { id: null }, { id: () => null, name: () => null, uid: () => null, calendarIdentifier: () => null }, {}, true);

  // ----- contacts
  const contactsApp = () => {
    const mk = (p) => ref('contacts', p, { id: () => p.id, name: () => p.name }, {
      emails: collection('contacts', () => p.emails.map((v) => ref('contacts', { id: v }, { value: () => v })), missingRef('contacts')),
      phones: collection('contacts', () => p.phones.map((v) => ref('contacts', { id: v }, { value: () => v })), missingRef('contacts')),
    });
    const people = (filter) => collection('contacts', () => data.contacts.people.filter(filter).map(mk), missingRef('contacts'));
    const groups = { byId: (gid) => {
      const exists = data.contacts.groups.includes(gid);
      return exists
        ? { people: people((p) => p.groups.includes(gid)) }
        : { people: () => { throw appleError(-1728, "Can't get object"); } };
    } };
    return { people: people(() => true), groups };
  };

  // ----- reminders
  const remindersApp = () => {
    const acct = (id) => data.reminders.lists.find((l) => l.account_id === id);
    const makeReminder = (props) => {
      const state = { item: null };
      const need = () => { if (!state.item) throw appleError(-1728, "Can't get object"); return state.item; };
      const r = ref('reminders', { id: null }, {
        id: () => need().id, name: () => need().title, completed: () => need().completed,
        dueDate: () => (need().due ? new Date(need().due) : null),
        alldayDueDate: () => (need().allday_due ? new Date(need().allday_due) : null),
        body: () => need().body,
      });
      r.commit = (l) => {
        const n = data.created.length + 1;
        const item = {
          id: `rNew${n}`, title: props.name, list_id: l.id, completed: false,
          due: props.dueDate ? props.dueDate.toISOString() : null,
          allday_due: props.alldayDueDate ? props.alldayDueDate.toISOString() : null,
          body: props.body === undefined ? null : props.body,
        };
        data.reminders.items.push(item);
        data.created.push({ app: 'reminders', id: item.id });
        state.item = item;
      };
      return r;
    };
    const listRef = (l) => ref('reminders', l, { id: () => l.id, name: () => l.name }, {
      reminders: collection('reminders', () => data.reminders.items.filter((x) => x.list_id === l.id).map(remRef), missingRef('reminders'), (obj) => obj.commit(l)),
    });
    function remRef(x) {
      const l = data.reminders.lists.find((q) => q.id === x.list_id);
      const raw = { ...x, _gone: () => !data.reminders.items.includes(x) };
      return ref('reminders', raw, {
        id: () => x.id, name: () => x.title, completed: () => x.completed,
        dueDate: () => (x.due ? new Date(x.due) : null), alldayDueDate: () => (x.allday_due ? new Date(x.allday_due) : null),
        body: () => x.body, container: () => listRef(l),
      }, {}, false, () => { if (!faults.unverifiedDelete) data.reminders.items.splice(data.reminders.items.indexOf(x), 1); data.created.push({ app: 'reminders', id: x.id, mutation: 'delete' }); });
    }
    const lists = collection('reminders', () => data.reminders.lists.map(listRef), missingRef('reminders'));
    const accountIds = [...new Set(data.reminders.lists.map((l) => l.account_id))];
    const accounts = () => {
      gate('reminders');
      return accountIds.map((aid) => ref('reminders', { id: aid }, { id: () => aid, name: () => acct(aid).account_name }, {
        lists: () => data.reminders.lists.filter((l) => l.account_id === aid).map(listRef),
      }));
    };
    return {
      accounts, lists, Reminder: makeReminder, delete: (r) => r[DEL](),
      defaultList: () => { gate('reminders'); return listRef(data.reminders.lists[0]); },
      reminders: collection('reminders', () => data.reminders.items.map(remRef), missingRef('reminders')),
    };
  };

  // ----- notes
  const notesApp = () => {
    const noteRef = (x) => {
      const f = data.notes.folders.find((q) => q.id === x.folder_id);
      return ref('notes', { id: x.id, _gone: () => !data.notes.items.includes(x) }, {
        id: () => x.id, name: () => x.title,
        passwordProtected: () => x.protected,
        modificationDate: () => (x.modified ? new Date(x.modified) : null),
        creationDate: () => (x.created ? new Date(x.created) : null),
        shared: () => x.shared,
        plaintext: () => x.text, // the bait getter counts every read
        container: () => folderRef(f),
      }, {}, false, () => { if (!faults.unverifiedDelete) data.notes.items.splice(data.notes.items.indexOf(x), 1); data.created.push({ app: 'notes', id: x.id, mutation: 'delete' }); });
    };
    const makeNote = (props) => {
      const state = { item: null };
      const need = () => { if (!state.item) throw appleError(-1728, "Can't get object"); return state.item; };
      const n = ref('notes', { id: null }, {
        id: () => need().id, name: () => need().title, passwordProtected: () => need().protected,
        modificationDate: () => new Date(need().modified), creationDate: () => new Date(need().created), shared: () => need().shared,
      });
      n.commit = (f) => {
        const text = props.body.replace(/<\/div>/g, '\n').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        const item = { id: `nNew${data.created.length + 1}`, title: text.split('\n')[0], folder_id: f.id, protected: false, text, modified: '2026-10-02T12:00:00Z', created: '2026-10-02T12:00:00Z', shared: false };
        data.notes.items.push(item);
        data.created.push({ app: 'notes', id: item.id, html: props.body });
        state.item = item;
      };
      return n;
    };
    function folderRef(f) {
      return ref('notes', { id: f.id }, { id: () => f.id, name: () => f.name, shared: () => f.shared }, {
        folders: () => [],
        notes: collection('notes', () => data.notes.items.filter((x) => x.folder_id === f.id).map(noteRef), missingRef('notes'), (obj) => obj.commit(f)),
      });
    }
    const accountRef = (a) => ref('notes', { id: a.id }, {
      id: () => a.id, name: () => a.name,
      defaultFolder: () => folderRef(data.notes.folders.find((f) => f.account_id === a.id)),
    }, {
      folders: () => data.notes.folders.filter((f) => f.account_id === a.id).map(folderRef),
    });
    const accounts = () => {
      gate('notes');
      return data.notes.accounts.map(accountRef);
    };
    return {
      accounts, Note: makeNote, delete: (r) => r[DEL](),
      defaultAccount: () => { gate('notes'); return accountRef(data.notes.accounts[0]); },
      folders: collection('notes', () => data.notes.folders.map(folderRef), missingRef('notes')),
      notes: collection('notes', () => data.notes.items.map(noteRef), missingRef('notes')),
    };
  };

  // ----- calendar
  const calendarApp = () => {
    const evRef = (x) => {
      const r = ref('calendar', { id: x.id, startDate: new Date(x.start), endDate: new Date(x.end), _gone: () => !data.calendar.events.includes(x) }, {
        uid: () => x.id, id: () => x.id, alldayEvent: () => x.all_day, recurrence: () => x.recurrence,
        attendees: () => Array.from({ length: x.attendees || 0 }, () => ({})),
      }, {}, false, () => { if (!faults.unverifiedDelete) data.calendar.events.splice(data.calendar.events.indexOf(x), 1); data.created.push({ app: 'calendar', id: x.id, mutation: 'delete' }); });
      // JXA properties are readable (call) and assignable; model both.
      const fields = { summary: ['title', (v) => v], startDate: ['start', (v) => v.toISOString()], endDate: ['end', (v) => v.toISOString()], location: ['location', (v) => v], description: ['description', (v) => v] };
      for (const [name, [key, enc]] of Object.entries(fields)) {
        Object.defineProperty(r, name, {
          enumerable: true,
          get: () => () => {
            gate('calendar');
            if (typeof r[RAW]._gone === 'function' && r[RAW]._gone()) throw appleError(-1728, "Can't get object");
            if (hide.includes(name)) throw appleError(-1728, "Can't get property");
            const v = x[key];
            return (name === 'startDate' || name === 'endDate') ? new Date(v) : v;
          },
          set: (v) => { gate('calendar'); x[key] = enc(v); data.created.push({ app: 'calendar', id: x.id, mutation: 'set', field: name }); },
        });
      }
      return r;
    };
    const makeEvent = (props) => {
      const state = { item: null };
      const need = () => { if (!state.item) throw appleError(-1728, "Can't get object"); return state.item; };
      const r = ref('calendar', { id: null }, {
        uid: () => need().id, alldayEvent: () => need().all_day, recurrence: () => need().recurrence, attendees: () => [],
      });
      const readers = { summary: () => need().title, startDate: () => new Date(need().start), endDate: () => new Date(need().end), location: () => need().location, description: () => need().description };
      for (const [name, get] of Object.entries(readers)) r[name] = () => { gate('calendar'); return get(); };
      r.commit = (c) => {
        const item = {
          id: `eNew${data.created.length + 1}`, calendar_id: c.id, title: props.summary, start: props.startDate.toISOString(), end: props.endDate.toISOString(),
          all_day: props.alldayEvent, location: props.location === undefined ? null : props.location, recurrence: '',
          description: props.description === undefined ? null : props.description, attendees: 0,
        };
        data.calendar.events.push(item);
        data.created.push({ app: 'calendar', id: item.id, mutation: 'create' });
        state.item = item;
      };
      return r;
    };
    const calRef = (c) => ref('calendar', { id: c.id, display: `Application("Calendar").calendars.byId("${c.id}")` }, {
      calendarIdentifier: () => { throw appleError(-1700, 'Could not convert types'); }, name: () => c.name, writable: () => c.writable,
    }, {
      events: collection('calendar', () => data.calendar.events.filter((e) => e.calendar_id === c.id).map(evRef), missingRef('calendar'), (obj) => obj.commit(c)),
    });
    return {
      calendars: () => { gate('calendar'); return data.calendar.calendars.map(calRef); },
      Event: makeEvent, delete: (r) => r[DEL](),
    };
  };

  const apps = {
    'com.apple.iCal': calendarApp,
    'com.apple.AddressBook': contactsApp,
    'com.apple.reminders': remindersApp,
    'com.apple.Notes': notesApp,
  };
  return { Application: (bundle) => apps[bundle]() };
}

function runSource(source, mode, params, world) {
  const sandbox = { Application: world.Application, Automation: { getDisplayString: (r) => (r && r[RAW] && r[RAW].display) || '' }, Date, JSON, Math, Object, Array, String, Number, RegExp, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return vm.runInContext('run', sandbox)([mode, JSON.stringify(params)]);
}

function runScript(app, mode, params, world, dir = JXA_DIR) {
  const source = `${fs.readFileSync(path.join(JXA_DIR, 'prelude.js'), 'utf8')}\n${fs.readFileSync(path.join(dir, `${app}.js`), 'utf8')}`;
  return runSource(source, mode, params, world);
}

// spawnFn replacement: "osascript" executes the real script text from argv in the vm.
function createVmSpawn(world) {
  const calls = [];
  const spawnFn = (bin, args, options) => {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      // args: ['-l','JavaScript','-e', source, mode, paramsJson]
      const source = args[3];
      const out = runSource(source, args[4], JSON.parse(args[5]), world);
      child.stdout.emit('data', Buffer.from(out, 'utf8'));
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

module.exports = { makeWorld, runScript, runSource, createVmSpawn, appleError };
