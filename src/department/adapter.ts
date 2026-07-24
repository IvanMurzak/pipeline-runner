/**
 * The `AgentRuntimeAdapter` abstraction (department-mesh, task d1;
 * `07-runtime-contract.md` §2). Today the runner has exactly one runtime
 * (`pipeline drive`), reached by one hard-coded subprocess contract, with no
 * way to talk to a running child. This is the seam that lets the mesh treat
 * ANY external process, container, or MCP-speaking agent as a "department" —
 * a normalized start/send/cancel/dispose surface plus a normalized upward
 * event stream, with the wire framing, CLI flags, session ids, and provider
 * auth hidden inside the adapter.
 *
 * The adapter is explicitly NOT responsible for routing, lease management, or
 * protocol framing — those stay in the supervisor (`./manager.ts`). It is
 * also explicitly NOT the wire protocol: these are runner-LOCAL domain types.
 * `@baizor/pipeline-protocol` does not carry the mesh schemas yet (that lands
 * at the `e1` gate, 0.4.0) — nothing here imports it, and nothing here is a
 * zod schema. Field names are snake_case where they mirror a wire concept
 * (`08-protocol-delta.md`) purely so a future swap to the real protocol types
 * is a near drop-in, not because these types ARE the wire.
 */

// ── Message / part / question shapes (07 §2, mirrors 08 §3's shared shapes
//    field-for-field, but as plain runner-local types — see the module doc) ──

