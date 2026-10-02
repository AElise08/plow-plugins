'use strict';

const { QueryError, invalid } = require('./errors');

// Verbs that must never exist here. Recognising them lets us answer
// FORBIDDEN_COMMAND (a deliberate refusal) instead of UNKNOWN_COMMAND.
const FORBIDDEN_VERBS = new Set([
  'create', 'new', 'add', 'edit', 'update', 'set', 'delete', 'remove', 'rm', 'move', 'mv',
  'complete', 'uncomplete', 'done', 'open', 'unlock', 'lock', 'execute', 'exec', 'run', 'eval',
  'script', 'applescript', 'osascript', 'jxa', 'shell', 'bash', 'sh', 'save', 'export',
  'import', 'sync', 'backup', 'duplicate', 'copy', 'archive', 'flag', 'tag', 'share', 'send',
  'write', 'rename', 'merge', 'activate',
]);

const LIMITS = {
  limit: { type: 'int', min: 1, max: 50, def: 10 },
  'max-chars': { type: 'int', min: 1, max: 2000, def: 400 },
  timeout: { type: 'int', min: 1, max: 60, def: 15 }, // seconds
  'scan-limit': { type: 'int', min: 1, max: 1000, def: 200 },
};
const TZ = { tz: { type: 'tz' } };

