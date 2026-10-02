#!/usr/bin/env node
/**
 * Builds each plugin folder from shared/:
 *
 *   <plugin>/cli/        the runnable CLI (core + only that app's JXA scripts + launcher)
 *   <plugin>/latch-plugin.json   manifest, with argv.read/argv.write DERIVED from the CLI's
 *                                own command table, so the allowlist can never drift from
 *                                what the CLI can do
 *
 * skill.md and README.md are hand-written and never touched.
 *
 *   node scripts/build-plugins.mjs           regenerate in place
 *   node scripts/build-plugins.mjs --check   fail (exit 1) if committed files differ from a fresh build
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = path.join(root, 'shared');
const require = createRequire(import.meta.url);
const { COMMANDS } = require(path.join(shared, 'src', 'args.js'));
const { APPS } = require(path.join(shared, 'src', 'sdef.js'));

const PLUGINS = [
  { app: 'contacts', title: 'Contacts', summary: 'Find a person and their phones and emails, right on this Mac.' },
  { app: 'reminders', title: 'Reminders', summary: 'Find, add and delete reminders, right on this Mac.' },
  { app: 'notes', title: 'Notes', summary: 'Find and read your notes (never locked ones), add and delete them, right on this Mac.' },
  { app: 'calendar', title: 'Calendar', summary: 'Check your calendar; add, change and delete events, right on this Mac.' },
];
const VERSION = '0.1.0';
const CORE = ['args.js', 'cli.js', 'commands.js', 'contract.js', 'dates.js', 'doctor.js', 'errors.js', 'schema.js', 'sdef.js', 'text.js'];

const read = (p) => fs.readFileSync(p, 'utf8');

/** Every file of a plugin's generated tree, as { relative path: content }. */
function generate(plugin) {
  const { app } = plugin;
  const name = `plow-${app}`;
  const files = {};
  for (const f of CORE) files[`cli/src/${f}`] = read(path.join(shared, 'src', f));
  files['cli/src/adapters/jxa.js'] = read(path.join(shared, 'src', 'adapters', 'jxa.js'));
  const jxa = path.join(shared, 'src', 'adapters', 'jxa');
  files['cli/src/adapters/jxa/prelude.js'] = read(path.join(jxa, 'prelude.js'));
  files[`cli/src/adapters/jxa/${app}.js`] = read(path.join(jxa, `${app}.js`));
  const common = path.join(jxa, `${app}-common.js`);
  if (fs.existsSync(common)) files[`cli/src/adapters/jxa/${app}-common.js`] = read(common);
  const write = path.join(shared, 'src', 'adapters', 'jxa-write', `${app}.js`);
  if (fs.existsSync(write)) files[`cli/src/adapters/jxa-write/${app}.js`] = read(write);
  files['cli/package.json'] = `${JSON.stringify({ name, version: VERSION, private: true, type: 'commonjs', description: `Runtime for the ${app} Latch plugin (generated; see scripts/build-plugins.mjs)` }, null, 2)}\n`;
  files[`cli/bin/${name}.js`] = read(path.join(shared, 'templates', 'launcher.js.tpl')).replaceAll('__APP__', app);
  files[`cli/bin/${name}.sh`] = read(path.join(shared, 'templates', 'launcher.sh.tpl')).replaceAll('__APP__', app);

  const own = Object.entries(COMMANDS).filter(([, c]) => c.app === app);
  const bare = ([k]) => k.slice(app.length + 1);
  const manifest = {
    name: app,
    title: plugin.title,
    summary: plugin.summary,
    version: VERSION,
    command: name,
    runtime: { binaries: [] },
    requires: { permissions: [`automation:${APPS[app].bundleId}`] },
    exec: { argv: ['/bin/sh', `cli/bin/${name}.sh`] },
    env: {},
    argv: {
      read: [...own.filter(([, c]) => !c.write).map((e) => [bare(e)]), ['doctor'], ['--help']],
      write: own.filter(([, c]) => c.write).map((e) => [bare(e)]),
    },
    skill: 'skill.md',
  };
  const j = (v) => JSON.stringify(v).replaceAll('","', '", "').replaceAll('],[', '], [');
  files['latch-plugin.json'] = [
    '{',
    `  "name": ${j(manifest.name)},`,
    `  "title": ${j(manifest.title)},`,
    `  "summary": ${j(manifest.summary)},`,
    `  "version": ${j(manifest.version)},`,
    `  "command": ${j(manifest.command)},`,
    '  "runtime": { "binaries": [] },',
    `  "requires": { "permissions": ${j(manifest.requires.permissions)} },`,
    `  "exec": { "argv": ${j(manifest.exec.argv)} },`,
    '  "env": {},',
    '  "argv": {',
    `    "read": ${j(manifest.argv.read)},`,
    `    "write": ${j(manifest.argv.write)}`,
    '  },',
    `  "skill": ${j(manifest.skill)}`,
    '}',
    '',
  ].join('\n');
  return files;
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function listTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = hash(fs.readFileSync(p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const check = process.argv.includes('--check');
let drift = 0;
for (const plugin of PLUGINS) {
  const dir = path.join(root, plugin.app);
  const files = generate(plugin);
  if (check) {
    const current = listTree(path.join(dir, 'cli'));
    for (const [rel, content] of Object.entries(files)) {
      const have = rel === 'latch-plugin.json' ? (fs.existsSync(path.join(dir, rel)) ? hash(read(path.join(dir, rel))) : null) : current[rel.replace(/^cli\//, '')] ?? null;
      if (have !== hash(content)) { console.error(`DRIFT ${plugin.app}/${rel}`); drift++; }
    }
    for (const rel of Object.keys(current)) {
      if (!(`cli/${rel}` in files)) { console.error(`EXTRA ${plugin.app}/cli/${rel}`); drift++; }
    }
    continue;
  }
  fs.rmSync(path.join(dir, 'cli'), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (rel.startsWith('cli/bin/')) fs.chmodSync(target, 0o755);
  }
  console.log(`built ${plugin.app}: ${Object.keys(files).length} files`);
}
if (check) {
  if (drift) { console.error(`${drift} file(s) out of sync: run \`node scripts/build-plugins.mjs\``); process.exit(1); }
  console.log('plugins are in sync with shared/');
}
