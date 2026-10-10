# Architecture

## Choice: reuse the native 9-tool runtime, add rules + helpers

`computer-use-pro` introduces no new input driver. All desktop interaction
goes through the installed `open-computer-use` 1.0.0 native runtime, either
as OpenCode MCP tools (`list_apps`, `get_app_state`, `click`,
`perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`,
`set_value`) or as the equivalent `ocu call` / `ocu js` CLI surface backed
by `dist/windows/amd64/open-computer-use.exe` (UI Automation + Win32 message
fallbacks + screenshot capture).

Rationale:

- Writing a parallel SendInput/UIA driver would duplicate a tested runtime,
  widen the trusted input surface, and need admin-adjacent privileges for no
  measured gain: the native path already delivers verified physical keyboard
  input (ASCII + Unicode `é中`), element/coordinate clicks, `set_value`, and
  `ScrollViewer` scrolling (proven by screenshot diff).
- What the native layer lacks (app launching, Windows-key delivery,
  clipboard) cannot be fixed from a skill: `Get-VirtualKey` has no Windows-key
  mapping, and there is no clipboard tool in the MCP surface or the `cua` JS
  API. Those are documented as limitations with approved alternatives, not
  papered over.
- Two accepted-but-inert behaviors are characterized as tripwire tests, not
  claimed as capabilities: `press_key` effects (caret never moves) and
  drag/double-click selection (nothing selected). If a future runtime starts
  driving them, the tripwires fail and the docs get re-verified instead of
  silently going stale.

## Components

- `SKILL.md` — the operating contract: mandatory observe→act→verify cycle,
  precondition checks, bounded retries (stale-state only), honest error
  reporting, supervised safety. This is where reliability comes from; the
  earlier smoke-test failures were mostly cycle violations (acting without a
  fresh `get_app_state`, typing into unfocused controls).
- `lib/keys.mjs` — empirical key-support table. Windows-key names were
  probed (`super`, `Win`, `LWin`, `Super_L`, `Meta`, `cmd`, `windows`,
  `LeftWin`: all `Unsupported key`) and are failed fast with a documented
  cause instead of sent to the runtime.
- `lib/cycle.mjs` — `runCycle` (observe/check/act/verify, timeouts, bounded
  retries), `isStaleStateError` (retry with fresh observation),
  `isHardDenial` (never retry). Pure logic, unit-tested with mocks.
- `lib/safety.mjs` — `classifyAction` (confirm-required vs supervised),
  `redactSecrets` (log hygiene), `assertClipboardProbeAllowed` (clipboard
  restricted to disposable probe strings).
- `scripts/launch-notepad.ps1` — approved launcher, confined to `%TEMP%`,
  returns `{pid, title, file}`. Replaces Start-menu/Windows-key launching,
  which the runtime cannot do.
- `scripts/focus-window.ps1` — foregrounds only automation-owned Notepad
  pids (coordinate drag/scroll need a visible window).

## Trade-offs

- Notepad as the test vehicle: boring, scriptable, UIA-clean. Win11 tab
  restore is the main hazard; contained by opening an explicit disposable
  file and aborting when unrelated visible Notepad windows exist. Content
  size re-lays out the tree (document element `2` → `6` once scrollable),
  which is why the suite derives every index from fresh state instead of
  hardcoding them.
- `ocu js` batching over many small `ocu call`s: one process reuses the
  element-index mapping and halves round trips; each batch still ends with a
  state read whose postcondition is asserted.
- No global-pointer mode: Windows supports `app_post` through HWND messages
  (no pointer movement, no focus theft) and rejects `sky_click`/`global`.
  Drags that need a window-server drag session may visibly no-op; the skill
  requires outcome verification so a silent no-op can never read as success.
- Screenshots ride along with `get_app_state`; tree-only results (minimized /
  cloaked / covered windows) are reported honestly, never synthesized.

## Deliberately not built

- Custom SendInput/keybd_event driver — unjustified while native typing is
  verified; would weaken the security boundary for no capability gain.
- Windows-key support — impossible from this layer (native key map); the
  skill fails fast with the cause and offers the launcher instead.
- Clipboard reading — no native tool; OS clipboard is probe-strings-only by
  policy, with `BLOCKED` as the default report.

## Addendum: genuine input backend

`scripts/send-input.ps1` (see `INPUT-BACKEND.md`) was added after source
inspection of the native `runtime.ps1` proved every mouse/keyboard path is a
fire-and-forget `PostMessage` with discarded returns. It uses real
`SendInput` for movement, drags (guaranteed release), clicks, chords, and
Unicode typing, plus the `move_cursor_smoothly` engine
(line/quadratic/cubic; `linear`/`ease_in_out`/`ease_out`). Supervised
desktop tests have since verified movement endpoints, sampled smoothness,
Paint drags, and release guarantees; keyboard text entry against a focused
control remains unproven (see test reports under `test-results/`).

## Addendum: evidence management

`scripts/capture-evidence.ps1` reuses the native screenshot source
(`ocu js` `getScreenshot`, the same bytes `get_app_state` returns) and
adds retention semantics the native layer lacks: `keep` / `temporary` /
`auto` / `discard` modes, SHA-256 duplicate detection, an append-safe
`artifacts/index.json`, and a deletion guard that only permits removing
files under owned temporary zones. `artifacts/` and `test-results/` are
local-only Git-ignored state; nothing retained there is committed.
