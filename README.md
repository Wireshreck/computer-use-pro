# computer-use-pro

Global OpenCode skill for supervised Windows desktop automation: screen
observation, window management, mouse, keyboard, and UI Automation — with
verified postconditions, bounded recovery, and a strict permission model.

Installed globally at `%USERPROFILE%\.config\opencode\skills\computer-use-pro`,
so it is discoverable across projects and new conversations. In a fresh chat,
invoke it explicitly (`Use the computer-use-pro skill to …`) or describe a
Windows GUI task and let OpenCode match it by description.

- Skill instructions: [`SKILL.md`](SKILL.md)
- Architecture and API trade-offs: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Repeatable smoke-test procedure: [`SMOKE-TEST.md`](SMOKE-TEST.md)

## Layout

```text
SKILL.md                    skill definition + operating rules
lib/keys.mjs                probed Windows key-support table
lib/cycle.mjs               observe → act → verify with bounded retries
lib/safety.mjs              action classification, secret redaction, clipboard guard
scripts/launch-notepad.ps1  approved disposable-window launcher (TEMP-confined)
scripts/focus-window.ps1    foreground helper for automation-owned windows
tests/unit/                 mocked unit tests (node:test, no desktop)
tests/integration/          real desktop test, gated by CUP_REAL=1
```

## Requirements

- Windows 10/11 with a logged-in desktop session
- Node.js 18+ (`node --test` runs the suites; no dependencies to install)
- `open-computer-use` 1.0.0+ (`ocu` on PATH) with MCP configured in OpenCode
- PowerShell 5.1+ (ships with Windows)

## Running tests

```powershell
npm test                     # mocked unit tests, no desktop touched
$env:CUP_REAL=1; npm run test:integration   # real disposable-Notepad test
```

The integration test aborts if any visible Notepad window it did not create
exists, closes only its own pid, deletes its temp file, and reports native
clipboard support as BLOCKED (no such tool exists).
