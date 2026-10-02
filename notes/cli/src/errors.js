'use strict';

// Exit codes per error code. 0 is success; everything else is an explicit state.
const EXIT_CODES = {
  INTERNAL: 1,
  INVALID_ARGUMENT: 2,
  UNKNOWN_COMMAND: 2,
  FORBIDDEN_COMMAND: 2,
  PERMISSION_DENIED: 3,
  TIMEOUT: 4,
  NOT_FOUND: 5,
  BLOCKED_MISSING_PROPERTY: 6,
  METHOD_UNAVAILABLE: 6,
  APP_UNAVAILABLE: 7,
  APP_ERROR: 7,
  ADAPTER_SCHEMA: 8,
  RUNTIME_MISSING: 9,
  GUARD_REFUSED: 10,
};

// Sanitized, fixed texts. Nothing coming from an app or from user input is ever
// interpolated into an error detail.
const DEFAULT_DETAIL = {
  INTERNAL: 'Unexpected internal error.',
  INVALID_ARGUMENT: 'An argument is missing, unknown or invalid.',
  UNKNOWN_COMMAND: 'Command is not part of the enumerated set.',
  FORBIDDEN_COMMAND: 'This kind of command (edit, complete, move, unlock, open, execute...) is refused by design.',
  PERMISSION_DENIED:
    'macOS denied Automation access to the app (error -1743). Nothing was read. ' +
    'Decide manually in System Settings > Privacy & Security > Automation.',
  TIMEOUT: 'The app did not answer before the timeout; the helper process was killed.',
  NOT_FOUND: 'No item or scope with that id exists in the state exposed by the app.',
  BLOCKED_MISSING_PROPERTY:
    'A property required by this command is missing from the local scripting dictionary.',
  METHOD_UNAVAILABLE: 'The app does not implement a required scripting method.',
  APP_UNAVAILABLE: 'The app could not be reached through Apple Events.',
  APP_ERROR: 'The app returned an error (number only, message withheld).',
  ADAPTER_SCHEMA: 'The adapter returned data that does not match the expected schema.',
  RUNTIME_MISSING: 'A required local runtime is not available.',
  GUARD_REFUSED: 'A safety guard refused the change; nothing was modified.',
};

class QueryError extends Error {
  constructor(code, detail, extra) {
    super(code);
    this.code = EXIT_CODES[code] === undefined ? 'INTERNAL' : code;
    this.detail = detail || DEFAULT_DETAIL[this.code];
    this.extra = extra || {};
    this.exitCode = EXIT_CODES[this.code];
  }
}

const invalid = (detail) => new QueryError('INVALID_ARGUMENT', detail);

module.exports = { QueryError, EXIT_CODES, DEFAULT_DETAIL, invalid };
