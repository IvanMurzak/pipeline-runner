/**
 * `DepartmentManager` — the department-mesh supervisor (task d1): admission,
 * lifecycle-strategy policy (`per-task` / `per-context` / `daemon`,
 * `07-runtime-contract.md` §5), capability-aware message routing, and
 * wiring the normalized `RuntimeEvent` stream into the EXISTING shipper
 * (`../shipper/shipper.ts`) via a runner-local journal (§8).
 *
 * Deliberately PARALLEL to `../jobs/manager.ts`, not a modification of it —
 * `pipeline drive` DISPATCH (`JobExecutor`) is untouched; this is a second
 * admission surface for department tasks, mirroring the shape (adapter
 * registry instead of one hard-coded contract, `admitTask` instead of
 * `handleLease`) without sharing state. Task d4 ported `pipeline drive`
 * ITSELF onto this same adapter registry as an ADDITIONAL entry
 * (`./pipeline-drive.ts`, `PipelineDriveAdapter`) — a department whose
 * resolved config names `adapterId: 'pipeline-drive'` now runs through this
 * manager too, without the pipeline-dispatch path above changing at all.
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
 * ── Live config updates (e2) ─────────────────────────────────────────────────
 * `department.config_update` (cloud → runner, on install approval and on
 * reconnect, `08-protocol-delta.md` §4) is handled by `handleConfigUpdateFrame`.
 * Only `limits.parkExpiry` (a duration string, `../core/duration.ts`) is wired
 * to anything today — it becomes a per-department `RuntimeConfig` override
 * (`configOverrides`) merged on top of `options.resolveRuntimeConfig` for
 * every future admission, AND, the realistic operational case, re-arms any
 * execution of that department CURRENTLY parked in `input_required` to the
 * new value immediately, rather than waiting for it to expire on the old one.
 * `limits.taskTimeout`/`maxArtifactBytes`/`retrySafe` are accepted (schema-
 * valid) but intentionally not acted on yet — see `handleConfigUpdateFrame`'s
 * doc.
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
 * wired to a shipper/transport.
 *
 * ── Artifact upload (d3, 08 §6 / 09 §3.1) ────────────────────────────────────
 * `department.artifact` stayed OUT of scope through e1 (journalled locally,
 * logged, never shipped). This task wires it up: an `artifact` `RuntimeEvent`
 * is handed to `uploadArtifact`, which first resolves `event.path` against
 * `state.runtime.cwd` (a RELATIVE path — the 07 §3 canonical example, `./out/
 * review.md` — is resolved the same way `jsonl-process.ts` resolves the
 * spawned process's own cwd; an ABSOLUTE path is used as-is; a `container`-
 * tier department's path is refused explicitly — see `resolveArtifactPath`'s
 * doc for why translating a container-internal path is out of scope rather
 * than guessed at), then hands the bytes to
 * `./artifact-upload.ts#uploadDepartmentArtifact`, which enforces the
 * per-artifact (1 MiB) and running per-task (8 MiB) caps RUNNER-FIRST —
 * rejecting explicitly, before any wire transfer, never truncating — then
 * chunks accepted content into 256 KiB `department.artifact` frames.
 * `taskArtifactBytesSent` tracks the running per-task total across this
 * manager's lifetime (keyed by `taskId`, so it survives a `per-context`
 * respawn's fresh `executionId` but resets on runner restart — a
 * best-effort local gate; the cloud's own check, `mesh-artifacts/service.ts`,
 * is the authoritative one). Every entry is reclaimed once no execution of
 * that `taskId` is still live — `releaseTaskArtifactBudgetIfIdle`, called
 * from both terminal funnels (`reportTerminal` AND `handleLeaseRevoked`,
 * which deliberately bypasses `reportTerminal` — see its own doc) — plus a
 * `MAX_TRACKED_TASK_ARTIFACT_BUDGETS` size backstop in case a future
 * termination path is ever added without also calling it.
 *
 * `department.artifact_ack` (cloud → runner) is handled by
 * `handleArtifactAckFrame`: a rejection is always logged at `warn` (never
 * silently dropped) and, if the caller wired `options.onArtifactAck`, handed
 * to it too — "surfaced, not swallowed" is a DoD line, not a suggestion.
 * **This handler is dormant today**: as of task d3, the cloud's `c9`
 * scheduler (`handleDepartmentArtifact` in
 * `cloud/apps/api/src/modules/mesh/scheduler.ts`) records
 * `task.artifact_stored`/`task.artifact_rejected` TASK EVENTS but does not
 * yet SEND a `department.artifact_ack` WIRE FRAME anywhere — this handler is
 * fully wired and tested against the real schema for when that frame starts
 * arriving, but no runner will actually receive one until the cloud side is
 * closed (tracked as a `c9`/mesh follow-up, not a defect in this file).
 *
 * ── Stuck detection (b4, D25 / 06 §5) ───────────────────────────────────────
 * "A task never goes quiet" ([05](05-department-project.md) §7.5) shipped with
 * a hole: crash (`reportTerminal`), wall-clock deadline, park expiry and the
 * cloud's lease sweeper all report, but a session that simply STOPS reporting
 * did nothing at all until its deadline — possibly hours. `armIdleTimer` is
 * NOT that mechanism and is left alone: it fires only for `per-context` and
 * merely evicts the handle to reclaim resources; it reports nothing and fails
 * nothing, which is a different, real job.
 *
 * Two failure shapes are covered, because the engine module (b3) observed the
 * second one for real and it is not a hang:
 *
 *   1. **The session goes quiet.** `armStuckTimer` watches the time since the
 *      last signal from the runtime (any `RuntimeEvent` — 06 §5's "tool
 *      activity, stream liveness, or `task.update_progress`", which for
 *      `claude-code` is one `progress` per assistant turn and per tool call).
 *      Past the threshold the execution terminates through the SAME
 *      finalize-now path cancellation and the deadline use, with the coded
 *      terminal reason `stuck` ({@link STUCK_FAILURE_REASON}).
 *   2. **The session ends having reported nothing.** 06 §4 predicted a missing
 *      tool allow-list would make the first `task.update_progress` "block
 *      forever"; b3 found the real behaviour is the opposite — the call is
 *      DENIED and the session runs to its own end, silently. A watchdog alone
 *      never fires on that, so a terminal `completed` from an execution that
 *      emitted NOT ONE signal in its whole life is reported `stuck` instead of
 *      a hollow success (`judgeTerminalEvent`).
 *
 * Both are gated on the engine DECLARING that it reports while it works
 * (`./engine.ts`'s `supportsStreaming: 'yes'`) — see `resolveStuckAfterMs`.
 * Silence only breaks a promise an engine actually made.
 *
 * A THIRD shape exists and is deliberately NOT here: a session that reported
 * for a while and was then CUT OFF (its execution token expired, so every
 * receiver tool started refusing) still ends with a `completed` — and it has
 * plenty of signals, so neither mechanism above can see it. Judging that one
 * needs the runtime's own tool-call outcomes, which the supervisor never sees;
 * it belongs to the engine module that reads the frames, and lives in
 * `./claude-code.ts` (x16, `UNREPORTED_FAILURE_REASON`). The `failed` it
 * produces arrives here as an ordinary terminal and passes through
 * `judgeTerminalEvent` untouched.
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

import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import * as nodeFs from 'node:fs';
import {
  DeptArtifactAckMessageSchema,
  DeptConfigUpdateMessageSchema,
  DeptOfferMessageSchema,
  DeptMessageSchema as WireDeptMessageSchema,
} from '@baizor/pipeline-protocol';
import type {
  DeptArtifactAckMessage,
  DeptEventMessage,
  DeptMessage as WireDeptMessage,
  DeptPart as WireDeptPart,
  DeptRuntimeEvent,
} from '@baizor/pipeline-protocol';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Dispatcher } from '../core/dispatcher';
import { parseDurationSeconds } from '../core/duration';
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
import type { ArtifactFileSystem } from './artifact-upload';
import { uploadDepartmentArtifact } from './artifact-upload';
import { adapterIdToEngine, ENGINE_MCP_TOKEN_ENV, ENGINE_MCP_URL_ENV, lookupEngine } from './engine';
import {
  buildDepartmentIndexEntry,
  buildDepartmentJournalEnvelope,
  departmentIndexPath,
  departmentJournalPath,
  senderFromMessages,
} from './events';
import type { ExecutionTokenSource } from './execution-token-manager';

// ── d6: pointing model-driven runtimes at the cloud MCP server ──────────────
// (13-mcp-authorization.md §12, 07-runtime-contract.md §4). "No adapter work
// at all" (07 §4) for an MCP-speaking runtime means exactly this: the runner
// does not implement an MCP client itself, it makes the URL + a live
// execution token available to whatever it spawns, via the SAME `env`
// mechanism every adapter already reads (`RuntimeConfig.env`,
// `./adapter.ts`). A JSONL/program runtime's CONTRACT is unchanged (07 §3) —
// it simply also receives these two variables and is free to ignore them;
// a model-driven runtime that knows to read them becomes its own MCP client
// against `https://…/mcp`, exactly as D14 intends.
//
// simplified-onboarding b2: the two names now live in `./engine.ts` and are
// re-exported here under their shipped names. They are the supervisor↔engine
// half of the contract an engine module's responsibilities 3/4 rest on
// (`requireEngineMcpEnv`), and an engine module must not have to import the
// whole supervisor to learn what they are called. Same strings, same values.
export const MESH_MCP_URL_ENV = ENGINE_MCP_URL_ENV;
export const MESH_EXECUTION_TOKEN_ENV = ENGINE_MCP_TOKEN_ENV;

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
   *  (`capability` reject). This is the BASE config, sourced from the
   *  file-backed binding store (`./bindings.ts`; `PIPELINE_RUNNER_DEPARTMENTS`
   *  survives inside it as a deprecated fallback) — a live
   *  `department.config_update` frame (below) layers a per-department override
   *  on TOP of whatever this returns; it does not replace it.
   *
   *  It MUST be a live accessor, never a captured Map: b1 made the binding
   *  store reloadable precisely so a running supervisor picks up a department
   *  bound after it started, and it does that by returning a different answer
   *  from this call, at admission, without any frame or restart. */
  resolveRuntimeConfig(departmentId: string): RuntimeConfig | null;
  send(frame: WireFrame): boolean;
  /** The agent connection's dispatcher — both for `attach()`'s inbound
   *  frames and the default `WireUploadTransport`'s `upload_ack` handler. */
  dispatcher: Pick<Dispatcher, 'on'>;
  /** Root dir each execution's journal lives under: `<root>/<executionId>/events.jsonl`. */
  journalRoot?: string;
  journal?: JournalWriter;
  /** d6 (13 §12): obtains/caches execution-scoped OAuth tokens via
   *  `client_credentials`. Absent ⇒ no `PIPELINE_MESH_*` env is injected at
   *  spawn and lease renewal skips the re-request — existing (pre-d6)
   *  behaviour, unchanged, for any caller that does not wire this. */
  executionTokens?: ExecutionTokenSource;
  capacity?(): number;
  draining?(): boolean;
  /** `per-context` idle window before an inactive handle is disposed (the
   *  next message/respawn picks the context back up). Default 15 minutes. */
  perContextIdleMs?: number;
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  env?: Record<string, string | undefined>;
  /** d3: injectable filesystem for `path`-referenced artifact reads. Default
   *  `nodeArtifactFs()` (real `node:fs`, sync — `./artifact-upload.ts`). */
  artifactFs?: ArtifactFileSystem;
  /** d3: called for every `department.artifact_ack` this manager receives
   *  (both accepted and rejected) — a hook for callers that want to observe
   *  ack traffic beyond the log line `handleArtifactAckFrame` always emits.
   *  Never required for "rejection is surfaced" to hold: that is the log
   *  line, unconditionally; this is additive. */
  onArtifactAck?(ack: DeptArtifactAckMessage): void;
}

