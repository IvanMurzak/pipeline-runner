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

export interface ShipperCursor {
  byteOffset: number;
  perRunSeq: Record<string, number>;
  /** Run ids whose stats record already shipped, oldest first. */
  statsShipped: string[];
  /** Run ids seen ENDED (terminal event observed), oldest first — the
   *  eviction order for `perRunSeq` bounding. */
  endedRuns: string[];
}

export function emptyCursor(): ShipperCursor {
  return { byteOffset: 0, perRunSeq: {}, statsShipped: [], endedRuns: [] };
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
      return {
        cursor: {
          byteOffset: Math.floor(byteOffset),
          perRunSeq,
          statsShipped: strings(parsed.statsShipped),
          endedRuns: strings(parsed.endedRuns),
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
    const statsIndex = cursor.statsShipped.indexOf(runId);
    if (statsIndex >= 0) cursor.statsShipped.splice(statsIndex, 1);
  }
  return evicted;
}
