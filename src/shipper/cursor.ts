/**
 * Shipper cursor — the restart-safe checkpoint (spike-report G1).
 *
 * `{ byteOffset, perRunSeq, statsShipped }` persisted ATOMICALLY in the
 * agent's DATA dir (never inside the tailed project):
 *
 *   - `byteOffset`   — journal position through the last line CONSUMED INTO
 *     THE SPOOL. Everything at/after it is either still in the journal
 *     (unread) or already durably spooled — a restart never re-ships a
 *     spooled line and never skips one.
 *   - `perRunSeq`    — the per-run monotonic seq counters AS OF `byteOffset`,
 *     so seqs stay contiguous across a process boundary (the spike's proven
 *     invariant). Bounded (G6): when the map exceeds `maxTrackedRuns`, the
 *     runs that ENDED longest ago are evicted (never an active run) with a
 *     warning — a post-eviction straggler event would restart at seq 1 and be
 *     deduped away server-side, which is why eviction is loud and last-resort.
 *   - `statsShipped` — run ids whose `.stats` record was already folded in
 *     (one synthetic record per run), insertion-ordered, pruned with the same
 *     bound.
 *   - `localStatsShipped` — run ids of LOCALLY-started runs (never seen in the
 *     tailed journal) whose record the periodic rescan shipped with
 *     `origin:"local"` (design D18). Disjoint from `statsShipped` by
 *     construction; same bound/pruning.
 *   - `statsRevisionShipped` — run id → the `revision` stamped on the LAST
 *     shipped `stats.run_record` for that run (design D13). Missing entry ⇒ 1
 *     (the pre-revision fleet's implicit first ship).
 *   - `statsTokensShipped` — run ids whose last-shipped record already carried
 *     NON-NULL `tokens`. The re-ship trigger is the one-way tokens
 *     null→non-null transition (enrichment never un-sets tokens), so this set
 *     makes the enrichment re-ship exactly-once: membership is taken on any
 *     ship whose record has tokens, and a member is never re-shipped for
 *     enrichment again.
 *
 * The cursor is saved on FLUSH (after pending events are durably spooled),
 * NOT on upload — upload confirmation is the spool's concern. A crash between
 * spool-write and cursor-save re-reads and re-spools the same lines with the
 * same seqs; ingest's `(run_id, seq)` dedup makes the overlap a no-op.
 */

import { join } from 'node:path';
import type { ShipperFileSystem } from './fs';

export const CURSOR_FILE_NAME = 'cursor.json';

/** Default bound on tracked per-run seq counters + statsShipped entries. */
export const DEFAULT_MAX_TRACKED_RUNS = 1000;

/** Backstop bound on stats markers — see {@link pruneStatsMarkers}. Markers are
 *  normally retained by RECORD AGE, not by count. */
export const DEFAULT_MAX_STATS_MARKERS = 10_000;

export interface ShipperCursor {
  byteOffset: number;
  perRunSeq: Record<string, number>;
  /** Run ids whose stats record already shipped, oldest first. */
  statsShipped: string[];
  /** Run ids of LOCAL runs whose record shipped with `origin:"local"` (D18),
   *  oldest first. */
  localStatsShipped: string[];
  /** Run id → last shipped `revision` (D13). Missing ⇒ 1. */
  statsRevisionShipped: Record<string, number>;
  /** Run ids whose last-shipped record had non-null `tokens` (the enrichment
   *  re-ship exactly-once guard), oldest first. */
  statsTokensShipped: string[];
  /** Run ids seen ENDED (terminal event observed — or shipped as a finished
   *  LOCAL record), oldest first — the eviction order for `perRunSeq`
   *  bounding. */
  endedRuns: string[];
  /**
   * run id → the `ended_at` (epoch ms) of its last shipped stats record.
   *
   * This is what keeps the stats markers alive for exactly as long as they can
   * still matter. The rescan only ever considers records inside
   * `STATS_RESCAN_WINDOW_MS`, so a marker whose record has aged out of that
   * window can never cause a re-ship and is safe to drop — whereas dropping a
   * marker for a record STILL in the window makes the rescan see an already
   * shipped run as brand new and re-ship it, misattributed as
   * `origin:"local"` (its perRunSeq/endedRuns evidence was pruned too).
   * Eviction is therefore driven by this timestamp, NOT by the perRunSeq
   * count bound, which exists for a different concern (seq allocation).
   */
  statsShippedAt: Record<string, number>;
}

export function emptyCursor(): ShipperCursor {
  return {
    byteOffset: 0,
    perRunSeq: {},
    statsShipped: [],
    localStatsShipped: [],
    statsRevisionShipped: {},
    statsTokensShipped: [],
    endedRuns: [],
    statsShippedAt: {},
  };
}

export class CursorStore {
  constructor(
    private readonly fs: ShipperFileSystem,
    private readonly dir: string
  ) {}

  get path(): string {
    return join(this.dir, CURSOR_FILE_NAME);
  }

