// Supervised-operation helpers: action classification and log redaction.
// Pure functions so they are unit-testable without desktop access.

/** Actions that must ask the user first (destructive / externally visible). */
const CONFIRM_PATTERNS = [
  /delete/i,
  /remove/i,
  /send/i,
  /submit/i,
  /purchase/i,
  /buy/i,
  /pay/i,
  /upload/i,
  /approve/i,
  /kill/i,
  /taskkill/i,
  /stop-process/i,
  /shutdown/i,
  /restart/i,
  /format/i,
  /password/i,
  /credential/i,
  /token/i,
];

/**
 * Classify a planned action.
 * @returns {'confirm-required'|'supervised'}
 * 'supervised' still means: report what you did; stop on surprise.
 */
export function classifyAction(description) {
  const text = String(description ?? '');
  if (CONFIRM_PATTERNS.some((re) => re.test(text))) return 'confirm-required';
  return 'supervised';
}

/** Redact likely secrets from diagnostic log lines. */
export function redactSecrets(line) {
  return String(line ?? '')
    .replace(/(password|passwd|pwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/gho_[A-Za-z0-9_]+/g, 'gho_[REDACTED]')
    .replace(/ghp_[A-Za-z0-9_]+/g, 'ghp_[REDACTED]');
}

/**
 * Clipboard guard: there is no native clipboard tool in the 9-tool surface.
 * OS-level clipboard access (System.Windows.Forms) is allowed ONLY for a
 * caller-supplied disposable probe string, and must never dump whatever the
 * user already has in the clipboard. This helper validates the contract.
 * @throws when the request would read unrelated clipboard content.
 */
export function assertClipboardProbeAllowed({ purpose, probeText, readBack }) {
  if (typeof probeText !== 'string' || probeText.length === 0 || probeText.length > 200) {
    throw new Error('clipboard use requires a caller-supplied disposable probe string (1-200 chars)');
  }
  if (!/probe|cup-|test/i.test(purpose ?? '') || !/probe|cup-|test/i.test(probeText)) {
    throw new Error('clipboard use is limited to disposable probe strings; refusing to handle unrelated content');
  }
  return { purpose, probeText, readBack: readBack !== false };
}