/** A2A-style unified content part: exactly one of {text|raw|url|data} is set. */
export interface Part {
  text?: string;
  /** Base64-encoded inline bytes. */
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export type DeptRole = 'ROLE_USER' | 'ROLE_AGENT';

export interface DeptMessage {
  messageId: string;
  role: DeptRole;
  parts: Part[];
  contextId?: string;
  taskId?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Question {
  text: string;
  context?: string | null;
  options?: string[] | null;
}

// ── Runtime configuration + capability negotiation ──────────────────────────

export type RuntimeLifecycle = 'per-task' | 'per-context' | 'daemon';

/** What a runtime declares (via `ready`) or is declared to offer (manifest).
 *  Negotiation is HONEST (07 §3): a `midTaskInput:false` runtime is never
 *  sent `task.message` while a task is in flight — full stop. */
export interface RuntimeCapabilities {
  midTaskInput: boolean;
  artifacts: boolean;
}

/** How to reach and run one department runtime. Adapter-agnostic; a given
 *  adapter reads only the fields it understands (e.g. `jsonl-process` reads
 *  `command`/`args`/`cwd`/`env`, ignores nothing else defined here). */
export interface RuntimeConfig {
  /** Which adapter this config targets, e.g. `'jsonl-process'`. Matches
   *  `AgentRuntimeAdapter.id` — the supervisor's registry lookup key. */
  adapterId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** The process MUST emit `ready` within this window or the execution fails
   *  (07 §3). Default: see `jsonl-process.ts`'s `DEFAULT_STARTUP_TIMEOUT_S`. */
  startupTimeoutSeconds?: number;
  /** Grace window between `shutdown`/SIGTERM and a hard kill on dispose. */
  gracefulShutdownSeconds?: number;
  /** How long a PARKED task (`input_required`, no answer yet) stays alive
   *  before the supervisor expires it (department-mesh task d2; 07 §7 —
   *  "a parked question inherits the department's park expiry rather than
   *  waiting forever"). The real source is a department's manifest
   *  (`department.config_update.limits.parkExpiry`, e.g. `"7d"`), which
   *  install/config-caching (task c2) has not wired onto the runner yet —
   *  this is the SAME placeholder env-driven seam `startupTimeoutSeconds`/
   *  `gracefulShutdownSeconds` already use ahead of that. Default:
   *  `./manager.ts`'s `DEFAULT_PARK_EXPIRY_S` (7 days). */
  parkExpirySeconds?: number;
  lifecycle?: RuntimeLifecycle;
}

export interface ProbeResult {
  ok: boolean;
  runtime?: string;
  version?: string;
  capabilities?: RuntimeCapabilities;
  /** Present when `ok:false` — why the probe failed. */
  reason?: string;
}

// ── Invocation + handle ──────────────────────────────────────────────────────

export interface DeptTaskSpec {
  taskId: string;
  contextId: string;
  /** Full message history the task starts with (a fresh task: just the
   *  opening message(s); a `per-context` respawn: the FULL retained history —
   *  see `./manager.ts`'s replay-on-restart policy). */
  messages: DeptMessage[];
  acceptedOutputModes?: string[];
}

export interface InvocationEnvelope {
  runtime: RuntimeConfig;
  task: DeptTaskSpec;
  /** Wall-clock deadline (ISO 8601); enforcement is the supervisor's job (07
   *  §7, task d2) — carried here so an adapter MAY surface it if the runtime
   *  it wraps has a native notion of one. Not enforced by `jsonl-process`. */
  deadlineAt?: string;
}

/** The public shape every adapter's handle satisfies. Concrete adapters may
 *  return a handle with additional private fields (structurally a subtype);
 *  callers other than the adapter that minted it must treat this as opaque. */
export interface RuntimeHandle {
  readonly adapterId: string;
  readonly taskId: string;
  readonly contextId: string;
  /** Capabilities as negotiated at `start()` (the runtime's actual `ready`
   *  frame wins over anything declared in a manifest ahead of time). */
  readonly capabilities: RuntimeCapabilities;
}

/** One down-message to an already-started (or being-started) runtime.
 *  `task.start` on an EXISTING handle is how `per-context`/`daemon` lifecycle
 *  reuse works: the adapter interface has no separate "attach" method — a
 *  live handle just receives another `task.start` down the same pipe (07
 *  §3's JSONL contract allows exactly this: "await the next `task.start`"
 *  for daemon lifecycle). `message` is genuine mid-task input. */
export type RuntimeInput = { kind: 'task.start'; task: DeptTaskSpec } | { kind: 'message'; message: DeptMessage };

export interface CheckpointRef {
  contextId: string;
  data: unknown;
}

// ── The normalized upward event stream (07 §2, verbatim) ────────────────────

export type RuntimeEvent =
  | { type: 'status'; state: 'WORKING'; message?: string }
  | { type: 'message'; parts: Part[] }
  | { type: 'input_required'; questionId: string; question: Question }
  | { type: 'artifact'; name: string; mediaType: string; bytes?: Uint8Array; path?: string }
  | { type: 'progress'; note: string }
  | { type: 'completed'; summary?: string }
  | { type: 'failed'; reason: string; retrySafe: boolean };

export type RuntimeEventSink = (event: RuntimeEvent) => void;

// ── The adapter interface (07 §2, verbatim) ──────────────────────────────────

export interface AgentRuntimeAdapter {
  readonly id: string;
  probe(config: RuntimeConfig): Promise<ProbeResult>;
  start(invocation: InvocationEnvelope, sink: RuntimeEventSink): Promise<RuntimeHandle>;
  send(handle: RuntimeHandle, input: RuntimeInput): Promise<void>;
  cancel(handle: RuntimeHandle, reason?: string): Promise<void>;
  checkpoint?(handle: RuntimeHandle): Promise<CheckpointRef>;
  resume?(checkpoint: CheckpointRef, invocation: InvocationEnvelope): Promise<RuntimeHandle>;
  dispose(handle: RuntimeHandle): Promise<void>;
}

/** Raised by an adapter for an execution-ending, non-recoverable-by-retry
 *  failure at `start()` time (e.g. missing `ready`) — distinguishes "this
 *  invocation failed" from a thrown bug. Callers may also see plain `Error`s
 *  from unexpected seam failures (spawn ENOENT, etc.); both reject the
 *  `start()` promise, per the interface — there is no separate "start failed"
 *  event, since the caller never got a handle to report one on. */
export class RuntimeAdapterError extends Error {}