const DEFAULT_CAPACITY = 4;
const DEFAULT_PER_CONTEXT_IDLE_MS = 15 * 60_000;
/** Fallback park-expiry (d2, 07 §7) when neither the offer nor
 *  `RuntimeConfig.parkExpirySeconds` states one — matches the design's own
 *  `parkExpiry` example (`"7d"`, `08-protocol-delta.md` §4's `DeptLimits`). */
const DEFAULT_PARK_EXPIRY_S = 7 * 24 * 60 * 60;
/** d3 (per code-review finding): hard ceiling on the number of DISTINCT
 *  `taskId`s `taskArtifactBytesSent` tracks at once. `releaseTaskArtifactBudgetIfIdle`
 *  (called from both termination funnels) is what's SUPPOSED to keep this map
 *  small — this is defence in depth for the case a future termination path is
 *  added without also calling it, so the map is bounded regardless, not just
 *  when every caller remembers to clean up. */
const MAX_TRACKED_TASK_ARTIFACT_BUDGETS = 2000;

// ── b4: stuck detection (D25, 06 §5) ────────────────────────────────────────

/**
 * The CODED terminal reason a stuck task carries, distinct from every other
 * `failed` (which mean the agent broke, declined, or ran past its deadline).
 *
 * It rides the EXISTING `failed` event rather than being a new event type, and
 * that is p1's deliberate protocol decision, not a shortcut:
 * `DeptRuntimeEventSchema` is a `z.discriminatedUnion("type", …)`, so an
 * unknown discriminant HARD-FAILS the parse and would crash every consumer
 * older than this change. `reason` was already `z.string().min(1)`, so the
 * value is additive by convention and needs no schema change at all — an old
 * consumer reads an ordinary `failed` with a reason it does not specially
 * recognize.
 *
 * Deliberately the BARE word: p1 publishes it as the one coded value in
 * `DEPT_FAILURE_REASONS`, which a consumer checks by equality. The human
 * detail (how long the silence was, which shape was detected) goes to the log
 * and the journal, never into the wire value. NOT imported from
 * `@baizor/pipeline-protocol` because that dependency is exact-pinned at
 * 0.4.0, which predates p1's constant — the STRING is the contract, and it is
 * identical either way.
 */
