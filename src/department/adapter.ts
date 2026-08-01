/**
 * The `AgentRuntimeAdapter` abstraction (department-mesh, task d1;
 * `07-runtime-contract.md` §2). Today the runner has exactly one runtime
 * (`pipeline drive`), reached by one hard-coded subprocess contract, with no
 * way to talk to a running child. This is the seam that lets the supervisor
 * treat ANY external process, container, or MCP-speaking agent as a
 * "department" — a normalized start/send/cancel/dispose surface plus a
 * normalized upward event stream, with the wire framing, CLI flags, session
 * ids, and provider auth hidden inside the adapter.
 *
 * The adapter is explicitly NOT responsible for routing, lease management, or
 * protocol framing — those stay in the supervisor (`./manager.ts`). It is
 * also explicitly NOT the wire protocol: these are runner-LOCAL domain types.
 * `@baizor/pipeline-protocol` does not carry the department schemas yet (that
 * lands at the `e1` gate, 0.4.0) — nothing here imports it, and nothing here is a
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
  /**
   * THIS department produced this message — it is our own reply, not something
   * a sender addressed to us.
   *
   * PURELY INTERNAL, like `InvocationEnvelope.executionId`: it is set by
   * `./manager.ts` when it records what a session emitted, and it never
   * crosses the wire in either direction.
   *
   * It exists because `role` cannot answer the question. `role` is the
   * SENDER's word about themselves, and a calling department's agent
   * legitimately sends `ROLE_AGENT` (the MCP `tasks.send` schema offers
   * exactly `ROLE_USER | ROLE_AGENT`, and an agent is not a user). So
   * `role === 'ROLE_AGENT'` conflates "another department's agent asked me
   * something" with "this is my own past reply" — and a prompt builder that
   * filtered on it dropped the entire inbound request, then refused the task
   * for carrying no text. That is exactly what happened on 2026-08-01 to a
   * task from `software` to `business`
   * (`claude-code: the envelope carries no sender text to run a session on`,
   * on an envelope whose one message was several thousand words long).
   *
   * The self-echo it guards against is real, which is why the guard did not
   * simply go away: `messageHistory` holds BOTH directions, and a respawn
   * replays it in full, so without this flag a restarted session would be fed
   * its own previous answers back as if a sender had written them.
   */
  selfAuthored?: boolean;
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
   *  waiting forever"). Sourced from a department's manifest via
   *  `department.config_update.limits.parkExpiry` (e.g. `"7d"`, parsed by
   *  `../core/duration.ts`), layered by `./manager.ts`'s
   *  `handleConfigUpdateFrame` on top of whatever `resolveRuntimeConfig`
   *  (still `startupTimeoutSeconds`/`gracefulShutdownSeconds`'s
   *  env-driven placeholder, `./config.ts`) returns as the base. Default:
   *  `./manager.ts`'s `DEFAULT_PARK_EXPIRY_S` (7 days). */
  parkExpirySeconds?: number;
  /** How long an execution of this department may go without ANY signal from
   *  its runtime before the supervisor reports it `stuck` (simplified-
   *  onboarding b4, D25; `./manager.ts`'s stuck detection). `0` disables the
   *  watchdog for this department; absent means the default
   *  (`./manager.ts`'s `DEFAULT_STUCK_AFTER_S`, 30 minutes), itself overridden
   *  by a `department.config_update`'s `limits.taskTimeout`. Only ever applied
   *  to an engine that DECLARES it reports while it works
   *  (`./engine.ts`'s `supportsStreaming: 'yes'`) — see
   *  `DepartmentManager.resolveStuckAfterMs`. */
  stuckAfterSeconds?: number;
  lifecycle?: RuntimeLifecycle;
  /** `container` adapter only (task d8, see the section above) — read-only-
   *  root/explicit-mounts/egress-allowlist spec. Every other adapter ignores
   *  this field entirely. */
  container?: ContainerSpec;
  /** `pipeline-drive` adapter only (task d4, see the section below) — the
   *  fields `../jobs/drive.ts`'s `DriveTarget`/`DriveMode('start')` need
   *  beyond what `command`/`cwd`/`env` above already supply. Every other
   *  adapter ignores this field entirely. */
  pipelineDrive?: PipelineDriveSpec;
}

export interface ProbeResult {
  ok: boolean;
  runtime?: string;
  version?: string;
  capabilities?: RuntimeCapabilities;
  /** Present when `ok:false` — why the probe failed. */
  reason?: string;
}

// ── `pipeline-drive` adapter spec (department-mesh, task d4; 07 §2.1) ───────
// Read by the `pipeline-drive` adapter ONLY (`./pipeline-drive.ts`) — mirrors
// `../jobs/drive.ts`'s `DriveTarget` fields exactly (that file is NOT changed
// by this task), so `buildDriveArgs` produces byte-identical argv whether
// called from the untouched pipeline-dispatch path (`../jobs/executor.ts`) or
// from this adapter — "one adapter abstraction serves both dispatch paths"
// without a second implementation of the contract.

/** One `pipeline-drive` department's static configuration — analogous to
 *  `ContainerSpec` for the `container` adapter. Deliberately does NOT carry
 *  `runId`: the adapter uses the invocation's own `DeptTaskSpec.taskId` for
 *  that (one department task IS one drive run, the same relationship a
 *  pipeline-dispatch lease's `run_id` has to its job). */
