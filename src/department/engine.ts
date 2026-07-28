/**
 * The engine-module contract (simplified-onboarding task b2; design
 * `06-engine-modules.md`, D9/D23/D24).
 *
 * ## Why this file exists
 *
 * "Engine" was a word in a design doc. The mechanism is already shipped:
 * `AgentRuntimeAdapter` (`./adapter.ts`, department-mesh d1), three
 * implementations, resolved by `RuntimeConfig.adapterId`. But that interface
 * is deliberately unopinionated — `probe/start/send/cancel/dispose` describes
 * ANY external process — so it says nothing about which of those behaviours a
 * given module actually honours, and nothing about the responsibilities that
 * are not method-shaped (wiring MCP, refusing without it). "Adding Codex is
 * five mechanical steps" was therefore a claim with nothing behind it to
 * check.
 *
 * This file adds exactly two things ON TOP of `AgentRuntimeAdapter` and
 * changes nothing underneath it:
 *
 *   1. `EngineModule` — `AgentRuntimeAdapter` plus three DECLARATIONS: the
 *      user-facing engine name, the capability set it can honour, and whether
 *      it refuses to run without its department MCP connection.
 *   2. `ENGINE_REGISTRY` — the one table that carries the `engine:` ⇄
 *      `adapterId` mapping, the same capability declarations in data form
 *      (for consumers that hold no adapter instance — notably the CLI's
 *      `validate`), and therefore the supported-engine list.
 *
 * No supervisor behaviour depends on any of it yet: `DepartmentManager` still
 * resolves adapters by `RuntimeConfig.adapterId` exactly as before, and every
 * shipped adapter keeps its `id`. This is a declaration layer, added ahead of
 * the `claude-code` module (task b3) that has to live inside it.
 *
 * ## `engine` is the user-facing name for `adapterId` (D9, 06 §7)
 *
 * A user writes `runtime: { engine: pipeline }`; the runner stores
 * `adapterId: 'pipeline-drive'`. The two names are one-to-one and the
 * translation happens at the CLI boundary (task a7) using this table — no
 * user-facing text says "adapterId", and no internal type is renamed, because
 * `AgentRuntimeAdapter` is shipped, tested and load-bearing.
 *
 * ## The six engine responsibilities (06 §3), and what carries each
 *
 * | # | Responsibility                                   | Carried by                                              |
 * |---|--------------------------------------------------|---------------------------------------------------------|
 * | 1 | Start a session in the department folder          | `start()` — `invocation.runtime.cwd`                     |
 * | 2 | Inject the envelope's prompt                      | `start()` — `invocation.task.messages`                   |
 * | 3 | Establish *and maintain* the department MCP link  | the module's OWN `start()`; `requireEngineMcpEnv()` hands it the URL + token the supervisor already injected |
 * | 4 | Refuse to start when that link cannot be made     | `requiresMcpConnection: true` + rejecting `start()` with `EngineMcpUnavailableError` |
 * | 5 | Detect that the session ended, and how            | the `completed` / `failed` events on the `RuntimeEventSink` |
 * | 6 | Emit a progress signal the supervisor can time out on | the `progress` event on the same sink                 |
 * |   | *Declare which capabilities it can honour*        | `engineCapabilities` (below)                             |
 *
 * Everything else is the supervisor's and is written once: leases, offers,
 * accept/reject, deadlines, park expiry, cancellation, process-group kills,
 * crash reporting, artifact upload, metering, retention, and token minting
 * (`./manager.ts`). An engine module is small on purpose: spawn, inject,
 * wire, observe. It knows nothing about the wire protocol, leases, or the
 * cloud.
 *
 * Responsibilities 1, 2, 5 and 6 are structurally forced — they are
 * `AgentRuntimeAdapter` methods and event shapes that already exist, and a
 * module that omits them does not compile or produces no terminal event.
 * 3 and 4 are not method-shaped (the module must connect from INSIDE its own
 * `start()`; a supervisor-called `connect()` hook would move the
 * responsibility back across the line 06 §3 draws). They are therefore
 * carried as a declaration plus a shared, typed refusal — see
 * `EngineMcpUnavailableError`.
 *
 * ## Adding an engine, in this repo, concretely (06 §6)
 *
 *   1. Implement `EngineModule` (i.e. `AgentRuntimeAdapter` + the three
 *      declarations) in a new `./<engine>.ts`.
 *   2. Add its name to `ENGINE_NAMES` below.
 *   3. Add its row to `ENGINE_REGISTRY` below — the `Record<EngineName, …>`
 *      type makes 2 without 3 (or 3 without 2) a compile error, so the enum
 *      and the table can never drift apart.
 *   4. Construct it in the adapter array at `../cli.ts` (the composition
 *      root — an adapter instance needs a logger, so SOME call site must make
 *      one; it is the only step outside this file).
 *
 * Nothing else: not `department.yml`'s shape, not the CLI's commands, not the
 * wire protocol, not the scheduler, not the cloud, not any existing
 * department.
 */