  /** Load the persisted cursor; a missing or corrupt file starts fresh (the
   *  journal is re-read from 0 and every overlap dedups server-side). */
  load(): { cursor: ShipperCursor; warning: string | null } {
    const text = this.fs.readFileText(this.path);
    if (text === null) return { cursor: emptyCursor(), warning: null };
    try {
      const parsed = JSON.parse(text) as Partial<ShipperCursor>;
      const byteOffset = Number(parsed.byteOffset);
      if (!Number.isFinite(byteOffset) || byteOffset < 0) throw new Error('bad byteOffset');
      const perRunSeq: Record<string, number> = {};
      for (const [runId, seq] of Object.entries(parsed.perRunSeq ?? {})) {
        const n = Number(seq);
        if (Number.isFinite(n) && n >= 0) perRunSeq[runId] = Math.floor(n);
      }
      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
      // Tolerant load of the numeric maps (an older cursor lacks them).
      const numberMap = (raw: unknown): Record<string, number> => {
        const out: Record<string, number> = {};
        if (typeof raw !== 'object' || raw === null) return out;
        for (const [runId, value] of Object.entries(raw)) {
          const n = Number(value);
          if (Number.isFinite(n)) out[runId] = n;
        }
        return out;
      };
      const statsRevisionShipped: Record<string, number> = {};
      if (typeof parsed.statsRevisionShipped === 'object' && parsed.statsRevisionShipped !== null) {
        for (const [runId, revision] of Object.entries(parsed.statsRevisionShipped)) {
          const n = Number(revision);
          if (Number.isFinite(n) && n >= 1) statsRevisionShipped[runId] = Math.floor(n);
        }
      }
      return {
        cursor: {
          byteOffset: Math.floor(byteOffset),
          perRunSeq,
          statsShipped: strings(parsed.statsShipped),
          localStatsShipped: strings(parsed.localStatsShipped),
          statsRevisionShipped,
          statsTokensShipped: strings(parsed.statsTokensShipped),
          endedRuns: strings(parsed.endedRuns),
          statsShippedAt: numberMap(parsed.statsShippedAt),
        },
        warning: null,
      };
    } catch (err) {
      return {
        cursor: emptyCursor(),
        warning: `cursor unreadable (${err instanceof Error ? err.message : String(err)}) — starting fresh; overlaps dedup server-side`,
      };
    }
  }

  save(cursor: ShipperCursor): void {
    this.fs.mkdirp(this.dir);
    this.fs.writeFileText(this.path, JSON.stringify(cursor, null, 2) + '\n');
  }
}

/**
 * Bound the cursor state (G6): evict per-run counters + bookkeeping for the
 * runs that ENDED longest ago once the tracked-run count exceeds `max`.
 * Returns the evicted run ids (caller logs them — eviction is never silent).
 */
export function pruneCursor(cursor: ShipperCursor, max = DEFAULT_MAX_TRACKED_RUNS): string[] {
  const evicted: string[] = [];
  while (Object.keys(cursor.perRunSeq).length > max && cursor.endedRuns.length > 0) {
    const runId = cursor.endedRuns.shift()!;
    if (runId in cursor.perRunSeq) {
      delete cursor.perRunSeq[runId];
      evicted.push(runId);
    }
  }
  return evicted;
}

/**
 * Evict stats markers that can no longer matter — the SEPARATE retention rule
 * (see `ShipperCursor.statsShippedAt`).
 *
 * A marker is droppable exactly when its record has aged out of the rescan
 * window, because the rescan will never look at that record again. Dropping
 * one any earlier is what makes an already-shipped run look brand new: with
 * its perRunSeq/endedRuns evidence gone too, `shipFirstFromRescan` classifies
 * a dispatched run as LOCAL and ships it a second time.
 *
 * `hardMax` is a backstop against a pathological run volume inside one window
 * (each entry is an id plus a number, so the normal case is a few tens of KB):
 * once exceeded, the OLDEST records go first — they are the closest to leaving
 * the window anyway, so they are the least likely to be re-shipped.
 */
export function pruneStatsMarkers(
  cursor: ShipperCursor,
  nowMs: number,
  windowMs: number,
  hardMax = DEFAULT_MAX_STATS_MARKERS,
): string[] {
  const dropFrom = (list: string[], runId: string): void => {
    const index = list.indexOf(runId);
    if (index >= 0) list.splice(index, 1);
  };
  const drop = (runId: string): void => {
    dropFrom(cursor.statsShipped, runId);
    dropFrom(cursor.localStatsShipped, runId);
    dropFrom(cursor.statsTokensShipped, runId);
    delete cursor.statsRevisionShipped[runId];
    delete cursor.statsShippedAt[runId];
  };

  const dropped: string[] = [];
  const cutoff = nowMs - windowMs;
  for (const [runId, endedAtMs] of Object.entries(cursor.statsShippedAt)) {
    if (endedAtMs < cutoff) {
      drop(runId);
      dropped.push(runId);
    }
  }

  const remaining = Object.entries(cursor.statsShippedAt);
  if (remaining.length > hardMax) {
    remaining.sort((a, b) => a[1] - b[1]); // oldest record first
    for (const [runId] of remaining.slice(0, remaining.length - hardMax)) {
      drop(runId);
      dropped.push(runId);
    }
  }
  return dropped;
}
