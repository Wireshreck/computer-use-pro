# Genuine Windows input backend (`scripts/send-input.ps1`)

## Why it exists

The native `open-computer-use` Windows runtime (`runtime.ps1`, shipped
inside `open-computer-use.exe`) delivers **all** mouse and keyboard input as
fire-and-forget `PostMessage` calls to a window handle:

| Native function | Mechanism | Observed consequence |
|---|---|---|
| `Send-MouseClick` / `Send-Drag` / `Send-Scroll` | `PostMessage` `WM_*BUTTON*`/`WM_MOUSEMOVE`/`WM_WHEEL`, returns discarded | Never moves the visible cursor, never changes focus, never starts a window-server drag session; canvas tools and selections ignore it |
| `Send-Text` | `PostMessage` `WM_CHAR` per character | Works only if the right child window already has keyboard context; many apps need real key processing first |
| `Send-Key` | `PostMessage` `WM_KEYDOWN`/`WM_KEYUP`, no `try/finally` | Ignored by hooks/accelerators/menus; modifiers can stick on error; `Get-VirtualKey` has no main-key mapping for the Windows key |
| `Invoke-TypeText` | `EM_SETSEL`/`EM_REPLACESEL`/`WM_SETTEXT` on a guessed edit HWND, else UIA `ValuePattern` (disabled by default) | The exact historical `type_text` failure modes |

`SendInput` appears **nowhere** in the native binary's imports. Success is
reported whenever the messages are posted, whether or not the application
visibly changed. This module is the smallest robust fix that fits inside the
skill layer: real `SendInput` delivery with verified focus, guaranteed
button/key release, explicit rejections, and a reusable smooth-movement
engine that the native `drag` (fixed 12 steps / 20 ms, no release guarantee)
cannot provide.

## Tool surface (JSON in / JSON out, exit 0 on transport)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/send-input.ps1 `
  -Action <move|drag|click|key|type> -ParamsJson '<json>' [-TimeoutMs 120000]
```

Every call prints exactly one JSON object: `{"ok":true, ...}` or
`{"ok":false,"action":"...","error":"..."}`. Physical input and
accessibility stay strictly separated: this module never calls UIA patterns,
and native `set_value`/semantic clicks remain the route for controls.

Common fields: `expect_hwnd` (verify foreground after input; informational),
`require_focus: true` (refuse instead of sending blind on mismatch).

## `move_cursor_smoothly` (the `move` action)

Parameters (`ParamsJson`):

| Field | Meaning |
|---|---|
| `end` | **[x, y] destination (required)**, virtual-screen pixels |
| `start` | Optional start; defaults to the live cursor position |
| `path` | `line` (default), `quadratic`, or `cubic` |
| `control_points` | `[[x,y]]` for quadratic, `[[x1,y1],[x2,y2]]` for cubic; forbidden for lines |
| `duration_ms` | 1..60000 (default 500) |
| `easing` | `linear`, `ease_in_out` (default), `ease_out` |
| `steps` | 2..2000; default targets ~120 events/s, clamped to 2..240 |
| `cancel_on_focus_loss` | Default true: abort if the foreground window changes mid-run |

Behavior: monotonic `Stopwatch` scheduling, eased interpolation, duplicate
pixels coalesced, exact landing on `end` (verified and reported), movement
only — never clicks or drags. Out-of-screen coordinates, bad paths, and bad
durations are rejected with explicit errors.

Straight line:

```powershell
.\send-input.ps1 -Action move -ParamsJson '{"end":[960,540],"duration_ms":800,"easing":"ease_in_out"}'
```

Quadratic curve (start, one control point, end):

```powershell
.\send-input.ps1 -Action move -ParamsJson '{"start":[100,100],"end":[900,700],"path":"quadratic","control_points":[[500,100]],"duration_ms":1200,"easing":"ease_out"}'
```

Cubic curve (start, two control points, end):

```powershell
.\send-input.ps1 -Action move -ParamsJson '{"path":"cubic","control_points":[[400,250],[600,550]],"end":[700,400],"duration_ms":1000,"easing":"linear"}'
```

Smooth drag (same engine, left button held, **always released** even on
cancel/error):

```powershell
.\send-input.ps1 -Action drag -ParamsJson '{"start":[300,400],"end":[700,400],"control_points":[[400,250],[600,550]],"duration_ms":1000,"button":"left"}'
```

## Supporting actions (same guarantees)

- `click`: moves the real cursor (optional `x`,`y`), physical down/up via
  `SendInput`, 1..4 `click_count`, left/right/middle. Use for canvas-level
  clicks the posted-message path cannot drive; prefer native semantic clicks
  for real controls.
- `key`: genuine down/up with modifiers held across the chord and released
  in `finally`; unknown names rejected (Windows keys mapped: `lwin`/`rwin` —
  backend support is not permission; skill policy still forbids unsupervised
  use).
- `type`: layout-independent Unicode typing (`KEYEVENTF_UNICODE`); control
  characters rejected (use `key`).
- `scroll`: genuine wheel clicks at the real cursor position (optional
  `x`,`y` positioning first), `direction` up/down/left/right, `amount` 1–20
  notches paced 30 ms apart, `require_focus` refusal supported. This
  replaces the native posted-`WM_MOUSEWHEEL` path, which is a no-op on
  windows that never see real input. Verify by viewport change (screenshot
  diff), never by `ok` alone.

## Invocation from the agent

The native MCP surface cannot register new tools, so this is a reusable
helper invoked through the existing shell/`execute` path — the same
sanctioned class as `scripts/launch-notepad.ps1`. Typical cycle: fresh
`get_app_state` → derive target from live `Frame:` → `send-input.ps1`
physical action → fresh observation → verify the visible postcondition.
Absence of an error is still not proof; screenshot-compare like the native
layer cannot do. For durable before/after proof, capture both ends with
`scripts/capture-evidence.ps1` (`keep` the pair as evidence).

## Limitations (unvalidated — no applications were run for this task)

- Real input goes to whatever owns the cursor/focus: verify `expect_hwnd`
  with `require_focus` for consequential moves; the module never steals
  focus itself (no `SetForegroundWindow`).
- Secure desktop (UAC prompts, logon screens) is unreachable by design.
- Integrity-level (UIPI) rules apply: a medium-integrity caller cannot drive
  elevated windows — reported as delivery failure, not success.
- First run compiles the embedded C# P/Invoke (~1 s); subsequent calls in
  the same process reuse it.
