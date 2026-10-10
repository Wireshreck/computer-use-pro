# Smoke-test procedure (repeatable, Tests A–H)

Prerequisites: logged-in Windows desktop session, `ocu` on PATH, Node 18+,
no visible Notepad windows with unsaved work (the test aborts otherwise to
protect them). Everything runs against a disposable `%TEMP%\cup-probe\*.txt`
window that is closed and deleted afterwards.

```powershell
cd $env:USERPROFILE\.config\opencode\skills\computer-use-pro
npm test                                   # mocked unit tests
$env:CUP_REAL=1; npm run test:integration  # real desktop test
```

## What each test proves

| # | Step | Pass criterion |
|---|---|---|
| A | Discovery + observation | This skill loads globally (OpenCode lists `computer-use-pro`); `getScreenshot` returns >10 KB of real bytes; bound pid equals the automation-owned pid |
| B | Application targeting | State header shows the owned `cup-case-*.txt - Notepad` window (pid + title match the launcher output) |
| C | Keyboard | `click` focuses the document; `type_text` writes ASCII + Unicode (`é中`) verbatim into `Value:`; `press_key` acceptance without caret effect is characterized as a tripwire (`AB`+`Left`+`X` → `ABX`) |
| D | Mouse | `scroll` on the `ScrollViewer` moves the viewport (screenshot-hash proof); coordinate click focuses without placing the caret, double-click selects no word, and drag selects nothing — all characterized as tripwires so a runtime change fails loudly |
| E | UI Automation | `set_value` on the freshly derived document index reads back exactly (indexes are re-derived because the tree re-lays out: document `2` → `6` once scrollable) |
| F | Clipboard | App binding exposes no clipboard member (`hasClip=no` → native support **BLOCKED**); OS `Forms.Clipboard` round-trips only the disposable `cup-probe-…` string |
| G | Recovery | `NoSuchAppXYZ123` → `appNotFound`; element `9999` → `unknown element_index`; `super` → `Unsupported key: super`. No retries, no target switching |
| H | Cleanup | Only the owned pid is `taskkill`ed; temp file deleted; before/after process lists identical except the owned pid |

## Manual spot-checks (optional)

- `ocu call list_apps` — inventory before acting.
- `scripts/launch-notepad.ps1` with a path outside `%TEMP%` — must refuse.
- `press_key` with `super`/`Win` — must return `Unsupported key`, never open Start.
- Cover the test Notepad with another window, then scroll — must fail with
  `No usable screenshot coordinates`, then succeed after
  `scripts/focus-window.ps1 -Pid <owned pid>` + fresh `get_app_state`.

Record mocked (unit) and real (integration) results separately; never claim a
capability whose postcondition was not observed.
