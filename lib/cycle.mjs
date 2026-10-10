// Observe -> act -> verify cycle with bounded retries and timeouts.
// Pure logic (no desktop access); the desktop driver is injected so unit
// tests can use mocks while integration tests inject the real `ocu` runner.

export class CycleError extends Error {
  constructor(step, cause, attempts) {
    super(`${step} failed after ${attempts} attempt(s): ${cause?.message ?? cause}`);
    this.name = 'CycleError';
    this.step = step;
    this.attempts = attempts;
    this.cause = cause;
  }
}

export function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one bounded interaction:
 *   1. observe() -> state
 *   2. check(state) -> target (throw to retry with a fresh observation)
 *   3. act(target) -> result
 *   4. verify(result/state) -> true (throw to retry)
 *
 * Retries only when `retryable(err)` is true. Anything else throws
 * immediately wrapped in CycleError.
 */
export async function runCycle(
  { observe, check, act, verify, retryable = () => false },
  { retries = 1, timeoutMs = 30000 } = {},
) {
  if (typeof observe !== 'function') throw new TypeError('observe must be a function');
  if (typeof act !== 'function') throw new TypeError('act must be a function');
  const attempts = retries + 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const state = await withTimeout(observe(), timeoutMs, 'observe');
      const target = check ? await check(state) : state;
      const result = await withTimeout(Promise.resolve().then(() => act(target)), timeoutMs, 'act');
      if (verify) await withTimeout(Promise.resolve().then(() => verify(result, state)), timeoutMs, 'verify');
      return { result, state, attempts: attempt };
    } catch (err) {
      lastError = err;
      const step = err?.step ?? 'cycle';
      if (attempt >= attempts || !retryable(err)) {
        throw new CycleError(step, err, attempt);
      }
    }
  }
  throw new CycleError('cycle', lastError, attempts);
}

/**
 * Retryable when a fresh observation may fix the problem: stale snapshots,
 * missing app-state bindings, or element indexes derived from an older tree.
 * The cycle re-runs observe+check on retry, so the index is re-derived.
 * Never retry hard denials (unsupported keys, appNotFound, permission).
 */
export function isStaleStateError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('stale') ||
    msg.includes('no app state is available') ||
    msg.includes('run get_app_state') ||
    msg.includes('unknown element_index') ||
    msg.includes('no usable screenshot')
  );
}

/** Never retry: the request itself is invalid or denied. */
export function isHardDenial(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('unsupported key') ||
    msg.includes('appnotfound') ||
    msg.includes('denied') ||
    msg.includes('permission')
  );
}
