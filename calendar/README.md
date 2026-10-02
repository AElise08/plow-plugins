# calendar (Latch plugin)

Check the calendar; add, change and delete events. Stages the `plow-calendar` CLI for an agent driving this Mac through [Latch](https://github.com/plow-pbc/latch): it talks to the **Calendar** app through one short `osascript` (JXA) process per call. No server, no network, nothing written to disk, and no Full Disk Access.

## Commands

| Command | Kind | Does |
|---|---|---|
| `calendars` | read | Every calendar with `id`, name and `writable` |
| `search` | read | Events overlapping `--from`..`--to` (max 366 days); optional `--query`, `--calendar-id` |
| `show` | read | One event with its description, by `--id` |
| `doctor` | read | Dictionary check; no Apple Event |
| `create` | write | One event, no guests, in a writable calendar |
| `update` | write | Only the fields passed, on one event (`--id` + `--expect-title`) |
| `delete` | write | One event by `--id` + `--expect-title` |

Writes (`create`, `update`, `delete`) are listed under `argv.write`, so Latch asks the owner to approve each one. `plow-calendar --help` prints the full usage and is the source of truth for flags.

Returned fields: `id`, `title`, `calendar` (id, name), `start`, `end`, `all_day`, `location`, `recurring`; `description` only from `show`. Guests, alarms and URLs are not read.

## Permission

`requires.permissions: ["automation:com.apple.iCal"]` — macOS Automation consent for **Calendar**. It is a permission to *control* the app; the restriction to the commands above lives in this CLI and in the manifest's argv allowlist, not in macOS. `plow-calendar doctor` never asks for it.

## Running under Latch

**Blocked as built: through `plow_run_command`, Calendar refuses this CLI's Apple Events.** Latch runs plugin commands inside a `sandbox-exec` profile, and on macOS 26.2 the app answers every collection read from a sandboxed process with error `-10004` (also with a sandbox that allows everything, and in AppleScript as well as JXA). The CLI reports it as `SANDBOX_REFUSED` (exit 3, nothing changed). Run unsandboxed (standalone, or through Latch's `plow_run_applescript`) the same scripts work. The experiments and the options for Latch are in [`../docs/sandbox-findings.md`](../docs/sandbox-findings.md).

What does work under the replica of Latch's sandbox: `--help`, `doctor`, and the error answers. A call that forgot `apple_events=true` comes back as `APP_UNAVAILABLE` (error -600). Latch's sandbox denies Apple Events unless the call declares `apple_events=true`, and Latch never stores a rule for such a call, so the owner would decide each one.

## Output contract

One JSON object on stdout: `schema_version, ok, source, items, warnings, coverage`. On failure `ok` is `false`, `items` and `coverage` are `null` and the exit code is non-zero (`PERMISSION_DENIED` / `SANDBOX_REFUSED` 3, `TIMEOUT` 4, `NOT_FOUND` 5, `BLOCKED_MISSING_PROPERTY` 6, `APP_UNAVAILABLE`/`APP_ERROR` 7, `ADAPTER_SCHEMA` 8, `RUNTIME_MISSING` 9, `GUARD_REFUSED` 10, bad arguments 2). stderr only ever carries the sanitised code. An incomplete scan is **not** an error: it is `ok: true` with `coverage.complete: false` and `coverage.reasons`; scans are bounded by `--scan-limit` (default 200) and a soft deadline, and "found nothing" is only true for what `coverage` says was scanned.

## Guards (nothing is modified when one trips)

Writes that change or remove an existing item need `--id` **and** `--expect-title` (the item's current title must start with it). A guard refusal is `error.code: GUARD_REFUSED` (exit 10) with `error.reason` one of `read_only_calendar`, `recurring_event`, `has_attendees`, `attendees_unknown`, `title_mismatch`, `title_unreadable`, `all_day_time_change`; the answer also carries `error.write_outcome` (`not_performed`, or `unknown` when a timeout or app error means the change may have happened — never retry blindly).

## Limits

- Repeating events are not expanded per occurrence; every window search carries `RECURRING_NOT_EXPANDED` and `complete: false`.
- A window search visits every calendar and can take 10-30 s (two calendars took about 8 s each on the tested Mac); `calendar search` defaults to a 45 s timeout (max 60). Use `--calendar-id` to go faster.
- Calendar ids come from the specifier reference (`calendars.byId("...")`) because the dictionary's `calendarIdentifier` did not convert to text on the tested Mac.
- All-day events created here end at 23:59:59 of the last day (the convention seen on a synced calendar).

## Checked on a real Mac

macOS 26.2, Node 24, 2026-10-02, running the CLI directly (**not** through Latch), with fictional "Teste MacQuery" items.

- `calendars` and a one-week `search` (overlap, time zone, resolved window) on a real calendar set.
- `create` (timed, in a writable local calendar, no guests), `update` (title and end only; other fields untouched) and `delete`, each with a matching read-back; afterwards `show` answered `NOT_FOUND`.

**Not verified:**

- `show` on an existing event (only the not-found path ran for real).
- All-day `create`/`update`.
- The guard refusals on real data (repeating event, event with guests, read-only calendar).
- How repeating events appear in a window.
- Anything that depends on running inside Latch: see the repository README, "Not verified inside Latch".

## Layout

```
latch-plugin.json   manifest; argv.read / argv.write are generated from the CLI's own command table
skill.md            what the agent reads (hand-written)
cli/                the runnable CLI, GENERATED from ../shared by `node scripts/build-plugins.mjs`; do not edit by hand
  bin/plow-calendar.sh   finds Node (>= 20) and runs the launcher; prints a JSON error (exit 9) if there is none
  bin/plow-calendar.js   launcher: adds the `calendar` group to the agent's argv and wires the real JXA adapter
  src/                core + only the JXA script(s) for Calendar
```
Change behaviour in `../shared/src`, rebuild, and commit both. `node scripts/build-plugins.mjs --check` fails if they differ.
