/**
 * EventShipper — the runner-side half that gets a run's telemetry to the
 * cloud (T1-12). Rebuilds the Phase-0 spike shipper properly on the T1-11
 * core seams.
 *
 * Data path (every stage injectable, nothing global):
 *
 *   events.jsonl ──JournalTail──▶ lines
 *     ─G2─▶ only events with a non-null run_id ship (session-scoped rows are
 *           a separate, later concern)
 *     ─PRIVACY─▶ `filterEventForTier` runs BEFORE anything is persisted or
 *           uploaded — no above-tier content ever exists downstream
 *     ─SEQ─▶ this shipper is THE per-run sequence authority: monotonic seq
 *           from 1, checkpointed with the byte offset (contiguous across
 *           restarts; `(run_id, seq)` dedup server-side)
 *     ─BATCH─▶ pending events flush on a size OR time threshold
 *     ─SPOOL─▶ flushes are DURABLE before the cursor advances (offline
 *           buffer == the normal path; bounded, drop-oldest, loudly logged)
 *     ─DRAIN─▶ oldest-first upload through the `UploadTransport` seam with
 *           core-backoff retries; confirmed chunks are deleted
 *
 * `.stats` folding: a terminal event triggers a one-shot synthetic
 * `stats.run_record` for that run through the same filter/seq/spool path
 * (see ./stats.ts — minimal seam, scope-flagged).
 *
 * SECURITY: log lines never contain payloads, tokens, or stripped content —
 * only counts, seq ranges, types, and transport status strings.
 */

import { join } from 'node:path';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from '../core/backoff';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import { CursorStore, DEFAULT_MAX_TRACKED_RUNS, pruneCursor, type ShipperCursor } from './cursor';
import { defaultDataDir, nodeShipperFs, type ShipperFileSystem } from './fs';
import {
  DEFAULT_PRIVACY_TIER,
  filterEventForTier,
  resolvePrivacyTier,
  type PrivacyFilterOptions,
  type PrivacyTier,
} from './privacy';
import { isTerminalEventType, nullStatsSource, statsRecordEvent, type StatsSource } from './stats';
import { DEFAULT_SPOOL_MAX_EVENTS, Spool } from './spool';
import { JournalTail } from './tail';
import type { UploadTransport } from './upload-transport';
import type { IngestBatchRequest, IngestEventRecord } from './wire-ingest';

export const DEFAULT_BATCH_MAX_EVENTS = 100;
export const DEFAULT_BATCH_MAX_MS = 2_000;
export const DEFAULT_POLL_MS = 500;

/** A parsed, filtered, seq-assigned event awaiting flush. */
interface PendingEvent {
  runId: string;
  seq: number;
  payload: unknown;
}

export interface EventShipperOptions {
  /** `<project>/.claude/pipeline/.runtime/events.jsonl`. */
  journalPath: string;
  /** The upload transport (see ./upload-transport.ts). */
  transport: UploadTransport;
  /**
   * State dir for THIS journal's cursor + spool. Callers should derive a
   * per-journal dir under the agent data dir (see `shipperStateDir`).
   */
  stateDir: string;
  /** Privacy tier; unset ⇒ env `PIPELINE_PRIVACY_TIER` ⇒ `metadata`.
   *  Unrecognized values FAIL CLOSED to `metadata`. */
  privacyTier?: string;
  /** Optional salt for path fingerprints (env `PIPELINE_PRIVACY_SALT`). */
  fingerprintSalt?: string;
  /** The `project_root` stamped on synthetic stats events. */
  projectRoot?: string;
  statsSource?: StatsSource;
  fs?: ShipperFileSystem;
  clock?: Clock;
  logger?: Logger;
  env?: Record<string, string | undefined>;
  /** Flush when this many events are pending (size threshold). */
  batchMaxEvents?: number;
  /** Flush at least this often while events are pending (time threshold). */
  batchMaxMs?: number;
  /** Journal poll cadence in follow mode. */
  pollMs?: number;
  /** Offline-buffer cap (events). Oldest chunks drop first, loudly. */
  spoolMaxEvents?: number;
  /** Bound on tracked per-run seq counters (G6). */
  maxTrackedRuns?: number;
  /** c6 (06.8.2, attempt fencing): start this run's seq counter at `base`
   *  (the lease's `event_seq_base`) so a re-attempt's events land in their
   *  own seq window — a foreign/late attempt restarting at 1 would otherwise
   *  be silently dedup-dropped against the previous attempt's ledger rows.
   *  Never LOWERS an existing counter (a resumed same-attempt journal keeps
   *  its contiguous seqs). */
  seqBase?: { runId: string; base: number };
  backoff?: BackoffPolicy;
  rng?: () => number;
}

/** Derive the per-journal state dir under the agent DATA dir. */
export function shipperStateDir(
  journalPath: string,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  // A short stable hash keeps one dir per journal without path-length issues.
  let hash = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < journalPath.length; i++) {
    hash = Math.imul(hash ^ journalPath.charCodeAt(i), 16777619) >>> 0;
  }
  return join(defaultDataDir(env, platform), 'shipper', hash.toString(16).padStart(8, '0'));
}