import type { IsolationTier } from '../core/capabilities';
import type { AgentRuntimeAdapter, InvocationEnvelope } from './adapter';
import { RuntimeAdapterError } from './adapter';

// ── Declared capabilities (06 §3) ───────────────────────────────────────────

/**
 * How well one capability is honoured. Three values, exactly the vocabulary
 * 06 §3's table uses ("yes" / "no" / "partial") — deliberately NOT a boolean,
 * because two of the shipped answers are genuinely neither: `pipeline`
 * streams only at invocation boundaries, and `process` lets the wrapped
 * runtime decide at handshake time.
 *
 * `'partial'` means "sometimes, or not fully" and is the honest answer
 * whenever a plain yes would over-promise. A consumer deciding whether to
 * hard-fail should treat `'no'` as an error and `'partial'` as a warning that
 * names the caveat — the caveat itself is documented capability by capability
 * on each engine's `*_ENGINE_CAPABILITIES` const below.
 */
export type EngineCapabilityLevel = 'yes' | 'partial' | 'no';

export const ENGINE_CAPABILITY_LEVELS = ['yes', 'partial', 'no'] as const;

/**
 * What a module declares it can honour, checked by `validate` against a
 * department's `communication:` block at AUTHORING time rather than
 * surprising anyone at runtime (06 §3; the same coherence rule
 * `department-mesh/06-department-registry.md` §3.1 already states).
 *
 * NOT to be confused with `RuntimeCapabilities` (`./adapter.ts`), which is a
 * different thing at a different time: that one is negotiated PER HANDLE at
 * `start()` from the runtime's own `ready` frame and governs what the
 * supervisor may send to THAT process. This one is a static property of the
 * MODULE, known before any process exists, which is what makes it usable by a
 * CLI that never starts anything. Where both exist they must not contradict:
 * a module declaring `acceptsMidTaskInput: 'no'` may never mint a handle with
 * `midTaskInput: true`.
 */
export interface EngineCapabilities {
  /** Can a message reach the session while a task is already in flight? */
  acceptsMidTaskInput: EngineCapabilityLevel;
  /** Can an in-flight task be stopped on request (as opposed to only by
   *  killing the process out from under it)? */
  supportsCancellation: EngineCapabilityLevel;
  /** Does the session report as it works, rather than only at the end? This
   *  is what responsibility 6's progress signal rides on, and what P4's
   *  stuck detection (D25) will time out against. */
  supportsStreaming: EngineCapabilityLevel;
  /** Can a session's state be captured and resumed later
   *  (`AgentRuntimeAdapter.checkpoint`/`resume`)? No shipped engine can. */
  supportsCheckpoint: EngineCapabilityLevel;
}

/**
 * `process` — `./jsonl-process.ts`, the flagship JSONL contract.
 *
 * - `acceptsMidTaskInput: 'partial'` — the contract HAS a mid-task channel
 *   (stdin, `task.message` down-frames), but whether a given runtime accepts
 *   one is that runtime's own `ready` declaration, and the adapter refuses to
 *   send when it said no (`./jsonl-process.ts`'s `send`). "Yes" would
 *   over-promise for a runtime this module cannot see yet.
 * - `supportsCancellation: 'yes'` — `task.cancel` down the same pipe, with a
 *   process-group kill behind it on dispose.
 * - `supportsStreaming: 'yes'` — `task.status` / `task.progress` /
 *   `task.message` arrive line by line while the task runs.
 * - `supportsCheckpoint: 'no'` — `checkpoint`/`resume` are not implemented.
 */
