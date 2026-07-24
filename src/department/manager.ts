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
 * d4; real lease renewal/reject/process-group-kill/deadlines is task d2 —
 * this manager's `cancel`/`dispose` calls are honest about that limit (see
 * `./jsonl-process.ts`'s `dispose()` doc).
 *
 * ── Wire frame shapes are PROVISIONAL ───────────────────────────────────────
 * `@baizor/pipeline-protocol` does not carry the mesh schemas yet (0.4.0,
 * the `e1` gate — see `08-protocol-delta.md`). The `department.offer` /
 * `department.message` / `department.cancel` / `department.accept` /
 * `department.reject` shapes below are runner-LOCAL, hand-parsed against
 * `WireFrame`'s tolerant passthrough envelope, snake_case to match 08's
 * documented field names so the eventual swap to real zod schemas is a
 * near drop-in. Nothing here imports the protocol package for them.
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
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Dispatcher } from '../core/dispatcher';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
import { defaultDataDir, nodeShipperFs, type ShipperFileSystem } from '../shipper/fs';
import { EventShipper, shipperStateDir } from '../shipper/shipper';
import { WireUploadTransport, type UploadTransport } from '../shipper/upload-transport';
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
  transport?: UploadTransport;
  fs?: ShipperFileSystem;
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
  shipper: EventShipper;
  idleTimer: unknown;
}

export class DepartmentManager {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly journalRoot: string;
  private readonly journal: JournalWriter;
  private readonly fs: ShipperFileSystem;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly makeId: () => string;
  private readonly perContextIdleMs: number;

  constructor(private readonly options: DepartmentManagerOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.id, adapter);
    this.journalRoot = options.journalRoot ?? join(defaultDataDir(options.env), 'department');
    this.journal = options.journal ?? nodeJournalWriter();
    this.fs = options.fs ?? nodeShipperFs();
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
    return () => {
      offOffer();
      offMessage();
      offCancel();
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
    const shipper = this.makeShipper(journalPath);
    shipper.start();

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
      shipper,
      idleTimer: null,
    };
    this.executions.set(offer.executionId, state);

