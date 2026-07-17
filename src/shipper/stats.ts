/**
 * `.stats` artifact shipping — the UNIFIED runs.jsonl watcher (design
 * `08-cloud-sync.md` D13 + D18; supersedes the T1-12 minimal seam).
 *
 * The engine writes per-run measurement records to
 * `<project>/.claude/pipeline/.stats/<pipeline-rel>/runs.jsonl` (one JSON
 * line per finished run — the `RunRecord` of the OSS
 * `apps/pipeline-cli/src/lib/stats.ts`) plus a human `.log` per run. The
 * SubagentStop stats relay hook may REWRITE a run's line later, enriching
 * `tokens` from null to folded counts. The shipper watches this in two ways:
 *
 *   1. JOURNAL TRIGGER (unchanged from T1-12): when it observes a TERMINAL
 *      event for a run (`run.completed` / `run.halted` / `pipeline.completed`
 *      / `pipeline.halted`), it looks the run up through the `StatsSource`
 *      seam and ships ONE synthetic event
 *
 *        { schema: 4, ts: <record.ended_at>, type: "stats.run_record",
 *          project_root, worktree: null, run_id, parent_run_id: null,
 *          session_id: null, data: <RunRecord + revision/origin> }
 *
 *      with `origin:"dispatched"`, `revision: 1`.
 *   2. PERIODIC RESCAN (D13+D18): an mtime-gated walk of the same
 *      `runs.jsonl` files (only files whose mtime changed since the last
 *      walk are re-read), windowed to records whose `ended_at` is within
 *      {@link STATS_RESCAN_WINDOW_MS} (14 days, matched to the cloud
 *      backfill window — D13 as revised at review). The shipper classifies
 *      each candidate: an UNSHIPPED record of a journal-known run ships as
 *      `origin:"dispatched"` (a record that landed after its terminal
 *      event); an unshipped record of a journal-UNKNOWN run is a LOCALLY
 *      started run and ships with `origin:"local"` when the
 *      `sync_local_stats` flag (default ON, D18) allows; an already-shipped
 *      record whose `tokens` went null→non-null re-ships with `revision`+1
 *      (exactly once — the transition is one-way).
 *
 * Every ship goes through the SAME privacy filter + seq assignment + spool
 * as journal events (metadata tier: numeric measures + outcome taxonomy
 * only — see `privacy.ts#filterStatsRecordMetadata`; `RunFailureDetail`
 * error excerpts are stripped at EVERY tier — D16/G-sec-2), and the payload
 * is validated against the protocol's `RunRecordStatsSchema` BEFORE
 * spooling — a malformed record is never spooled. Once-per-run/-revision
 * bookkeeping lives in the cursor (`statsShipped`, `localStatsShipped`,
 * `statsRevisionShipped`, `statsTokensShipped`); crash-window duplicates
 * dedup on `(run_id, seq)`.
 *
 * Scope deliberately NOT covered here: the per-run `.log` text at the
 * `full` tier.
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

/** Rescan window (D13, revised at review): a record whose `ended_at` is
 *  older than this is never (re-)shipped by the rescan — matched to the
 *  cloud's 14-day backfill window. */
export const STATS_RESCAN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Default cadence of the periodic rescan. The mtime gate makes an idle
 *  rescan two `stat` calls per stats file, so a tight-ish default is cheap. */
export const DEFAULT_STATS_RESCAN_MS = 60_000;

// ── The `sync_local_stats` flag (D18) ────────────────────────────────────────

/** Env var for the `sync_local_stats` flag (config option wins). Falsey
 *  values (`0/false/off/no`) opt OUT of local-run stats sync. */
export const SYNC_LOCAL_STATS_ENV = 'PIPELINE_SYNC_LOCAL_STATS';

/** D18: local-run metric sync is DEFAULT ON (disclosed at registration). */
export const DEFAULT_SYNC_LOCAL_STATS = true;

const FLAG_FALSE = ['0', 'false', 'off', 'no'];
const FLAG_TRUE = ['1', 'true', 'on', 'yes'];

/**
 * Resolve the `sync_local_stats` flag: an explicit config value wins, else
 * the env var, else the D18 default (ON). An UNRECOGNIZED value fails toward
 * PRIVACY (off — the user was clearly reaching for the opt-out) and reports
 * itself via the returned `warning`.
 */