export const STUCK_FAILURE_REASON = 'stuck';

/** No signal from the runtime for this long ⇒ stuck, when the department
 *  states no `limits.taskTimeout` and no explicit `stuckAfterSeconds`.
 *  Matches 05 §6's own rendering of the case ("no progress for 30m — flagged
 *  stuck, sender notified"). */
export const DEFAULT_STUCK_AFTER_S = 30 * 60;
/** Clamp on a threshold DERIVED from `limits.taskTimeout` (never on an
 *  explicit `stuckAfterSeconds`, which an operator meant literally). The floor
 *  exists because a single model turn legitimately runs for minutes with no
 *  frame in between; the ceiling because a department with an all-day
 *  `taskTimeout` still deserves to hear about silence the same day. */
export const MIN_DERIVED_STUCK_AFTER_S = 5 * 60;
export const MAX_DERIVED_STUCK_AFTER_S = 60 * 60;

/**
 * `limits.taskTimeout` → a progress threshold: a quarter of the time the whole
 * task is allowed, clamped. A department that must finish in 2h (05 §2's own
 * reference manifest) gets 30m, which is exactly the number 05 §6 renders —
 * the design's example and this default are the same story told twice.
 *
 * Note what this does NOT do: `taskTimeout` still is not a deadline here. The
 * wall-clock deadline arrives pre-computed on the offer (`deadline_at`,
 * `armDeadlineTimer`) and is untouched; this reads the same limit for the one
 * thing the runner CAN act on locally.
 */
