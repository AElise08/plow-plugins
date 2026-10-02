'use strict';

const { QueryError } = require('./errors');
const { parseArgs, COMMANDS } = require('./args');
const { HANDLERS } = require('./commands');
const { runDoctor } = require('./doctor');
const { successEnvelope, errorEnvelope, enforceCap } = require('./contract');

function helpResult(apps, bare) {
  const items = Object.entries(COMMANDS).filter(([, c]) => !apps || !c.app || apps.includes(c.app)).map(([key, c]) => ({
    command: bare && c.app ? key.slice(c.app.length + 1) : key,
    read_only: !c.write,
    ...(c.destructive ? { destructive: true } : {}),
    flags: Object.entries(c.flags).map(([name, s]) => ({
      name: `--${name}`,
      type: s.type,
      required: Boolean(s.required),
      default: s.def === undefined ? null : s.def,
      ...(s.min !== undefined ? { min: s.min, max: s.max } : {}),
      ...(s.values ? { values: s.values } : {}),
    })),
  }));
  return {
    source: 'mac-query', items,
    warnings: [{ code: 'REMOTE_CONTEXT', message: 'Command output is read by the model provider as conversation context.' }],
    coverage: { complete: true, reasons: [], returned: items.length, output_truncated: false },
  };
}

/**
 * Pure entry point: argv + dependencies in, { exitCode, envelope } out.
 * deps: { adapter, capabilities(appKey), probe, apps?, bare?, name? }
 *   name: label for parse-level errors (default 'mac-query'; a plugin passes 'plow-<app>')
 *   apps: restrict to these apps; bare: `help` names commands without the app group
 *   (a plugin launcher adds the group itself, so agents type `search`, not `notes search`)
 */
async function main(argv, deps) {
  const name = deps.name || 'mac-query';
  let source = name;
  try {
    const { key, command, opts } = parseArgs(argv, deps.apps || null);
    source = command.app || (key === 'doctor' ? 'doctor' : name);
    const memo = new Map();
    const ctx = {
      adapter: deps.adapter,
      probe: deps.probe,
      apps: deps.apps || null,
      capabilities(appKey) {
        if (!memo.has(appKey)) memo.set(appKey, deps.capabilities(appKey));
        return memo.get(appKey);
      },
    };
    let result;
    if (key === 'help') result = helpResult(deps.apps || null, Boolean(deps.bare));
    else if (key === 'doctor') result = runDoctor(ctx);
    else {
      const caps = ctx.capabilities(command.app);
      if (caps.blocked) {
        throw new QueryError('BLOCKED_MISSING_PROPERTY', undefined, { missing: caps.missing_required });
      }
      result = await HANDLERS[key](opts, ctx);
    }
    const envelope = enforceCap(successEnvelope(result.source, result.items, result.warnings, result.coverage, result.query ? { query: result.query } : undefined));
    return { exitCode: 0, envelope };
  } catch (e) {
    const err = e instanceof QueryError ? e : new QueryError('INTERNAL');
    return { exitCode: err.exitCode, envelope: errorEnvelope(source, err) };
  }
}

// Writes exactly one JSON object to stdout. stderr carries only the sanitized code.
function emit({ exitCode, envelope }, stdout, stderr, name = 'mac-query') {
  stdout.write(`${JSON.stringify(envelope)}\n`);
  if (!envelope.ok) stderr.write(`${name}: ${envelope.error.code}\n`);
  return exitCode;
}

module.exports = { main, emit };