    const started = await this.spawnAndStart(state);
    return started ? { accepted: true } : { accepted: false, reason: 'broken_runtime' };
  }

  /** Deliver mid-task input. Live + capable ⇒ sent immediately. Otherwise
   *  queued and, if there is no live handle at all, a respawn is kicked off
   *  (07 §3's "queues it and delivers at the next task.start"). */
  async deliverMessage(executionId: string, message: DeptMessage): Promise<{ delivered: boolean; reason?: string }> {
    const state = this.executions.get(executionId);
    if (state === undefined || state.terminal) return { delivered: false, reason: 'unknown or terminal execution' };
    state.lastActivityAt = this.clock.now();
    state.messageHistory.push(message);

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

  async cancelExecution(executionId: string, reason?: string): Promise<void> {
    const state = this.executions.get(executionId);
    if (state === undefined || state.terminal) return;
    if (state.handle !== null) {
      try {
        await state.adapter.cancel(state.handle, reason);
      } catch (err) {
        this.logger.warn(`department execution ${executionId}: cancel() failed: ${describeError(err)}`);
      }
      return; // the runtime is expected to report task.failed/exit, which finalizes normally
    }
    // No live process (evicted / never started) — nothing to signal; the
    // cancellation itself is the terminal outcome.
    await this.reportTerminal(state, { type: 'failed', reason: reason ?? 'canceled', retrySafe: false });
  }

  // ── Spawn / respawn ────────────────────────────────────────────────────

  private async spawnAndStart(state: ExecutionState): Promise<boolean> {
    state.pendingQueue = []; // its contents are already IN messageHistory — see deliverMessage
    const task: DeptTaskSpec = { taskId: state.taskId, contextId: state.contextId, messages: state.messageHistory };
    const invocation: InvocationEnvelope = { runtime: state.runtime, task };
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

    if (event.type === 'completed' || event.type === 'failed') {
      void this.reportTerminal(state, event);
      return;
    }
    this.journalRuntimeEvent(state, event);
  }

  private async reportTerminal(state: ExecutionState, event: Extract<RuntimeEvent, { type: 'completed' } | { type: 'failed' }>): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    this.clearIdleTimer(state);
    this.journalRuntimeEvent(state, event);
    if (state.handle !== null) {
      const handle = state.handle;
      state.handle = null;
      try {
        await state.adapter.dispose(handle);
      } catch (err) {
        this.logger.warn(`department execution ${state.executionId}: dispose() failed: ${describeError(err)}`);
      }
    }
    try {
      await state.shipper.stop();
    } catch (err) {
      this.logger.warn(`department execution ${state.executionId}: shipper stop failed: ${describeError(err)}`);
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

  // ── Shipper construction (mirrors ../jobs/shipper-lifecycle.ts) ────────

  private makeShipper(journalPath: string): EventShipper {
    const transport =
      this.options.transport ?? new WireUploadTransport({ sendFrame: this.options.send, dispatcher: this.options.dispatcher, clock: this.clock });
    return new EventShipper({
      journalPath,
      transport,
      stateDir: shipperStateDir(journalPath, this.options.env),
      projectRoot: journalPath,
      fs: this.fs,
      clock: this.clock,
      logger: this.logger,
      env: this.options.env,
    });
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

// ── Provisional wire-frame parsing (see the module doc) ─────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function narrowWirePart(raw: unknown): Part | null {
  if (!isRecord(raw)) return null;
  const part: Part = {};
  if (typeof raw.text === 'string') part.text = raw.text;
  if (typeof raw.raw === 'string') part.raw = raw.raw;
  if (typeof raw.url === 'string') part.url = raw.url;
  if (raw.data !== undefined) part.data = raw.data;
  if (typeof raw.media_type === 'string') part.mediaType = raw.media_type;
  if (typeof raw.filename === 'string') part.filename = raw.filename;
  if (isRecord(raw.metadata)) part.metadata = raw.metadata;
  return part;
}

function narrowWireMessage(raw: unknown): DeptMessage | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.message_id !== 'string' || raw.message_id.length === 0) return null;
  if (raw.role !== 'ROLE_USER' && raw.role !== 'ROLE_AGENT') return null;
  if (!Array.isArray(raw.parts)) return null;
  const parts = raw.parts.map(narrowWirePart).filter((p): p is Part => p !== null);
  if (parts.length === 0) return null;
  return {
    messageId: raw.message_id,
    role: raw.role,
    parts,
    ...(typeof raw.context_id === 'string' ? { contextId: raw.context_id } : {}),
    ...(typeof raw.task_id === 'string' ? { taskId: raw.task_id } : {}),
    ...(typeof raw.created_at === 'string' ? { createdAt: raw.created_at } : {}),
  };
}

function narrowOfferFrame(frame: WireFrame): DepartmentOfferInput | null {
  const f = frame as Record<string, unknown>;
  if (typeof f.execution_id !== 'string' || f.execution_id.length === 0) return null;
  if (typeof f.task_id !== 'string' || f.task_id.length === 0) return null;
  if (typeof f.context_id !== 'string' || f.context_id.length === 0) return null;
  if (typeof f.department_id !== 'string' || f.department_id.length === 0) return null;
  if (!Array.isArray(f.messages)) return null;
  const messages = f.messages.map(narrowWireMessage).filter((m): m is DeptMessage => m !== null);
  if (messages.length === 0) return null;
  return {
    executionId: f.execution_id,
    taskId: f.task_id,
    contextId: f.context_id,
    departmentId: f.department_id,
    messages,
    ...(Array.isArray(f.accepted_output_modes)
      ? { acceptedOutputModes: f.accepted_output_modes.filter((m): m is string => typeof m === 'string') }
      : {}),
    ...(typeof f.deadline_at === 'string' ? { deadlineAt: f.deadline_at } : {}),
  };
}

function buildDepartmentAcceptFrame(offer: DepartmentOfferInput): WireFrame {
  return { type: 'department.accept', execution_id: offer.executionId, task_id: offer.taskId };
}

function buildDepartmentRejectFrame(executionId: string, reason: DepartmentRejectReason): WireFrame {
  return { type: 'department.reject', execution_id: executionId, reason };
}
