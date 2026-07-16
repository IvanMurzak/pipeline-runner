/**
 * Connection manager — the agent's steady-state loop.
 *
 *   idle → connecting → registering → online
 *                 ↘ backoff ↗              │drop
 *                     ↖──────────────────── ┘
 *   (any) → stopped_fatal   on a fatal `register_reject` / protocol mismatch
 *   (any) → stopped         on `stop()`
 *
 * Rules encoded here:
 *   - `register` is ALWAYS the first frame sent after a transport opens.
 *   - Transports are tried in order within one attempt: if a transport fails
 *     to ESTABLISH (closes before open), the next one (long-poll fallback) is
 *     tried immediately; when all fail, the attempt ends and reconnect is
 *     scheduled with exponential backoff + jitter (capped) — see `backoff.ts`.
 *   - A fatal `register_reject` (`upgrade_required`/`invalid_token`/`revoked`)
 *     STOPS the client — no hot-loop reconnect. `capacity` retries with backoff.
 *   - After `register_ack`: persist `runner_id` (+ cadence) via the store,
 *     reset backoff, start the heartbeat loop.
 *   - Heartbeat directives: `reregister` → drop the connection and re-handshake
 *     (register is re-sent on the fresh connection); `drain` → set the
 *     draining flag (stop accepting new work — state only for now).
 *   - Missed heartbeat acks → the connection is presumed dead → reconnect.
 *
 * Inbound frames all flow through the `Dispatcher`; T1-12/T1-13 attach their
 * `lease`/`answer`/`upload_ack` handlers on `client.dispatcher` later.
 */

import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff';
import type { Clock } from './clock';
import { systemClock } from './clock';
import type { ConfigStore } from './config';
import { Dispatcher } from './dispatcher';
import { HeartbeatLoop } from './heartbeat';
import type { Logger } from './log';
import { nullLogger } from './log';
import { applyRegisterAck, buildRegisterFrame, classifyReject, describeReject } from './register';
import type { Transport, TransportConnection } from './transport';
import type { RunnerStatus, WireFrame } from './wire';
import { isCompatible, isRegisterAck, isRegisterReject, PROTOCOL_VERSION } from './wire';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'registering'
  | 'online'
  | 'backoff'
  | 'stopped'
  | 'stopped_fatal';

export const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;

export interface AgentClientEvents {
  onOnline?(runnerId: string): void;
  onFatal?(reason: string): void;
  onStateChange?(state: ConnectionState): void;
}

export interface AgentClientOptions {
  store: ConfigStore;
  /** Ordered transport ladder: primary first (WSS), then fallbacks (long-poll). */
  transports: Transport[];
  backoff?: BackoffPolicy;
  rng?: () => number;
  clock?: Clock;
  logger?: Logger;
  makeId?: () => string;
  registerTimeoutMs?: number;
  maxMissedAcks?: number;
  events?: AgentClientEvents;
}

export class AgentClient {
  readonly dispatcher: Dispatcher;

  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly rng: () => number;
  private readonly backoff: BackoffPolicy;
  private readonly makeId: () => string;
  private readonly registerTimeoutMs: number;

  private state_: ConnectionState = 'idle';
  private fatalReason_: string | null = null;
  private draining_ = false;

  private attempt = 0;
  private transportIndex = 0;
  private connection: TransportConnection | null = null;
  private opened = false;
  private registerId: string | null = null;
  private registerTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private heartbeat: HeartbeatLoop | null = null;

  constructor(private readonly options: AgentClientOptions) {
    if (options.transports.length === 0) throw new Error('AgentClient needs at least one transport');
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.rng = options.rng ?? Math.random;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.registerTimeoutMs = options.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
    this.dispatcher = new Dispatcher(this.logger);
    this.dispatcher.on('register_ack', (frame) => this.onRegisterAck(frame));
    this.dispatcher.on('register_reject', (frame) => this.onRegisterReject(frame));
    this.dispatcher.on('heartbeat_ack', (frame) => this.heartbeat?.handleAck(frame));
  }

  get state(): ConnectionState {
    return this.state_;
  }

  /** The fatal-stop reason, when `state === "stopped_fatal"`. */
  get fatalReason(): string | null {
    return this.fatalReason_;
  }

  /** True once the server directed `drain` — stop accepting new work. */
  get draining(): boolean {
    return this.draining_;
  }

  /**
   * Send a frame to the control plane over the live connection. Returns `true`
   * iff a live ONLINE connection accepted it; `false` when not `online` / no
   * connection (dropped with a debug log — never queued) — so the caller knows
   * the live channel could not deliver and decides its own retry/ignore policy.
   *
   * The sole PUBLIC send path, shared by T2-03 job execution, the T1-13
   * needs-input relay, and T1-12's shipper transport; the internal handshake /
   * heartbeat frames still go straight through `this.connection`. A `false`
   * return is NOT data loss for the relay: the parked question is journalled by
   * `drive` as an `awaiting_input` event, so the relay re-surfaces on reconnect.
   * Keep this consistent with the state model: only `online` may send.
   */
  send(frame: WireFrame): boolean {
    if (this.state_ !== 'online' || this.connection === null) {
      this.logger.debug(`frame '${frame.type}' not sent — connection not online`);
      return false;
    }
    this.connection.send(frame);
    return true;
  }

  start(): void {
    if (this.state_ !== 'idle' && this.state_ !== 'stopped' && this.state_ !== 'stopped_fatal') return;
    this.fatalReason_ = null;
    this.attempt = 0;
    this.transportIndex = 0;
    this.connect();
  }

  stop(): void {
    this.setState('stopped');
    this.clearTimers();
    this.stopHeartbeat();
    const connection = this.connection;
    this.connection = null;
    connection?.close();
  }