export const PROCESS_ENGINE_CAPABILITIES: EngineCapabilities = {
  acceptsMidTaskInput: 'partial',
  supportsCancellation: 'yes',
  supportsStreaming: 'yes',
  supportsCheckpoint: 'no',
};

/**
 * `container` — `./container.ts`. IDENTICAL to `process` by construction, and
 * that identity is the point: the container adapter delegates the entire
 * JSONL contract to a wrapped `jsonl-process` and adds only isolation
 * (read-only root, explicit mounts, egress allowlist). If these two ever
 * diverged, `container` would have become a second protocol rather than a
 * sandbox — which is exactly what `./_adapter-conformance.ts` exists to
 * prevent, by running one suite unchanged against both.
 */
export const CONTAINER_ENGINE_CAPABILITIES: EngineCapabilities = { ...PROCESS_ENGINE_CAPABILITIES };

/**
 * `pipeline` — `./pipeline-drive.ts`. Matches 06 §3's table row for row.
 *
 * - `acceptsMidTaskInput: 'no'` — buffered exec, no stdin, drive exits after
 *   every invocation; `send()` always throws. An answer to a parked question
 *   arrives as a brand-new `start()` with the full replayed history, not as
 *   mid-task input.
 * - `supportsCancellation: 'yes'` — signal-based abort of the in-flight exec,
 *   the same lever pipeline dispatch has always had.
 * - `supportsStreaming: 'partial'` — nothing is reported WHILE an invocation
 *   runs (the exec is buffered); events appear only at invocation boundaries,
 *   one per exec (`input_required`, `completed`, `failed`). Progress exists
 *   at the granularity of a park/answer cycle, not of the work itself.
 * - `supportsCheckpoint: 'no'` — `checkpoint`/`resume` are not implemented;
 *   the lifecycle is `per-task` only.
 */
export const PIPELINE_ENGINE_CAPABILITIES: EngineCapabilities = {
  acceptsMidTaskInput: 'no',
  supportsCancellation: 'yes',
  supportsStreaming: 'partial',
  supportsCheckpoint: 'no',
};

/**
 * `claude-code` — `./claude-code.ts` (task b3). Matches 06 §3's table row for
 * row; it is the only engine that column describes, and the only one whose
 * every answer is an unqualified one.
 *
 * - `acceptsMidTaskInput: 'yes'` — 06 §3's own words are "yes — via the
 *   receiver tools", and this module additionally keeps the session's stdin
 *   open (`--input-format stream-json`), so `send()` reaches a LIVE session
 *   rather than being queued for a respawn. Both halves are real; the
 *   per-handle `RuntimeCapabilities.midTaskInput` it mints is `true` to match.
 * - `supportsCancellation: 'yes'` — stdin half-close as the polite ask, with a
 *   process-GROUP SIGTERM→SIGKILL escalation behind it on dispose. A Claude
 *   Code session shells out constantly, so the group is the only correct
 *   target.
 * - `supportsStreaming: 'yes'` — `--output-format stream-json` delivers one
 *   JSON frame per line WHILE the session works; every assistant turn and
 *   every tool call becomes a `progress` event. Unlike `pipeline`, nothing
 *   waits for an invocation boundary.
 * - `supportsCheckpoint: 'no'` — `checkpoint`/`resume` are not implemented.
 *   Claude Code does have native session resume (`--resume <session_id>`), so
 *   this is the one capability here that is 'no' by choice of scope rather
 *   than by nature; declaring 'yes' would promise a `CheckpointRef` round trip
 *   that no code in this package performs.
 */
export const CLAUDE_CODE_ENGINE_CAPABILITIES: EngineCapabilities = {
  acceptsMidTaskInput: 'yes',
  supportsCancellation: 'yes',
  supportsStreaming: 'yes',
  supportsCheckpoint: 'no',
};

