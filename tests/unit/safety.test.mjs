import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction, redactSecrets, assertClipboardProbeAllowed } from '../../lib/safety.mjs';

describe('safety: classification, redaction, clipboard guard (mocked)', () => {
  it('requires confirmation for destructive / externally visible actions', () => {
    for (const a of ['delete temp file', 'send message', 'taskkill /PID 1', 'approve prompt', 'publish password reset']) {
      assert.equal(classifyAction(a), 'confirm-required', a);
    }
  });

  it('treats ordinary reads and edits as supervised', () => {
    for (const a of ['capture screenshot', 'click element 2', 'type probe text', 'list apps']) {
      assert.equal(classifyAction(a), 'supervised', a);
    }
  });

  it('redacts secrets from log lines', () => {
    assert.equal(redactSecrets('api_key=abc123 rest'), 'api_key=[REDACTED] rest');
    assert.equal(redactSecrets('token gho_xyz789 ok'), 'token gho_[REDACTED] ok');
    assert.equal(redactSecrets('plain probe line'), 'plain probe line');
  });

  it('allows clipboard only for disposable probe strings', () => {
    const ok = assertClipboardProbeAllowed({ purpose: 'cup-TestD copy probe', probeText: 'cup-probe-123' });
    assert.equal(ok.probeText, 'cup-probe-123');
    assert.throws(
      () => assertClipboardProbeAllowed({ purpose: 'read user data', probeText: 'cup-probe-123' }),
      /disposable probe/,
    );
    assert.throws(
      () => assertClipboardProbeAllowed({ purpose: 'cup-TestD probe', probeText: 'real user content here' }),
      /disposable probe/,
    );
    assert.throws(() => assertClipboardProbeAllowed({ purpose: 'cup-TestD probe', probeText: '' }), /probe string/);
  });
});
