# notes (Latch plugin)

Find and read notes (never locked ones), add a note, delete a note. Stages the `plow-notes` CLI for an agent driving this Mac through [Latch](https://github.com/plow-pbc/latch): it talks to the **Notes** app through one short `osascript` (JXA) process per call. No server, no network, nothing written to disk, and no Full Disk Access.

## Commands

| Command | Kind | Does |
|---|---|---|
| `folders` | read | Every folder with `id`, account and name |
| `search` | read | Title (default) or text (`--scope text`, with a short snippet); optional `--folder-id`, `--account-id` |
| `show` | read | One note: metadata and plain text, by `--id` |
| `doctor` | read | Dictionary check; no Apple Event |
| `create` | write | One new note: `--title`, `--body` (plain text, escaped), `--folder-id` |
| `delete` | write | One unlocked note by `--id` + `--expect-title` |

Writes (`create`, `delete`) are listed under `argv.write`, so Latch asks the owner to approve each one. `plow-notes --help` prints the full usage and is the source of truth for flags.

Returned fields: `id`, `title`, `folder`, `account`, `modified`, `protected`, and `snippet` (search) or `text` (show). Plain text only, never the HTML body.

## Permission

`requires.permissions: ["automation:com.apple.Notes"]` — macOS Automation consent for **Notes**. It is a permission to *control* the app; the restriction to the commands above lives in this CLI and in the manifest's argv allowlist, not in macOS. `plow-notes doctor` never asks for it.

## Running under Latch

Latch runs a plugin command inside a `sandbox-exec` profile that **denies Apple Events by default**, so every call that reaches the app must declare `apple_events=true` on `plow_run_command` (`doctor` and `--help` need nothing). Latch never stores a rule for such a call: the owner decides each one. The skill tells the agent both. A call that forgot `apple_events=true` comes back as `APP_UNAVAILABLE` (error -600), which was checked by running the plugin under a replica of Latch's sandbox (`scripts/sandbox-smoke.mjs`). If a call is refused for another reason you will see `PERMISSION_DENIED` (macOS Automation not granted, or the call forgot `apple_events=true`), or `SANDBOX_REFUSED` (error -10004: the app itself refuses Apple Events from a sandboxed sender; Latch documents Mail's compose as one such case, and whether Notes behaves that way has not been checked).

## Output contract

One JSON object on stdout: `schema_version, ok, source, items, warnings, coverage`. On failure `ok` is `false`, `items` and `coverage` are `null` and the exit code is non-zero (`PERMISSION_DENIED` / `SANDBOX_REFUSED` 3, `TIMEOUT` 4, `NOT_FOUND` 5, `BLOCKED_MISSING_PROPERTY` 6, `APP_UNAVAILABLE`/`APP_ERROR` 7, `ADAPTER_SCHEMA` 8, `RUNTIME_MISSING` 9, `GUARD_REFUSED` 10, bad arguments 2). stderr only ever carries the sanitised code. An incomplete scan is **not** an error: it is `ok: true` with `coverage.complete: false` and `coverage.reasons`; scans are bounded by `--scan-limit` (default 200) and a soft deadline, and "found nothing" is only true for what `coverage` says was scanned.

## Guards (nothing is modified when one trips)

Writes that change or remove an existing item need `--id` **and** `--expect-title` (the item's current title must start with it). A guard refusal is `error.code: GUARD_REFUSED` (exit 10) with `error.reason` one of `protected_note`, `protection_unknown`, `title_mismatch`, `title_unreadable`; the answer also carries `error.write_outcome` (`not_performed`, or `unknown` when a timeout or app error means the change may have happened — never retry blindly).

## Limits

- **Locked notes are never read.** The text is requested only when `password protected` is exactly `false`; `true`, missing or an error means "do not read". Locked notes show their title only, and a text search reports them (`PROTECTED_BODY_SKIPPED`, `complete: false`).
- Deleting moves the note to the app's "Recently Deleted" folder (it is not erased): the answer has `verified_gone: false`, `remaining_folder` and `STILL_IN_FOLDER`. The tool neither restores nor empties that folder.
- Attachments, images, OCR, checklist state, tags and tables are out of scope.

## Checked on a real Mac

macOS 26.2, Node 24, 2026-10-02, running the CLI directly (**not** through Latch), with fictional "Teste MacQuery" items.

- Title search, text search with a snippet, and `show` on an unlocked note.
- A locked note was found by title with `protected: true`, `show` returned `body_blocked`, and its body was never read.
- `create` (title came from the first line) and `delete` (note moved to "Recently Deleted").

**Not verified:**

- `folders` on a real Mac (not run).
- `create`/`delete` with an explicit `--folder-id`.
- That `account.folders` lists every nested folder (the code de-duplicates by id but does not prove full coverage).
- Anything that depends on running inside Latch: see the repository README, "Not verified inside Latch".

## Layout

```
latch-plugin.json   manifest; argv.read / argv.write are generated from the CLI's own command table
skill.md            what the agent reads (hand-written)
cli/                the runnable CLI, GENERATED from ../shared by `node scripts/build-plugins.mjs`; do not edit by hand
  bin/plow-notes.sh   finds Node (>= 20) and runs the launcher; prints a JSON error (exit 9) if there is none
  bin/plow-notes.js   launcher: adds the `notes` group to the agent's argv and wires the real JXA adapter
  src/                core + only the JXA script(s) for Notes
```
Change behaviour in `../shared/src`, rebuild, and commit both. `node scripts/build-plugins.mjs --check` fails if they differ.
