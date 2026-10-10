import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCycle, CycleError, isStaleStateError, isHardDenial, withTimeout } from '../../lib/cycle.mjs';

describe('cycle: observe-act-verify (mocked, no desktop)', () => {
  it('returns result on the happy path with one observation', () => {
    let observations = 0;
    return runCycle(
      {
        observe: async () => ({ n: ++observations }),
        check: async (s) => s.n,
        act: async (t) => t * 2,
        verify: async (r) => assert.equal(r, 2),
      },
      { retries: 2 },
    ).then(({ result, attempts }) => {
      assert.equal(result, 2);
      assert.equal(attempts, 1);
      assert.equal(observations, 1);
    });
  });

  it('retries with a fresh observation on stale state, then succeeds', () => {
    let calls = 0;
    return runCycle(
      {
        observe: async () => ({ v: ++calls }),
        act: async () => {
          if (calls === 1) throw Object.assign(new Error('No app state is available for X'), { step: 'act' });
          return 'ok';
        },
        retryable: isStaleStateError,
      },
      { retries: 2 },
    ).then(({ result, attempts }) => {
      assert.equal(result, 'ok');
      assert.equal(attempts, 2);
    });
  });

  it('does not retry hard denials', () => {
    let acts = 0;
    return assert.rejects(
      () =>
        runCycle(
          {
            observe: async () => ({}),
            act: async () => {
              acts++;
              throw new Error('Unsupported key: super');
            },
            retryable: (e) => !isHardDenial(e) && isStaleStateError(e),
          },
          { retries: 3 },
        ),
      (e) => e instanceof CycleError && /failed after 1 attempt/.test(e.message),
    ).then(() => assert.equal(acts, 1));
  });

  it('wraps the final failure in CycleError with attempt count', () => {
    return assert.rejects(
      () =>
        runCycle(
          {
            observe: async () => ({}),
            act: async () => {
              throw Object.assign(new Error('stale snapshot'), { step: 'verify' });
            },
            retryable: () => true,
          },
          { retries: 1 },
        ),
      (e) => e instanceof CycleError && e.attempts === 2 && e.step === 'verify',
    );
  });

  it('withTimeout rejects a hanging step', () => {
    return assert.rejects(
      withTimeout(new Promise(() => {}), 20, 'observe'),
      /observe timed out after 20 ms/,
    );
  });
});