export class EventShipper {
  readonly tier: PrivacyTier;

  private readonly fs: ShipperFileSystem;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly transport: UploadTransport;
  private readonly statsSource: StatsSource;
  private readonly filterOptions: PrivacyFilterOptions;
  private readonly projectRoot: string;

  private readonly batchMaxEvents: number;
  private readonly batchMaxMs: number;
  private readonly pollMs: number;
  private readonly maxTrackedRuns: number;
  private readonly backoff: BackoffPolicy;
  private readonly rng: () => number;

  private readonly cursorStore: CursorStore;
  private readonly spool: Spool;
  private cursor: ShipperCursor;
  private tail: JournalTail;

  private pending: PendingEvent[] = [];
  private pendingParseOffset: number;

  private draining = false;
  private drainAttempt = 0;
  private retryTimer: unknown = null;
  private pollTimer: unknown = null;
  private flushTimer: unknown = null;
  private started = false;

  constructor(private readonly options: EventShipperOptions) {
    this.fs = options.fs ?? nodeShipperFs();
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.transport = options.transport;
    this.statsSource = options.statsSource ?? nullStatsSource;
    this.batchMaxEvents = options.batchMaxEvents ?? DEFAULT_BATCH_MAX_EVENTS;
    this.batchMaxMs = options.batchMaxMs ?? DEFAULT_BATCH_MAX_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.maxTrackedRuns = options.maxTrackedRuns ?? DEFAULT_MAX_TRACKED_RUNS;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.rng = options.rng ?? Math.random;
    this.filterOptions = {
      fingerprintSalt:
        options.fingerprintSalt ?? (options.env ?? process.env).PIPELINE_PRIVACY_SALT ?? '',
    };
    this.projectRoot = options.projectRoot ?? '(unknown-project-root)';

    const resolved = resolvePrivacyTier(options.privacyTier, options.env ?? process.env);
    this.tier = resolved.tier;
    if (resolved.warning !== null) this.logger.warn(resolved.warning);
    if (this.tier === DEFAULT_PRIVACY_TIER) {
      this.logger.info(`privacy tier: ${this.tier} (content never leaves this machine)`);
    } else {
      this.logger.info(`privacy tier: ${this.tier} (opt-in)`);
    }

    this.cursorStore = new CursorStore(this.fs, options.stateDir);
    const loaded = this.cursorStore.load();
    if (loaded.warning !== null) this.logger.warn(loaded.warning);
    this.cursor = loaded.cursor;
    if (options.seqBase !== undefined) {
      const { runId, base } = options.seqBase;
      if ((this.cursor.perRunSeq[runId] ?? 0) < base) this.cursor.perRunSeq[runId] = base;
    }
    this.tail = new JournalTail(this.fs, options.journalPath, this.cursor.byteOffset);
    this.pendingParseOffset = this.cursor.byteOffset;
    this.spool = new Spool(this.fs, join(options.stateDir, 'spool'), options.spoolMaxEvents ?? DEFAULT_SPOOL_MAX_EVENTS);
  }

  /** Events parsed but not yet flushed to the spool. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Events durably spooled but not yet confirmed uploaded. */
  get spooledCount(): number {
    return this.spool.eventCount;
  }

  // ── Follow mode ────────────────────────────────────────────────────────────

  /** Start polling + time-based flushing (tests may drive pollOnce/flushNow
   *  directly instead). Also kicks a drain for chunks a previous process left
   *  spooled. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const pollLoop = (): void => {
      this.pollOnce();
      this.pollTimer = this.clock.setTimeout(pollLoop, this.pollMs);
    };
    const flushLoop = (): void => {
      this.flushNow();
      this.flushTimer = this.clock.setTimeout(flushLoop, this.batchMaxMs);
    };
    this.pollTimer = this.clock.setTimeout(pollLoop, this.pollMs);
    this.flushTimer = this.clock.setTimeout(flushLoop, this.batchMaxMs);
    void this.drain();
  }

  /** Stop timers and do a final flush + drain attempt. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer);
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.pollTimer = this.flushTimer = this.retryTimer = null;
    this.pollOnce();
    this.flushNow();
    await this.drain();
  }

  // ── Tail → filter → seq ────────────────────────────────────────────────────

  /**
   * One tail cycle: read new complete journal lines, filter them by tier,
   * assign seqs, queue stats folds for newly-terminal runs. Flushes when the
   * SIZE threshold is reached. Returns the number of events queued.
   */
  pollOnce(): number {
    const poll = this.tail.poll();
    if (poll.rotated) {
      // New file at position 0. Seq counters are KEPT (a run spanning the
      // rotation keeps a monotonic seq; overlaps dedup server-side).
      this.logger.warn('journal shrank — treating as rotation, tail reset to 0 (seq counters kept)');
    }
    let added = 0;
    for (const line of poll.lines) {
      added += this.ingestLine(line);
    }
    this.pendingParseOffset = poll.parseOffset;
    if (this.pending.length >= this.batchMaxEvents) this.flushNow();
    return added;
  }