  private setState(state: ConnectionState): void {
    if (this.state_ === state) return;
    this.state_ = state;
    this.options.events?.onStateChange?.(state);
  }

  private clearTimers(): void {
    if (this.registerTimer !== null) {
      this.clock.clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  private connect(): void {
    const transport = this.options.transports[this.transportIndex]!;
    this.opened = false;
    this.setState('connecting');
    this.logger.info(`connecting via ${transport.name} (attempt ${this.attempt + 1})`);
    this.connection = transport.open({
      onOpen: () => this.handleOpen(),
      onFrame: (frame) => this.handleFrame(frame),
      onClose: (info) => this.handleClose(info),
    });
  }

  private handleFrame(frame: WireFrame): void {
    if (this.state_ === 'stopped' || this.state_ === 'stopped_fatal') return;
    this.dispatcher.dispatch(frame);
  }

  private handleOpen(): void {
    if (this.state_ !== 'connecting') return;
    const identity = this.options.store.load();
    if (identity === null) {
      this.fatal('no agent identity configured — run `pipeline-runner register` first');
      return;
    }
    this.opened = true;
    this.setState('registering');
    this.registerId = this.makeId();
    // The register frame is the FIRST frame on the connection, always.
    this.connection?.send(buildRegisterFrame(identity, this.registerId));
    this.registerTimer = this.clock.setTimeout(() => {
      this.logger.warn('register timed out — dropping connection');
      this.connection?.close();
    }, this.registerTimeoutMs);
  }

  private onRegisterAck(frame: WireFrame): void {
    if (this.state_ !== 'registering') {
      this.logger.debug('unexpected register_ack ignored');
      return;
    }
    if (!isRegisterAck(frame)) {
      this.logger.warn('malformed register_ack ignored');
      return;
    }
    if (frame.id !== undefined && this.registerId !== null && frame.id !== this.registerId) {
      this.logger.debug('register_ack with stale correlation id ignored');
      return;
    }
    if (!isCompatible(frame.protocol_version)) {
      this.fatal(
        `server negotiated protocol v${frame.protocol_version}, but this agent speaks v${PROTOCOL_VERSION} — update the agent`
      );
      return;
    }
    if (this.registerTimer !== null) {
      this.clock.clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    const identity = applyRegisterAck(this.options.store, frame);
    this.attempt = 0;
    this.transportIndex = 0;
    this.setState('online');
    this.logger.info(`registered as ${frame.runner_id}`);
    this.heartbeat = new HeartbeatLoop({
      runnerId: frame.runner_id,
      intervalS: identity.heartbeat_interval_s,
      send: (hb) => this.connection?.send(hb),
      status: (): RunnerStatus => (this.draining_ ? 'draining' : 'online'),
      activeRunIds: () => [],
      onDirective: (directive) => {
        if (directive === 'drain') {
          this.draining_ = true;
          this.logger.info('draining: no new work will be accepted');
        } else {
          this.logger.info('reregister directed — re-handshaking');
          this.connection?.close();
        }
      },
      onMissedAcks: (misses) => {
        this.logger.warn(`${misses} heartbeat acks missed — presuming connection dead`);
        this.connection?.close();
      },
      maxMissedAcks: this.options.maxMissedAcks,
      makeId: this.makeId,
      clock: this.clock,
      logger: this.logger,
    });
    this.heartbeat.start();
    this.options.events?.onOnline?.(frame.runner_id);
  }

  private onRegisterReject(frame: WireFrame): void {
    if (this.state_ !== 'registering') {
      this.logger.debug('unexpected register_reject ignored');
      return;
    }
    if (!isRegisterReject(frame)) {
      this.logger.warn('malformed register_reject ignored');
      return;
    }
    if (this.registerTimer !== null) {
      this.clock.clearTimeout(this.registerTimer);
      this.registerTimer = null;
    }
    const message = describeReject(frame);
    if (classifyReject(frame.reason) === 'fatal') {
      this.fatal(message);
      return;
    }
    this.logger.warn(`register rejected: ${message}`);
    this.connection?.close(); // → handleClose → backoff → retry
  }

  private fatal(reason: string): void {
    this.fatalReason_ = reason;
    this.logger.error(`fatal: ${reason}`);
    this.clearTimers();
    this.stopHeartbeat();
    const connection = this.connection;
    this.connection = null;
    this.setState('stopped_fatal'); // set BEFORE close so handleClose no-ops
    connection?.close();
    this.options.events?.onFatal?.(reason);
  }

  private handleClose(info: { error?: string }): void {
    if (this.state_ === 'stopped' || this.state_ === 'stopped_fatal' || this.state_ === 'backoff') return;
    const wasEstablished = this.opened;
    this.opened = false;
    this.clearTimers();
    this.stopHeartbeat();
    this.connection = null;
    if (info.error) this.logger.warn(`connection closed: ${info.error}`);

    // A transport that failed to ESTABLISH falls through to the next one
    // (WSS → long-poll) within the same attempt.
    if (!wasEstablished && this.transportIndex < this.options.transports.length - 1) {
      const failed = this.options.transports[this.transportIndex]!.name;
      this.transportIndex += 1;
      const next = this.options.transports[this.transportIndex]!.name;
      this.logger.warn(`${failed} failed to establish — falling back to ${next}`);
      this.connect();
      return;
    }

    this.transportIndex = 0;
    const delay = backoffDelayMs(this.attempt, this.backoff, this.rng);
    this.attempt += 1;
    this.setState('backoff');
    this.logger.info(`reconnecting in ${Math.round(delay)}ms`);
    this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delay);
  }
}
