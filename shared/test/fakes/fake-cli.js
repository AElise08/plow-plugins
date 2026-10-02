#!/usr/bin/env node
'use strict';

// TEST-ONLY entry: runs the production `main` over the fake backend, as a real
// process, so stdout/stderr/exit-code behaviour is exercised end to end.
// Faults come from MQ_FAKE_FAULTS (JSON). It is never referenced from bin/ or src/.
const { main, emit } = require('../../src/cli');
const { createFakeAdapter, fakeCapabilities } = require('./fake-adapter');

const faults = process.env.MQ_FAKE_FAULTS ? JSON.parse(process.env.MQ_FAKE_FAULTS) : {};
const probe = {
  nodeVersion: () => process.version, platform: () => 'fake', osascriptPresent: () => true,
  bundlePresent: () => true, bundleId: (p) => ({ 'Contacts.app': 'com.apple.AddressBook', 'Reminders.app': 'com.apple.reminders', 'Notes.app': 'com.apple.Notes', 'Calendar.app': 'com.apple.iCal' }[p.split('/').pop()]),
};

main(process.argv.slice(2), { adapter: createFakeAdapter({ faults }), capabilities: fakeCapabilities(), probe }).then((r) => {
  process.exitCode = emit(r, process.stdout, process.stderr);
});
