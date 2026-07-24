/**
 * `DepartmentManager` — the department-mesh supervisor (task d1): admission,
 * lifecycle-strategy policy (`per-task` / `per-context` / `daemon`,
 * `07-runtime-contract.md` §5), capability-aware message routing, and
 * wiring the normalized `RuntimeEvent` stream into the EXISTING shipper
 * (`../shipper/shipper.ts`) via a runner-local journal (§8).
 *
 * Deliberately PARALLEL to `../jobs/manager.ts`, not a modification of it —
 * `pipeline drive` dispatch is untouched; this is a second admission surface
 * for department tasks, mirroring the shape (adapter registry instead of one
 * hard-coded contract, `admitTask` instead of `handleLease`) without sharing
 * state. Porting `pipeline drive` itself onto the adapter abstraction is task
 * d4.
 *
 * ── Real leases, reject, process-group kill, deadlines (d2) ─────────────────
 * `department.lease_renew` is sent at TTL/3 on the EXISTING heartbeat cadence
 * — `renewLeases()` is called from the connection's `onBeat` hook (`../cli.ts`,
 * same seam `JobManager.touchActiveRecords()` already rides), never a second
 * timer (07 §6). `department.lease_revoked` (cloud → runner) stops work and
 * ships NOTHING further for that execution. Cancellation
 * (`cancelExecution`/`terminateExecution`) always finalizes PROMPTLY — it
 * politely asks (`adapter.cancel()` → `task.cancel`) and then immediately
 * reports terminal, which disposes the handle; `./jsonl-process.ts`'s
 * `dispose()` is what actually SIGTERMs the process GROUP and SIGKILLs it
 * after `gracefulShutdownSeconds` (07 §7) — cancellation is never left
 * waiting indefinitely on the runtime's cooperation. Every execution also
 * carries a wall-clock DEADLINE (`offer.deadline_at`, armed at admission) and
 * a PARK-EXPIRY timer (armed whenever the runtime asks `input_required`,
 * cleared on answer/respawn/terminal) — both route through the same
 * `terminateExecution` finalize-now path on expiry, so neither can wait
 * forever.
 *
 * ── Wire frame shapes (e1 repin) ─────────────────────────────────────────────
 * `@baizor/pipeline-protocol` 0.4.0 carries the real mesh schemas (08-
 * protocol-delta.md) as of the e1 gate. `department.offer` is parsed with
 * `DeptOfferMessageSchema`; `department.message` is validated against
 * `DeptMessageSchema`; outgoing `department.accept` / `department.reject` /
 * `department.event` frames are built as real, typed `Dept*Message` shapes.
 * The runner-LOCAL `DeptMessage`/`Part` types (`./adapter.ts`) stay camelCase
 * domain types distinct from the wire's snake_case shapes by design (see
 * `./adapter.ts`'s module doc) — this file is the translation boundary.
 *
 * ── Event delivery (e1 fix — see the e1 gate report) ─────────────────────────
 * d1 originally shipped `RuntimeEvent`s through the EXISTING pipeline shipper
 * (tail -> filter -> seq -> batch -> spool -> drain -> `upload` frame ->
 * `ingestBatch`), reading 07 §8 ("mesh runtime events reach the cloud through
 * the existing shipper") as "reuse the exact `upload` wire frame". That is a
 * genuine integration bug, not a protocol schema bug: `ingestBatch`
 * (`cloud/apps/api/src/modules/runs/ingest.ts`) resolves an unknown `run_id`
 * by CREATING a new `runs` row (`findRunByReportedId(...) ?? createRun(...)`)
 * — a department execution id has no `dept_executions` counterpart there, so
 * every mesh event would silently fabricate a phantom pipeline `runs` row and
 * NEVER reach `dept_task_events` / `transitionTask` / `appendMessage`. The
 * cloud's `department.event` handler (08 §5) was always the intended
 * destination. Fixed here: `RuntimeEvent`s are shipped as real
 * `department.event` wire frames sent directly on the connection (`seq`
 * seeded from the offer's `event_seq_base`, 08 §4's attempt-fencing
 * convention), NOT through the shipper/`ingestBatch` path. The local journal
 * file write is KEPT (harmless, useful for on-disk audit) but is no longer
 * wired to a shipper/transport. `department.artifact` (chunked upload) stays
 * OUT of scope here — 08 §6 / P4 (task c9/d3); an `artifact` `RuntimeEvent` is
 * journalled locally and logged, not yet shipped.
 *
 * ── Lifecycle policy, concretely ────────────────────────────────────────────
 *   - `per-task`: one `adapter.start()` per execution; disposed at terminal.
 *   - `per-context`: same as `per-task` at the wire-contract level (07 §3:
 *     the process exits after `task.completed`/`task.failed` regardless of
 *     lifecycle, EXCEPT `daemon`) — what's special is CRASH RECOVERY: a
 *     process that dies unexpectedly WHILE working (`failed`+`retrySafe`)
 *     gets exactly ONE silent auto-respawn with the full retained message
 *     history replayed, so the task continues instead of failing outright.
 *     Idle eviction (no runtime activity for `perContextIdleMs`) disposes a
 *     stuck handle the same way a crash does — the next message/respawn
 *     picks it back up.
 *   - `daemon`: the ONE case a live handle is reused across tasks — a new
 *     task for the same runtime rides `adapter.send(handle,
 *     {kind:'task.start', task})` instead of a fresh `adapter.start()`.
 *     (Not exercised end-to-end by this task's admission path yet — the
 *     seam exists on the adapter interface and is unit-tested there; wiring
 *     multiple concurrent tasks onto one daemon handle through `admitTask`
 *     is left to the task that actually needs it, to avoid speculative
 *     surface here.)
 */

