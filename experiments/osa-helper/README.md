# osa-helper: a proof of concept, not a plugin runtime

A 50-line Swift program that does what `osascript -l JavaScript` does (compile a script, call its `run(argv)`, print the result) but through OSAKit, signed with **one** entitlement: `com.apple.security.temporary-exception.apple-events`, listing the four apps. It exists to answer one question: does a sandboxed process that carries that entitlement get past the `-10004` that Contacts, Reminders, Notes and Calendar give to every other sandboxed sender? See [`../../docs/sandbox-findings.md`](../../docs/sandbox-findings.md).

**It does.** Build, sign (ad-hoc, no Developer ID needed) and try it; every command below asks only for counts:

```sh
cd experiments/osa-helper
swiftc -O osa.swift -o osa                      # Command Line Tools are enough
cp osa osa_entitled
codesign --force -s - --entitlements entitlements.plist osa_entitled

JXA='function run(argv){ return JSON.stringify({argv: argv, calendars: Application("com.apple.iCal").calendars().length}); }'

# the same sandbox profile Latch uses, Apple Events allowed (see scripts/sandbox-smoke.mjs)
node ../../scripts/sandbox-smoke.mjs calendar --apple-events --raw -- "$PWD/osa" JavaScript "$JXA"           # {"argv":[],"calendars":"ERR -10004"}
node ../../scripts/sandbox-smoke.mjs calendar --apple-events --raw -- "$PWD/osa_entitled" JavaScript "$JXA" 'a"b$c'  # {"argv":["a\"b$c"],"calendars":"8"}
```

What was checked (macOS 26.2, arm64, counts only): the entitled helper reads all four apps inside the replica of Latch's profile and inside `(allow default)`, with argv values (quotes, `$`) arriving intact; the unentitled build of the same program gets `-10004` from all four. `automation.apple-events` on its own, with or without hardened runtime, did **not** help; the temporary-exception key is what flipped it.

**Not checked:** an x86_64 build (arm64 only was run), a Developer-ID-signed or notarised build, how long this undocumented behaviour of the entitlement lasts across macOS releases, and any of it inside Latch itself.

**Before this could be a runtime**, it must not be a generic script runner: with that entitlement, anything that can start it can drive these four apps from inside the sandbox. A real helper would run only scripts it ships (checked against a compiled-in hash), never source handed to it on the command line.