export interface PipelineDriveSpec {
  /** Absolute pipeline root inside the checkout (`--root`) — mirrors
   *  `DriveTarget.pipelineRoot`. */
  pipelineRoot: string;
  /** Entry iteration for the initial `--start` (root-relative, e.g.
   *  `steps/01-plan.md`) — mirrors `DriveMode`'s `start` variant. */
  startIteration: string;
  /** Mirrors `DriveTarget.defaultModel` (`--default-model`). */
  defaultModel?: string;
  /** Mirrors `DriveTarget.defaultEffort` (`--default-effort`). */
  defaultEffort?: string;
  /** Mirrors `DriveTarget.variables` (`--var NAME=value`, START invocation
   *  only — `buildDriveArgs` itself enforces that, unchanged). */
  variables?: Record<string, string>;
}

// ── `container` isolation-tier spec (department-mesh, task d8; 07 §2.1/§2.2,
//    10-security.md §5/T15/T30) ───────────────────────────────────────────────
// Read by the `container` adapter ONLY (`./container.ts`) — every other
// adapter ignores `RuntimeConfig.container` entirely, same "read what you
// understand" discipline `RuntimeConfig`'s own doc states. Kept here (next to
// `RuntimeConfig`) rather than in `./container.ts` so the field can be typed
// on `RuntimeConfig` without a cross-module import cycle.

/** One explicit host<->container bind mount. `container` never bind-mounts
 *  anything NOT listed here (plus its own auto-provisioned per-execution
 *  workspace, `./container.ts`) — "explicit mounts only" is enforced by
 *  construction: there is no "mount everything under `cwd`" fallback. */
export interface ContainerMount {
  /** Absolute host-side path. */
  hostPath: string;
  /** Absolute path the mount appears at INSIDE the container. */
  containerPath: string;
  /** Default false (read-write). The container's ROOT filesystem is
   *  read-only regardless of this flag — mounts (including this one) are the
   *  ONLY writable surface a `container`-tier runtime has. */
  readOnly?: boolean;
}

/** One egress-allowlist entry: a host (name or literal IP) the container may
 *  reach, optionally restricted to one port. No wildcards — exact match only,
 *  the same least-privilege discipline `10-security.md`'s SSRF controls (T8)
 *  apply elsewhere. */
export interface ContainerEgressRule {
  host: string;
  port?: number;
}

export type ContainerRuntimeBinary = 'docker' | 'podman';

/** The `container` adapter's per-department config (07 §2.1: "wraps
 *  `jsonl-process` … in a container with a read-only root, explicit mounts,
 *  and an egress allowlist"). Required on `RuntimeConfig` whenever
 *  `adapterId === 'container'` — `ContainerAdapter` refuses to start a
 *  department that omits it rather than ever running one unsandboxed. */
export interface ContainerSpec {
  /** OCI image the wrapped `command`/`args` run inside. No default — an
   *  operator must choose one explicitly, exactly as `command` has none. */
  image: string;
  /** Explicit mounts — see `ContainerMount`'s doc. May be empty. */
  mounts: ContainerMount[];
  /** Egress allowlist. Empty/absent ⇒ the container gets NO network at all
   *  (`--network none`) — the safe default; a runtime that needs egress must
   *  say so, host by host. */
  egressAllowlist?: ContainerEgressRule[];
  /** REQUIRED whenever `egressAllowlist` is non-empty: the pre-provisioned
   *  container network the operator has configured to actually enforce that
   *  allowlist (firewall/proxy rules — see `./container.ts`'s module doc for
   *  exactly what this adapter does and does not automate). Missing this
   *  while declaring an allowlist is a fail-closed construction error, never
   *  a silent attach to an unenforced default network. */
  egressNetwork?: string;
  /** `'docker'` (default) or `'podman'` — both accept the same flag surface
   *  this adapter emits. */
  runtimeBinary?: ContainerRuntimeBinary;
  /** Container-side working directory. Defaults to the auto-provisioned
   *  per-execution workspace mount's container path. */
  workdir?: string;
  /** Container path the auto-provisioned, per-execution workspace directory
   *  is mounted at, read-write (T15/T30). Default `/workspace`. */
  workspaceContainerPath?: string;
  /** Size, in MiB, of the writable `/tmp` tmpfs every container gets so
   *  `--read-only` stays usable without relaxing it (memory-backed, never a
   *  host bind-mount, never persisted). Default 64. */
  tmpfsSizeMb?: number;
  /** Extra raw flags appended verbatim just before the image — an escape
   *  hatch for operator-specific needs (resource limits, a seccomp profile,
   *  …). Never used to relax read-only-root or the mount list; those are
   *  hard-coded by `./container.ts`, not configurable through this field. */
  extraArgs?: string[];
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
  /**
   * x21 (D33) — the execution this invocation IS. Required, not optional: an
   * engine module that cannot name its own execution cannot be handed any
   * supervisor seam keyed by one, and until this field existed it could not
   * (`./claude-code.ts` said so in its own `headersHelper` doc, and `b3`
   * reported the resulting DoD box unmet rather than claiming it).
   *
   * PURELY INTERNAL. This is the runner's own type, not a
   * `@baizor/pipeline-protocol` one — the wire has carried `execution_id`
   * since 0.4.0 (`department.offer`, `department.event`, `department.artifact`
   * …) and `./manager.ts` has always held it as `ExecutionState.executionId`;
   * it simply was never threaded down to the adapter. Adding it here needs no
   * protocol change of any kind.
   *
   * NOT a secret and NOT a capability: it is already in journal paths, index
   * lines and log messages. It is an IDENTIFIER, which is exactly why an
   * engine may safely put it somewhere world-readable (`./claude-code.ts`
   * places it on the headers-helper's argv) while the token and the loopback
   * secret that go with it may not.
   */
  executionId: string;
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
