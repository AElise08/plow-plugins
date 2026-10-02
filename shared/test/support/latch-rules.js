'use strict';

// A JavaScript port of the parts of Latch's own plugin checks that matter to us:
//   packages/device-core/src/plugins/manifest.ts   (parseManifest)
//   packages/device-core/src/plugins/argvRules.ts  (classifyArgv)
// from https://github.com/plow-pbc/latch at commit 006f4db79b1234842fe9e525dda0c6352e61030a.
// It is a MIRROR, not the real code: if Latch changes those rules, update this file.
// (scripts/check-against-latch.mjs runs the real ones against a Latch checkout.)

const AUTOMATION_APPS = [
  'com.apple.MobileSMS', 'com.apple.mail', 'com.apple.iCal', 'com.apple.AddressBook',
  'com.apple.Notes', 'com.apple.reminders', 'com.apple.finder', 'com.apple.Safari',
];
const QUERYABLE_PERMISSIONS = ['accessibility', 'contacts', 'calendars'];
const PERMISSION_IDS = new Set(['full_disk_access', ...QUERYABLE_PERMISSIONS, ...AUTOMATION_APPS.map((b) => `automation:${b}`)]);
const ACCOUNT_IDS = new Set(['google']);
const SLUG = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{64}$/;
const NO_DOTDOT = /^(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;
const INSIDE = new RegExp(`^(?!/)${NO_DOTDOT.source.slice(1)}`);

class PluginError extends Error {}
const fail = (m) => { throw new PluginError(m); };
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v, what) => { if (v === undefined || v === null) return []; if (!Array.isArray(v)) fail(`${what} must be an array`); return v; };
const isStrings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const str = (v, what) => { if (v === undefined) return undefined; if (typeof v !== 'string') fail(`${what} must be a string`); return v; };
const inside = (v, what) => { if (typeof v !== 'string' || !INSIDE.test(v)) fail(`${what} must be a path inside the plugin`); return v; };

function parseManifest(raw) {
  let json;
  try { json = JSON.parse(raw); } catch { fail('manifest is not valid JSON'); }
  const m = obj(json);
  const name = str(m.name, 'manifest name') ?? '';
  if (!SLUG.test(name)) fail('manifest name must be lowercase letters, digits and dashes');
  const title = str(m.title, 'manifest title');
  if (title !== undefined && !title.trim()) fail('manifest title must not be blank');
  const summary = str(m.summary, 'manifest summary');
  if (summary !== undefined && !summary.trim()) fail('manifest summary must not be blank');
  const command = str(m.command, 'manifest command') ?? '';
  if (!SLUG.test(command)) fail('manifest command must be lowercase letters, digits and dashes');
  if (!(str(m.version, 'manifest version') ?? '')) fail('manifest needs a version');
  const runtime = obj(m.runtime);
  const binaries = arr(runtime.binaries, 'runtime.binaries').map((b) => {
    const bin = obj(b);
    const bname = str(bin.name, 'binary name') ?? '';
    if (!SLUG.test(bname) || bname === 'bin') fail('binary name is invalid');
    for (const arch of ['arm64', 'x64']) {
      if (typeof obj(bin.url)[arch] !== 'string' || !obj(bin.url)[arch].startsWith('https://')) fail(`binary ${bname} needs an https url for arm64 and x64`);
      if (typeof obj(bin.sha256)[arch] !== 'string' || !SHA.test(obj(bin.sha256)[arch])) fail(`binary ${bname} needs a sha256 for arm64 and x64`);
    }
    return bname;
  });
  if (new Set(binaries).size !== binaries.length) fail('binary names must be unique');
  const exec = obj(m.exec);
  if (!isStrings(exec.argv) || exec.argv.length === 0) fail('manifest needs exec.argv');
  if (!NO_DOTDOT.test(exec.argv[0])) fail('exec.argv[0] must not contain a .. segment');
  for (const [key, value] of Object.entries(obj(m.env))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) fail('env names must be UPPER_SNAKE_CASE');
    if (typeof obj(value).fixed !== 'string') fail(`env value ${key} needs a fixed string`);
  }
  const argv = obj(m.argv);
  const read = arr(argv.read, 'argv.read');
  const write = arr(argv.write, 'argv.write');
  const prefixes = [...read, ...write];
  if (!prefixes.every(isStrings)) fail('argv prefixes must be arrays of strings');
  if (prefixes.some((p) => p.length === 0)) fail('argv prefixes must not be empty');
  for (const a of prefixes) for (const b of prefixes) if (a !== b && a.every((tok, i) => b[i] === tok)) fail(`argv prefixes must not overlap: ${a.join(' ')}`);
  const req = obj(m.requires);
  const accounts = arr(req.accounts, 'requires.accounts').map((e) => { if (!ACCOUNT_IDS.has(e)) fail('requires.accounts entries must name an account connector this Mac offers'); return e; });
  const permissions = arr(req.permissions, 'requires.permissions').map((e) => { if (!PERMISSION_IDS.has(e)) fail('requires.permissions entries must name a permission this Mac can check'); return e; });
  const hooks = obj(m.hooks);
  if (hooks.postinstall !== undefined) inside(hooks.postinstall, 'hooks.postinstall');
  const skill = m.skill === undefined ? null : inside(m.skill, 'skill');
  return { name, title, summary, command, binaries, exec: { argv: exec.argv }, argv: { read, write }, requires: { accounts, permissions }, skill };
}

const startsWith = (argv, prefix) => prefix.every((tok, i) => argv[i] === tok);
function classifyArgv(manifest, argv) {
  const tail = argv.slice(1);
  const read = manifest.argv.read.find((p) => startsWith(tail, p));
  if (read) return { kind: 'read', prefix: read };
  if (manifest.argv.write.some((p) => startsWith(tail, p))) return { kind: 'write' };
  return { kind: 'refused' };
}

module.exports = { parseManifest, classifyArgv, PluginError, PERMISSION_IDS };