// ── The module contract ─────────────────────────────────────────────────────

/**
 * An `AgentRuntimeAdapter` that also says what it is. Every shipped adapter
 * implements this; `claude-code` (task b3) implements the same three
 * declarations and nothing more is asked of it structurally.
 */
export interface EngineModule extends AgentRuntimeAdapter {
  /** The user-facing name (`engine:` in `department.yml`). `ENGINE_REGISTRY`
   *  maps it back to `id`, which stays the registry key the supervisor
   *  resolves `RuntimeConfig.adapterId` against. */
  readonly engine: EngineName;
  /** Responsibility 7 — what this module can honour, statically. */
  readonly engineCapabilities: EngineCapabilities;
  /**
   * Responsibilities 3 + 4 (D23/D24). `true` means: this module's `start()`
   * MUST establish its department MCP connection and MUST reject — with
   * `EngineMcpUnavailableError`, before spawning anything — when it cannot.
   * A session that cannot report anything is worse than one that never began.
   *
   * The three process/drive modules declare `false`, and that is ground truth
   * rather than an oversight: `./manager.ts`'s `resolveMcpEnv` deliberately
   * degrades to "no MCP env this spawn" instead of failing admission, because
   * JSONL and drive runtimes work with no MCP access whatsoever.
   * `claude-code` (b3) is the one that declares `true`, and shows why the flag
   * exists: without the connection it has no `task.complete` and no
   * `task.fail`, so it can only end by deadline.
   */
  readonly requiresMcpConnection: boolean;
  /**
   * x20 — the isolation tier this module ACTUALLY provides
   * (`../core/capabilities.ts`'s `IsolationTier`, the same vocabulary
   * `register --container` advertises and the mesh scheduler matches a
   * department's `requiredIsolation` against).
   *
   * Exactly one shipped module answers `'container'`, and that asymmetry is
   * the point. Isolation is not a flag on a `RuntimeConfig` that any adapter
   * honours — it is a property of the adapter that runs the process, because
   * only `./container.ts` builds a `docker run` around it. Every other module
   * spawns straight onto the host and IGNORES `RuntimeConfig.container`
   * entirely (`./adapter.ts`'s own field doc says so).
   *
   * Declaring it makes that ignoring CHECKABLE instead of silent: see
   * `./manager.ts`'s `resolveIsolationRefusal`, which refuses to run a
   * department whose config asks for a sandbox the selected adapter cannot
   * build. Before x20 that request was simply dropped and the session ran
   * unsandboxed on the host.
   */
  readonly isolation: IsolationTier;
}

// ── Responsibility 4: refusing, rather than running blind (D24) ─────────────

/** The URL + token the supervisor injects for a spawn (`./manager.ts`). */
export const ENGINE_MCP_URL_ENV = 'PIPELINE_MESH_MCP_URL';
export const ENGINE_MCP_TOKEN_ENV = 'PIPELINE_MESH_EXECUTION_TOKEN';

/**
 * x21 (D33) — the OTHER half of responsibility 3, the half D23 specified and
 * `b3` could not build: not "a token for this spawn" but "a way to get the
 * NEXT one".
 *
 * The two variables above are fixed at spawn. `./manager.ts:511-521` states
 * outright that a renewal "does not (cannot) push a new token into an
 * already-running process", so a session that outlives its execution token's
 * TTL loses every receiver tool it has — including `task.complete` and
 * `task.fail` — and (pre-`x16`) reported success anyway.
 *
 * These two point at a LOOPBACK endpoint the supervisor owns
 * (`./execution-token-endpoint.ts`), scoped to one execution by a
 * per-execution secret. A child of the session presents the secret and gets a
 * FRESH execution token back — the same short-lived, audience-restricted
 * credential the session already holds a copy of, never anything more. The
 * daemon's durable OAuth client secret stays where
 * `./execution-token-manager.ts` says it stays: in the daemon, in memory.
 *
 * Injected only when the supervisor actually has such an endpoint, exactly
 * the way the two above are injected only when a token could be minted —
 * absent is the normal, working, pre-x21 state and every engine must tolerate
 * it (`./claude-code.ts` falls back to the static header).
 */
