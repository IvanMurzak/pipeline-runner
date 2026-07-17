/**
 * Heartbeat loop. After `register_ack` the connection starts one of these; it
 * sends a `heartbeat` frame every `heartbeat_interval_s` (server-stated, or
 * `DEFAULT_HEARTBEAT_INTERVAL_S`) carrying `runner_id`, `active_run_ids`,
 * `status`, `paused_until`, and the `runs_authoritative` capability flag.
 *
 * `active_run_ids` / `status` / `paused_until` are composed from the caller's
 * accessors (the connection threads in the `JobManager`'s truthful
 * `activeRunIds()` / `runnerStatus()` / `pausedUntil()` — c2 wiring); absent
 * accessors default to the pre-wiring stub (`[]` / `"online"` / `null`).
 *
 * `runs_authoritative: true` is EMITTED UNCONDITIONALLY (design decision D13,
 * capability-keyed not presence-keyed): the cloud only applies per-run lease
 * logic when this flag is present, so a caller that has NOT wired real
 * `activeRunIds`/`status` accessors would otherwise be lying about
 * exhaustiveness. This loop's `[]`/`"online"` defaults ARE exhaustively true
 * in that case (no accessor ⇒ no job manager attached ⇒ genuinely zero active
 * runs — e.g. the `register` command's ephemeral validation connection), so
 * the flag is always safe to emit from this loop.
 *
 * Each beat sets a fresh correlation `id`; the matching `heartbeat_ack` is
 * paired by that id via `handleAck`. Ack directives:
 *   - `reregister` → surfaced via `onDirective` (the connection re-handshakes)
 *   - `drain`      → surfaced via `onDirective` (the client stops accepting
 *                    new work — state only for now) AND subsequent beats
 *                    report the drained status the `status()` callback returns.
 *   - `none`/absent → nothing.
 *
 * Liveness: if a beat comes due while previous beats are still unacked, that
 * is a MISS; after `maxMissedAcks` consecutive misses `onMissedAcks` fires so
 * the connection can declare the socket dead and reconnect.
 *
 * All timing goes through the injectable `Clock`.
 */

import type { Clock } from './clock';
import { systemClock } from './clock';
import type { Logger } from './log';
import { nullLogger } from './log';
import type { HeartbeatDirective, HeartbeatMessage, RunnerStatus, WireFrame } from './wire';
import { isHeartbeatAck } from './wire';

/** Cadence used when `register_ack` does not state one. */
export const DEFAULT_HEARTBEAT_INTERVAL_S = 30;

/** Consecutive missed acks before the connection is presumed dead. */
export const DEFAULT_MAX_MISSED_ACKS = 2;

export interface HeartbeatOptions {
  runnerId: string;
  /** Send a frame on the live connection. */
  send(frame: HeartbeatMessage): void;
  /** Cadence in seconds; defaults to `DEFAULT_HEARTBEAT_INTERVAL_S`. */
  intervalS?: number;
  /** Called on a `reregister` or `drain` ack directive. */
  onDirective?(directive: Exclude<HeartbeatDirective, 'none'>): void;
  /** Called when `maxMissedAcks` consecutive beats went unacked. */
  onMissedAcks?(misses: number): void;
  maxMissedAcks?: number;
  /** Current in-flight run ids; absent ⇒ `[]`. */
  activeRunIds?(): string[];
  /** Current runner status; defaults to "online". */
  status?(): RunnerStatus;
  /** ISO time the earliest provider-limit-paused job auto-resumes, or null
   *  when nothing is paused; absent ⇒ `null`. */
  pausedUntil?(): string | null;
  makeId?(): string;
  clock?: Clock;
  logger?: Logger;
}

export class HeartbeatLoop {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly maxMissedAcks: number;
  private readonly makeId: () => string;

  private readonly pending = new Map<string, number>();
  private misses = 0;
  private timer: unknown = null;
  private running = false;
  private beats = 0;

  constructor(private readonly options: HeartbeatOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.intervalMs = (options.intervalS ?? DEFAULT_HEARTBEAT_INTERVAL_S) * 1000;
    this.maxMissedAcks = options.maxMissedAcks ?? DEFAULT_MAX_MISSED_ACKS;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
  }

  /** Number of heartbeat frames sent so far. */
  get sentCount(): number {
    return this.beats;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.misses = 0;
  }

  /**
   * Feed a `heartbeat_ack` frame (the connection routes these here). Pairs by
   * correlation id; unmatched or malformed acks are logged and ignored.
   */
  handleAck(frame: WireFrame): void {
    if (!isHeartbeatAck(frame)) {
      this.logger.warn('malformed heartbeat_ack ignored');
      return;
    }
    if (frame.id === undefined || !this.pending.has(frame.id)) {
      this.logger.debug('unmatched heartbeat_ack ignored');
      return;
    }
    this.pending.delete(frame.id);
    this.misses = 0;
    const directive = frame.directive ?? 'none';
    if (directive === 'reregister' || directive === 'drain') {
      this.logger.info(`server directive: ${directive}`);
      this.options.onDirective?.(directive);
    }
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => this.beat(), this.intervalMs);
  }

  private beat(): void {
    if (!this.running) return;
    if (this.pending.size > 0) {
      this.misses += 1;
      this.logger.warn(`heartbeat ack overdue (${this.misses}/${this.maxMissedAcks})`);
      if (this.misses >= this.maxMissedAcks) {
        this.options.onMissedAcks?.(this.misses);
        // The connection typically stops this loop from onMissedAcks; if it
        // chose not to, keep beating — the socket may yet recover.
        if (!this.running) return;
      }
    }
    const id = this.makeId();
    this.pending.set(id, this.clock.now());
    const frame: HeartbeatMessage = {
      type: 'heartbeat',
      id,
      runner_id: this.options.runnerId,
      active_run_ids: this.options.activeRunIds?.() ?? [],
      status: this.options.status?.() ?? 'online',
      paused_until: this.options.pausedUntil?.() ?? null,
      // D13 — capability-keyed heartbeat semantics; see the module doc for
      // why this is safe to emit unconditionally from this loop.
      runs_authoritative: true,
    };
    this.beats += 1;
    try {
      this.options.send(frame);
    } catch (err) {
      this.logger.warn(`heartbeat send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.running) this.schedule();
  }
}
