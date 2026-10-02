# contacts (Latch plugin)

Find a person in the Contacts app and read their phones and emails. Stages the `plow-contacts` CLI for an agent driving this Mac through [Latch](https://github.com/plow-pbc/latch): it talks to the **Contacts** app through one short `osascript` (JXA) process per call. No server, no network, nothing written to disk, and no Full Disk Access.

## Commands

| Command | Kind | Does |
|---|---|---|
| `search` | read | People whose name, phone or email contains the text; optional `--group-id` |
| `show` | read | The same fields for one person, by `--id` |
| `doctor` | read | Checks this Mac's Contacts dictionary; sends no Apple Event |

There are no writes: `argv.write` is empty, and the CLI has nothing that writes. `plow-contacts --help` prints the full usage and is the source of truth for flags.

Returned fields: `id`, `name`, `emails` (values), `phones` (values). Nothing else is read: no notes, birthday, addresses, photo, social profiles or labels.

## Permission

`requires.permissions: ["automation:com.apple.AddressBook"]` — macOS Automation consent for **Contacts**. It is a permission to *control* the app; the restriction to the commands above lives in this CLI and in the manifest's argv allowlist, not in macOS. `plow-contacts doctor` never asks for it.

## Output contract

One JSON object on stdout: `schema_version, ok, source, items, warnings, coverage`. On failure `ok` is `false`, `items` and `coverage` are `null` and the exit code is non-zero (`PERMISSION_DENIED` 3, `TIMEOUT` 4, `NOT_FOUND` 5, `BLOCKED_MISSING_PROPERTY` 6, `APP_UNAVAILABLE`/`APP_ERROR` 7, `ADAPTER_SCHEMA` 8, `RUNTIME_MISSING` 9, `GUARD_REFUSED` 10, bad arguments 2). stderr only ever carries the sanitised code. An incomplete scan is **not** an error: it is `ok: true` with `coverage.complete: false` and `coverage.reasons`; scans are bounded by `--scan-limit` (default 200) and a soft deadline, and "found nothing" is only true for what `coverage` says was scanned.

## Limits

- Phone search is literal: formatting differences (spaces, dashes, `+55`) are not normalised.
- Accents are not folded in search.
- There is no write command, by design.

## Checked on a real Mac

macOS 26.2, Node 24, 2026-10-02, running the CLI directly (**not** through Latch), with fictional "Teste MacQuery" items.

- `search` (name/email/phone) and `show` returned the right person with the email and phone of a one-email, one-phone test contact, and complete coverage (a contact with several emails or phones was only exercised on fakes).

**Not verified:**

- `--group-id` scoping on a real address book (group ids were not exercised).
- Anything that depends on running inside Latch: see the repository README, "Not verified inside Latch".

## Layout

```
latch-plugin.json   manifest; argv.read / argv.write are generated from the CLI's own command table
skill.md            what the agent reads (hand-written)
cli/                the runnable CLI, GENERATED from ../shared by `node scripts/build-plugins.mjs`; do not edit by hand
  bin/plow-contacts.sh   finds Node (>= 20) and runs the launcher; prints a JSON error (exit 9) if there is none
  bin/plow-contacts.js   launcher: adds the `contacts` group to the agent's argv and wires the real JXA adapter
  src/                core + only the JXA script(s) for Contacts
```
Change behaviour in `../shared/src`, rebuild, and commit both. `node scripts/build-plugins.mjs --check` fails if they differ.
