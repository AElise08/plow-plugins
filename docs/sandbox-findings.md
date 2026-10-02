# What happens to these plugins inside Latch's sandbox

**Short version:** on macOS 26.2, Contacts, Reminders, Notes and Calendar **refuse every collection read from a sandboxed process** with error `-10004` (privilege violation), including when the sandbox allows Apple Events and including when the sandbox allows *everything*. The plugins in this repo run `osascript` under `plow_run_command`, which is sandboxed, so as built they cannot read these apps through Latch. Run unsandboxed (standalone, or through `plow_run_applescript`) the same scripts work, and so does a sandboxed helper that carries the `temporary-exception.apple-events` entitlement (tested: see option 3 below).

This matches what Latch's own executor says about it (`packages/device-core/src/executor.ts`, `runAppleScript`, commit `006f4db`): *"some apps refuse commands from any seatbelt-sandboxed sender whose own code signature lacks an apple-events entitlement (-10004, whatever the profile says — verified with `(allow default)`), and osascript is Apple's binary, so no profile can admit it."*

## What was run (2026-10-02, macOS 26.2)

Everything below asks only for a **count** or an app's **name**; no item content is read. The "replica" is `scripts/sandbox-smoke.mjs`, the same `sandbox-exec` profile, environment and working directory as Latch's executor.

| Experiment | Result |
|---|---|
| Plugin `--help` and `doctor` under the replica | work, for all four plugins (Node is found, the `.sdef` is readable, `plutil` runs) |
| Plugin data call under the replica **without** `apple_events` | stopped by the sandbox: JXA error `-600`; the CLI says `APP_UNAVAILABLE` and names `apple_events=true` |
| The same four reads under the replica **with** `apple_events` (`calendars`, `lists`, `folders`, `search`) | all four `SANDBOX_REFUSED` (`-10004`) |
| Bare JXA `Application(bundle).name()` for the four apps, replica with Apple Events | works (the app answers a request for its own name) |
| Bare JXA `calendars()`, `accounts()`, `lists()`, `groups()` counts, replica with Apple Events | all `-10004` |
| The same counts in **AppleScript** (`count calendars`, `count lists`, ...), replica with Apple Events | all `-10004` (so it is not a JXA limitation) |
| `count calendars` in a sandbox that allows everything: `sandbox-exec -p '(version 1)(allow default)' /usr/bin/osascript -e '...'` | `-10004` (so it is not a gap in the replica's profile) |
| A tiny OSAKit helper, ad-hoc signed with **only** `com.apple.security.temporary-exception.apple-events` (the four apps), running JXA inside the replica with Apple Events allowed | **works**: counts `8 / 1 / 1 / 2` for calendars, reminders lists, notes accounts, contact groups; argv with quotes and `$` arrives intact |
| The same helper **without** the entitlement (control) | `-10004` for all four |
| Helper with `automation.apple-events` only, ad-hoc, with and without hardened runtime | `-10004` (not enough on its own) |
| The same counts **outside** any sandbox | work (8 calendars, 1 reminders list, 1 notes account, 2 contact groups on the tested Mac) |

Reproduce a row, for example the last two:

```sh
osascript -e 'tell application id "com.apple.iCal" to count calendars'                       # 8
sandbox-exec -p '(version 1)(allow default)' osascript -e 'tell application id "com.apple.iCal" to count calendars'   # -10004
node scripts/sandbox-smoke.mjs calendar --apple-events -- calendars                           # SANDBOX_REFUSED
```

## What it means for Latch

`plow_run_command` cannot be the transport for these four apps. The ways out that this evidence supports:

1. **Let a plugin opt out of the sandbox for Apple Events**, the way `plow_run_applescript` already does (outside the sandbox, approved per call, the script and its `args` shown to the approver). For example a manifest field that runs `exec.argv` unsandboxed under the same approval, with `apple_events` implied. The plugins here would then work as they are: the CLI, the allowlist and the guards do not depend on the sandbox.
2. **Ship them as skills for `plow_run_applescript`** instead of plugins: AppleScript recipes with `on run argv`, no CLI. The CLI's safety work (strict argument checks, locked-note guard, `--expect-title`, coverage reporting) would have to be rewritten as recipe text and loses its tests.
3. **A helper binary that carries the `com.apple.security.temporary-exception.apple-events` entitlement**, in place of `/usr/bin/osascript`, as the plugin's own runtime. **Tested, and it works** (macOS 26.2, arm64, counts only): see [`../experiments/osa-helper`](../experiments/osa-helper). The helper is 50 lines of Swift, ad-hoc signed with that one entitlement, runs JXA through OSAKit, and reads all four apps from inside the replica of Latch's sandbox, while the identical unentitled build gets `-10004`. It would keep this repo's CLI, allowlist and guards unchanged (only the adapter's `spawn` target changes). Open points: an x86_64 build and a signed/notarised one were not tried; the behaviour is undocumented and may change across macOS releases; the binary has to be distributed (it is about 50 KB, so `runtime.binaries` could point at a file in this repo, or a postinstall hook could compile it where the Command Line Tools exist); and the helper must only run the scripts it ships, because with that entitlement anything that can start it can drive the four apps from inside the sandbox.

Until one of these exists, a call through Latch returns `SANDBOX_REFUSED` (exit 3), the skills say so, and tell the agent to ask the owner about `plow_run_applescript`. Option 3 is the one that keeps the plugins as they are, and it is the one that has now been shown to work.
