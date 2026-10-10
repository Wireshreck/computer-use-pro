import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keySupport, assertKeyUsable, VERIFIED_OK, ACCEPTED, UNSUPPORTED } from '../../lib/keys.mjs';

describe('keys: support classification (mocked, no desktop)', () => {
  it('marks runtime-accepted keys as accepted (acceptance is not effect)', () => {
    for (const k of ['Return', 'Escape', 'ctrl+a', 'alt+Tab', 'End', 'a', 'Left']) {
      assert.equal(keySupport(k), 'accepted', k);
    }
  });

  it('marks every Windows-key spelling as unsupported', () => {
    for (const k of UNSUPPORTED) {
      assert.equal(keySupport(k), 'unsupported', k);
    }
    assert.equal(keySupport('SUPER'), 'unsupported');
    assert.equal(keySupport('super+r'), 'unsupported');
  });

  it('marks unknown names as unverified, not accepted', () => {
    assert.equal(keySupport('F12'), 'unverified');
    assert.equal(keySupport('ctrl+q'), 'unverified');
    assert.equal(keySupport(''), 'unverified');
  });

  it('assertKeyUsable throws a documented error for the Windows key', () => {
    assert.throws(() => assertKeyUsable('super'), /unsupported key "super"/);
    assert.equal(assertKeyUsable('Return'), 'Return');
  });

  it('tables are non-empty and disjoint', () => {
    assert.ok(ACCEPTED.length > 0 && UNSUPPORTED.length > 0);
    assert.deepEqual([...VERIFIED_OK], [...ACCEPTED]);
    const overlap = ACCEPTED.filter((k) => UNSUPPORTED.includes(k));
    assert.deepEqual(overlap, []);
  });
});