export const ENGINE_MCP_HELPER_URL_ENV = 'PIPELINE_MESH_HELPER_URL';
/** SECRET. Per-execution, loopback-only, in-memory, revoked at terminal. It
 *  authorizes exactly one thing: "hand me a fresh token for MY execution".
 *  Same discipline as the token itself — never on a command line, never on
 *  disk, never logged. */
export const ENGINE_MCP_HELPER_SECRET_ENV = 'PIPELINE_MESH_HELPER_SECRET';

/** What responsibility 3 needs, once. Nothing else about the connection is
 *  the supervisor's business — how a module keeps it alive across token
 *  expiry is the module's own problem (for `claude-code`, D23's
 *  `headersHelper`, now buildable: see `ENGINE_MCP_HELPER_URL_ENV`). */
export interface EngineMcpEnv {
  url: string;
  /** Short-lived, audience-restricted, and re-minted on every spawn. NEVER
   *  log it, and never put it on a command line. */
  token: string;
}

/** x21 — the loopback re-auth channel, read out of the same injected env, or
 *  `null` when the supervisor offered none. Optional by construction: an
 *  engine that gets `null` still has a working (if expiry-bound) connection,
 *  which is precisely the pre-x21 behaviour. */
export interface EngineMcpHelperChannel {
  url: string;
  /** SECRET — see `ENGINE_MCP_HELPER_SECRET_ENV`. */
  secret: string;
}

/**
 * x21 — read the loopback re-auth channel out of an invocation, or `null`.
 *
 * Deliberately NOT a refusal, unlike `requireEngineMcpEnv` below: a missing
 * channel costs a long task its recovery, not its ability to run, and every
 * shipped runtime worked without one before x21.
 */
export function readEngineMcpHelperChannel(invocation: InvocationEnvelope): EngineMcpHelperChannel | null {
  const env = invocation.runtime.env ?? {};
  const url = env[ENGINE_MCP_HELPER_URL_ENV];
  const secret = env[ENGINE_MCP_HELPER_SECRET_ENV];
  if (typeof url !== 'string' || url.length === 0) return null;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return { url, secret };
}

/**
 * Raised by an `EngineModule` with `requiresMcpConnection: true` whose
 * connection cannot be established. A subclass of `RuntimeAdapterError` on
 * purpose: `./manager.ts`'s `startWithInvocation` already catches everything
 * `start()` rejects with and reports it as a terminal `failed` carrying the
 * message, so refusing this way needs no supervisor change and produces a
 * stated reason rather than a silent one.
 */
export class EngineMcpUnavailableError extends RuntimeAdapterError {}

/**
 * Read the injected MCP environment out of an invocation, or refuse.
 *
 * The supervisor puts both variables in `runtime.env` when it could mint a
 * token and omits them when it could not — there is no third state and no
 * flag to consult, so "can I connect?" is answered exactly here. Shared
 * rather than reimplemented per module so that every engine refuses for the
 * same reason, with the same message, at the same moment: before spawning.
 */
export function requireEngineMcpEnv(invocation: InvocationEnvelope, engine: string): EngineMcpEnv {
  const env = invocation.runtime.env ?? {};
  const url = env[ENGINE_MCP_URL_ENV];
  const token = env[ENGINE_MCP_TOKEN_ENV];
  if (typeof url !== 'string' || url.length === 0 || typeof token !== 'string' || token.length === 0) {
    throw new EngineMcpUnavailableError(
      `${engine}: refusing to start — no department MCP connection is available for this execution ` +
        `(${ENGINE_MCP_URL_ENV}/${ENGINE_MCP_TOKEN_ENV} not injected: the runner is unregistered, ` +
        'execution tokens are unconfigured, or the authorization server refused). ' +
        'A session that cannot report its own completion is worse than one that never began.'
    );
  }
  return { url, token };
}

// ── The registry (06 §2's table, as data) ───────────────────────────────────

