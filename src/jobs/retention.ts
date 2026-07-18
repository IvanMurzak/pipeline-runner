/**
 * Workspace retention policy (c6, design 04 §Workspace, record + teardown
 * lifecycle — D15). Governs what happens to a job's checkout + record at a
 * TERMINAL outcome and what the periodic GC reaps later:
 *
 *   - default                                  → immediate teardown + record
 *     deletion (fixes the E6 disk leak: the shipped runner NEVER deleted a
 *     workspace).
 *   - `PIPELINE_RUNNER_WORKSPACE_RETENTION=<d>` → terminal workspaces are kept
 *     for the window (record tombstoned with `terminal.at`); a boot-time +
 *     periodic GC reaps expired ones. Durations: `30s`, `15m`, `12h`, `7d`,
 *     or a plain number of seconds.
 *   - `PIPELINE_RUNNER_KEEP_WORKSPACES=1`      → infinite: no teardown, no GC
 *     (records are tombstoned so the reconcile ignores them).
 *   - a record's `preserve_workspace` flag (05.2 unshipped improvements)
 *     always wins over teardown AND GC.
 *
 * Quarantined records (crash leftovers awaiting adoption/cancel) are reaped by
 * the same GC after `max(retention, DEFAULT_QUARANTINE_GC_MS)` — long enough
 * that a returning server decision is never beaten to the workspace, bounded
 * so an abandoned run cannot leak disk forever (04 failure-mode table: "record
 * GC on next reconcile after N days").
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';

export interface RetentionPolicy {
  /** `PIPELINE_RUNNER_KEEP_WORKSPACES=1`: never delete anything. */
  keepForever: boolean;
  /** Terminal-workspace retention window in ms; null = immediate delete. */
  retentionMs: number | null;
}

/** Default window before an un-adopted QUARANTINED record + workspace is
 *  reaped (aligned with the design's park-expiry default of 14 days). */
export const DEFAULT_QUARANTINE_GC_MS = 14 * 24 * 60 * 60 * 1000;

/** Cadence of the periodic retention sweep (boot-time sweep runs regardless). */
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d)?$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a retention duration (`45s`, `15m`, `12h`, `7d`, plain seconds).
 *  Null when unparseable. */
export function parseRetentionDuration(raw: string): number | null {
  const match = raw.trim().match(DURATION_RE);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] ?? 's').toLowerCase();
  return value * (UNIT_MS[unit] ?? 1000);
}

/** Resolve the policy from the environment. An unparseable retention value
 *  warns and falls back to the immediate-delete default (fail toward the leak
 *  FIX, not toward re-leaking). */
export function resolveRetentionPolicy(
  env: Record<string, string | undefined> = process.env,
  logger: Logger = nullLogger
): RetentionPolicy {
  if (env.PIPELINE_RUNNER_KEEP_WORKSPACES === '1') {
    return { keepForever: true, retentionMs: null };
  }
  const raw = env.PIPELINE_RUNNER_WORKSPACE_RETENTION;
  if (raw === undefined || raw.trim() === '') {
    return { keepForever: false, retentionMs: null };
  }
  const ms = parseRetentionDuration(raw);
  if (ms === null) {
    logger.warn(
      `PIPELINE_RUNNER_WORKSPACE_RETENTION unparseable ('${raw}') — expected e.g. 30s/15m/12h/7d; using immediate delete`
    );
    return { keepForever: false, retentionMs: null };
  }
  return { keepForever: false, retentionMs: ms };
}

/** The window after which a quarantined (non-terminal, unresumed) record is
 *  reaped: the operator's retention window when it is LONGER than the
 *  quarantine default, else the default. */
export function quarantineGcMs(policy: RetentionPolicy): number {
  return Math.max(policy.retentionMs ?? 0, DEFAULT_QUARANTINE_GC_MS);
}
