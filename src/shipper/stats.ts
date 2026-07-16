/**
 * `.stats` artifact folding — MINIMAL SEAM (scope-flagged in the T1-12
 * report).
 *
 * The engine writes per-run measurement records to
 * `<project>/.claude/pipeline/.stats/<pipeline-rel>/runs.jsonl` (one JSON
 * line per finished run — the `RunRecord` of the OSS
 * `apps/pipeline-cli/src/lib/stats.ts`) plus a human `.log` per run. The
 * shipper folds the machine-readable record in-band: when it observes a
 * TERMINAL event for a run (`run.completed` / `run.halted` /
 * `pipeline.completed` / `pipeline.halted`), it looks the run up through the
 * `StatsSource` seam and, when found, ships ONE synthetic event
 *
 *   { schema: 4, ts: <record.ended_at>, type: "stats.run_record",
 *     project_root, worktree: null, run_id, parent_run_id: null,
 *     session_id: null, data: <RunRecord> }
 *
 * through the SAME privacy filter + seq assignment + spool as journal events
 * (metadata tier: numeric measures + outcome taxonomy only — see
 * `privacy.ts#filterStatsRecordMetadata`). `cursor.statsShipped` makes the
 * fold once-per-run; a crash-window duplicate dedups on `(run_id, seq)`.
 *
 * Scope deliberately NOT covered here (flagged): tokens-enrichment arriving
 * AFTER the terminal event (the stats relay hook can rewrite `runs.jsonl`
 * later — a late fold would need a re-ship policy), and the per-run `.log`
 * text at the `full` tier.
 */

import { join } from 'node:path';
import type { ShipperFileSystem } from './fs';

/** Event types that mark a run as ENDED (spike-report G4/G6). */
export const TERMINAL_EVENT_TYPES = [
  'run.completed',
  'run.halted',
  'pipeline.completed',
  'pipeline.halted',
] as const;

export function isTerminalEventType(type: unknown): boolean {
  return typeof type === 'string' && (TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

/** The synthetic event type wrapping a `.stats` run record. */
export const STATS_EVENT_TYPE = 'stats.run_record';

export interface StatsSource {
  /** The run's `runs.jsonl` record, or null when none exists (yet). */
  findRunRecord(runId: string): Record<string, unknown> | null;
}

/** A `StatsSource` that never finds anything (stats folding disabled). */
export const nullStatsSource: StatsSource = { findRunRecord: () => null };

/**
 * The real source: walks `<statsDir>/**\/runs.jsonl` (skipping the per-run
 * `runs/` dirs, per the stats layout) and returns the newest record matching
 * `run_id`.
 */
export class DiskStatsSource implements StatsSource {
  constructor(
    private readonly fs: ShipperFileSystem,
    private readonly statsDir: string
  ) {}

  findRunRecord(runId: string): Record<string, unknown> | null {
    return this.scanDir(this.statsDir, runId);
  }

  private scanDir(dir: string, runId: string): Record<string, unknown> | null {
    const entries = this.fs.listDir(dir);
    if (entries === null) return null;
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (entry.name === 'runs') continue; // per-run .log dir — not records
        const found = this.scanDir(join(dir, entry.name), runId);
        if (found !== null) return found;
      } else if (entry.name === 'runs.jsonl') {
        const found = this.scanFile(join(dir, entry.name), runId);
        if (found !== null) return found;
      }
    }
    return null;
  }

  private scanFile(path: string, runId: string): Record<string, unknown> | null {
    const text = this.fs.readFileText(path);
    if (text === null) return null;
    let newest: Record<string, unknown> | null = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        if (record !== null && typeof record === 'object' && record.run_id === runId) newest = record;
      } catch {
        /* tolerate a torn/garbage line */
      }
    }
    return newest;
  }
}

/** Derive `<project>/.claude/pipeline/.stats` from the journal path
 *  (`<project>/.claude/pipeline/.runtime/events.jsonl`). */
export function statsDirForJournal(journalPath: string): string {
  // dirname(journalPath) = .../.runtime → sibling `.stats`.
  const runtimeDir = journalPath.replace(/[\\/][^\\/]*$/, '');
  const pipelineDir = runtimeDir.replace(/[\\/][^\\/]*$/, '');
  return join(pipelineDir, '.stats');
}

/** Wrap a run record as the synthetic journal-shaped event (UNFILTERED — the
 *  caller pushes it through the privacy filter like any journal line). */
export function statsRecordEvent(
  runId: string,
  record: Record<string, unknown>,
  projectRoot: string,
  fallbackTs: string
): Record<string, unknown> {
  return {
    schema: 4,
    ts: typeof record.ended_at === 'string' ? record.ended_at : fallbackTs,
    type: STATS_EVENT_TYPE,
    project_root: projectRoot,
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: null,
    data: record,
  };
}
