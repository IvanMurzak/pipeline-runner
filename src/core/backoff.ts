/**
 * Reconnect backoff policy: exponential with a cap and BOUNDED jitter.
 *
 * delay(attempt) = min(capMs, baseMs * factor^attempt) * U[1 - jitterRatio, 1 + jitterRatio]
 *
 * With the defaults (base 1s, factor 2, cap 30s, jitter ±25%) the schedule is
 * ~1s, 2s, 4s, 8s, 16s, 30s, 30s, … and consecutive jittered samples can
 * never invert below the cap: max(d_n) = 1.25·r_n < 0.75·2·r_n = min(d_{n+1})
 * — i.e. the schedule stays monotonic while still de-thundering herds.
 *
 * The RNG is injectable so tests pin the jitter.
 */

export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
  factor: number;
  /** Symmetric jitter as a fraction of the raw delay (0.25 ⇒ ±25%). */
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  capMs: 30_000,
  factor: 2,
  jitterRatio: 0.25,
};

/**
 * Delay before reconnect attempt `attempt` (0-based: 0 ⇒ first retry).
 * `rng` must return a float in [0, 1).
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  rng: () => number = Math.random
): number {
  const exponent = Math.max(0, attempt);
  const raw = Math.min(policy.capMs, policy.baseMs * policy.factor ** exponent);
  const spread = raw * policy.jitterRatio;
  return raw - spread + rng() * 2 * spread;
}