export function deriveStuckAfterSeconds(taskTimeoutSeconds: number): number {
  return Math.min(MAX_DERIVED_STUCK_AFTER_S, Math.max(MIN_DERIVED_STUCK_AFTER_S, Math.round(taskTimeoutSeconds / 4)));
}

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
  // ── b4: journal identity (05 §6) ────────────────────────────────────────
  /** Who addressed the task (`senderFromMessages`), or null — carried on every
   *  journal envelope and on the per-department index line. */
  sender: string | null;
  /** The USER-FACING engine name for `runtime.adapterId` (06 §7), or null for
   *  an adapter outside `./engine.ts`'s registry. */
  engine: string | null;
  // ── b4: stuck detection (D25) ───────────────────────────────────────────
  /** Silence tolerated before this execution is reported `stuck`, or null when
   *  it is not watched at all — see `resolveStuckAfterMs`. Resolved once, at
   *  admission, from the runtime config in force then. */
  stuckAfterMs: number | null;
  stuckTimer: unknown;
  /** How many signals the RUNTIME has emitted for this execution (every
   *  non-terminal `RuntimeEvent`, across a `per-context` respawn). Zero at a
   *  terminal is stuck-shape 2: the session ended having reported nothing. */
  runtimeSignals: number;
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
  /** Per-department `RuntimeConfig` overrides applied live via
   *  `department.config_update` — merged on top of `options.resolveRuntimeConfig`'s
   *  result at admission time. Today this only ever carries `parkExpirySeconds`
   *  (see `handleConfigUpdateFrame`'s doc). */
  private readonly configOverrides = new Map<string, Partial<RuntimeConfig>>();
  /** d3: running total of artifact bytes THIS PROCESS has sent per `taskId`
   *  (09 §3.1's per-task 8 MiB cap, enforced runner-first) — see the module
   *  doc's "Artifact upload" section for why this is per-task, not
   *  per-execution, and why it is best-effort rather than authoritative. */
  private readonly taskArtifactBytesSent = new Map<string, number>();
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
    const offConfigUpdate = dispatcher.on('department.config_update', (frame) => this.handleConfigUpdateFrame(frame));
    const offArtifactAck = dispatcher.on('department.artifact_ack', (frame) => this.handleArtifactAckFrame(frame));
    return () => {
      offOffer();
      offMessage();
      offCancel();
      offLeaseRevoked();
      offConfigUpdate();
      offArtifactAck();
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

    const runtime = this.resolveEffectiveRuntimeConfig(offer.departmentId);
    if (runtime === null) return { accepted: false, reason: 'capability' };
    const adapter = this.adapters.get(runtime.adapterId);
    if (adapter === undefined) return { accepted: false, reason: 'capability' };

    const journalPath = departmentJournalPath(this.journalRoot, offer.executionId);
    this.journal.ensureDir(dirname(journalPath));
    const sender = senderFromMessages(offer.messages);
    const engine = adapterIdToEngine(runtime.adapterId);
    this.appendDepartmentIndexEntry(offer, journalPath, sender, engine);

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
      sender,
      engine,
      stuckAfterMs: this.resolveStuckAfterMs(runtime),
      stuckTimer: null,
      runtimeSignals: 0,
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
        // d6 (13 §12): "re-REQUEST (not refresh) on lease renewal — the
        // token dies with the lease." A successful renewal means a fresh
        // lease TTL, so re-request a fresh execution token to match. This
        // updates `executionTokens`' cache for the NEXT spawn/relay drain;
        // it does not (cannot) push a new token into an already-running
        // process. Fire-and-forget: never let this block the heartbeat
        // cadence `renewLeases()` itself rides. `ExecutionTokenManager.renew`
        // never rejects (failures resolve to `{ ok: false }` and are already
        // logged by `../core/mesh-oauth.ts`) — the `.catch` is defence in
        // depth against a differently-behaved `ExecutionTokenSource`.
        void this.options.executionTokens?.renew(state.executionId).catch(() => {});
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
    this.clearStuckTimer(state);
    // d6 (13 §12): "revoking the lease revokes the token" — drop it from the
    // in-memory cache too, so nothing (a stray relay drain, a respawn race)
    // could ever hand it out again for a lease that is already gone.
    this.options.executionTokens?.discard(executionId);
    // d3 (per code-review finding): this path deliberately bypasses
    // `reportTerminal` (see this method's doc), so it needs its OWN call to
    // reclaim the per-task artifact-budget entry — `reportTerminal` doing it
    // is not enough to cover every termination path.
    this.releaseTaskArtifactBudgetIfIdle(state.taskId);
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

  // ── e2: department.config_update (cloud → runner) ───────────────────────
  // Cloud sends this on install approval and on reconnect
  // (`08-protocol-delta.md` §4/§5, `06-department-registry.md`). Two limits
  // are wired to a runner concept:
  //   - `limits.parkExpiry`  → `RuntimeConfig.parkExpirySeconds` (e2).
  //   - `limits.taskTimeout` → `RuntimeConfig.stuckAfterSeconds` (b4), via
  //     `deriveStuckAfterSeconds`. This is NOT a deadline: wall-clock
  //     deadlines flow through the offer's pre-computed `deadline_at`
  //     (`armDeadlineTimer`, above) and are untouched — a manifest-level
  //     `taskTimeout` would need cloud-side plumbing into THAT computation.
  //     What the runner can do locally with it is decide how long silence
  //     from this department's sessions is tolerable, which is exactly D25's
  //     "per-department threshold defaulting from `limits`".
  // `limits.maxArtifactBytes`/`retrySafe` have no runner-side consumer at all
  // yet (`retrySafe` is emitted BY the runtime today, `./adapter.ts`'s
  // `RuntimeEvent`, not configured) — left unwired, same "honest placeholder"
  // discipline as `cli.ts:69`.

  /** Merge any live `department.config_update` override on top of the
   *  static/base `resolveRuntimeConfig` result. Used at admission
   *  (`admitTask`) so every FUTURE offer for a department picks up its
   *  latest known config; already-admitted executions keep whatever
   *  `ExecutionState.runtime` they started with, updated in place by
   *  `handleConfigUpdateFrame` when a config_update actually changes
   *  something relevant to a live execution (park expiry). */
  private resolveEffectiveRuntimeConfig(departmentId: string): RuntimeConfig | null {
    const base = this.options.resolveRuntimeConfig(departmentId);
    if (base === null) return null;
    const override = this.configOverrides.get(departmentId);
    return override === undefined ? base : { ...base, ...override };
  }

  private handleConfigUpdateFrame(frame: WireFrame): void {
    const parsed = DeptConfigUpdateMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.logger.warn('malformed department.config_update ignored');
      return;
    }
    const { department_id: departmentId, limits } = parsed.data;

    // "Known" here mirrors admission's own gate: a department this runner
    // has no base config for can never be admitted anyway, so there is
    // nothing meaningful to override — ignore rather than cache an override
    // that would never be read.
    if (this.options.resolveRuntimeConfig(departmentId) === null) {
      this.logger.warn(`department.config_update for unknown department '${departmentId}' ignored`);
      return;
    }

    const override: Partial<RuntimeConfig> = {};

    if (limits.parkExpiry !== undefined) {
      const parkExpirySeconds = parseDurationSeconds(limits.parkExpiry);
      if (parkExpirySeconds === null) {
        this.logger.warn(
          `department.config_update for '${departmentId}': limits.parkExpiry '${limits.parkExpiry}' is not a valid duration — ignored (other fields, if any, still apply)`,
        );
      } else {
        override.parkExpirySeconds = parkExpirySeconds;
      }
    }

    // b4: the department's own answer to "how long may a session of mine be
    // silent?", derived from the one limit that already states how long its
    // work may take. See `deriveStuckAfterSeconds` for why a quarter, and the
    // section comment above for why this is not a deadline.
    if (limits.taskTimeout !== undefined) {
      const taskTimeoutSeconds = parseDurationSeconds(limits.taskTimeout);
      if (taskTimeoutSeconds === null || taskTimeoutSeconds <= 0) {
        this.logger.warn(
          `department.config_update for '${departmentId}': limits.taskTimeout '${limits.taskTimeout}' is not a valid duration — ignored (other fields, if any, still apply)`,
        );
      } else {
        override.stuckAfterSeconds = deriveStuckAfterSeconds(taskTimeoutSeconds);
      }
    }

    if (Object.keys(override).length === 0) return; // nothing this manager acts on in this frame

    const existing = this.configOverrides.get(departmentId) ?? {};
    this.configOverrides.set(departmentId, { ...existing, ...override });

    // Also apply to every live (non-terminal) execution of this department
    // NOW — both so a FUTURE park on an already-running execution uses the
    // new value, and, the realistic operational case, so an execution
    // ALREADY parked waiting for input is re-armed to it immediately rather
    // than expiring on the stale one.
    for (const state of this.executions.values()) {
      if (state.departmentId !== departmentId || state.terminal) continue;
      state.runtime = { ...state.runtime, ...override };
      if (override.parkExpirySeconds !== undefined && state.parkTimer !== null) {
        this.armParkTimer(state);
        this.logger.info(
          `department execution ${state.executionId}: parked wait re-armed to ${override.parkExpirySeconds}s (config_update)`,
        );
      }
      if (override.stuckAfterSeconds !== undefined) {
        const stuckAfterMs = this.resolveStuckAfterMs(state.runtime);
        if (stuckAfterMs !== state.stuckAfterMs) {
          state.stuckAfterMs = stuckAfterMs;
          // Re-arm only when the execution is not parked — a parked wait has
          // the watchdog suspended, and `deliverMessage` restores it.
          if (state.parkTimer === null) this.armStuckTimer(state);
          this.logger.info(
            `department execution ${state.executionId}: stuck threshold re-armed to ${override.stuckAfterSeconds}s (config_update)`,
          );
        }
      }
    }
  }

  // ── d3: department.artifact_ack (cloud → runner) ─────────────────────────
  // 08 §6 / 09 §3.1: "an explicit department.artifact_ack per artifact —
  // rejection is always explicit; silent truncation is forbidden." A
  // malformed frame is logged and dropped, same tolerance every other
  // handler in this class applies; a well-formed one is ALWAYS logged —
  // `accepted:true` at info, `accepted:false` at warn with the reason — so a
  // rejection can never pass through unnoticed. `options.onArtifactAck` is an
  // additive hook for a caller that wants to react to it (e.g. a future
  // per-execution artifact-status surface); it is not what makes rejection
  // "surfaced" — the log line unconditionally is.
  //
  // DORMANT TODAY: the cloud's `c9` scheduler does not yet SEND this frame
  // (it records `task.artifact_stored`/`task.artifact_rejected` task events
  // instead — see the module doc's "Artifact upload" section) — this handler
  // is ready and tested against the real schema, but nothing calls it in
  // production until that cloud-side gap closes.
  private handleArtifactAckFrame(frame: WireFrame): void {
    const parsed = DeptArtifactAckMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.logger.warn('malformed department.artifact_ack ignored');
      return;
    }
    const ack = parsed.data;
    if (ack.accepted) {
      this.logger.info(`department.artifact_ack: artifact ${ack.artifact_id} accepted`);
    } else {
      this.logger.warn(`department.artifact_ack: artifact ${ack.artifact_id} REJECTED — ${ack.reason ?? 'no reason given'}`);
    }
    this.options.onArtifactAck?.(ack);
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
    // b4: work is expected to resume from here, so the silence window restarts
    // (and, if the execution was parked, the suspended watchdog comes back).
    this.armStuckTimer(state);

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

  /**
   * NOT declared `async` on purpose: several callers fire this with
   * `void this.spawnAndStart(state)` and rely on it reaching (synchronous
   * fake-adapter) `adapter.start()` in the SAME synchronous turn — e.g. the
   * crash-recovery respawn in `handleRuntimeEvent`, exercised by tests that
   * assert `adapter.startCalls()` immediately after driving the crash event,
   * with no intervening tick. `await`ing anything — even an already-settled
   * promise — always defers to the next microtask, so the `executionTokens`
   * path (d6) is kept in a SEPARATE branch that only ever runs when d6 is
   * actually wired; the no-`executionTokens` path below stays exactly as
   * synchronous as it was before this task, byte for byte.
   */
  private spawnAndStart(state: ExecutionState): Promise<boolean> {
    state.pendingQueue = []; // its contents are already IN messageHistory — see deliverMessage
    const task: DeptTaskSpec = { taskId: state.taskId, contextId: state.contextId, messages: state.messageHistory };
    if (this.options.executionTokens === undefined) {
      return this.startWithInvocation(state, task, null);
    }
    // d6 (13 §12 / 07 §4): every (re)spawn gets its OWN execution token —
    // requested fresh here, never carried over from a prior spawn of the
    // same execution (a per-context respawn gets a fresh one exactly like
    // the original admission did). A failure here (offline, execution
    // somehow not yet visible to the AS) degrades to "no MCP env this
    // spawn" — it must NEVER block or fail admission, since JSONL/program
    // runtimes work today with no MCP access whatsoever (DoD: "existing
    // behaviour unchanged").
    return this.resolveMcpEnv(state).then((mcpEnv) => this.startWithInvocation(state, task, mcpEnv));
  }

  private async startWithInvocation(state: ExecutionState, task: DeptTaskSpec, mcpEnv: Record<string, string> | null): Promise<boolean> {
    const invocation: InvocationEnvelope = {
      runtime: mcpEnv === null ? state.runtime : { ...state.runtime, env: { ...state.runtime.env, ...mcpEnv } },
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
      // b4: the silence window starts at the spawn, not at the first signal —
      // a session that never says anything at all is the commonest hang.
      this.armStuckTimer(state);
      return true;
    } catch (err) {
      this.logger.warn(`department execution ${state.executionId}: start() failed: ${describeError(err)}`);
      await this.reportTerminal(state, { type: 'failed', reason: describeError(err), retrySafe: false });
      return false;
    }
  }

  /**
   * d6 (13 §12): resolve `{ PIPELINE_MESH_MCP_URL, PIPELINE_MESH_EXECUTION_TOKEN }`
   * for this spawn, or `null` when there is nothing to inject —
   * `executionTokens` not configured, the runner is not registered yet, or
   * the AS refused the request (e.g. `invalid_grant`: this execution is not
   * leased to this runner — should not normally happen, since the offer
   * itself only exists because it IS leased here, but the AS is the source
   * of truth and this must degrade, not throw, either way). NEVER logs the
   * token itself — only the OAuth error code on failure.
   */
  private async resolveMcpEnv(state: ExecutionState): Promise<Record<string, string> | null> {
    if (this.options.executionTokens === undefined) return null;
    const resourceUrl = this.options.executionTokens.resourceUrl();
    if (resourceUrl === null) return null;
    const result = await this.options.executionTokens.getToken(state.executionId);
    if (!result.ok) {
      this.logger.warn(
        `department execution ${state.executionId}: could not obtain an execution token (${result.error.error}) — runtime will not have direct /mcp access this spawn`
      );
      return null;
    }
    return { [MESH_MCP_URL_ENV]: resourceUrl, [MESH_EXECUTION_TOKEN_ENV]: result.token.accessToken };
  }

  private handleRuntimeEvent(state: ExecutionState, event: RuntimeEvent): void {
    if (state.terminal) return; // a stale handle's straggling line after finalize
    state.lastActivityAt = this.clock.now();
    // b4: the stuck watchdog's input (06 §5's progress signal — "tool
    // activity, stream liveness, or `task.update_progress`"). Counted rather
    // than re-armed per event: a busy `claude-code` session emits hundreds of
    // these, and `checkStuck` re-reads `lastActivityAt` when it wakes, so one
    // timer per window is enough. Terminals are excluded — ending is not a
    // sign of life, and shape 2 asks whether anything came BEFORE the end.
    if (event.type !== 'completed' && event.type !== 'failed') state.runtimeSignals += 1;

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
      void this.reportTerminal(state, this.judgeTerminalEvent(state, event));
      return;
    }
    this.journalRuntimeEvent(state, event);
    this.shipDepartmentEvent(state, event);
  }

  /**
   * b4, stuck shape 2 — "the session ended having reported nothing" (D25).
   *
   * 06 §4 predicted that a headless session missing its tool allow-list would
   * hang on the first `task.update_progress` ("would block forever"). b3
   * observed the opposite and it is worse: the call is DENIED, and the session
   * runs to its own natural end having reported precisely nothing. Silent, not
   * hung — so the watchdog below never fires on it, and the sender receives a
   * `completed` that means nothing happened.
   *
   * A `completed` from a watched engine (one that DECLARED it reports while it
   * works) that emitted NOT ONE signal in its entire life is therefore reported
   * `stuck` instead. The conditions are deliberately narrow:
   *
   * - Only `completed` is ever rewritten. A `failed` already carries the
   *   runtime's own stated reason, and replacing it would destroy the more
   *   specific information.
   * - Only a WATCHED engine (`stuckAfterMs !== null`). `pipeline` declares
   *   `supportsStreaming: 'partial'` — nothing at all is reported while a
   *   buffered exec runs — so a silent `completed` from it is normal and is
   *   left exactly as it is, as it is for any adapter outside the registry.
   * - Only ZERO signals, not "few". One `progress`, one `message`, one
   *   `input_required` — any evidence the session was reporting — and the
   *   `completed` stands untouched.
   *
   * That last condition is what makes this blind to x16's shape — a session
   * cut off mid-task has hundreds of signals — and widening it here is not the
   * fix: "few signals" is not evidence of anything, and the evidence that IS
   * conclusive (a receiver-tool call that came back an error) exists only in
   * the runtime's own stream, which the supervisor does not read. So the
   * supervisor keeps the judgement it can actually make, and the engine module
   * makes the one it can — see this file's module doc.
   */
  private judgeTerminalEvent(
    state: ExecutionState,
    event: Extract<RuntimeEvent, { type: 'completed' } | { type: 'failed' }>,
  ): Extract<RuntimeEvent, { type: 'completed' } | { type: 'failed' }> {
    if (event.type !== 'completed' || state.stuckAfterMs === null || state.runtimeSignals > 0) return event;
    this.logger.warn(
      `department execution ${state.executionId}: the ${state.engine ?? state.runtime.adapterId} session ended without ` +
        'reporting anything at all — no progress, no message, no question — so its completion vouches for no work; ' +
        `reporting '${STUCK_FAILURE_REASON}' rather than a hollow success`,
    );
    return { type: 'failed', reason: STUCK_FAILURE_REASON, retrySafe: false };
  }

  private async reportTerminal(state: ExecutionState, event: Extract<RuntimeEvent, { type: 'completed' } | { type: 'failed' }>): Promise<void> {
    if (state.terminal) return;
    state.terminal = true;
    this.clearIdleTimer(state);
    this.clearDeadlineTimer(state);
    this.clearParkTimer(state);
    this.clearStuckTimer(state);
    // d6: the execution is done — its token (if any was ever requested) is
    // useless from here on; drop the cache entry (see handleLeaseRevoked's
    // matching note).
    this.options.executionTokens?.discard(state.executionId);
    // d3 (per code-review finding): reclaim this task's artifact-budget
    // entry now that this execution is ending — see `releaseTaskArtifactBudgetIfIdle`'s
    // doc for why it only actually deletes when no OTHER execution of the
    // same taskId is still live.
    this.releaseTaskArtifactBudgetIfIdle(state.taskId);
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
      departmentId: state.departmentId,
      sender: state.sender,
      engine: state.engine,
      event,
      nowIso: new Date(this.clock.now()).toISOString(),
    });
    this.journal.appendLine(state.journalPath, JSON.stringify(envelope));
  }

  /**
   * b4 (05 §6): one line per admitted execution in the department's OWN index
   * file, so a reader resolves "what has this department run?" by computing a
   * single path (`departmentIndexPath`) instead of listing the journal root
   * and opening every execution's journal to find out whose it was.
   *
   * Written once, at admission, and never rewritten — the outcome is not
   * duplicated here; the entry carries `journal_path`, which is where the
   * outcome already is. Best-effort in the same sense the journal itself is: a
   * failed index append must never take an admission down with it, since the
   * execution's own journal is the source of truth either way.
   */
  private appendDepartmentIndexEntry(
    offer: DepartmentOfferInput,
    journalPath: string,
    sender: string | null,
    engine: string | null,
  ): void {
    const indexPath = departmentIndexPath(this.journalRoot, offer.departmentId);
    const entry = buildDepartmentIndexEntry({
      executionId: offer.executionId,
      taskId: offer.taskId,
      contextId: offer.contextId,
      departmentId: offer.departmentId,
      sender,
      engine,
      journalPath,
      nowIso: new Date(this.clock.now()).toISOString(),
    });
    try {
      this.journal.ensureDir(dirname(indexPath));
      this.journal.appendLine(indexPath, JSON.stringify(entry));
    } catch (err) {
      this.logger.warn(`department execution ${offer.executionId}: per-department index append failed: ${describeError(err)}`);
    }
  }

  /**
   * Ship a `RuntimeEvent` to the cloud as a real `department.event` wire
   * frame (e1 fix — see the module doc's "Event delivery" note). `artifact`
   * events take a SEPARATE path — 08 §6 gives artifacts their own dedicated
   * `department.artifact` chunked-upload frames, never the tier-filtered
   * event-ingest path (07 §8) — routed to `uploadArtifact` (d3) instead of
   * `buildDepartmentEventFrame`/`options.send` below.
   * Best-effort: `options.send` returning false (runner offline) is logged,
   * not queued/retried — a durable per-execution event outbox is future work
   * (mirrors `gatewayRegistry.sendToRunner`'s own best-effort semantics on
   * the cloud -> runner leg).
   */
  private shipDepartmentEvent(state: ExecutionState, event: RuntimeEvent): void {
    if (event.type === 'artifact') {
      this.uploadArtifact(state, event);
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

  /**
   * d3 (08 §6 / 09 §3.1): hand one `artifact` `RuntimeEvent` to
   * `./artifact-upload.ts#uploadDepartmentArtifact`, which enforces every cap
   * runner-first and chunks accepted content into `department.artifact`
   * frames. `event.path`, if present, is resolved FIRST via
   * `resolveArtifactPath` — against `state.runtime.cwd` for a relative path,
   * or refused outright for a `container`-tier department (see that method's
   * doc) — before the uploader ever sees it. `taskArtifactBytesSent` — this
   * manager's running per-task total — is only incremented on a `'sent'`
   * outcome (via `noteTaskArtifactBytesSent`), so a rejected artifact never
   * inflates the budget its own rejection was measured against. A rejection
   * is already logged (either by `resolveArtifactPath` or by
   * `uploadDepartmentArtifact` itself, with the exact cap and size that were
   * violated) — nothing further to do here; this execution's task keeps
   * running exactly as it would for any other best-effort-shipped event.
   */
  private uploadArtifact(state: ExecutionState, event: Extract<RuntimeEvent, { type: 'artifact' }>): void {
    let path = event.path;
    if (path !== undefined) {
      const resolved = this.resolveArtifactPath(state, path);
      if (!resolved.ok) {
        this.logger.warn(resolved.reason);
        return;
      }
      path = resolved.path;
    }

    const bytesAlreadySentForTask = this.taskArtifactBytesSent.get(state.taskId) ?? 0;
    const outcome = uploadDepartmentArtifact(
      {
        executionId: state.executionId,
        taskId: state.taskId,
        name: event.name,
        mediaType: event.mediaType,
        ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
        ...(path !== undefined ? { path } : {}),
      },
      {
        send: this.options.send,
        bytesAlreadySentForTask,
        ...(this.options.artifactFs !== undefined ? { fs: this.options.artifactFs } : {}),
        logger: this.logger,
      },
    );
    if (outcome.status === 'sent') {
      this.noteTaskArtifactBytesSent(state.taskId, outcome.size);
      this.logger.info(
        `department execution ${state.executionId}: artifact "${event.name}" uploaded (${outcome.size}B, ${outcome.chunkTotal} chunk(s), checksum ${outcome.checksum})`,
      );
    }
  }

  /**
   * d3 (per code-review finding): resolve a `task.artifact`'s `path` against
   * the department's OWN working directory before ever handing it to
   * `uploadDepartmentArtifact` — the previous version passed `event.path`
   * through verbatim, which resolved against the DAEMON's cwd rather than the
   * runtime's, even though 07 §3's own canonical example is a relative path
   * (`"./out/review.md"`) and `jsonl-process.ts` spawns the child WITH
   * `runtime.cwd` (`this.spawnSeam.spawn(runtime.command, runtime.args ?? [],
   * { cwd: runtime.cwd, ... })`) — so resolving against that same `cwd` is
   * what makes a relative artifact path mean what the runtime that emitted it
   * meant.
   *
   * - An ABSOLUTE path is used as-is (already unambiguous).
   * - A RELATIVE path is resolved against `state.runtime.cwd` when the
   *   department declares one; with no declared `cwd` there is nothing to
   *   resolve against but the daemon's own process cwd, so the path is
   *   passed through unchanged — the same behaviour this manager has always
   *   had for that case, now explicit rather than accidental.
   * - A `container`-tier department (`state.runtime.container !== undefined`)
   *   is REFUSED explicitly, always, regardless of whether the path looks
   *   relative or absolute: `path` names a location inside the CONTAINER's
   *   filesystem (relative to `ContainerSpec.workspaceContainerPath`/
   *   `workdir`, e.g. `/workspace`), which this HOST process cannot open
   *   directly. Correctly translating it would need to know whether it falls
   *   under the auto-provisioned workspace mount (`container.ts`'s
   *   `<workspaceRoot>/<taskId>` ↔ `/workspace`) or one of
   *   `ContainerSpec.mounts`' arbitrary host↔container pairs — information
   *   `ContainerAdapter` does not expose to this supervisor today. Guessing
   *   wrong here would mean silently reading (or worse, silently NOT
   *   reading) the wrong file, so this refuses with a reason naming the
   *   limitation instead — the same "explicit refusal over guessing" contract
   *   `uploadDepartmentArtifact`'s caps already hold to. Container-tier
   *   artifact publishing is left to inline `bytes` (under 64 KiB) or a
   *   follow-up task that threads the host mount path through
   *   `ContainerHandle`.
   */
  private resolveArtifactPath(state: ExecutionState, path: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (state.runtime.container !== undefined) {
      return {
        ok: false,
        reason:
          `department execution ${state.executionId}: artifact path "${path}" is inside a 'container'-tier department's ` +
          `filesystem, which this runner process cannot read directly (d3 scope gap — path translation across the ` +
          `container boundary is not implemented) — rejected, not read from the wrong filesystem; use inline bytes ` +
          `under 64 KiB instead`,
      };
    }
    if (isAbsolute(path) || state.runtime.cwd === undefined) return { ok: true, path };
    return { ok: true, path: resolvePath(state.runtime.cwd, path) };
  }

  /** d3 (per code-review finding): record a successful upload against
   *  `taskId`'s running total, evicting the OLDEST tracked task first if this
   *  would introduce a new entry past {@link MAX_TRACKED_TASK_ARTIFACT_BUDGETS}
   *  — the size backstop described in the module doc. */
  private noteTaskArtifactBytesSent(taskId: string, size: number): void {
    const current = this.taskArtifactBytesSent.get(taskId) ?? 0;
    if (current === 0 && this.taskArtifactBytesSent.size >= MAX_TRACKED_TASK_ARTIFACT_BUDGETS) {
      const oldest: string | undefined = this.taskArtifactBytesSent.keys().next().value;
      if (oldest !== undefined) this.taskArtifactBytesSent.delete(oldest);
    }
    this.taskArtifactBytesSent.set(taskId, current + size);
  }

  /**
   * d3 (per code-review finding): reclaim `taskId`'s `taskArtifactBytesSent`
   * entry once no NON-TERMINAL execution of that task remains — called from
   * both termination funnels (`reportTerminal`, and `handleLeaseRevoked`
   * separately since it deliberately bypasses `reportTerminal`). Guarded by
   * "no other execution of this taskId is still live" rather than deleting
   * unconditionally: a task CAN have more than one `ExecutionState` at once
   * (a redelivered offer with a fresh `executionId` after the previous
   * attempt's lease expired, before this one's own termination lands) — were
   * this to always delete, one execution's termination would erase the
   * budget another, still-running execution of the SAME task had already
   * spent against, letting it exceed 09 §3.1's per-task cap after all. */
  private releaseTaskArtifactBudgetIfIdle(taskId: string): void {
    for (const other of this.executions.values()) {
      if (other.taskId === taskId && !other.terminal) return;
    }
    this.taskArtifactBytesSent.delete(taskId);
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
    // b4: the STUCK watchdog is deliberately left running here. Eviction
    // reclaims a process; it does not decide the task is fine. An execution
    // whose handle was evicted and that nobody ever nudges again is exactly
    // the "goes quiet" case, and it is still reported — the two mechanisms
    // observe the same silence and do different things about it.
  }

  // ── b4: stuck detection (D25, 06 §5 — see the module doc) ───────────────

  /**
   * How long this execution may be silent, or `null` for "not watched".
   *
   * The gate is the engine's OWN declaration (`./engine.ts`, b2): only an
   * engine that says `supportsStreaming: 'yes'` — "I report as I work, not
   * only at the end" — can be held to it. `pipeline` declares `'partial'`
   * (nothing is reported WHILE a buffered exec runs; events appear only at
   * invocation boundaries), so timing it out on silence would fail every
   * pipeline department that thinks for longer than the threshold. An adapter
   * with no registry row at all — a test double, a future third-party module —
   * declared nothing and is likewise not watched: the supervisor never invents
   * a promise on a module's behalf.
   *
   * Given a watched engine: an explicit `stuckAfterSeconds` wins (`0` disables
   * it for that department), otherwise the default. `handleConfigUpdateFrame`
   * is what turns a department's `limits.taskTimeout` into that field.
   */
  private resolveStuckAfterMs(runtime: RuntimeConfig): number | null {
    const engineName = adapterIdToEngine(runtime.adapterId);
    const declaration = engineName === null ? null : lookupEngine(engineName);
    if (declaration?.capabilities.supportsStreaming !== 'yes') return null;
    const seconds = runtime.stuckAfterSeconds ?? DEFAULT_STUCK_AFTER_S;
    return seconds > 0 ? seconds * 1000 : null;
  }

  private armStuckTimer(state: ExecutionState): void {
    this.clearStuckTimer(state);
    if (state.terminal || state.stuckAfterMs === null) return;
    state.stuckTimer = this.clock.setTimeout(() => this.checkStuck(state), state.stuckAfterMs);
  }

  private clearStuckTimer(state: ExecutionState): void {
    if (state.stuckTimer !== null) {
      this.clock.clearTimeout(state.stuckTimer);
      state.stuckTimer = null;
    }
  }

  /**
   * One window elapsed — but the window is measured from the LAST signal, not
   * from when the timer was armed, so a session that has been reporting all
   * along simply re-arms for the remainder. That is what keeps a slow-but-live
   * task off this path without re-arming a timer on every one of the hundreds
   * of frames a busy session emits.
   */
  private checkStuck(state: ExecutionState): void {
    state.stuckTimer = null;
    if (state.terminal || state.stuckAfterMs === null) return;
    // Parked: the sender has been asked a question and the wait is legitimate
    // and bounded by park expiry (d2), which owns this window entirely.
    // `deliverMessage` re-arms this timer when the answer lands.
    if (state.parkTimer !== null) return;
    const quietFor = this.clock.now() - state.lastActivityAt;
    if (quietFor < state.stuckAfterMs) {
      state.stuckTimer = this.clock.setTimeout(() => this.checkStuck(state), state.stuckAfterMs - quietFor);
      return;
    }
    this.logger.warn(
      `department execution ${state.executionId}: no progress for ${quietFor}ms (threshold ${state.stuckAfterMs}ms) — ` +
        `reporting '${STUCK_FAILURE_REASON}' and notifying the sender`,
    );
    // `retrySafe: false`, like every other supervisor-initiated termination
    // (cancel, deadline, park expiry): a session that stopped reporting may
    // have got arbitrarily far through its side effects first, and the
    // supervisor cannot know how far.
    void this.terminateExecution(state, STUCK_FAILURE_REASON, false);
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
    // b4: a parked question is not silence — the runtime asked, and the wait
    // is the SENDER's now, bounded by park expiry below. Suspend the stuck
    // watchdog for the duration; `deliverMessage` re-arms it on the answer.
    this.clearStuckTimer(state);
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
 *  the caller logs and drops, same tolerance as before the repin.
 *
 *  b4: MESSAGE-level `metadata` is carried through. It was dropped here
 *  before, silently, which made the sender identity unreachable for everything
 *  downstream that reads it — `./events.ts`'s `senderFromMessages` (the
 *  journal's `sender` column, 05 §6) and `./claude-code.ts`'s
 *  `buildSessionContext` (which tells a session who addressed it) both read
 *  `metadata.sender` and, for any wire-delivered offer, always found nothing. */
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
    ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
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