/**
 * Every engine this build supports. THE enum: the type below is derived from
 * it, `ENGINE_REGISTRY` is keyed by that type, and `validate`'s
 * supported-engine list is its sorted keys — so an engine cannot be half-added.
 *
 * `claude-code` joined the list in task b3, at the same moment
 * `./claude-code.ts` and its registry row did — listing it any earlier would
 * have made `validate` tell a user that `engine: claude-code` is supported
 * when nothing in this repo could run it. `codex` / `copilot` are still not
 * listed for exactly that reason: "planned" is documentation, not a value a
 * validator should accept.
 */
export const ENGINE_NAMES = ['claude-code', 'process', 'container', 'pipeline'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

/** One engine, as a CLI or a validator sees it — no adapter instance, no
 *  logger, no process. */
export interface EngineDeclaration {
  /** Same as the key it is stored under; carried on the row so iteration
   *  over `Object.values` stays self-describing. */
  readonly engine: EngineName;
  /** The `AgentRuntimeAdapter.id` / `RuntimeConfig.adapterId` this engine
   *  name resolves to — the ONE place the translation lives. */
  readonly adapterId: string;
  readonly capabilities: EngineCapabilities;
  /** Mirrors `EngineModule.requiresMcpConnection` for the same row. */
  readonly requiresMcpConnection: boolean;
  /** Mirrors `EngineModule.isolation` for the same row (x20) — carried as
   *  DATA so the supervisor can judge an isolation request from an
   *  `adapterId` alone, holding no adapter instance, exactly the way
   *  `resolveStuckAfterMs` already reads `capabilities.supportsStreaming`. */
  readonly isolation: IsolationTier;
}

/** Any engine table, including one a test or a future build composes. The
 *  key type is widened to `string` on purpose: a caller-supplied table may
 *  name engines this build does not have (that is the point of the stub-engine
 *  proof), and pretending otherwise would need a cast at every call site. */
export type EngineRegistry = Readonly<Record<string, EngineDeclaration>>;

/**
 * The shipped table. `Record<EngineName, …>` is load-bearing: adding a name
 * to `ENGINE_NAMES` without a row here (or a row without a name) is a
 * compile error, which is what makes "adding an engine is mechanical" true
 * rather than aspirational.
 */
export const ENGINE_REGISTRY: Readonly<Record<EngineName, EngineDeclaration>> = {
  'claude-code': {
    engine: 'claude-code',
    // The one engine whose user-facing name and adapter id coincide: here the
    // mechanism and the thing genuinely have one name (06 §7).
    adapterId: 'claude-code',
    capabilities: CLAUDE_CODE_ENGINE_CAPABILITIES,
    requiresMcpConnection: true,
    // Spawns `claude` straight onto the host. Nothing about this module
    // sandboxes anything — see `isolation`'s doc on `EngineModule`.
    isolation: 'process',
  },
  process: {
    engine: 'process',
    adapterId: 'jsonl-process',
    capabilities: PROCESS_ENGINE_CAPABILITIES,
    requiresMcpConnection: false,
    isolation: 'process',
  },
  container: {
    engine: 'container',
    adapterId: 'container',
    capabilities: CONTAINER_ENGINE_CAPABILITIES,
    requiresMcpConnection: false,
    // The one row that says `container`, and the only adapter that builds a
    // `docker run` (`./container.ts`).
    isolation: 'container',
  },
  pipeline: {
    engine: 'pipeline',
    adapterId: 'pipeline-drive',
    capabilities: PIPELINE_ENGINE_CAPABILITIES,
    requiresMcpConnection: false,
    isolation: 'process',
  },
};

/**
 * The supported-engine list, sorted, for `validate`'s output and its error
 * message ("supported: claude-code, container, pipeline, process"). Sorted rather than
 * declaration-ordered so the list a user reads does not silently reorder when
 * an engine is added.
 */
export function supportedEngines(registry: EngineRegistry = ENGINE_REGISTRY): string[] {
  return Object.keys(registry).sort();
}

/** Membership against the SHIPPED table, narrowing to `EngineName`. Use
 *  `lookupEngine` for a caller-supplied table — see `EngineRegistry`'s doc. */
export function isSupportedEngine(name: string): name is EngineName {
  return Object.hasOwn(ENGINE_REGISTRY, name);
}

/** One row, or `null` — never a throw: an unknown `engine:` is a user typo to
 *  be reported with the supported list, not an exception. */
export function lookupEngine(name: string, registry: EngineRegistry = ENGINE_REGISTRY): EngineDeclaration | null {
  return Object.hasOwn(registry, name) ? (registry[name] as EngineDeclaration) : null;
}

/** `engine:` → `adapterId`. The CLI (task a7) performs the translation when
 *  it writes a binding; this is the table it reads. */
export function engineToAdapterId(name: string, registry: EngineRegistry = ENGINE_REGISTRY): string | null {
  return lookupEngine(name, registry)?.adapterId ?? null;
}

/**
 * x20 — the isolation tier the adapter behind `adapterId` actually provides,
 * or `null` when this build has no engine row for it.
 *
 * `null` means "not this table's to judge", NOT "no isolation": a caller-
 * supplied or test adapter id is outside the shipped set entirely, and
 * `./manager.ts` deliberately does not refuse those (it cannot know what they
 * do — the same posture `adapterIdToEngine` already takes by returning null,
 * and `resolveStuckAfterMs` by declining to watch). Every adapterId a real
 * department can be bound to IS in the table, so the refusal covers every
 * reachable configuration.
 */
export function isolationForAdapterId(adapterId: string, registry: EngineRegistry = ENGINE_REGISTRY): IsolationTier | null {
  for (const row of Object.values(registry)) {
    if (row.adapterId === adapterId) return row.isolation;
  }
  return null;
}

/** `adapterId` → `engine:`, for going the other way: naming the engine that
 *  ran a task in `status`/log output without leaking the internal id
 *  (06 §1's "▶ session started (claude-code)"). */
export function adapterIdToEngine(adapterId: string, registry: EngineRegistry = ENGINE_REGISTRY): string | null {
  for (const row of Object.values(registry)) {
    if (row.adapterId === adapterId) return row.engine;
  }
  return null;
}

/**
 * x14 — every `adapterId` this build has a module for, sorted.
 *
 * The mirror image of `supportedEngines()`, and it exists for the one caller
 * `supportedEngines()` cannot serve: `../cli.ts`'s `bind`, whose `--adapter`
 * flag takes the INTERNAL id rather than the user-facing engine name (it is a
 * machine seam — the `pipeline` CLI's `department serve` shells it, having
 * already done the `engine:` → `adapterId` translation on its side).
 *
 * Sorted rather than declaration-ordered for the same reason
 * `supportedEngines()` sorts: the list a user reads in a refusal must not
 * silently reorder when an engine is added.
 */
export function registeredAdapterIds(registry: EngineRegistry = ENGINE_REGISTRY): string[] {
  return [...new Set(Object.values(registry).map((row) => row.adapterId))].sort();
}

/**
 * x14 — does this build have an engine module behind `adapterId`?
 *
 * This is the fact the runner OWNS and, until x14, never stated: `bind` wrote
 * whatever `--adapter` string it was handed (`b1`'s `narrowRuntimeConfig`
 * validates the SHAPE of a runtime spec, never the existence of the adapter),
 * so a caller guessing at an id got a stored binding, a `● online` report, and
 * a `capability` reject on the first offer that ever arrived for it. The plugin
 * kept its own hand-written mirror of this table precisely because asking was
 * not possible; `x32` found that mirror had gone stale and made `claude-code`
 * — the only engine P4 built — unreachable.
 *
 * Deliberately checked against the ADAPTER id and not the engine name: a
 * binding stores `adapterId`, `DepartmentManager` resolves adapters by it, and
 * the flag is spelled that way. `adapterIdToEngine` names the engine behind an
 * id when a message wants to be helpful about it.
 */
export function isRegisteredAdapterId(adapterId: string, registry: EngineRegistry = ENGINE_REGISTRY): boolean {
  return Object.values(registry).some((row) => row.adapterId === adapterId);
}
