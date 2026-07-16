import { describe, expect, test } from 'bun:test';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from '../src/core/backoff';

describe('backoffDelayMs', () => {
  test('with pinned rng=0.5 the schedule is the exact exponential, then capped', () => {
    const rng = () => 0.5; // midpoint of symmetric jitter ⇒ the raw delay
    const schedule = [0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelayMs(attempt, DEFAULT_BACKOFF, rng));
    expect(schedule).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  test('monotonic below the cap even across jitter extremes', () => {
    // max jittered delay of attempt n must not exceed min jittered delay of n+1
    for (let attempt = 0; attempt < 4; attempt++) {
      const maxThis = backoffDelayMs(attempt, DEFAULT_BACKOFF, () => 1 - Number.EPSILON);
      const minNext = backoffDelayMs(attempt + 1, DEFAULT_BACKOFF, () => 0);
      expect(maxThis).toBeLessThanOrEqual(minNext);
    }
  });

  test('jitter is bounded to ±jitterRatio of the raw delay', () => {
    const raw = 4_000; // attempt 2
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 0)).toBe(raw * 0.75);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThan(raw * 1.25);
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, () => 0.999999)).toBeGreaterThan(raw * 1.24);
  });

  test('the raw delay is capped at capMs', () => {
    expect(backoffDelayMs(50, DEFAULT_BACKOFF, () => 0.5)).toBe(DEFAULT_BACKOFF.capMs);
  });

  test('honours a custom policy', () => {
    const policy: BackoffPolicy = { baseMs: 100, capMs: 500, factor: 3, jitterRatio: 0 };
    expect(backoffDelayMs(0, policy, () => 0.9)).toBe(100);
    expect(backoffDelayMs(1, policy, () => 0.1)).toBe(300);
    expect(backoffDelayMs(2, policy, () => 0.5)).toBe(500); // capped (900 → 500)
  });

  test('negative attempts clamp to the base', () => {
    expect(backoffDelayMs(-3, DEFAULT_BACKOFF, () => 0.5)).toBe(DEFAULT_BACKOFF.baseMs);
  });
});