const COMMANDS = {
  'contacts search': {
    app: 'contacts',
    flags: {
      query: { type: 'text', required: true, max: 500 },
      'group-id': { type: 'id' },
      limit: LIMITS.limit, 'max-chars': LIMITS['max-chars'],
      timeout: LIMITS.timeout, 'scan-limit': LIMITS['scan-limit'],
    },
  },
  'contacts show': {
    app: 'contacts',
    flags: { id: { type: 'id', required: true }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'reminders lists': {
    app: 'reminders',
    flags: { limit: { ...LIMITS.limit, def: 50 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'reminders search': {
    app: 'reminders',
    flags: {
      query: { type: 'text', max: 500 },
      'list-id': { type: 'id' },
      status: { type: 'enum', values: ['pending', 'completed', 'all'], def: 'pending' },
      'due-from': { type: 'text', max: 64 },
      'due-to': { type: 'text', max: 64 },
      'include-undated': { type: 'bool' },
      ...TZ,
      limit: LIMITS.limit, 'max-chars': LIMITS['max-chars'],
      timeout: LIMITS.timeout, 'scan-limit': LIMITS['scan-limit'],
    },
  },
  'reminders show': {
    app: 'reminders',
    flags: { id: { type: 'id', required: true }, ...TZ, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'notes folders': {
    app: 'notes',
    flags: { limit: { ...LIMITS.limit, def: 50 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'notes search': {
    app: 'notes',
    flags: {
      query: { type: 'text', required: true, max: 500 },
      'folder-id': { type: 'id' },
      'account-id': { type: 'id' },
      scope: { type: 'enum', values: ['title', 'text'], def: 'title' },
      limit: LIMITS.limit, 'max-chars': LIMITS['max-chars'],
      timeout: LIMITS.timeout, 'scan-limit': LIMITS['scan-limit'],
    },
  },
  'notes show': {
    app: 'notes',
    flags: { id: { type: 'id', required: true }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'calendar calendars': {
    app: 'calendar',
    flags: { limit: { ...LIMITS.limit, def: 50 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'calendar search': {
    app: 'calendar',
    flags: {
      query: { type: 'text', max: 500 },
      'calendar-id': { type: 'id' },
      from: { type: 'text', required: true, max: 64 },
      to: { type: 'text', required: true, max: 64 },
      ...TZ,
      limit: LIMITS.limit, 'max-chars': LIMITS['max-chars'],
      // Measured on a real Mac: two calendars cost ~8 s each, so 15 s is too tight.
      timeout: { ...LIMITS.timeout, def: 45 }, 'scan-limit': LIMITS['scan-limit'],
    },
  },
  'calendar show': {
    app: 'calendar',
    flags: { id: { type: 'id', required: true }, ...TZ, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  // The only two write commands. They create one new item; nothing is ever
  // edited, completed, moved or deleted.
  'reminders create': {
    app: 'reminders', write: true,
    flags: {
      title: { type: 'text', required: true, max: 500 },
      body: { type: 'text', max: 5000 },
      'list-id': { type: 'id' },
      due: { type: 'text', max: 64 },
      ...TZ,
      'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout,
    },
  },
  'notes create': {
    app: 'notes', write: true,
    flags: {
      title: { type: 'text', required: true, max: 500 },
      body: { type: 'text', max: 20000 },
      'folder-id': { type: 'id' },
      'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout,
    },
  },
  // Deleting: one item per call, by id, with an identity guard (--expect-title must
  // match the current title). Never by search. The scripts add further refusals.
  'reminders delete': {
    app: 'reminders', write: true, destructive: true,
    flags: { id: { type: 'id', required: true }, 'expect-title': { type: 'text', required: true, max: 500 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'notes delete': {
    app: 'notes', write: true, destructive: true,
    flags: { id: { type: 'id', required: true }, 'expect-title': { type: 'text', required: true, max: 500 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'calendar delete': {
    app: 'calendar', write: true, destructive: true,
    flags: { id: { type: 'id', required: true }, 'expect-title': { type: 'text', required: true, max: 500 }, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout },
  },
  'calendar create': {
    app: 'calendar', write: true,
    flags: {
      'calendar-id': { type: 'id', required: true },
      title: { type: 'text', required: true, max: 500 },
      start: { type: 'text', required: true, max: 64 },
      end: { type: 'text', max: 64 },
      'all-day': { type: 'bool' },
      location: { type: 'text', max: 500 },
      description: { type: 'text', max: 5000 },
      ...TZ, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout,
    },
  },
  'calendar update': {
    app: 'calendar', write: true,
    flags: {
      id: { type: 'id', required: true },
      'expect-title': { type: 'text', required: true, max: 500 },
      title: { type: 'text', max: 500 },
      start: { type: 'text', max: 64 },
      end: { type: 'text', max: 64 },
      location: { type: 'text', max: 500 },
      description: { type: 'text', max: 5000 },
      ...TZ, 'max-chars': LIMITS['max-chars'], timeout: LIMITS.timeout,
    },
  },
  doctor: { app: null, flags: {} },
  help: { app: null, flags: {} },
};

const hasControl = (s) => /[\u0000-\u001F\u007F]/.test(s);

function coerce(flag, spec, raw) {
  const name = `--${flag}`;
  switch (spec.type) {
    case 'int': {
      if (!/^\d{1,6}$/.test(raw)) throw invalid(`${name} must be an integer.`);
      const n = Number(raw);
      if (n < spec.min || n > spec.max) throw invalid(`${name} must be between ${spec.min} and ${spec.max}.`);
      return n;
    }
    case 'enum':
      if (!spec.values.includes(raw)) throw invalid(`${name} must be one of: ${spec.values.join(', ')}.`);
      return raw;
    case 'id':
      if (raw.length < 1 || raw.length > 512 || hasControl(raw) || raw.trim() === '') {
        throw invalid(`${name} is not a well-formed id.`);
      }
      return raw;
    case 'tz':
      if (raw.length < 1 || raw.length > 64 || hasControl(raw)) throw invalid(`${name} is not a valid time zone.`);
      return raw;
    case 'text': {
      if (raw.includes('\u0000')) throw invalid(`${name} must not contain NUL.`);
      if (raw.length > (spec.max || 500)) throw invalid(`${name} is too long.`);
      if (raw.trim() === '') throw invalid(`${name} must not be empty.`);
      return raw;
    }
    default:
      throw new QueryError('INTERNAL');
  }
}

/**
 * argv -> { key, command, opts }. `apps` (optional) restricts which apps' commands exist. Strict: unknown flags, repeated flags,
 * positionals and missing required flags are all INVALID_ARGUMENT. Values are
 * only ever treated as data.
 */
function parseArgs(argv, apps = null) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw invalid('argv must be strings.');
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { key: 'help', command: COMMANDS.help, opts: {} };
  }
  const safeToken = (t) => (/^[a-z][a-z-]{0,19}$/.test(t) ? t : null);
  const first = argv[0];
  let key;
  let rest;
  if (first === 'help' || first === 'doctor') {
    key = first;
    rest = argv.slice(1);
  } else {
    const verb = argv[1];
    const group = ['contacts', 'reminders', 'notes', 'calendar'].includes(first) ? first : null;
    const enumerated = group && verb && COMMANDS[`${group} ${verb}`];
    if (!enumerated && (FORBIDDEN_VERBS.has(first) || (group && verb && FORBIDDEN_VERBS.has(verb)))) {
      throw new QueryError('FORBIDDEN_COMMAND');
    }
    if (!group || !verb || verb.startsWith('-')) {
      throw new QueryError('UNKNOWN_COMMAND', safeToken(first) ? `Unknown command group "${first}".` : undefined);
    }
    key = `${group} ${verb}`;
    if (!COMMANDS[key]) throw new QueryError('UNKNOWN_COMMAND');
    rest = argv.slice(2);
  }
  const command = COMMANDS[key];
  // A plugin that serves only some apps refuses everything else as unknown, so
  // its Automation footprint is exactly the apps it declares.
  if (apps && command.app && !apps.includes(command.app)) throw new QueryError('UNKNOWN_COMMAND');
  const opts = {};
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith('--')) throw invalid('Unexpected positional argument.');
    const eq = tok.indexOf('=');
    const flag = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const spec = Object.prototype.hasOwnProperty.call(command.flags, flag) ? command.flags[flag] : null;
    if (!spec) throw invalid(safeToken(flag) ? `Unknown flag --${flag} for this command.` : 'Unknown flag.');
    if (seen.has(flag)) throw invalid(`--${flag} was given more than once.`);
    seen.add(flag);
    if (spec.type === 'bool') {
      if (eq !== -1) throw invalid(`--${flag} does not take a value.`);
      opts[flag] = true;
      continue;
    }
    let raw;
    if (eq !== -1) raw = tok.slice(eq + 1);
    else {
      if (i + 1 >= rest.length) throw invalid(`--${flag} requires a value.`);
      raw = rest[++i];
    }
    opts[flag] = coerce(flag, spec, raw);
  }
  for (const [flag, spec] of Object.entries(command.flags)) {
    if (opts[flag] === undefined) {
      if (spec.required) throw invalid(`--${flag} is required.`);
      if (spec.def !== undefined) opts[flag] = spec.def;
    }
  }
  return { key, command, opts };
}

module.exports = { parseArgs, COMMANDS, FORBIDDEN_VERBS };