import { dirname, join } from 'node:path';
import * as nodeFs from 'node:fs';
import {
  DeptOfferMessageSchema,
  DeptMessageSchema as WireDeptMessageSchema,
} from '@baizor/pipeline-protocol';
import type {
  DeptEventMessage,
  DeptMessage as WireDeptMessage,
  DeptPart as WireDeptPart,
  DeptRuntimeEvent,
} from '@baizor/pipeline-protocol';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Dispatcher } from '../core/dispatcher';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
import { defaultDataDir } from '../shipper/fs';
import type {
  AgentRuntimeAdapter,
  DeptMessage,
  DeptTaskSpec,
  InvocationEnvelope,
  Part,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeLifecycle,
} from './adapter';
import { buildDepartmentJournalEnvelope } from './events';

// ── The journal-writer seam (runner IS the journal writer here — unlike
//    pipeline runs, where pipeline-cli writes events.jsonl, nothing external
//    produces this file) ───────────────────────────────────────────────────

export interface JournalWriter {
  ensureDir(path: string): void;
  appendLine(path: string, line: string): void;
}

export function nodeJournalWriter(): JournalWriter {
  return {
    ensureDir: (path) => nodeFs.mkdirSync(path, { recursive: true }),
    appendLine: (path, line) => nodeFs.appendFileSync(path, `${line}\n`, 'utf8'),
  };
}

// ── Admission input/result ──────────────────────────────────────────────────

export interface DepartmentOfferInput {
  executionId: string;
  taskId: string;
  contextId: string;
  departmentId: string;
  messages: DeptMessage[];
  acceptedOutputModes?: string[];
  deadlineAt?: string;
  /** Starting shipper sequence number for this attempt's `department.event`s
   *  (08 §4's `attempt × 1_000_000` attempt-fencing convention). Optional so
   *  direct `admitTask()` callers (tests; `makeOffer()`) that don't care about
   *  cross-attempt sequence collisions may omit it — defaults to 0. */
  eventSeqBase?: number;
  /** Lease-scoped renewal credential (d2, 07 §6) — mirrors `job_jwt` on the
   *  pipeline-dispatch `LeaseMessage`. Optional so direct `admitTask()`
   *  callers that don't exercise renewal may omit it; renewal is simply
   *  skipped for an execution with no lease token/ttl recorded. */
  leaseToken?: string;
  leaseTtlS?: number;
}

export type DepartmentRejectReason = 'busy' | 'capability' | 'policy' | 'broken_runtime';
export type AdmitResult = { accepted: true } | { accepted: false; reason: DepartmentRejectReason };

export interface DepartmentManagerOptions {
  adapters: AgentRuntimeAdapter[];
  /** Resolve a `department_id` to how to run it. Null ⇒ unknown department
   *  (`capability` reject) — the config_update caching this reads from is a
   *  separate concern (c2/config wiring), intentionally not built here. */
  resolveRuntimeConfig(departmentId: string): RuntimeConfig | null;
  send(frame: WireFrame): boolean;
  /** The agent connection's dispatcher — both for `attach()`'s inbound
   *  frames and the default `WireUploadTransport`'s `upload_ack` handler. */
  dispatcher: Pick<Dispatcher, 'on'>;
  /** Root dir each execution's journal lives under: `<root>/<executionId>/events.jsonl`. */
  journalRoot?: string;
  journal?: JournalWriter;
  capacity?(): number;
  draining?(): boolean;
  /** `per-context` idle window before an inactive handle is disposed (the
   *  next message/respawn picks the context back up). Default 15 minutes. */
  perContextIdleMs?: number;
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  env?: Record<string, string | undefined>;
}

