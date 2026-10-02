'use strict';

const { APPS } = require('./sdef');

// Environment + dictionary check only. Sends no Apple Events, reads no data and
// does not try to obtain any macOS consent.
function runDoctor(ctx) {
  const items = [];
  const probe = ctx.probe;
  items.push({
    kind: 'runtime',
    node: probe.nodeVersion(),
    osascript: probe.osascriptPresent() ? 'present' : 'missing',
    platform: probe.platform(),
  });
  for (const [key, app] of Object.entries(APPS)) {
    if (ctx.apps && !ctx.apps.includes(key)) continue;
    const present = probe.bundlePresent(app.bundle);
    const bundleId = present ? probe.bundleId(app.bundle) : null;
    const caps = present ? ctx.capabilities(key) : { blocked: true, missing_required: ['app-not-found'], unsupported: [], supported: [], dictionary: 'unreadable' };
    items.push({
      kind: 'app',
      app: key,
      bundle_present: present,
      bundle_id: bundleId,
      bundle_id_expected: app.bundleId,
      bundle_id_confirmed: bundleId === app.bundleId,
      dictionary: caps.dictionary || 'ok',
      commands: caps.blocked ? 'blocked' : 'available',
      missing_required: caps.missing_required,
      supported_features: caps.supported,
      unsupported_features: caps.unsupported,
    });
  }
  const ok = items.every((i) => i.kind === 'runtime' ? i.osascript === 'present' : i.commands === 'available' && i.bundle_id_confirmed);
  return {
    source: 'doctor',
    items,
    warnings: [
      { code: 'AUTOMATION_NOT_CHECKED', message: 'doctor does not query data nor request Automation consent; permission state is unknown until the first real command.' },
      { code: 'REMOTE_CONTEXT', message: 'Whatever a command prints is returned to the model provider as conversation context. Local access does not mean the results stay on this Mac.' },
    ],
    coverage: { complete: ok, reasons: ok ? [] : ['ENVIRONMENT_INCOMPLETE'], returned: items.length, output_truncated: false },
  };
}

module.exports = { runDoctor };
