#!/usr/bin/env node
/**
 * Runs Latch's REAL manifest parser and argv allowlist (not the mirror in
 * shared/test/support/latch-rules.js) against every plugin in this repo.
 *
 *   git clone --depth 1 https://github.com/plow-pbc/latch.git /some/where/latch
 *   node scripts/check-against-latch.mjs /some/where/latch
 *
 * It copies packages/device-core/src/plugins/{manifest,argvRules}.ts into a temp dir
 * (swapping manifest.ts's import of the Automation app list for the list taken verbatim
 * from hostGate/inventory.ts), runs them with Node's built-in TypeScript stripping
 * (Node >= 22.18), and deletes the temp dir. It reads the Latch checkout; it changes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latch = process.argv[2];
if (!latch) { console.error('usage: check-against-latch.mjs <path to a plow-pbc/latch checkout>'); process.exit(2); }
const plugins = path.join(latch, 'packages', 'device-core', 'src', 'plugins');
const inventory = path.join(latch, 'packages', 'device-core', 'src', 'hostGate', 'inventory.ts');
for (const f of [path.join(plugins, 'manifest.ts'), path.join(plugins, 'argvRules.ts'), inventory]) {
  if (!fs.existsSync(f)) { console.error(`not found: ${f}`); process.exit(2); }
}

const inv = fs.readFileSync(inventory, 'utf8');
const apps = /export const AUTOMATION_APPS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\);/.exec(inv)?.[1];
const queryable = /export const QUERYABLE_PERMISSIONS[^=]*=\s*(\[[^\]]*\]);/.exec(inv)?.[1];
if (!apps || !queryable) { console.error('could not read AUTOMATION_APPS / QUERYABLE_PERMISSIONS from inventory.ts'); process.exit(2); }
const importLine = 'import { AUTOMATION_APPS, QUERYABLE_PERMISSIONS } from "../hostGate/inventory.js";';
const manifestSrc = fs.readFileSync(path.join(plugins, 'manifest.ts'), 'utf8');
if (!manifestSrc.includes(importLine)) { console.error('manifest.ts changed shape (its inventory import moved); update this script'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latch-check-'));
try {
  fs.writeFileSync(path.join(tmp, 'manifest.ts'), manifestSrc.replace(importLine, `const AUTOMATION_APPS = Object.freeze([${apps}]);\nconst QUERYABLE_PERMISSIONS = ${queryable};`));
  fs.writeFileSync(path.join(tmp, 'argvRules.ts'), fs.readFileSync(path.join(plugins, 'argvRules.ts'), 'utf8').replace('from "./manifest.js"', 'from "./manifest.ts"'));
  fs.writeFileSync(path.join(tmp, 'check.ts'), `
import fs from "node:fs";
import path from "node:path";
import { parseManifest } from "./manifest.ts";
import { classifyArgv } from "./argvRules.ts";
const repo = process.argv[2];
let failures = 0;
for (const app of ["contacts", "reminders", "notes", "calendar"]) {
  const m = parseManifest(fs.readFileSync(path.join(repo, app, "latch-plugin.json"), "utf8"));
  const doc = fs.readFileSync(path.join(repo, app, m.skill!), "utf8");
  const calls = [...doc.matchAll(/argv=(\\[[^\\]]*\\])/g)].map((x) => JSON.parse(x[1]) as string[]);
  const refused = calls.filter((c) => classifyArgv(m, c).kind === "refused").length;
  if (calls.length === 0 || refused) failures++;
  console.log(\`\${app}: manifest accepted (command=\${m.command}, permissions=\${m.requires.permissions.join(",")}); skill examples=\${calls.length}, refused=\${refused}\`);
}
process.exit(failures ? 1 : 0);
`);
  const r = spawnSync(process.execPath, [path.join(tmp, 'check.ts'), repo], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
