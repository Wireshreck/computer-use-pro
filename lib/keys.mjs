// Windows key-support table for the open-computer-use v1.0.0 native runtime.
//
// Two independent properties, probed on Windows 11 via `ocu js` against
// disposable Notepad windows (see SMOKE-TEST.md). DO NOT conflate them:
//
// - ACCEPTED: press_key returned isError=false. Acceptance is NOT proof of
//   effect: in this runtime version no press_key name produced an observable
//   effect on the test document (characters, arrows, Home/End,
//   Delete/BackSpace, Return, ctrl+a all accepted, none observed to act).
//   Verify the postcondition after every press_key use.
// - UNSUPPORTED: press_key returned "Unsupported key: <name>" from
//   Get-VirtualKey (runtime.ps1). The Windows key has NO accepted name.
// - UNVERIFIED: standard xdotool-style names that were not probed.
//
// Effect-verified keyboard input in this runtime is `type_text` (ASCII and
// Unicode observed to land) and control writes via `set_value`.

export const ACCEPTED = Object.freeze([
  'Return',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'End',
  'Home',
  'Left',
  'Up',
  'F5',
  'a',
  'b',
  'ctrl+a',
  'ctrl+c',
  'alt+Tab',
]);

export const UNSUPPORTED = Object.freeze([
  'super',
  'Win',
  'LWin',
  'RWin',
  'Super_L',
  'Meta',
  'cmd',
  'windows',
  'Windows',
  'LeftWin',
  'RightWin',
]);

export const UNVERIFIED = Object.freeze([
  'Down',
  'Right',
  'Page_Up',
  'Page_Down',
  'Insert',
  'F1',
  'F2',
  'F3',
  'F4',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'ctrl+s',
  'ctrl+f',
  'shift+Tab',
]);

// Backwards-compatible alias: "verified" historically meant "probed OK".
// It describes runtime acceptance, never observed effect.
export const VERIFIED_OK = ACCEPTED;

const UNSUPPORTED_SET = new Set(UNSUPPORTED.map((k) => k.toLowerCase()));
const ACCEPTED_SET = new Set(ACCEPTED.map((k) => k.toLowerCase()));

/**
 * Classify a press_key name before use.
 * @returns {'accepted'|'unsupported'|'unverified'}
 * NOTE: 'accepted' means the runtime takes the key without error. It does
 * not mean the key acted — always verify the postcondition.
 */
export function keySupport(key) {
  if (typeof key !== 'string' || key.length === 0) return 'unverified';
  const k = key.toLowerCase();
  if (UNSUPPORTED_SET.has(k)) return 'unsupported';
  if (ACCEPTED_SET.has(k)) return 'accepted';
  // Chords: supported only if every part is supported.
  if (key.includes('+')) {
    const parts = key.split('+');
    if (parts.some((p) => UNSUPPORTED_SET.has(p.toLowerCase()))) return 'unsupported';
    if (parts.every((p) => ACCEPTED_SET.has(p.toLowerCase()))) return 'accepted';
    return 'unverified';
  }
  return 'unverified';
}

/**
 * Throw a structured error for keys known to be unsupported, so callers
 * fail fast with a documented cause instead of sending a doomed key.
 */
export function assertKeyUsable(key) {
  if (keySupport(key) === 'unsupported') {
    throw new Error(
      `unsupported key "${key}": the Windows native runtime has no mapping ` +
        `for the Windows/Super key (Get-VirtualKey, runtime.ps1). ` +
        `Launch apps with scripts/launch-notepad.ps1 style Start-Process ` +
        `instead; never press the Windows key.`,
    );
  }
  return key;
}