const DEFAULT_CAPACITY = 4;
const DEFAULT_PER_CONTEXT_IDLE_MS = 15 * 60_000;
/** Fallback park-expiry (d2, 07 §7) when neither the offer nor
 *  `RuntimeConfig.parkExpirySeconds` states one — matches the design's own
 *  `parkExpiry` example (`"7d"`, `08-protocol-delta.md` §4's `DeptLimits`). */
const DEFAULT_PARK_EXPIRY_S = 7 * 24 * 60 * 60;

interface ExecutionState {
  executionId: string;
  taskId: string;
  contextId: string;
  departmentId: string;
  adapter: AgentRuntimeAdapter;
  runtime: RuntimeConfig;
  lifecycle: RuntimeLifecycle;
  handle: RuntimeHandle | null;
  /** Every message exchanged so far, both directions, in order — the replay
   *  substrate for a `per-context` respawn (07 §5: "the next message
   *  restarts it with the message history"). */
  messageHistory: DeptMessage[];
  /** Messages that arrived while there was no live/capable handle to take
   *  them; folded into `messageHistory`'s `task.start` on the next spawn. */
  pendingQueue: DeptMessage[];
  terminal: boolean;
  /** Bounds crash-recovery to ONE silent auto-respawn per execution — never
   *  an infinite crash loop. */
  respawnAttempted: boolean;
  lastActivityAt: number;
  journalPath: string;
  /** Next `department.event.seq` to send — seeded from the offer's
   *  `event_seq_base` (08 §4 attempt-fencing), incremented per shipped event. */
  nextSeq: number;
  idleTimer: unknown;
  // ── d2: leases, deadline, park-expiry ──────────────────────────────────
  /** Null when this execution was admitted without lease info (direct
   *  `admitTask()` callers) — `renewLeases()` simply skips it. */
  leaseToken: string | null;
  leaseTtlS: number | null;
  /** Clock-ms of the last `department.lease_renew` actually sent (or of
   *  admission, before the first renewal) — `renewLeases()` fires again once
   *  `leaseTtlS/3` has elapsed since this. */
  lastLeaseRenewalAt: number;
  /** Wall-clock deadline this execution was offered (07 §7), or null when
   *  admitted without one (direct `admitTask()` callers) — no timer armed. */
  deadlineAtIso: string | null;
  deadlineTimer: unknown;
  /** Armed whenever the runtime reports `input_required`; cleared on answer
   *  delivery, respawn, or terminal — the DoD's "a parked question expires
   *  at the department's park expiry, not never". */
  parkTimer: unknown;
}

export class DepartmentManager {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly journalRoot: string;
  private readonly journal: JournalWriter;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly makeId: () => string;
  private readonly perContextIdleMs: number;

