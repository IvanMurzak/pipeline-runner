/**
 * Injectable clock/timer seam. The connection manager and the heartbeat loop
 * schedule ALL their timing through this interface so tests drive time with a
 * fake clock — no real timers, no sleeps.
 */

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** The real clock (Bun/Node globals). */
export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  now: () => Date.now(),
};