export function resolveSyncLocalStats(
  explicit: boolean | string | undefined,
  env: Record<string, string | undefined> = process.env
): { enabled: boolean; warning: string | null } {
  for (const [value, source] of [
    [explicit, 'config'],
    [env[SYNC_LOCAL_STATS_ENV], `env ${SYNC_LOCAL_STATS_ENV}`],
  ] as const) {
    if (value === undefined || value === '') continue;
    if (typeof value === 'boolean') return { enabled: value, warning: null };
    const lowered = value.toLowerCase();
    if (FLAG_FALSE.includes(lowered)) return { enabled: false, warning: null };
    if (FLAG_TRUE.includes(lowered)) return { enabled: true, warning: null };
    return {
      enabled: false,
      warning: `unrecognized sync_local_stats value '${value}' (${source}) — failing toward privacy (off)`,
    };
  }
  return { enabled: DEFAULT_SYNC_LOCAL_STATS, warning: null };
}

// ── The stats source seam ────────────────────────────────────────────────────

export interface StatsSource {
  /** The run's `runs.jsonl` record, or null when none exists (yet). */
  findRunRecord(runId: string): Record<string, unknown> | null;
  /**
   * Rescan support (D13+D18): the NEWEST record per run, across every
   * `runs.jsonl` whose mtime changed since the previous `scanRecords` call,
   * windowed to `ended_at >= windowStartMs`. Optional — a source without it
   * disables the periodic rescan (journal-triggered folding still works).
   */
  scanRecords?(windowStartMs: number): Array<Record<string, unknown>>;
}

/** A `StatsSource` that never finds anything (stats folding disabled). */
export const nullStatsSource: StatsSource = { findRunRecord: () => null };

/**
 * The real source: walks `<statsDir>/**\/runs.jsonl` (skipping the per-run
 * `runs/` dirs, per the stats layout). `findRunRecord` returns the newest
 * record matching `run_id`; `scanRecords` returns the newest record per run
 * from CHANGED files only (per-file mtime gate, held in memory — a restart
 * rescans everything once and the cursor bookkeeping dedups).
 */
export class DiskStatsSource implements StatsSource {
  /** runs.jsonl path → mtime as of the last completed scan of that file. */
  private readonly scannedMtimes = new Map<string, number>();

  constructor(
    private readonly fs: ShipperFileSystem,
    private readonly statsDir: string
  ) {}

  findRunRecord(runId: string): Record<string, unknown> | null {
    for (const path of this.listRecordFiles(this.statsDir)) {
      const found = this.scanFile(path, runId);
      if (found !== null) return found;
    }
    return null;
  }

  scanRecords(windowStartMs: number): Array<Record<string, unknown>> {
    const newestByRun = new Map<string, Record<string, unknown>>();
    for (const path of this.listRecordFiles(this.statsDir)) {
      // Stat BEFORE reading: a write racing the read makes the stored mtime
      // stale, so the next rescan re-reads the file (never skips a change).
      const mtime = this.fs.statMtime(path);
      if (mtime === null) continue;
      if (this.scannedMtimes.get(path) === mtime) continue;
      const text = this.fs.readFileText(path);
      if (text === null) continue;
      for (const record of parseRecordLines(text)) {
        const runId = record.run_id;
        if (typeof runId !== 'string' || runId === '') continue;
        const endedMs = typeof record.ended_at === 'string' ? Date.parse(record.ended_at) : NaN;
        if (!Number.isFinite(endedMs) || endedMs < windowStartMs) continue;
        newestByRun.set(runId, record); // later line wins (newest per run)
      }
      this.scannedMtimes.set(path, mtime);
    }
    return [...newestByRun.values()];
  }

  /** All `runs.jsonl` files under `dir`, skipping per-run `runs/` log dirs. */
  private listRecordFiles(dir: string): string[] {
    const entries = this.fs.listDir(dir);
    if (entries === null) return [];
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        if (entry.name === 'runs') continue; // per-run .log dir — not records
        files.push(...this.listRecordFiles(join(dir, entry.name)));
      } else if (entry.name === 'runs.jsonl') {
        files.push(join(dir, entry.name));
      }
    }
    return files;
  }

  private scanFile(path: string, runId: string): Record<string, unknown> | null {
    const text = this.fs.readFileText(path);
    if (text === null) return null;
    let newest: Record<string, unknown> | null = null;
    for (const record of parseRecordLines(text)) {
      if (record.run_id === runId) newest = record;
    }
    return newest;
  }
}

/** Parse a runs.jsonl body into its object lines (garbage lines tolerated). */
function parseRecordLines(text: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
        records.push(record as Record<string, unknown>);
      }
    } catch {
      /* tolerate a torn/garbage line */
    }
  }
  return records;
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
