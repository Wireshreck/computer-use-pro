#Requires -Version 5.1
<#
.SYNOPSIS
  Genuine Windows input backend for computer-use-pro (SendInput-based).
.DESCRIPTION
  The native open-computer-use Windows runtime (runtime.ps1) delivers ALL
  mouse and keyboard input as fire-and-forget PostMessage calls to a window
  handle: Send-MouseClick, Send-Drag, Send-Scroll, Send-Text (WM_CHAR) and
  Send-Key (WM_KEYDOWN/WM_KEYUP). Posted messages bypass the real input
  system, so they never move the visible cursor, never change focus, never
  start a window-server drag session, and are ignored by any app that reads
  real input state (hooks, accelerators, menus, canvas tools). Return values
  are discarded ([void]), so success is reported even when nothing happened.

  This module is the smallest robust architectural fix that fits inside the
  skill layer: it drives the REAL input system with user32 SendInput, which
  moves the visible cursor, carries button state through the window server
  (real drag sessions), and delivers keys through normal keyboard processing.

  Physical input vs accessibility (strictly separated here, as everywhere in
  this skill):
    - SendInput mouse/keyboard = physical-style input (this module).
    - UIA ValuePattern.SetValue / InvokePattern.Invoke = accessibility
      operations (native set_value / click tasks). Never confused.

  SAFETY: nothing here elevates privileges, bypasses UAC/secure-desktop, or
  dismisses consequential dialogs. Focus is VERIFIED (GetForegroundWindow),
  never merely claimed. Buttons/keys are always released (try/finally).

  JSON interface (for agents / ocu js / shell):
    powershell -NoProfile -ExecutionPolicy Bypass -File send-input.ps1 `
      -Action move -ParamsJson '{"end":[960,540],"duration_ms":800,"easing":"ease_in_out"}'
    Actions: move | drag | click | key | type | scroll
    Every invocation prints one JSON object: {"ok":true,...} or
    {"ok":false,"error":"..."} and exits 0 (transport) unless -Action itself
    is malformed (exit 2).
.EXAMPLE
  # Straight smooth move, 800 ms
  .\send-input.ps1 -Action move -ParamsJson '{"end":[960,540],"duration_ms":800,"easing":"ease_in_out"}'
.EXAMPLE
  # Quadratic Bezier: start -> control -> end
  .\send-input.ps1 -Action move -ParamsJson '{"start":[100,100],"end":[900,700],"control_points":[[500,100]],"duration_ms":1200,"easing":"ease_out"}'
.EXAMPLE
  # Cubic Bezier drag (holds left button along the curve, always releases)
  .\send-input.ps1 -Action drag -ParamsJson '{"start":[300,400],"end":[700,400],"control_points":[[400,250],[600,550]],"duration_ms":1000,"button":"left"}'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('move', 'drag', 'click', 'key', 'type', 'scroll')]
  [string]$Action,
  [Parameter(Mandatory = $false)]
  [string]$ParamsJson = '{}',
  [Parameter(Mandatory = $false)]
  [int]$TimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CupSendInput {
    // NOTE: pInputs is IntPtr, not INPUT[]. PowerShell cannot populate
    // explicit-layout union structs through property assignment (writes are
    // silently lost), so callers build the 40-byte INPUT in unmanaged memory
    // with Marshal.Write* and pass its pointer. Offsets below assume x64:
    // type@0 u32; mouse: dx@8 i32, dy@12 i32, data@16 u32, flags@20 u32,
    // time@24 u32, extra@32 ptr; keybd: vk@8 u16, scan@10 u16, flags@12 u32,
    // time@16 u32, extra@24 ptr.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, IntPtr pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public const int INPUT_SIZE = 40;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;
}
"@

$MOUSE_BUTTONS = @{
  left   = @{ down = 0x0002; up = 0x0004 }
  right  = @{ down = 0x0008; up = 0x0010 }
  middle = @{ down = 0x0020; up = 0x0040 }
}
# Wheel flags for SendInput (MOUSEEVENTF_WHEEL/HWHEEL); mouseData carries the
# signed delta in WHEEL_DELTA (120) units. Unlike the native runtime's posted
# WM_MOUSEWHEEL to a guessed HWND, these travel through the real input queue
# at the CURRENT cursor position, so the window under the cursor scrolls.
$MOUSE_WHEEL = 0x0800
$MOUSE_HWHEEL = 0x1000
$WHEEL_DELTA = 120

# Virtual-key map. Includes LWIN/RWIN (absent from the native runtime map);
# skill POLICY still forbids unsupervised Windows-key presses — backend
# support must not be confused with permission to use it.
$VK_MAP = @{
  backspace = 0x08; tab = 0x09; return = 0x0D; enter = 0x0D; escape = 0x1B; esc = 0x1B
  space = 0x20; end = 0x23; home = 0x24; left = 0x25; up = 0x26; right = 0x27; down = 0x28
  insert = 0x2D; delete = 0x2E; lwin = 0x5B; rwin = 0x5C; win = 0x5B; super = 0x5B
  f1 = 0x70; f2 = 0x71; f3 = 0x72; f4 = 0x73; f5 = 0x74; f6 = 0x75
  f7 = 0x76; f8 = 0x77; f9 = 0x78; f10 = 0x79; f11 = 0x7A; f12 = 0x7B
  shift = 0x10; ctrl = 0x11; control = 0x11; alt = 0x12
  page_up = 0x21; prior = 0x21; page_down = 0x22; next = 0x22
}
$VK_EXTENDED = @(0x25, 0x26, 0x27, 0x28, 0x23, 0x24, 0x21, 0x22, 0x2D, 0x2E, 0x5B, 0x5C)

function Get-VirtualScreen {
  [pscustomobject]@{
    x      = [CupSendInput]::GetSystemMetrics(76)
    y      = [CupSendInput]::GetSystemMetrics(77)
    width  = [CupSendInput]::GetSystemMetrics(78)
    height = [CupSendInput]::GetSystemMetrics(79)
  }
}

function Assert-OnVirtualScreen([int]$x, [int]$y) {
  $vs = Get-VirtualScreen
  if ($x -lt $vs.x -or $x -gt ($vs.x + $vs.width - 1) -or
      $y -lt $vs.y -or $y -gt ($vs.y + $vs.height - 1)) {
    throw "coordinates [$x,$y] are outside the virtual screen ($($vs.x),$($vs.y) $($vs.width)x$($vs.height)); refusing to move there"
  }
}

function Get-CursorPosition {
  $pt = New-Object CupSendInput+POINT
  if (-not [CupSendInput]::GetCursorPos([ref]$pt)) { throw 'GetCursorPos failed' }
  return @($pt.X, $pt.Y)
}

$script:CupInputSize = 40
function New-InputBuffer([uint32]$type) {
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($script:CupInputSize)
  for ($i = 0; $i -lt $script:CupInputSize; $i++) {
    [Runtime.InteropServices.Marshal]::WriteByte($ptr, $i, 0)
  }
  [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 0, [int]$type)
  # Return as PSObject-note: callers must Free-InputBuffer in finally.
  return $ptr
}

function Free-InputBuffer([IntPtr]$ptr) {
  if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
}

function Send-BufferedInput([IntPtr]$ptr, [string]$what) {
  $sent = [CupSendInput]::SendInput(1, $ptr, $script:CupInputSize)
  if ($sent -ne 1) { throw "SendInput delivered $sent/1 $what events" }
}

function Send-MouseInput([uint32]$flags) {
  $ptr = New-InputBuffer 0
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 20, [int]$flags)
    Send-BufferedInput $ptr 'mouse'
  } finally {
    Free-InputBuffer $ptr
  }
}

function Move-CursorAbsolute([int]$x, [int]$y) {
  Assert-OnVirtualScreen $x $y
  # Managed cursor placement: exact virtual-screen pixels, no 0..65535
  # normalization rounding. This moves the REAL cursor (unlike posted mouse
  # messages), so drag sessions and hover/focus behave genuinely.
  [Windows.Forms.Cursor]::Position = New-Object Drawing.Point($x, $y)
}

function Get-ForegroundHwnd { return [CupSendInput]::GetForegroundWindow() }

function Send-KeyEvent([int]$vk, [bool]$keyUp) {
  $flags = 0
  if ($VK_EXTENDED -contains $vk) { $flags = $flags -bor 0x0001 }
  if ($keyUp) { $flags = $flags -bor 0x0002 }
  $scan = [uint16][CupSendInput]::MapVirtualKey([uint32]$vk, 0)
  $ptr = New-InputBuffer 1
  try {
    [Runtime.InteropServices.Marshal]::WriteInt16($ptr, 8, [int16]$vk)
    [Runtime.InteropServices.Marshal]::WriteInt16($ptr, 10, [int16]$scan)
    [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 12, [int]$flags)
    Send-BufferedInput $ptr ("keyboard vk=0x" + $vk.ToString('X2'))
  } finally {
    Free-InputBuffer $ptr
  }
}

function Resolve-VirtualKey([string]$name) {
  $n = $name.ToLowerInvariant()
  if ($VK_MAP.ContainsKey($n)) { return [int]$VK_MAP[$n] }
  if ($n -match '^f([1-9]|1[0-2])$') { return 0x70 + [int]$Matches[1] - 1 }
  if ($n.Length -eq 1) {
    $code = [int][char]$n.ToUpperInvariant()[0]
    if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
  }
  throw "Unsupported key: $name (no virtual-key mapping; refusing to pretend it worked)"
}

function Invoke-Easing([string]$mode, [double]$t) {
  switch ($mode) {
    'linear' { return $t }
    'ease_out' { $u = 1.0 - $t; return 1.0 - $u * $u * $u }
    'ease_in_out' { return 0.5 - 0.5 * [math]::Cos([math]::PI * $t) }
    default { throw "unknown easing '$mode' (expected linear|ease_in_out|ease_out)" }
  }
}

function Get-PathPoint($spec, [double]$t) {
  # NOTE: multi-element array literals with computed elements (e.g.
  # @($a + $b * $t, $c)) miscompile inside PowerShell `switch` branches on
  # this platform (bogus op_Addition/op_Multiply on Object[]), so the path
  # kinds use if/elseif and each coordinate is computed before packing.
  if ($t -lt 0) { $t = 0 }
  if ($t -gt 1) { $t = 1 }
  $s = $spec.start; $e = $spec.end
  if ($spec.kind -eq 'line') {
    $px = $s[0] + ($e[0] - $s[0]) * $t
    $py = $s[1] + ($e[1] - $s[1]) * $t
    $pt = @([double]$px, [double]$py)
    return $pt
  } elseif ($spec.kind -eq 'quadratic') {
    $c = $spec.control; $u = 1.0 - $t
    $px = $u * $u * $s[0] + 2 * $u * $t * $c[0] + $t * $t * $e[0]
    $py = $u * $u * $s[1] + 2 * $u * $t * $c[1] + $t * $t * $e[1]
    $pt = @([double]$px, [double]$py)
    return $pt
  } elseif ($spec.kind -eq 'cubic') {
    $c1 = $spec.control1; $c2 = $spec.control2; $u = 1.0 - $t
    $px = $u * $u * $u * $s[0] + 3 * $u * $u * $t * $c1[0] + 3 * $u * $t * $t * $c2[0] + $t * $t * $t * $e[0]
    $py = $u * $u * $u * $s[1] + 3 * $u * $u * $t * $c1[1] + 3 * $u * $t * $t * $c2[1] + $t * $t * $t * $e[1]
    $pt = @([double]$px, [double]$py)
    return $pt
  } else {
    throw "unknown path kind '$($spec.kind)'"
  }
}

function Resolve-MoveSpec($p) {
  # Validates user input into a normalized move spec. Rejects malformed
  # paths, negative durations, and unreasonable step counts with explicit
  # errors instead of misbehaving.
  if ($null -eq $p.end -or $p.end.Count -ne 2) { throw "move requires 'end': [x, y]" }
  $end = @([int]$p.end[0], [int]$p.end[1])
  Assert-OnVirtualScreen $end[0] $end[1]
  $start = if ($null -ne $p.start) { @([int]$p.start[0], [int]$p.start[1]) } else { Get-CursorPosition }
  Assert-OnVirtualScreen $start[0] $start[1]

  $duration = if ($null -ne $p.duration_ms) { [int]$p.duration_ms } else { 500 }
  if ($duration -le 0 -or $duration -gt 60000) { throw "'duration_ms' must be within 1..60000 (got $duration)" }
  $easing = if ([string]::IsNullOrWhiteSpace($p.easing)) { 'ease_in_out' } else { $p.easing.ToLowerInvariant() }
  if (@('linear', 'ease_in_out', 'ease_out') -notcontains $easing) { throw "unknown easing '$($p.easing)'" }

  # Default step budget targets ~120 events/sec, clamped to a sane range so
  # the run can neither spam the input queue nor visibly jump.
  $steps = if ($null -ne $p.steps) { [int]$p.steps } else { [math]::Min(240, [math]::Max(2, [int][math]::Ceiling($duration / 8.0))) }
  if ($steps -lt 2 -or $steps -gt 2000) { throw "'steps' must be within 2..2000 (got $steps)" }

  $kind = if ([string]::IsNullOrWhiteSpace($p.path)) { 'line' } else { $p.path.ToLowerInvariant() }
  $spec = @{ kind = $kind; start = $start; end = $end }
  $cps = @()
  if ($null -ne $p.control_points) { foreach ($c in $p.control_points) { $cps += ,@([int]$c[0], [int]$c[1]) } }
  switch ($kind) {
    'line' { if ($cps.Count -ne 0) { throw "'path: line' takes no control_points" } }
    'quadratic' {
      if ($cps.Count -ne 1) { throw "'path: quadratic' needs exactly 1 control point" }
      $spec.control = $cps[0]; Assert-OnVirtualScreen $cps[0][0] $cps[0][1]
    }
    'cubic' {
      if ($cps.Count -ne 2) { throw "'path: cubic' needs exactly 2 control points" }
      $spec.control1 = $cps[0]; $spec.control2 = $cps[1]
      Assert-OnVirtualScreen $cps[0][0] $cps[0][1]; Assert-OnVirtualScreen $cps[1][0] $cps[1][1]
    }
    default { throw "unknown 'path' '$($p.path)' (expected line|quadratic|cubic)" }
  }
  $cancelOnFocusLoss = if ($null -ne $p.cancel_on_focus_loss) { [bool]$p.cancel_on_focus_loss } else { $true }
  return @{ spec = $spec; duration = $duration; easing = $easing; steps = $steps; cancelOnFocusLoss = $cancelOnFocusLoss }
}

function Invoke-SmoothCursorMovement($move, [scriptblock]$onStep = $null) {
  # Drives the interpolated path on a monotonic clock (Stopwatch) and lands
  # EXACTLY on the destination. Pure movement: never touches buttons. An
  # optional per-step hook lets drag hold its button (set before the run and
  # released by the caller's finally block — never here).
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $anchorHwnd = Get-ForegroundHwnd
  $last = @(-1, -1)
  try {
    for ($i = 1; $i -le $move.steps; $i++) {
      if ($move.cancelOnFocusLoss -and (Get-ForegroundHwnd) -ne $anchorHwnd) {
        throw "cancelled: foreground window changed mid-movement (cancel_on_focus_loss)"
      }
      $targetMs = $move.duration * $i / $move.steps
      $remaining = $targetMs - $sw.Elapsed.TotalMilliseconds
      if ($remaining -gt 1.5) { Start-Sleep -Milliseconds ([int][math]::Floor($remaining)) }
      $t = [math]::Min(1.0, $sw.Elapsed.TotalMilliseconds / $move.duration)
      $pt = Get-PathPoint $move.spec (Invoke-Easing $move.easing $t)
      $ix = [int][math]::Round($pt[0]); $iy = [int][math]::Round($pt[1])
      if ($ix -ne $last[0] -or $iy -ne $last[1]) {
        Move-CursorAbsolute $ix $iy
        $last = @($ix, $iy)
      }
      if ($null -ne $onStep) { & $onStep $i }
    }
  } finally {
    $sw.Stop()
  }
  # Exact landing: rounding may leave the cursor 1px off, so set the true
  # destination (and verify it — report, don't claim).
  Move-CursorAbsolute $move.spec.end[0] $move.spec.end[1]
  $landed = Get-CursorPosition
  return @{ steps = $move.steps; elapsed_ms = [int]$sw.Elapsed.TotalMilliseconds; landed = $landed }
}

function Invoke-SmoothDrag($move, [string]$button) {
  if (-not $MOUSE_BUTTONS.ContainsKey($button)) { throw "unknown mouse button '$button' (expected left|right|middle)" }
  $flags = $MOUSE_BUTTONS[$button]
  # Start exactly on the path start so the press and the movement agree.
  Move-CursorAbsolute $move.spec.start[0] $move.spec.start[1]
  Start-Sleep -Milliseconds 30
  Send-MouseInput $flags.down
  try {
    return Invoke-SmoothCursorMovement $move
  } finally {
    # Button release is unconditional — cancellation and errors can never
    # leave the button held down.
    Start-Sleep -Milliseconds 20
    Send-MouseInput $flags.up
  }
}

function Invoke-PhysicalClick($p) {
  $button = if ([string]::IsNullOrWhiteSpace($p.button)) { 'left' } else { $p.button.ToLowerInvariant() }
  if (-not $MOUSE_BUTTONS.ContainsKey($button)) { throw "unknown mouse button '$button'" }
  $count = if ($null -ne $p.click_count) { [int]$p.click_count } else { 1 }
  if ($count -lt 1 -or $count -gt 4) { throw "'click_count' must be within 1..4" }
  if ($null -ne $p.x) { Move-CursorAbsolute ([int]$p.x) ([int]$p.y) ; Start-Sleep -Milliseconds 30 }
  $flags = $MOUSE_BUTTONS[$button]
  for ($i = 0; $i -lt $count; $i++) {
    Send-MouseInput $flags.down
    try { Start-Sleep -Milliseconds 40 }
    finally { Send-MouseInput $flags.up }
    if ($i -lt $count - 1) { Start-Sleep -Milliseconds 60 }
  }
  return @{ button = $button; click_count = $count; cursor = (Get-CursorPosition) }
}

function Invoke-PhysicalScroll($p) {
  # Genuine wheel input at the real cursor position. Optionally moves the
  # cursor over the target first (callers derive x/y from a fresh AX Frame).
  # One wheel "click" = one WHEEL_DELTA notch, paced so apps scroll normally
  # instead of receiving a single giant delta.
  $dir = if ([string]::IsNullOrWhiteSpace($p.direction)) { 'down' } else { $p.direction.ToLowerInvariant() }
  if (@('up', 'down', 'left', 'right') -notcontains $dir) { throw "unknown direction '$($p.direction)' (expected up|down|left|right)" }
  $amount = if ($null -ne $p.amount) { [int]$p.amount } else { 3 }
  if ($amount -lt 1 -or $amount -gt 20) { throw "'amount' must be within 1..20 wheel clicks (got $amount)" }
  if ($null -ne $p.x) { Move-CursorAbsolute ([int]$p.x) ([int]$p.y); Start-Sleep -Milliseconds 60 }
  $vertical = ($dir -eq 'up' -or $dir -eq 'down')
  $flags = if ($vertical) { $MOUSE_WHEEL } else { $MOUSE_HWHEEL }
  # Windows sign convention: wheel-up and wheel-right are positive.
  $sign = if ($dir -eq 'up' -or $dir -eq 'right') { 1 } else { -1 }
  for ($i = 0; $i -lt $amount; $i++) {
    $ptr = New-InputBuffer 0
    try {
      [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 16, [int]($sign * $WHEEL_DELTA))
      [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 20, [int]$flags)
      Send-BufferedInput $ptr 'wheel'
    } finally {
      Free-InputBuffer $ptr
    }
    if ($i -lt $amount - 1) { Start-Sleep -Milliseconds 30 }
  }
  return @{ direction = $dir; clicks = $amount }
}

function Invoke-PhysicalKeys($p) {
  # Genuine key delivery through the input system (down AND up, modifiers
  # held across the chord, always released). Rejects unknown names instead
  # of pretending they worked.
  if ([string]::IsNullOrWhiteSpace($p.key)) { throw "key action requires 'key'" }
  $names = $p.key -split '\+'
  $vks = @(foreach ($n in $names) { Resolve-VirtualKey $n.Trim() })
  $main = $vks[$vks.Length - 1]
  $mods = @($vks | Select-Object -SkipLast 1)
  $holdMs = if ($null -ne $p.hold_ms) { [int]$p.hold_ms } else { 30 }
  if ($holdMs -lt 0 -or $holdMs -gt 5000) { throw "'hold_ms' must be within 0..5000" }
  foreach ($m in $mods) { Send-KeyEvent $m $false }
  try {
    Send-KeyEvent $main $false
    if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
  } finally {
    try { Send-KeyEvent $main $true } catch {}
    for ($i = $mods.Count - 1; $i -ge 0; $i--) {
      try { Send-KeyEvent $mods[$i] $true } catch {}
    }
  }
  return @{ key = $p.key }
}

function Invoke-PhysicalType($p) {
  # Unicode-aware typing: printable characters go through KEYEVENTF_UNICODE
  # (layout-independent); structural keys are rejected here — use key.
  if ($null -eq $p.text) { throw "type action requires 'text'" }
  $text = [string]$p.text
  if ($text.Length -eq 0 -or $text.Length -gt 4000) { throw "'text' must be 1..4000 characters" }
  foreach ($ch in $text.ToCharArray()) {
    $code = [int]$ch
    if ($code -lt 32 -or $code -eq 127) { throw "type rejects control character U+$($code.ToString('X4')); use the key action" }
    foreach ($wantsUp in @($false, $true)) {
      $flags = 0x0004
      if ($wantsUp) { $flags = $flags -bor 0x0002 }
      $ptr = New-InputBuffer 1
      try {
        [Runtime.InteropServices.Marshal]::WriteInt16($ptr, 8, 0)
        [Runtime.InteropServices.Marshal]::WriteInt16($ptr, 10, [int16]$code)
        [Runtime.InteropServices.Marshal]::WriteInt32($ptr, 12, [int]$flags)
        Send-BufferedInput $ptr 'Unicode'
      } finally {
        Free-InputBuffer $ptr
      }
    }
    Start-Sleep -Milliseconds 4
  }
  return @{ characters = $text.Length }
}

function Assert-ExpectedForeground($p) {
  # Verification only: reports the foreground HWND and whether it matches an
  # expected window. Never claims focus it cannot prove.
  $fg = Get-ForegroundHwnd
  $out = @{ foreground_hwnd = $fg.ToInt64() }
  if ($null -ne $p.expect_hwnd -and $p.expect_hwnd -ne 0) {
    $out.expected_hwnd = [int64]$p.expect_hwnd
    $out.focus_verified = ($fg.ToInt64() -eq [int64]$p.expect_hwnd)
    if (-not $out.focus_verified -and $p.require_focus) {
      throw "focus not verified: foreground=$($fg.ToInt64()) expected=$($p.expect_hwnd) - refusing to send input blind"
    }
  }
  return $out
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
try {
  $p = $ParamsJson | ConvertFrom-Json
  if ((Get-Date).ToUniversalTime() -gt $deadline) { throw 'timed out before starting' }
  switch ($Action) {
    'move' {
      $move = Resolve-MoveSpec $p
      $r = Invoke-SmoothCursorMovement $move
      $result = @{ ok = $true; action = 'move'; end = $move.spec.end; easing = $move.easing } + $r
    }
    'drag' {
      $move = Resolve-MoveSpec $p
      $button = if ([string]::IsNullOrWhiteSpace($p.button)) { 'left' } else { $p.button }
      $r = Invoke-SmoothDrag $move $button
      $result = @{ ok = $true; action = 'drag'; button = $button; end = $move.spec.end } + $r
    }
    'click' {
      $r = Invoke-PhysicalClick $p
      $result = @{ ok = $true; action = 'click' } + $r
    }
    'key' {
      $r = Invoke-PhysicalKeys $p
      $result = @{ ok = $true; action = 'key' } + $r
    }
    'type' {
      $r = Invoke-PhysicalType $p
      $result = @{ ok = $true; action = 'type' } + $r
    }
    'scroll' {
      $r = Invoke-PhysicalScroll $p
      $result = @{ ok = $true; action = 'scroll' } + $r
    }
  }
  if ($null -ne $p.expect_hwnd -and $Action -in @('key', 'type', 'click', 'drag', 'scroll')) {
    # Optional post-action focus attestation (informational; input already
    # went through the real input queue regardless).
    $result.focus = (Assert-ExpectedForeground $p)
  }
  $result | ConvertTo-Json -Compress -Depth 6
} catch {
  @{ ok = $false; action = $Action; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 6
}
