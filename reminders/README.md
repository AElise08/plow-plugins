# reminders (Latch plugin)

Find, add and delete reminders. Stages the `plow-reminders` CLI for an agent driving this Mac through [Latch](https://github.com/plow-pbc/latch): it talks to the **Reminders** app through one short `osascript` (JXA) process per call. No server, no network, nothing written to disk, and no Full Disk Access.

## Commands

| Command | Kind | Does |
|---|---|---|
| `lists` | read | Every list with `id`, name and account |
| `search` | read | Filter by text (title only), list id, status (`pending` default), due window, `--include-undated` |
| `show` | read | One reminder with its body, by `--id` |
| `doctor` | read | Dictionary check; no Apple Event |
| `create` | write | One new reminder: `--title`, `--body`, `--list-id`, `--due`, `--tz` |
| `delete` | write | One reminder by `--id` + `--expect-title` |

Writes (`create`, `delete`) are listed under `argv.write`, so Latch asks the owner to approve each one. `plow-reminders --help` prints the full usage and is the source of truth for flags.

Returned fields: `id`, `title`, `list` (id, name), `completed`, `due`, `all_day`, `has_due`; `body` only from `show`.

## Permission

`requires.permissions: ["automation:com.apple.reminders"]` — macOS Automation consent for **Reminders**. It is a permission to *control* the app; the restriction to the commands above lives in this CLI and in the manifest's argv allowlist, not in macOS. `plow-reminders doctor` never asks for it.

## Output contract

One JSON object on stdout: `schema_version, ok, source, items, warnings, coverage`. On failure `ok` is `false`, `items` and `coverage` are `null` and the exit code is non-zero (`PERMISSION_DENIED` 3, `TIMEOUT` 4, `NOT_FOUND` 5, `BLOCKED_MISSING_PROPERTY` 6, `APP_UNAVAILABLE`/`APP_ERROR` 7, `ADAPTER_SCHEMA` 8, `RUNTIME_MISSING` 9, `GUARD_REFUSED` 10, bad arguments 2). stderr only ever carries the sanitised code. An incomplete scan is **not** an error: it is `ok: true` with `coverage.complete: false` and `coverage.reasons`; scans are bounded by `--scan-limit` (default 200) and a soft deadline, and "found nothing" is only true for what `coverage` says was scanned.

## Guards (nothing is modified when one trips)

Writes that change or remove an existing item need `--id` **and** `--expect-title` (the item's current title must start with it). A guard refusal is `error.code: GUARD_REFUSED` (exit 10) with `error.reason` one of `title_mismatch`, `title_unreadable`; the answer also carries `error.write_outcome` (`not_performed`, or `unknown` when a timeout or app error means the change may have happened — never retry blindly).

## Limits

- `--due-from` is inclusive and `--due-to` exclusive; a bare `YYYY-MM-DD` is the whole day in `--tz` (default: this Mac's zone), never UTC. Date-times need an offset.
- The answer echoes the resolved bounds in `query`.
- `all_day` may be `null`: how Reminders reports date-only vs timed reminders is not proven (`ALL_DAY_UNVERIFIED`).
- There is no "complete" or "edit": a reminder can only be created or deleted.

## Checked on a real Mac

macOS 26.2, Node 24, 2026-10-02, running the CLI directly (**not** through Latch), with fictional "Teste MacQuery" items.

- `search` (pending/all, by title) and `show` (body, due) returned correct data.
- `create` with a date-time put the reminder in the default list; the read-back matched title and due.
- `delete` removed the reminder and the app confirmed it was gone (`verified_gone: true`).

**Not verified:**

- `lists` on a real Mac (not run).
- `create --due YYYY-MM-DD` (all-day) and `--list-id` on a real Mac.
- The date-only vs timed distinction (`all_day`).
- Anything that depends on running inside Latch: see the repository README, "Not verified inside Latch".

## Layout

```
latch-plugin.json   manifest; argv.read / argv.write are generated from the CLI's own command table
skill.md            what the agent reads (hand-written)
cli/                the runnable CLI, GENERATED from ../shared by `node scripts/build-plugins.mjs`; do not edit by hand
  bin/plow-reminders.sh   finds Node (>= 20) and runs the launcher; prints a JSON error (exit 9) if there is none
  bin/plow-reminders.js   launcher: adds the `reminders` group to the agent's argv and wires the real JXA adapter
  src/                core + only the JXA script(s) for Reminders
```
Change behaviour in `../shared/src`, rebuild, and commit both. `node scripts/build-plugins.mjs --check` fails if they differ.
