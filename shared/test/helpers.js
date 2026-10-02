'use strict';

const { main } = require('../src/cli');
const { createFakeAdapter, fakeCapabilities } = require('./fakes/fake-adapter');
const { buildData } = require('./fakes/fake-data');

const probe = {
  nodeVersion: () => 'v-test', platform: () => 'fake', osascriptPresent: () => true,
  bundlePresent: () => true,
  bundleId: (p) => ({ 'Contacts.app': 'com.apple.AddressBook', 'Reminders.app': 'com.apple.reminders', 'Notes.app': 'com.apple.Notes', 'Calendar.app': 'com.apple.iCal' }[p.split('/').pop()]),
};

// Runs the production `main` over the fake backend (fictional data only).
async function run(argv, { faults, data, caps, adapter } = {}) {
  const d = data || buildData();
  const a = adapter || createFakeAdapter({ data: d, faults });
  const result = await main(argv, { adapter: a, capabilities: fakeCapabilities(caps), probe });
  return { ...result, env: result.envelope, adapter: a, data: d };
}

const ids = (env) => env.items.map((i) => i.id);

module.exports = { run, ids, probe };