  constructor(private readonly options: DepartmentManagerOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter);
    this.journalRoot = options.journalRoot ?? join(defaultDataDir(options.env), 'department');
    this.journal = options.journal ?? nodeJournalWriter();
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.perContextIdleMs = options.perContextIdleMs ?? DEFAULT_PER_CONTEXT_IDLE_MS;
  }

  /** Executions currently running (not terminal) — parity with
   *  `JobManager.activeCount` for future heartbeat/capacity composition. */
  get activeCount(): number {
    return [...this.executions.values()].filter((e) => !e.terminal).length;
  }

  // ── Wire attachment ────────────────────────────────────────────────────

  attach(dispatcher: Pick<Dispatcher, 'on'> = this.options.dispatcher): () => void {
    const offOffer = dispatcher.on('department.offer', (frame) => void this.handleOfferFrame(frame));
    const offMessage = dispatcher.on('department.message', (frame) => void this.handleMessageFrame(frame));
    const offCancel = dispatcher.on('department.cancel', (frame) => void this.handleCancelFrame(frame));
    const offLeaseRevoked = dispatcher.on('department.lease_revoked', (frame) => this.handleLeaseRevokedFrame(frame));
    return () => {
      offOffer();
      offMessage();
      offCancel();
      offLeaseRevoked();
    };
  }

  private async handleOfferFrame(frame: WireFrame): Promise<void> {
    const offer = narrowOfferFrame(frame);
    if (offer === null) {
      this.logger.warn('malformed department.offer ignored');
      return;
    }
    const result = await this.admitTask(offer);
    if (result.accepted) {
      this.options.send(buildDepartmentAcceptFrame(offer));
    } else {
      this.options.send(buildDepartmentRejectFrame(offer.executionId, result.reason));
    }
  }

  private async handleMessageFrame(frame: WireFrame): Promise<void> {
    const f = frame as Record<string, unknown>;
    if (typeof f.execution_id !== 'string' || f.execution_id.length === 0) {
      this.logger.warn('malformed department.message ignored (missing execution_id)');
      return;
    }
    const message = narrowWireMessage(f.message);
    if (message === null) {
      this.logger.warn(`malformed department.message ignored (execution ${f.execution_id})`);
      return;
    }
    await this.deliverMessage(f.execution_id, message);
  }

  private async handleCancelFrame(frame: WireFrame): Promise<void> {
    const f = frame as Record<string, unknown>;
    if (typeof f.execution_id !== 'string' || f.execution_id.length === 0) {
      this.logger.warn('malformed department.cancel ignored (missing execution_id)');
      return;
    }
    await this.cancelExecution(f.execution_id, typeof f.reason === 'string' ? f.reason : undefined);
  }

  // ── Admission ──────────────────────────────────────────────────────────

  /**
   * Admit one department task offer: capacity/draining/adapter-known checks,
   * then `adapter.start()`. Callable directly (bypassing the wire layer) —
   * the wire handler above is a thin adapter over this.
   */
  async admitTask(offer: DepartmentOfferInput): Promise<AdmitResult> {
    if (this.options.draining?.() === true) return { accepted: false, reason: 'policy' };
    const capacity = this.options.capacity?.() ?? DEFAULT_CAPACITY;
    if (this.activeCount >= capacity) return { accepted: false, reason: 'busy' };
    if (this.executions.has(offer.executionId)) {
      // Redelivered offer for an execution we already admitted — idempotent.
      return { accepted: true };
    }

    const runtime = this.options.resolveRuntimeConfig(offer.departmentId);
    if (runtime === null) return { accepted: false, reason: 'capability' };
    const adapter = this.adapters.get(runtime.adapterId);
    if (adapter === undefined) return { accepted: false, reason: 'capability' };

    const journalPath = join(this.journalRoot, sanitizeForPath(offer.executionId), 'events.jsonl');
    this.journal.ensureDir(dirname(journalPath));

    const state: ExecutionState = {
      executionId: offer.executionId,
      taskId: offer.taskId,
      contextId: offer.contextId,
      departmentId: offer.departmentId,
      adapter,
      runtime,
      lifecycle: runtime.lifecycle ?? 'per-task',
      handle: null,
      messageHistory: [...offer.messages],
      pendingQueue: [],
      terminal: false,
      respawnAttempted: false,
      lastActivityAt: this.clock.now(),
      journalPath,
      nextSeq: offer.eventSeqBase ?? 0,
      idleTimer: null,
      leaseToken: offer.leaseToken ?? null,
      leaseTtlS: offer.leaseTtlS ?? null,
      lastLeaseRenewalAt: this.clock.now(),
      deadlineAtIso: offer.deadlineAt ?? null,
      deadlineTimer: null,
      parkTimer: null,
    };
    this.executions.set(offer.executionId, state);
    this.armDeadlineTimer(state);

    const started = await this.spawnAndStart(state);
    return started ? { accepted: true } : { accepted: false, reason: 'broken_runtime' };
  }

  // ── d2: lease renewal (called from the connection's heartbeat `onBeat`
  //    hook, `../cli.ts` — rides the EXISTING cadence, never a 2nd timer,
  //    07 §6) ────────────────────────────────────────────────────────────

  /** Send `department.lease_renew` for every non-terminal execution whose
   *  lease is due (TTL/3 since the last renewal, or since admission). A
   *  failed send (runner offline) is retried on the next beat — never marked
   *  renewed. */
  renewLeases(): void {
    const now = this.clock.now();
    for (const state of this.executions.values()) {
      if (state.terminal || state.leaseToken === null || state.leaseTtlS === null) continue;
      const renewEveryMs = (state.leaseTtlS * 1000) / 3;
      if (now - state.lastLeaseRenewalAt < renewEveryMs) continue;
      const sent = this.options.send({
        type: 'department.lease_renew',
        execution_id: state.executionId,
        lease_token: state.leaseToken,
      });
      if (sent) {
        state.lastLeaseRenewalAt = now;
      } else {
        this.logger.warn(`department execution ${state.executionId}: lease_renew not sent — connection not online`);
      }
    }
  }

  // ── d2: lease revocation (cloud → runner) ───────────────────────────────

  private handleLeaseRevokedFrame(frame: WireFrame): void {
    const f = frame as Record<string, unknown>;
    if (typeof f.execution_id !== 'string' || f.execution_id.length === 0) {
      this.logger.warn('malformed department.lease_revoked ignored (missing execution_id)');
      return;
    }
    this.handleLeaseRevoked(f.execution_id, typeof f.reason === 'string' && f.reason.length > 0 ? f.reason : 'lease revoked');
  }

  /** `department.lease_revoked` (07 §6): "stop; do not report further state".
   *  Marks the execution terminal WITHOUT going through `reportTerminal` (that
   *  would ship a final `department.event` — exactly the "further state" this
   *  frame says not to report) and tears the runtime down locally,
   *  best-effort. */
  private handleLeaseRevoked(executionId: string, reason: string): void {
    const state = this.executions.get(executionId);
    if (state === undefined || state.terminal) return;
    this.logger.warn(`department execution ${executionId}: lease revoked (${reason}) — stopping locally, reporting nothing further`);
    state.terminal = true;
    this.clearIdleTimer(state);
    this.clearDeadlineTimer(state);
    this.clearParkTimer(state);
    const handle = state.handle;
    state.handle = null;
    if (handle !== null) {
      void state.adapter.cancel(handle, reason).catch(() => {
        /* best-effort — the lease is already gone either way */
      });
      void state.adapter.dispose(handle).catch((err) => {
        this.logger.warn(`department execution ${executionId}: dispose() after lease_revoked failed: ${describeError(err)}`);
      });
    }
  }

  /** Deliver mid-task input. Live + capable ⇒ sent immediately. Otherwise
   *  queued and, if there is no live handle at all, a respawn is kicked off
   *  (07 §3's "queues it and delivers at the next task.start"). */
  async deliverMessage(executionId: string, message: DeptMessage): Promise<{ delivered: boolean; reason?: string }> {
    const state = this.executions.get(executionId);
    if (state === undefined || state.terminal) return { delivered: false, reason: 'unknown or terminal execution' };
    state.lastActivityAt = this.clock.now();
    state.messageHistory.push(message);

    // An answer (or anything else fed in) ends the current parked wait — the
    // park-expiry timer, if one is armed, no longer applies (d2).
    this.clearParkTimer(state);

    if (state.handle !== null && state.handle.capabilities.midTaskInput) {
      await state.adapter.send(state.handle, { kind: 'message', message });
      return { delivered: true };
    }
    state.pendingQueue.push(message);
    if (state.handle === null) {
      void this.spawnAndStart(state);
      return { delivered: false, reason: 'no live process for this context — respawning' };
    }
    return { delivered: false, reason: 'runtime does not accept mid-task input — queued for the next task.start' };
  }

  /**
   * `department.cancel` (d2, 07 §7): politely ask (`adapter.cancel()` →
   * `task.cancel`), then finalize IMMEDIATELY — never wait on the runtime's
   * cooperation. Finalizing calls `reportTerminal`, which disposes the
   * handle; `./jsonl-process.ts`'s `dispose()` is what actually SIGTERMs the
   * process GROUP and SIGKILLs it after `gracefulShutdownSeconds` if it is
   * still alive. Bounded, deterministic — not "wait for task.failed/exit".
   */
  async cancelExecution(executionId: string, reason?: string): Promise<void> {
    const state = this.executions.get(executionId);
    if (state === undefined || state.terminal) return;
    await this.terminateExecution(state, reason ?? 'canceled', false);
  }

  /** Shared finalize-now path for cancellation, a blown wall-clock deadline,
   *  and an expired park (d2) — all three are "stop this execution, do not
   *  wait for the runtime to agree", differing only in the reported reason. */
  private async terminateExecution(state: ExecutionState, reason: string, retrySafe: boolean): Promise<void> {
    if (state.handle !== null) {
      try {
        await state.adapter.cancel(state.handle, reason);
      } catch (err) {
        this.logger.warn(`department execution ${state.executionId}: cancel() failed: ${describeError(err)}`);
      }
    }
    await this.reportTerminal(state, { type: 'failed', reason, retrySafe });
  }

  // ── Spawn / respawn ────────────────────────────────────────────────────

  private async spawnAndStart(state: ExecutionState): Promise<boolean> {
    state.pendingQueue = []; // its contents are already IN messageHistory — see deliverMessage
    const task: DeptTaskSpec = { taskId: state.taskId, contextId: state.contextId, messages: state.messageHistory };
    const invocation: InvocationEnvelope = {
      runtime: state.runtime,
      task,
      // Enforcement is THIS manager's job (armDeadlineTimer, d2, 07 §7) —
      // surfaced here too only because an adapter MAY use it natively
      // (adapter.ts's doc); jsonl-process does not read it.
      ...(state.deadlineAtIso !== null ? { deadlineAt: state.deadlineAtIso } : {}),
    };
    try {
      const handle = await state.adapter.start(invocation, (event) => this.handleRuntimeEvent(state, event));
      state.handle = handle;
      state.lastActivityAt = this.clock.now();
      this.armIdleTimer(state);
      return true;
    } catch (err) {
      this.logger.warn(`department execution ${state.executionId}: start() failed: ${describeError(err)}`);
      await this.reportTerminal(state, { type: 'failed', reason: describeError(err), retrySafe: false });
      return false;
    }
  }

  private handleRuntimeEvent(state: ExecutionState, event: RuntimeEvent): void {
    if (state.terminal) return; // a stale handle's straggling line after finalize
    state.lastActivityAt = this.clock.now();

    // Crash recovery (per-context only, bounded to one silent respawn): the
    // process is gone but the task is not actually done — continue instead
    // of failing outright.
    if (event.type === 'failed' && event.retrySafe && state.lifecycle === 'per-context' && !state.respawnAttempted) {
      state.respawnAttempted = true;
      state.handle = null;
      this.clearIdleTimer(state);
      this.clearParkTimer(state); // the OLD process's parked wait is moot — the new one starts fresh
      this.logger.warn(
        `department execution ${state.executionId}: runtime gone (${event.reason}) — respawning with ${state.messageHistory.length} replayed message(s)`
      );
      void this.spawnAndStart(state);
      return;
    }

    if (event.type === 'message') {
      state.messageHistory.push({
        messageId: this.makeId(),
        role: 'ROLE_AGENT',
        parts: event.parts,
        taskId: state.taskId,
        contextId: state.contextId,
      });
    }

    // A midTaskInput:false runtime that just asked a question can never
    // receive the answer live — evict it now so the answer (whenever it
    // arrives via deliverMessage) triggers a respawn instead of waiting on
    // a process that structurally cannot use it.
    if (event.type === 'input_required' && state.handle !== null && !state.handle.capabilities.midTaskInput) {
      const handle = state.handle;
      state.handle = null;
      this.clearIdleTimer(state);
      void state.adapter.dispose(handle).catch((err) => {
        this.logger.warn(`department execution ${state.executionId}: dispose() after input_required failed: ${describeError(err)}`);
      });
    }

    // A parked question inherits the department's park expiry rather than
    // waiting forever (d2, 07 §7) — armed whether or not the handle above
    // was just evicted; `deliverMessage()`/respawn clear it.
    if (event.type === 'input_required') {
      this.armParkTimer(state);
    }

    if (event.type === 'completed' || event.type === 'failed') {
      void this.reportTerminal(state, event);
      return;
    }
    this.journalRuntimeEvent(state, event);
    this.shipDepartmentEvent(state, event);
  }

  private async reportTerminal(state: ExecutionState, event: Extract<RuntimeEvent, { type: 'completed' } | { type: 'failed' }>): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    this.clearIdleTimer(state);
    this.clearDeadlineTimer(state);
    this.clearParkTimer(state);
    this.journalRuntimeEvent(state, event);
    this.shipDepartmentEvent(state, event);
    if (state.handle !== null) {
      const handle = state.handle;
      state.handle = null;
      try {
        await state.adapter.dispose(handle);
      } catch (err) {
        this.logger.warn(`department execution ${state.executionId}: dispose() failed: ${describeError(err)}`);
      }
    }
  }

  private journalRuntimeEvent(state: ExecutionState, event: RuntimeEvent): void {
    const envelope = buildDepartmentJournalEnvelope({
      executionId: state.executionId,
      taskId: state.taskId,
      contextId: state.contextId,
      event,
      nowIso: new Date(this.clock.now()).toISOString(),
    });
    this.journal.appendLine(state.journalPath, JSON.stringify(envelope));
  }

  /**
   * Ship a `RuntimeEvent` to the cloud as a real `department.event` wire
   * frame (e1 fix — see the module doc's "Event delivery" note). `artifact`
   * events are NOT shipped here — 08 §6 gives artifacts their own dedicated
   * `department.artifact` chunked-upload frame (P4 / task c9-d3), out of
   * scope for this manager; they are journalled locally and logged only.
   * Best-effort: `options.send` returning false (runner offline) is logged,
   * not queued/retried — a durable per-execution event outbox is future work
   * (mirrors `gatewayRegistry.sendToRunner`'s own best-effort semantics on
   * the cloud -> runner leg).
   */
  private shipDepartmentEvent(state: ExecutionState, event: RuntimeEvent): void {
    if (event.type === 'artifact') {
      this.logger.warn(
        `department execution ${state.executionId}: artifact "${event.name}" journalled locally only — department.artifact upload is not yet wired (P4 scope)`,
      );
      return;
    }
    const seq = state.nextSeq;
    state.nextSeq += 1;
    const frame = buildDepartmentEventFrame(state, event, seq);
    if (!this.options.send(frame)) {
      this.logger.warn(
        `department execution ${state.executionId}: department.event seq ${seq} (${event.type}) not sent — runner offline`,
      );
    }
  }

  // ── Idle eviction (per-context) ────────────────────────────────────────

  private armIdleTimer(state: ExecutionState): void {
    this.clearIdleTimer(state);
    if (state.lifecycle !== 'per-context') return;
    state.idleTimer = this.clock.setTimeout(() => this.checkIdle(state), this.perContextIdleMs);
  }

  private clearIdleTimer(state: ExecutionState): void {
    if (state.idleTimer !== null) {
      this.clock.clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  private checkIdle(state: ExecutionState): void {
    if (state.terminal || state.handle === null) return;
    const idleFor = this.clock.now() - state.lastActivityAt;
    if (idleFor < this.perContextIdleMs) {
      this.armIdleTimer(state); // spurious wake (activity bumped lastActivityAt) — re-check later
      return;
    }
    this.logger.info(`department execution ${state.executionId}: idle ${idleFor}ms — evicting (per-context)`);
    const handle = state.handle;
    state.handle = null;
    void state.adapter.dispose(handle).catch((err) => {
      this.logger.warn(`department execution ${state.executionId}: dispose() on idle-evict failed: ${describeError(err)}`);
    });
    // No re-arm: a future deliverMessage()/respawn re-establishes activity.
  }

  // ── d2: wall-clock deadline (07 §7) ─────────────────────────────────────

  /** Arm the execution's deadline timer from `state.deadlineAtIso` (the
   *  offer's `deadline_at`) — a no-op when admitted without one (direct
   *  `admitTask()` test callers). Armed ONCE, at admission; unaffected by
   *  per-context respawns (the deadline bounds the whole EXECUTION, not any
   *  one process instance). */
  private armDeadlineTimer(state: ExecutionState): void {
    if (state.deadlineAtIso === null) return;
    const deadlineMs = Date.parse(state.deadlineAtIso);
    if (!Number.isFinite(deadlineMs)) return;
    const delay = Math.max(0, deadlineMs - this.clock.now());
    state.deadlineTimer = this.clock.setTimeout(() => this.onDeadlineExceeded(state), delay);
  }

  private clearDeadlineTimer(state: ExecutionState): void {
    if (state.deadlineTimer !== null) {
      this.clock.clearTimeout(state.deadlineTimer);
      state.deadlineTimer = null;
    }
  }

  private onDeadlineExceeded(state: ExecutionState): void {
    if (state.terminal) return;
    this.logger.warn(`department execution ${state.executionId}: wall-clock deadline (${state.deadlineAtIso ?? '?'}) exceeded — cancelling`);
    void this.terminateExecution(state, 'wall-clock deadline exceeded', false);
  }

  // ── d2: park expiry (07 §7 — "a parked question inherits the department's
  //    park expiry rather than waiting forever") ──────────────────────────

  private armParkTimer(state: ExecutionState): void {
    this.clearParkTimer(state);
    const seconds = state.runtime.parkExpirySeconds ?? DEFAULT_PARK_EXPIRY_S;
    state.parkTimer = this.clock.setTimeout(() => this.onParkExpired(state), seconds * 1000);
  }

  private clearParkTimer(state: ExecutionState): void {
    if (state.parkTimer !== null) {
      this.clock.clearTimeout(state.parkTimer);
      state.parkTimer = null;
    }
  }

  private onParkExpired(state: ExecutionState): void {
    if (state.terminal) return;
    this.logger.warn(`department execution ${state.executionId}: parked question expired without an answer — cancelling`);
    void this.terminateExecution(state, 'parked question expired without an answer', false);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Execution ids are caller-minted (offer frame) — sanitize before using one
 *  as a path segment, same discipline as `../jobs/workspace.ts`'s job ids. */
function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// ── Wire-frame parsing / building — real protocol 0.4.0 schemas (e1 repin) ──
// The wire's `Dept*` shapes are snake_case (08-protocol-delta.md); the
// runner-LOCAL `DeptMessage`/`Part` types (`./adapter.ts`) stay camelCase by
// design (see that module's doc) — the functions below are the translation
// boundary, now backed by REAL zod validation instead of hand-rolled checks.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromWirePart(raw: WireDeptPart): Part {
  const part: Part = {};
  if (raw.text !== undefined) part.text = raw.text;
  if (raw.raw !== undefined) part.raw = raw.raw;
  if (raw.url !== undefined) part.url = raw.url;
  if (raw.data !== undefined) part.data = raw.data;
  if (raw.mediaType !== undefined) part.mediaType = raw.mediaType;
  if (raw.filename !== undefined) part.filename = raw.filename;
  if (raw.metadata !== undefined) part.metadata = raw.metadata;
  return part;
}

function toWirePart(part: Part): WireDeptPart {
  return {
    ...(part.text !== undefined ? { text: part.text } : {}),
    ...(part.raw !== undefined ? { raw: part.raw } : {}),
    ...(part.url !== undefined ? { url: part.url } : {}),
    ...(part.data !== undefined ? { data: part.data } : {}),
    ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
    ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
  } as WireDeptPart;
}

/** Validate + translate an incoming wire `DeptMessage` (real
 *  `DeptMessageSchema`, snake_case) into the runner-local camelCase
 *  `DeptMessage` (`./adapter.ts`). Returns null on a schema-invalid frame —
 *  the caller logs and drops, same tolerance as before the repin. */
function narrowWireMessage(raw: unknown): DeptMessage | null {
  const parsed = WireDeptMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  return {
    messageId: m.message_id,
    role: m.role,
    parts: m.parts.map(fromWirePart),
    ...(m.context_id !== undefined ? { contextId: m.context_id } : {}),
    ...(m.task_id !== undefined ? { taskId: m.task_id } : {}),
    createdAt: m.created_at,
  };
}

/** Validate + translate an incoming `department.offer` frame with the REAL
 *  `DeptOfferMessageSchema` (e1 repin — was hand-rolled field presence
 *  checks before). `event_seq_base` threads through to `ExecutionState.nextSeq`. */
function narrowOfferFrame(frame: WireFrame): DepartmentOfferInput | null {
  const parsed = DeptOfferMessageSchema.safeParse(frame);
  if (!parsed.success) return null;
  const f = parsed.data;
  const messages = f.messages.map((m) => narrowWireMessage(m)).filter((m): m is DeptMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    executionId: f.execution_id,
    taskId: f.task_id,
    contextId: f.context_id,
    departmentId: f.department_id,
    messages,
    acceptedOutputModes: f.accepted_output_modes,
    deadlineAt: f.deadline_at,
    eventSeqBase: f.event_seq_base,
    leaseToken: f.lease_token,
    leaseTtlS: f.lease_ttl_s,
  };
}

function buildDepartmentAcceptFrame(offer: DepartmentOfferInput): WireFrame {
  return { type: 'department.accept', execution_id: offer.executionId, task_id: offer.taskId };
}

function buildDepartmentRejectFrame(executionId: string, reason: DepartmentRejectReason): WireFrame {
  return { type: 'department.reject', execution_id: executionId, reason };
}

/** Map a runner-LOCAL `RuntimeEvent` (`./adapter.ts`, camelCase) onto the
 *  wire's `DeptRuntimeEvent` (snake_case where it differs — `question_id`,
 *  `retry_safe`). Never called for `type: 'artifact'` (see
 *  `shipDepartmentEvent`'s doc) — that variant has no wire counterpart here. */
function toWireRuntimeEvent(event: Exclude<RuntimeEvent, { type: 'artifact' }>): DeptRuntimeEvent {
  switch (event.type) {
    case 'status':
      return { type: 'status', state: event.state, ...(event.message !== undefined ? { message: event.message } : {}) };
    case 'message':
      return { type: 'message', parts: event.parts.map(toWirePart) };
    case 'input_required':
      return {
        type: 'input_required',
        question_id: event.questionId,
        question: {
          text: event.question.text,
          ...(event.question.context != null ? { context: event.question.context } : {}),
          ...(event.question.options != null ? { options: event.question.options } : {}),
        },
      };
    case 'progress':
      return { type: 'progress', note: event.note };
    case 'completed':
      return { type: 'completed', ...(event.summary !== undefined ? { summary: event.summary } : {}) };
    case 'failed':
      return { type: 'failed', reason: event.reason, retry_safe: event.retrySafe };
  }
}

function buildDepartmentEventFrame(
  state: { executionId: string; taskId: string },
  event: Exclude<RuntimeEvent, { type: 'artifact' }>,
  seq: number,
): DeptEventMessage {
  return {
    type: 'department.event',
    execution_id: state.executionId,
    task_id: state.taskId,
    seq,
    event: toWireRuntimeEvent(event),
  };
}