  private ingestLine(line: string): number {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.logger.warn('skipping malformed journal line (not JSON)');
      return 0;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.logger.warn('skipping malformed journal line (not an object)');
      return 0;
    }
    const event = value as Record<string, unknown>;
    const runId = typeof event.run_id === 'string' && event.run_id.length > 0 ? event.run_id : null;
    if (runId === null) {
      // G2: session-scoped events (run_id null) are NOT shipped per-run.
      this.logger.debug('skipping session-scoped event (null run_id) — not shippable (G2)');
      return 0;
    }

    let added = this.queueEvent(runId, event);
    if (isTerminalEventType(event.type)) {
      this.noteRunEnded(runId);
      added += this.foldStats(runId);
    }
    return added;
  }

  /** PRIVACY FILTER (before anything persists) → seq assign → pending. */
  private queueEvent(runId: string, event: Record<string, unknown>): number {
    const payload = filterEventForTier(event, this.tier, this.filterOptions);
    const seq = (this.cursor.perRunSeq[runId] ?? 0) + 1;
    this.cursor.perRunSeq[runId] = seq;
    this.pending.push({ runId, seq, payload });
    return 1;
  }

  private noteRunEnded(runId: string): void {
    if (!this.cursor.endedRuns.includes(runId)) this.cursor.endedRuns.push(runId);
  }

  private foldStats(runId: string): number {
    if (this.cursor.statsShipped.includes(runId)) return 0;
    const record = this.statsSource.findRunRecord(runId);
    if (record === null) return 0;
    const event = statsRecordEvent(runId, record, this.projectRoot, new Date(this.clock.now()).toISOString());
    const added = this.queueEvent(runId, event);
    this.cursor.statsShipped.push(runId);
    this.logger.info(`stats record folded for run ${runId}`);
    return added;
  }

  // ── Flush (durable spool + cursor commit) ──────────────────────────────────

  /**
   * Persist all pending events to the spool (grouped per run, chunked at the
   * batch size), advance + save the cursor, and kick the drain. Also drains
   * when nothing is pending (retry path).
   */
  flushNow(): void {
    if (this.pending.length > 0) {
      const byRun = new Map<string, IngestEventRecord[]>();
      for (const event of this.pending) {
        let records = byRun.get(event.runId);
        if (!records) {
          records = [];
          byRun.set(event.runId, records);
        }
        records.push({ seq: event.seq, payload: event.payload });
      }
      this.pending = [];

      for (const [runId, records] of byRun) {
        for (let i = 0; i < records.length; i += this.batchMaxEvents) {
          const batch: IngestBatchRequest = { run_id: runId, events: records.slice(i, i + this.batchMaxEvents) };
          const { dropped } = this.spool.append(batch);
          for (const drop of dropped) {
            this.logger.error(
              `OFFLINE BUFFER CAP HIT — dropped ${drop.eventCount} buffered events (run ${drop.runId}, seq ${drop.firstSeq}..${drop.lastSeq}); ` +
                'these events are permanently lost; the server will see a seq gap'
            );
          }
        }
      }

      this.cursor.byteOffset = this.pendingParseOffset;
      const evicted = pruneCursor(this.cursor, this.maxTrackedRuns);
      if (evicted.length > 0) {
        this.logger.warn(`seq state bound reached — evicted counters for ${evicted.length} ended run(s)`);
      }
      this.cursorStore.save(this.cursor);
    }
    void this.drain();
  }

  // ── Drain (upload with retry/backoff) ──────────────────────────────────────

  /**
   * Upload spooled chunks oldest-first. Single-flight; a retryable failure
   * schedules the next attempt with exponential backoff + jitter (core
   * policy); a non-retryable rejection sets the chunk aside as `.rejected`
   * (never silent) and continues.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const chunk = this.spool.oldest();
        if (chunk === null) return;
        const events = chunk.batch.events;
        const result = await this.transport.upload(chunk.batch);
        if (result.ok) {
          this.spool.remove(chunk.name);
          this.drainAttempt = 0;
          this.logger.debug(
            `uploaded ${events.length} events for run ${chunk.batch.run_id} ` +
              `(seq ${events[0]?.seq}..${events[events.length - 1]?.seq}; inserted=${result.ack.inserted} skipped=${result.ack.skipped})`
          );
          continue;
        }
        if (!result.retryable) {
          this.spool.reject(chunk.name);
          this.logger.error(
            `upload of run ${chunk.batch.run_id} rejected (${result.error}) — chunk set aside as ${chunk.name}.rejected`
          );
          continue;
        }
        const delay = backoffDelayMs(this.drainAttempt, this.backoff, this.rng);
        this.drainAttempt += 1;
        this.logger.warn(`upload failed (${result.error}) — retrying in ${Math.round(delay)}ms`);
        if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
        this.retryTimer = this.clock.setTimeout(() => {
          this.retryTimer = null;
          void this.drain();
        }, delay);
        return;
      }
    } finally {
      this.draining = false;
    }
  }
}
