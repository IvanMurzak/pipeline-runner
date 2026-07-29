/**
 * `pipeline-drive` — department-mesh task d4 (`07-runtime-contract.md` §2.1,
 * `11-migration-rollout.md` P5). Wraps the EXISTING, UNCHANGED `pipeline
 * drive` contract (`../jobs/drive.ts`'s `buildDriveArgs` / `classifyDriveOutcome`
 * — neither touched by this file) behind the `AgentRuntimeAdapter` surface
 * (`./adapter.ts`, task d1), so `pipeline drive` becomes expressible as one
 * department runtime among others (`jsonl-process`, `container`) — "one
 * adapter abstraction serves both dispatch paths" (P5 DoD).
 *
 * ── This is a REFACTOR, not a new capability ────────────────────────────────
 * The pipeline-DISPATCH path (`../jobs/executor.ts`'s `JobExecutor`) is
 * intentionally left calling `buildDriveArgs`/`classifyDriveOutcome` DIRECTLY,
 * exactly as before this task — its provider-limit pause ladder, needs-input
 * relay (`NeedsInputRelay`), durable resume records, and ordered-completion
 * flush/report sequencing are supervisor-level policy (07 §2: "the adapter is
 * … not responsible for routing, lease management, or protocol framing —
 * those stay in the supervisor") that does not fit this adapter's generic
 * start/send/cancel/dispose surface without inventing NEW behaviour for
 * `pipeline drive` — forbidden by this task's own DoD ("no behaviour change
 * for pipeline runs"). `11-migration-rollout.md` §5 explicitly keeps that
 * "duplicate park/answer path" for pipeline dispatch; this adapter does not
 * retire or replace it. `../jobs/drive.test.ts`'s golden argv tests keep
 * asserting THAT direct path, byte-for-byte unchanged by this file.
 *
 * What THIS file proves instead: `AgentRuntimeAdapter` is expressive enough
 * to describe `pipeline drive`'s exact CLI contract — same argv (07 §2.1:
 * "wraps today's drive.ts contract unchanged"), same BUFFERED `JobExec` seam
 * (`../jobs/types.ts` earmarked this exactly: "that contract stays exactly
 * as-is for `pipeline drive` … d4 later ports it onto the adapter abstraction
 * unchanged"), same exit-code classification — reachable from the
 * department-mesh admission surface (`./manager.ts`) for a department whose
 * resolved `RuntimeConfig.adapterId === 'pipeline-drive'`.
 *
 * ── Declared capabilities (07 §2.1, fixed, never negotiated) ────────────────
 * `acceptsMidTaskInput: false`, `lifecycle: 'per-task'` only — always, not
 * something a `ready`-style handshake could ever raise (there is no
 * handshake: buffered `JobExec`, no stdin, drive exits after every
 * invocation). Consequently:
 *   - `send(handle, {kind:'message', …})` ALWAYS throws — mirrors
 *     `JsonlProcessAdapter`'s own capability-refusal discipline exactly
 *     (`./jsonl-process.ts`). `DepartmentManager` already never calls this
 *     for a `midTaskInput:false` handle (`./manager.ts`'s `deliverMessage`),
 *     so this is belt-and-braces, same posture as jsonl-process's own guard.
 *   - `send(handle, {kind:'task.start', …})` (daemon/per-context handle
 *     reuse) ALSO throws — 07 §2.1 restricts this adapter to `per-task`
 *     only; there is no live process to hand a second task to.
 *   - `checkpoint`/`resume` are not implemented (optional on the interface;
 *     `per-context`/`daemon` reuse do not apply here).
 *
 * ── One process per `start()`, not a loop (07 §1's buffered-exec note) ──────
 * Drive's own contract already has THREE invocation shapes (`start` /
 * `resume` / `answer`, `DriveMode`) chained by the CALLER (`executor.ts`'s
 * `driveLoop`) across possibly many exec calls before a task-level terminal
 * state is reached. THIS adapter's `start()` performs exactly ONE such exec
 * and reports the ONE resulting `RuntimeEvent` — `completed`, `failed`, or
 * `input_required` — derived from `classifyDriveOutcome`. It does NOT
 * loop/retry/pause internally on a PLAIN failure (provider-limit handling is
 * the one exception, below) — a caller that wants the FULL multi-step drive
 * loop is exactly what `JobExecutor.driveLoop` already is, untouched by this
 * file.
 *
 * ── Resuming a parked question (07 §5, `DepartmentManager`'s respawn-on-
 *    answer contract) ────────────────────────────────────────────────────────
 * `acceptsMidTaskInput:false` means `send()` never delivers an answer to a
 * LIVE process (there is none to deliver to — drive already exited). Instead,
 * per `./adapter.ts`'s own documented contract and `./manager.ts`'s
 * `deliverMessage`/`spawnAndStart`, an answer arrives as a BRAND NEW
 * `start()` call whose `task.messages` is the FULL retained history —
 * original message(s) plus the answer, appended last. This adapter honors
 * that contract for real: it remembers the drive-minted `iteration_path` /
 * `session_id` from its own `input_required` event (an internal
 * `taskId`-keyed map — nothing about this rides the wire; `RuntimeEvent`'s
 * `input_required` shape carries no room for it and is not changed here), and
 * on the NEXT `start()` for the SAME `taskId`, builds `DriveMode`'s existing
 * `answer` variant (`--resume --start <iteration_path> --answer <text>`)
 * instead of restarting from `pipelineDrive.startIteration` — using the
 * SAME, unmodified `buildDriveArgs` the fresh-start path uses, just a
 * different (already-existing) mode literal. The answer TEXT is read off the
 * last message in the replayed history (the cloud always appends it there,
 * `./manager.ts`'s `deliverMessage`); a park whose next `start()` carries no
 * usable text fails the task rather than silently resending nothing.
 * `iteration_path` is deliberately NOT consumed by `buildDriveArgs`'s
 * `resume`/`answer` modes beyond `--start`'s value — `session_id`/`step_id`
 * are retained too (parity with `JobExecutor`'s own `ParkedQuestion`/
 * `RecordedQuestion`) even though drive's argv never reads them back.
 *
 * `start()` itself resolves as soon as the handle is minted — there is no
 * "ready" signal to wait for (unlike `jsonl-process`'s handshake), and the
 * BUFFERED `JobExec` seam offers no earlier one either (a single promise that
 * only resolves at exit, `../jobs/types.ts`). The one drive exec races in the
 * background; its outcome reaches `sink` once `pipeline drive` exits —
 * exactly mirroring how `jsonl-process` streams events AFTER `start()`
 * resolves, just with a single terminal-shaped event instead of a live
 * stream (drive has nothing incremental to report, 07 §1's own table: "stdout
 * buffered until close"). The background exec is awaited with a `.catch()`
 * at the fire-and-forget call site — `sink()` runs synchronously inside
 * `DepartmentManager.handleRuntimeEvent` (journal `fs.appendFileSync`, a
 * wire `send()`) and a throw there would otherwise become an unhandled
 * rejection that crashes the whole daemon (verified empirically on Bun
 * 1.3.14), taking every in-flight execution down with it — not merely this
 * one task.
 *
 * ── Provider limits (06.7, `../jobs/drive.ts`'s module doc: "provider limit
 *    takes precedence over exit-code classification") ──────────────────────
 * `JobExecutor.driveLoop` runs `detectProviderLimit(result)` BEFORE
 * `classifyDriveOutcome` and PAUSES (auto-resume) rather than failing on a
 * hit. This adapter runs the SAME detector (`defaultProviderLimitDetector`,
 * injectable, unmodified) with the SAME precedence, but — unlike
 * `driveLoop` — does NOT implement a pause/backoff timer or auto-resume loop
 * itself: that ladder is genuinely supervisor policy (07 §2), and
 * `DepartmentManager` has no equivalent mechanism today for a `per-task`
 * lifecycle (its ONE auto-respawn path is gated to `per-context`,
 * `./manager.ts`'s `handleRuntimeEvent`). Flattening a detected limit to an
 * ordinary `retrySafe:false` failure would silently lose exactly the
 * distinction this task exists to preserve; instead it is surfaced honestly
 * as `{type:'failed', retrySafe:true}` — a truthful signal a supervisor CAN
 * act on, even though none does yet for this lifecycle. A parked question's
 * remembered `iteration_path`/`session_id` (above) is left untouched when a
 * limit is hit while resuming an answer, so a future retry can still resume
 * from the right place.
 *
 * ── Cancellation (07 §7) ─────────────────────────────────────────────────────
 * There is no wire channel to ask politely (buffered `JobExec`, no stdin) —
 * the injectable `AbortSignal` (`JobExecOptions.signal`) is the only lever,
 * and it is the EXACT SAME mechanism `JobExecutor`'s own cancel/suspend
 * already use for the SAME `pipeline drive` child (`nodeJobExec()`'s abort
 * handling: `child.kill()`, a plain SIGTERM to the direct child — no
 * process-group escalation, because the buffered seam offers none). `cancel()`
 * and `dispose()` both abort and both mark the handle disposed (suppressing
 * any late/stale result either could otherwise still report) — this is
 * IDENTICAL in strength to what pipeline dispatch already had before this
 * task; no credential path, no kill semantics, changed (10-security.md §7 P5
 * gate).
 *
 * **Known, deliberately NOT fixed gap (follow-up, not this task):**
 * `cancel()`/`dispose()` only ever reach `nodeJobExec()`'s plain
 * `child.kill()` — SIGTERM to the direct child, no process-GROUP kill, no
 * SIGKILL escalation — unlike `jsonl-process`/`container`, which both use
 * `ProcessHandle.killGroup()` (task d2) via the STREAMING `nodeJobSpawn()`
 * seam. Giving `pipeline-drive` the same strength would mean either (a)
 * adding `detached:true`/group-kill semantics to the SHARED `nodeJobExec()`
 * seam — which every pipeline-dispatch invocation (git, `pipeline drive`,
 * `pipeline hash`, `pipeline plan`, `pipeline match`) also runs through,
 * risking the exact "no behaviour change for pipeline runs" guarantee this
 * task is graded on — or (b) giving this adapter its own parallel spawn path
 * that bypasses the shared `JobExec` seam entirely, which would reintroduce
 * the asymmetry between the two dispatch paths this task exists to remove.
 * Left as-is; a real fix belongs to a task scoped to touch `nodeJobExec()`
 * deliberately, with pipeline-dispatch regression coverage as its own gate.
 *
 * ── Saying that the run STARTED (x40) ───────────────────────────────────────
 * `x36` fixed this defect in `./claude-code.ts`; its own worker found the same
 * hole here and correctly left it outside that fence, because the two engines
 * have nothing in common about WHEN a run has provably begun. Before x40 this
 * module emitted no `{type:'status'}` event at all, ever — `grep -c` returned
 * zero — and that event is the ONLY thing in the system that moves a task out
 * of `SUBMITTED`. The cloud's transition table admits `SUBMITTED -> WORKING |
 * REJECTED | CANCELED`, and its scheduler says so in as many words:
 * "`department.accept` does NOT move a task to WORKING (only the runner's own
 * `status` event does)". So a `pipeline`-engine task was admitted `SUBMITTED`
 * and stayed there for the whole run — rendered to its own sender as `queued`
 * while `pipeline drive` worked for minutes or hours, which is exactly the
 * "goes quiet" failure 02 §5 forbids, on the flagship path.
 *
 * Two consequences beyond the wrong live state, both of which this fixes:
 *
 *  1. A drive that FAILS lands as `REJECTED`, not `FAILED`. The cloud's `x18`
 *     picks whichever terminal the state machine permits, and from `SUBMITTED`
 *     that is `REJECTED` — "the department refused the task" — for a pipeline
 *     that genuinely ran and genuinely failed. From `WORKING` it lands as the
 *     `FAILED` it actually is.
 *  2. Every completion goes through the cloud's `x36` repair
 *     (`ensureWorkingForLiveExecution`), which promotes on the engine's behalf
 *     and logs at WARN that "the engine never emitted a status event". That is
 *     deliberate defence in depth whose own doc says "the primary fix is still
 *     the engine's". This is that fix.
 *
 * ── Which instant, and why it is not `claude-code`'s ────────────────────────
 * x36 announces at the `init` frame, because that is the earliest instant a
 * Claude Code session has provably begun, and announcing at first-assistant-
 * activity would be too late by construction. This adapter has no frames at
 * all: `JobExec` is BUFFERED (`../jobs/types.ts`), a single promise that
 * settles only when `pipeline drive` EXITS. There is no `init`, no `ready`, no
 * stdout line — nothing between the spawn and the exit.
 *
 * So the instants actually available here are:
 *
 *  - **Immediately before `exec.run()`** — this one. It is the last
 *    synchronous point at which anything is knowable, and it is knowable
 *    truthfully: every pre-flight decision that can end this execution WITHOUT
 *    a child process ever existing has already been made — `start()`'s spec
 *    and lifecycle validation (which throws, so no handle and no sink exist
 *    yet), `prune()`, and `runOnce`'s own parked-without-an-answer refusal.
 *    Past that point the ONLY remaining act is the spawn. The announcement
 *    therefore means "a `pipeline drive` child is being launched for this task
 *    now", never the weaker "an execution was admitted".
 *  - After `exec.run()` resolves — too late by construction, and worse than
 *    x36's rejected alternative rather than merely equal to it. The buffered
 *    seam produces NOTHING until the process exits, so this instant IS the
 *    instant of the terminal event: `status` and `completed` would be sunk in
 *    the same turn, one `seq` apart, and the announcement meant to unblock the
 *    terminal would be racing it with no gap at all. x36 called that shape
 *    "usually wins is not a fix"; here it would not even usually win.
 *  - Inside `start()`, before `runOnce` — earlier, but it announces the wrong
 *    thing. It would fire for a resume that is about to refuse itself for want
 *    of an answer, i.e. for an execution that never launches a process.
 *
 * Emitted once per `runOnce()`, which is once per `start()` — this adapter is
 * `per-task` and performs exactly one exec per start, so there is no second
 * announcement inside a run. A park/answer RESPAWN does announce again, and
 * that is correct rather than the re-announcement x36 warns against: the cloud
 * has already taken `INPUT_REQUIRED -> WORKING` itself when the sender's answer
 * landed (`scheduler.ts#answerTask`), so the second announcement restates the
 * state the task is already in — and the cloud ignores a `status` it cannot
 * legally transition to ("same state or illegal … ignore; never mutate"). It
 * can never yank a still-parked task out of `INPUT_REQUIRED`, because this
 * adapter only ever reaches this line when an answer is already in hand.
 *
 * What this does NOT re-arm: `./manager.ts`'s `b4` stuck detection. `pipeline`
 * declares `supportsStreaming: 'partial'` (`./engine.ts`), so
 * `resolveStuckAfterMs` returns `null` and BOTH shapes — the silence watchdog
 * and `judgeTerminalEvent`'s "ended having reported nothing" — are inapplicable
 * to this engine and always were. Independently of that, `handleRuntimeEvent`
 * already excludes `status` from the runtime-signal count (x36), engine-
 * agnostically, so this event could not have disabled shape 2 even for a
 * watched engine.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import {
  buildDriveArgs,
  classifyDriveOutcome,
  defaultProviderLimitDetector,
  type DriveMode,
  type DriveOutcome,
  type DriveTarget,
  type ProviderLimitDetector,
} from '../jobs/drive';
import type { JobExec, JobExecResult } from '../jobs/types';
import { nodeJobExec } from '../jobs/types';
import type {
  DeptMessage,
  DeptTaskSpec,
  InvocationEnvelope,
  PipelineDriveSpec,
  ProbeResult,
  Question,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeHandle,
  RuntimeInput,
} from './adapter';
import { RuntimeAdapterError } from './adapter';
import type { IsolationTier } from '../core/capabilities';
// simplified-onboarding b2: the engine-module declarations (`./engine.ts`).
import type { EngineCapabilities, EngineModule, EngineName } from './engine';
import { PIPELINE_ENGINE_CAPABILITIES } from './engine';

/** 07 §2.1: fixed and declared, never negotiated (there is no handshake that
 *  could raise it — unlike `jsonl-process`'s `ready` frame). */
export const PIPELINE_DRIVE_CAPABILITIES: RuntimeCapabilities = { midTaskInput: false, artifacts: false };

/**
 * x40: the human half of the ONE `{type:'status', state:'WORKING'}` event this
 * module emits per `runOnce()` — see the module doc's "Saying that the run
 * STARTED" section for the instant it is emitted at and why that instant, and
 * not the two alternatives, is the only honest one for a buffered exec.
 *
 * Names the INVOCATION rather than the session, because that is what this
 * adapter can actually vouch for: one `pipeline drive` child is being spawned.
 * A resume announces the same thing again for its own child, which is the
 * truth about that child.
 */
export const DRIVE_STARTED_STATUS_MESSAGE = 'pipeline drive invocation started';

export interface PipelineDriveAdapterOptions {
  exec?: JobExec;
  logger?: Logger;
  /** Mints a fallback `input_required` question id for a parked outcome whose
   *  drive final JSON predates `question_id` (06.2.1) — mirrors
   *  `JobExecutor`'s own fallback-minting (`../jobs/executor.ts`'s
   *  `this.makeId()` in `driveLoop`'s `awaiting_input` branch). */
  makeId?(): string;
  /** Same seam `JobExecutor` injects (`../jobs/executor.ts`'s
   *  `detectProviderLimit`), defaulting to the SAME `defaultProviderLimitDetector`
   *  (`../jobs/drive.ts`, unmodified) — see this module's doc's "Provider
   *  limits" section. */
  detectProviderLimit?: ProviderLimitDetector;
  clock?: Clock;
  /** Safety-net upper bound on how long a remembered park (`ParkedDriveState`)
   *  is trusted — see "Bounding parked-resume state" below. Default
   *  `DEFAULT_PARKED_STATE_TTL_MS`. */
  parkedStateTtlMs?: number;
  /** Hard ceiling on the number of remembered parks, oldest-touched evicted
   *  first. Default `DEFAULT_MAX_PARKED_ENTRIES`. */
  maxParkedEntries?: number;
}

/** 7 days — the same order of magnitude as `./manager.ts`'s own
 *  `DEFAULT_PARK_EXPIRY_S`, duplicated here as a LOCAL constant rather than
 *  imported: this adapter's sweep must not depend on the supervisor's own
 *  policy ever being reachable (see "Bounding parked-resume state"). */
export const DEFAULT_PARKED_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds memory even if the TTL is misconfigured absurdly large or a
 *  pathological number of tasks park in a short window. */
export const DEFAULT_MAX_PARKED_ENTRIES = 500;

// ── Parked-question resume state (07 §5's respawn-on-answer contract) ───────
// Keyed by `taskId`, which is stable across the whole execution (never
// changes across a park/answer respawn, `./manager.ts`'s `spawnAndStart`) —
// NOT by handle identity, since `DepartmentManager` disposes the handle that
// reported `input_required` and mints a fresh one on the next `start()`.
//
// ── Bounding parked-resume state ─────────────────────────────────────────
// `cancel()` clears an entry (above), but `cancel()` is NOT reliably reached
// for a PARKED execution that later terminates: `midTaskInput:false` makes
// `./manager.ts`'s `handleRuntimeEvent` null out `state.handle` the INSTANT
// `input_required` fires, and every termination path that can fire while
// parked — park expiry (`onParkExpired`), an explicit `department.cancel`
// (`cancelExecution`), a blown wall-clock deadline (`onDeadlineExceeded`),
// and `lease_revoked` — all gate their OWN `adapter.cancel()` call on
// `state.handle !== null`. A parked task always has a null handle, so NONE
// of these ever call `cancel()`; `state.terminal` is set and the map entry
// would otherwise leak for the life of the daemon. Park expiry exists
// PRECISELY for "the answer never comes" — this is the mainline unanswered-
// park path, not a corner case.
//
// This adapter has no callback for "an execution ended silently" at all (the
// interface has none to offer), so the fix cannot depend on ANY caller
// telling it — `prune()` (on `PipelineDriveAdapter`) sweeps on its own, by
// elapsed time and by a hard count ceiling, on every `runOnce()` call
// (start OR resume), so ANY task's activity opportunistically reclaims
// entries abandoned by OTHER tasks. A pruned entry, if an answer somehow
// still arrives for it later, is simply treated as a fresh `{kind:'start'}`
// (`runOnce`'s `parkedState === undefined` branch) — degrading safely rather
// than ever resuming from a stale or fabricated target.

interface ParkedDriveState {
  /** `DriveParked.iteration_path` (`../jobs/drive.ts`) — the ONLY field
   *  `buildDriveArgs`'s `answer` mode actually reads back (as `--start`'s
   *  value on the resume invocation). */
  iterationPath: string;
  /** Retained for parity with `JobExecutor`'s own `ParkedQuestion`/
   *  `RecordedQuestion` (`../jobs/executor.ts`) — not consumed by
   *  `buildDriveArgs`, which has no `--session-id`/`--step-id` flag. */
  sessionId: string | null;
  stepId: string | null;
  /** `clock.now()` when this entry was (re)written — the basis for the TTL/
   *  size-based eviction in `PipelineDriveAdapter.prune()`. Adapter-local
   *  bookkeeping only; never drive or wire data. */
  touchedAtMs: number;
}

/** The answer text for a resume: the LAST message's first text part. Reads
 *  ONLY the last entry (never scans further back) — `DepartmentManager`
 *  always appends the answer last (`./manager.ts`'s `deliverMessage`), and
 *  falling back to earlier history on a textless last message would risk
 *  silently replaying STALE content as if it were a live answer. Null ⇒ the
 *  caller fails the task rather than resuming with no `--answer` value. */
function extractAnswerText(messages: readonly DeptMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (last === undefined) return null;
  for (const part of last.parts) {
    if (typeof part.text === 'string' && part.text.length > 0) return part.text;
  }
  return null;
}

// ── The handle ────────────────────────────────────────────────────────────

class PipelineDriveHandle implements RuntimeHandle {
  readonly adapterId = 'pipeline-drive';
  readonly capabilities: RuntimeCapabilities = PIPELINE_DRIVE_CAPABILITIES;
  /** Set by `cancel()`/`dispose()` — once true, a still-in-flight exec's
   *  eventual result is never reported (mirrors `jsonl-process`'s "an exit
   *  during dispose() is not reported as a failure"). */
  disposed = false;

  constructor(
    readonly taskId: string,
    readonly contextId: string,
    readonly controller: AbortController
  ) {}
}

function asPipelineDriveHandle(handle: RuntimeHandle): PipelineDriveHandle {
  if (!(handle instanceof PipelineDriveHandle)) {
    throw new RuntimeAdapterError('pipeline-drive: handle was not minted by this adapter');
  }
  return handle;
}

// ── The adapter ───────────────────────────────────────────────────────────

export class PipelineDriveAdapter implements EngineModule {
  readonly id = 'pipeline-drive';
  // ── Engine-module declarations (b2, 06 §3) ──────────────────────────────
  /** `engine: pipeline` is what a user writes; `pipeline-drive` is what the
   *  binding stores. The two differ precisely because the internal id names
   *  the MECHANISM (`pipeline drive`) and the engine names the THING
   *  (a pipeline) — 06 §7. */
  readonly engine: EngineName = 'pipeline';
  /** Fixed, never negotiated — this module has no handshake to raise them
   *  with (see this file's "Declared capabilities" section). */
  readonly engineCapabilities: EngineCapabilities = PIPELINE_ENGINE_CAPABILITIES;
  /** `pipeline drive` reaches the cloud through the runner's own event
   *  shipper, not through the department MCP server; it has never needed the
   *  injected variables and does not refuse without them. */
  readonly requiresMcpConnection = false;
  /** x20: `pipeline drive` runs as an ordinary host child process. */
  readonly isolation: IsolationTier = 'process';

  private readonly exec: JobExec;
  private readonly logger: Logger;
  private readonly makeId: () => string;
  private readonly detectLimit: ProviderLimitDetector;
  private readonly clock: Clock;
  private readonly parkedStateTtlMs: number;
  private readonly maxParkedEntries: number;
  /** Parked-resume state, keyed by `taskId` — see the module doc's "Resuming
   *  a parked question" / "Bounding parked-resume state" sections and
   *  `ParkedDriveState`'s own doc. Bounded by `prune()`, called on every
   *  `runOnce()` — see that method's doc for why this cannot depend on
   *  `cancel()` being reached. */
  private readonly parked = new Map<string, ParkedDriveState>();

  constructor(options: PipelineDriveAdapterOptions = {}) {
    this.exec = options.exec ?? nodeJobExec();
    this.logger = options.logger ?? nullLogger;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.detectLimit = options.detectProviderLimit ?? defaultProviderLimitDetector;
    this.clock = options.clock ?? systemClock;
    this.parkedStateTtlMs = options.parkedStateTtlMs ?? DEFAULT_PARKED_STATE_TTL_MS;
    this.maxParkedEntries = options.maxParkedEntries ?? DEFAULT_MAX_PARKED_ENTRIES;
  }

  /**
   * Bound `this.parked` independently of any caller ever reaching `cancel()`
   * (see the module doc's "Bounding parked-resume state") — called at the
   * TOP of every `runOnce()`, before peeking this task's own entry, so a
   * pruned entry (including this very task's, if it is old enough) is
   * treated exactly like one that was never parked. Two mechanisms, both
   * cheap:
   *   - TTL sweep: an entry untouched for longer than `parkedStateTtlMs` is
   *     dropped — its execution is presumed abandoned (park-expired,
   *     deadline-blown, cancelled, or lease-revoked; this adapter has no
   *     visibility into WHICH, only that nothing has touched it in a very
   *     long time).
   *   - Hard ceiling: oldest-touched-first eviction down to
   *     `maxParkedEntries` (`Map` iterates in insertion order, and `runOnce`
   *     deletes-then-reinserts on every touch so re-parking moves an entry
   *     to the "freshest" end) — bounds memory even under pathological churn
   *     or an absurdly large TTL.
   */
  private prune(now: number): void {
    for (const [taskId, state] of this.parked) {
      if (now - state.touchedAtMs > this.parkedStateTtlMs) this.parked.delete(taskId);
    }
    while (this.parked.size > this.maxParkedEntries) {
      const oldest = this.parked.keys().next().value;
      if (oldest === undefined) break;
      this.parked.delete(oldest);
    }
  }

  /**
   * Best-effort binary-presence check. Unlike `jsonl-process`'s `probe()`
   * (a real `initialize`/`ready` handshake, 07 §3), `pipeline drive` has NO
   * handshake to probe at all — this simply confirms `config.command
   * --version` runs. Not wired into any live admission path today (nothing
   * in `./manager.ts` calls `adapter.probe()` — same as every other adapter
   * in this package); it exists to satisfy the interface and is exercised by
   * this module's own tests.
   */
  async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const result = await this.exec.run(config.command, ['--version'], { cwd: config.cwd, env: config.env });
    if (result.code !== 0) {
      return {
        ok: false,
        reason: `'${config.command} --version' exited ${result.code ?? 'null'}${result.error ? `: ${result.error}` : ''}`,
      };
    }
    const version = result.stdout.trim();
    return {
      ok: true,
      runtime: 'pipeline-drive',
      capabilities: PIPELINE_DRIVE_CAPABILITIES,
      ...(version.length > 0 ? { version } : {}),
    };
  }

  async start(invocation: InvocationEnvelope, sink: RuntimeEventSink): Promise<RuntimeHandle> {
    const { runtime, task } = invocation;
    const drive = runtime.pipelineDrive;
    if (drive === undefined) {
      throw new RuntimeAdapterError("pipeline-drive: RuntimeConfig.pipelineDrive is required (07 §2.1)");
    }
    if (drive.pipelineRoot.trim().length === 0) {
      throw new RuntimeAdapterError('pipeline-drive: pipelineDrive.pipelineRoot must not be blank');
    }
    if (drive.startIteration.trim().length === 0) {
      throw new RuntimeAdapterError('pipeline-drive: pipelineDrive.startIteration must not be blank');
    }
    // 07 §2.1: this adapter IS `lifecycle:'per-task'` only — it never keeps a
    // live process across a respawn, so a department misconfigured with
    // `RuntimeConfig.lifecycle: 'per-context'` would silently get NONE of
    // what that lifecycle promises (idle-eviction reuse, real checkpoint
    // continuity) while still flipping `./manager.ts`'s crash-recovery gate
    // (`state.lifecycle === 'per-context'`) on for a `retrySafe:true`
    // provider-limit failure it was never designed to receive. Refuse rather
    // than silently behave as `per-task` under a `per-context` label.
    if (runtime.lifecycle !== undefined && runtime.lifecycle !== 'per-task') {
      throw new RuntimeAdapterError(
        `pipeline-drive: RuntimeConfig.lifecycle must be 'per-task' (or omitted) — got '${runtime.lifecycle}' (07 §2.1)`
      );
    }

    const controller = new AbortController();
    const handle = new PipelineDriveHandle(task.taskId, task.contextId, controller);
    // Fire-and-forget: the ONE drive exec races in the background; its
    // outcome reaches `sink` once `pipeline drive` exits (see this module's
    // doc — there is no earlier signal the buffered `JobExec` seam could
    // offer, unlike jsonl-process's `ready`). The `.catch()` here is NOT
    // decorative: `sink()` runs synchronously inside `DepartmentManager.
    // handleRuntimeEvent` (journal write, wire `send()`) and an uncaught
    // throw from EITHER of those would otherwise surface as an unhandled
    // promise rejection — which crashes the whole runner daemon, not just
    // this task (see the module doc). RESIDUAL COST, accepted deliberately:
    // if `sink()` itself is what throws, the terminal event this call was
    // trying to deliver is LOST — only a `logger.warn` survives — so
    // `DepartmentManager` never learns this execution ended and the task
    // sits non-terminal until its wall-clock deadline (`armDeadlineTimer`)
    // or park-expiry timer eventually fires and force-terminates it. That
    // trade (one task stuck until its deadline vs. the ENTIRE daemon,
    // every in-flight execution across every department, crashing outright)
    // is the right one, but it is a real cost, not a free fix.
    void this.runOnce(runtime, drive, task, sink, handle).catch((err: unknown) => {
      this.logger.warn(
        `pipeline-drive[${task.taskId}]: runOnce failed unexpectedly (${err instanceof Error ? err.message : String(err)})`
      );
    });
    return handle;
  }

  async send(handleIn: RuntimeHandle, input: RuntimeInput): Promise<void> {
    asPipelineDriveHandle(handleIn); // validates minting, mirrors every other adapter here
    if (input.kind === 'message') {
      throw new RuntimeAdapterError(
        "pipeline-drive: acceptsMidTaskInput:false (07 §2.1) — task.message can never be sent to this runtime; the supervisor must queue it and deliver at the next start()"
      );
    }
    throw new RuntimeAdapterError(
      "pipeline-drive: lifecycle is 'per-task' only (07 §2.1) — there is no live process to hand a second task.start to"
    );
  }

  async cancel(handleIn: RuntimeHandle, _reason?: string): Promise<void> {
    const handle = asPipelineDriveHandle(handleIn);
    // No wire channel to ask politely (buffered JobExec, no stdin) — abort is
    // the only lever, identical in strength to what pipeline dispatch already
    // had (`JobExecutor`'s own cancel/suspend use the same signal-based
    // abort against the same `nodeJobExec()` seam). See this module's doc.
    //
    // `disposed` is set HERE too, not only in `dispose()` (its own doc
    // comment already promised "set by cancel()/dispose()") — `manager.ts`'s
    // `terminateExecution` calls `cancel()` then immediately finalizes
    // WITHOUT waiting for anything from this adapter's `sink`; a still-
    // in-flight exec's eventual result must never be reported once the
    // supervisor has already moved on. `dispose()` (called right after, in
    // every real caller) then no-ops on its own `disposed` guard — harmless,
    // `AbortController.abort()` is idempotent regardless.
    handle.disposed = true;
    // Real termination — no future respawn will ever consume this park.
    // (The OTHER caller of `dispose()`, evicting a handle right after
    // `input_required` so the supervisor can respawn with the answer, never calls
    // `cancel()` first — see the module doc — so this never fires for that
    // case.)
    this.parked.delete(handle.taskId);
    handle.controller.abort();
  }

  async dispose(handleIn: RuntimeHandle): Promise<void> {
    const handle = asPipelineDriveHandle(handleIn);
    if (handle.disposed) return;
    handle.disposed = true;
    handle.controller.abort();
  }

  private async runOnce(
    runtime: RuntimeConfig,
    drive: PipelineDriveSpec,
    task: DeptTaskSpec,
    sink: RuntimeEventSink,
    handle: PipelineDriveHandle
  ): Promise<void> {
    // Bound `this.parked` on EVERY invocation — not only when about to
    // insert a new entry — so any task's activity (fresh start OR resume)
    // opportunistically sweeps entries abandoned by OTHER tasks (module
    // doc's "Bounding parked-resume state"; `prune()`'s own doc for why).
    this.prune(this.clock.now());

    // Resuming a parked question (07 §5, module doc's "Resuming a parked
    // question"): a PEEK, not a consume — only actually removed from the map
    // once we know the outcome (below), so a provider limit hit while
    // resuming leaves the parked state intact for a future retry.
    const parkedState = this.parked.get(task.taskId);

    let mode: DriveMode;
    if (parkedState !== undefined) {
      const answer = extractAnswerText(task.messages);
      if (answer === null) {
        // Terminal either way (a 'failed' event is about to be reported, or
        // the handle is already disposed) — no future respawn will consume
        // this park for this taskId, so clean it up rather than leak it.
        this.parked.delete(task.taskId);
        if (!handle.disposed) {
          sink({
            type: 'failed',
            reason:
              'pipeline-drive: task was parked awaiting an answer, but the replayed message history carries no usable answer text',
            retrySafe: false,
          });
        }
        return;
      }
      mode = { kind: 'answer', startIteration: parkedState.iterationPath, answer };
    } else {
      mode = { kind: 'start', startIteration: drive.startIteration };
    }

    const target: DriveTarget = {
      pipelineRoot: drive.pipelineRoot,
      runId: task.taskId,
      ...(drive.defaultModel !== undefined ? { defaultModel: drive.defaultModel } : {}),
      ...(drive.defaultEffort !== undefined ? { defaultEffort: drive.defaultEffort } : {}),
      ...(drive.variables !== undefined ? { variables: drive.variables } : {}),
    };
    // The SAME, unchanged argv builder pipeline-dispatch uses, with a mode
    // `buildDriveArgs` already supports — this IS the "one abstraction
    // serves both dispatch paths" proof (P5 DoD).
    const args = buildDriveArgs(target, mode);

    // x40: and the task says it is working — the one event that moves it off
    // `SUBMITTED`, without which it is rendered to its own sender as `queued`
    // for the entire run and its eventual failure lands as `REJECTED` rather
    // than `FAILED`. See {@link DRIVE_STARTED_STATUS_MESSAGE} and the module
    // doc for why HERE: every branch that can end this execution without ever
    // launching a child is above this line, and the buffered `JobExec` seam
    // offers nothing between the spawn below and its exit.
    //
    // No `handle.disposed` guard, and none is reachable: everything from
    // `start()`'s `void this.runOnce(…)` down to the `await` on the next line
    // runs in ONE synchronous turn, before `start()` has returned the handle to
    // anybody who could cancel or dispose it.
    sink({ type: 'status', state: 'WORKING', message: DRIVE_STARTED_STATUS_MESSAGE });

    let result: JobExecResult;
    try {
      result = await this.exec.run(runtime.command, args, {
        cwd: runtime.cwd,
        env: runtime.env,
        signal: handle.controller.signal,
      });
    } catch (err) {
      // `JobExec.run()`'s own contract promises never to reject (failures are
      // data — `../jobs/types.ts`); this is defence in depth against a
      // differently-behaved injected seam, same posture as
      // `./manager.ts`'s `executionTokens?.renew(...).catch(() => {})`.
      const reason = `pipeline drive exec threw: ${err instanceof Error ? err.message : String(err)}`;
      if (handle.disposed) {
        this.logger.debug(`pipeline-drive[${task.taskId}]: exec threw after dispose — dropped (${reason})`);
        return;
      }
      sink({ type: 'failed', reason, retrySafe: false });
      return;
    }

    // Torn down via cancel()/dispose() while the exec was in flight — the
    // outcome (however classified) is moot; the supervisor already finalized
    // this execution through a different path (mirrors jsonl-process's "an
    // exit during dispose() is not reported as a failure"). `this.parked` is
    // left exactly as `cancel()` already set it (cleared) or untouched
    // (a plain `dispose()`-only eviction, which never fires mid-exec).
    if (handle.disposed) {
      this.logger.debug(`pipeline-drive[${task.taskId}]: exec settled after dispose — outcome dropped`);
      return;
    }

    // Provider limit takes precedence over exit-code classification (06.7,
    // `../jobs/drive.ts`'s module doc — the SAME rule `JobExecutor.driveLoop`
    // applies) — see the module doc's "Provider limits" section for why this
    // adapter surfaces it as `retrySafe:true` rather than pausing/retrying
    // itself. `this.parked` is deliberately left in place here (NOT deleted):
    // if this invocation was itself an answer-resume, the iteration/answer
    // target must survive for a future retry to use — but it IS re-touched
    // (moved to the "freshest" end, TTL clock reset) so a task that keeps
    // legitimately hitting the limit on retry never goes stale under
    // `prune()` just because it has been parked a long time in wall-clock
    // terms.
    const limit = this.detectLimit(result);
    if (limit !== null) {
      if (parkedState !== undefined) {
        this.parked.delete(task.taskId);
        this.parked.set(task.taskId, { ...parkedState, touchedAtMs: this.clock.now() });
      }
      sink({ type: 'failed', reason: `pipeline drive provider limit: ${limit.reason}`, retrySafe: true });
      return;
    }

    const outcome = classifyDriveOutcome(result);
    if (outcome.kind === 'awaiting_input') {
      // Delete-then-set (not a plain overwriting `set()`) so a re-park moves
      // this entry to the "freshest" end of the `Map`'s insertion order —
      // `prune()`'s hard-ceiling eviction relies on that ordering.
      this.parked.delete(task.taskId);
      this.parked.set(task.taskId, {
        iterationPath: outcome.parked.iteration_path,
        sessionId: outcome.parked.session_id,
        stepId: outcome.parked.step_id,
        touchedAtMs: this.clock.now(),
      });
    } else {
      // completed / halted / failed — no future respawn will consume a park
      // for this taskId again (a fresh admission always mints a NEW taskId).
      this.parked.delete(task.taskId);
    }

    sink(this.toRuntimeEvent(outcome));
  }

  /** `classifyDriveOutcome` (`../jobs/drive.ts`, UNCHANGED) has four kinds;
   *  `RuntimeEvent` has three that apply here. `halted` and `failed` map onto
   *  the SAME `RuntimeEvent` shape — exactly mirroring `JobExecutor.driveLoop`'s
   *  own switch, where the `'halted'` and `'failed'` cases already do the
   *  identical thing (`reportTerminal('halted', …)` then `this.fail(…)`). */
  private toRuntimeEvent(outcome: DriveOutcome): RuntimeEvent {
    switch (outcome.kind) {
      case 'completed':
        return { type: 'completed', summary: outcome.outcome };
      case 'halted':
        return { type: 'failed', reason: outcome.reason, retrySafe: false };
      // `classifyDriveOutcome`'s 'failed' kind covers a usage error (exit 2),
      // an unrecognized exit code, AND a spawn-level failure (`code===null`
      // — binary missing, EPERM, …). Deliberately `retrySafe:false` across
      // the board: unlike `jsonl-process`'s synthetic "process died
      // mid-stream" failure (a qualitatively different case — real work was
      // interrupted, and per-context crash-recovery can pick it back up),
      // none of THESE causes are something a blind retry fixes, and
      // `retrySafe` has no live consumer for this adapter's `per-task`-only
      // lifecycle today anyway (`./manager.ts`'s one auto-respawn path is
      // gated to `per-context`) — false is the safer default until a real
      // consumer exists to prove a finer distinction is worth it.
      case 'failed':
        return { type: 'failed', reason: outcome.reason, retrySafe: false };
      case 'awaiting_input': {
        const parked = outcome.parked;
        const question: Question = {
          text: parked.question.text,
          context: parked.question.context,
          options: parked.question.options,
        };
        // 06.2.1/06.2.2: drive's own minted question_id wins verbatim; an
        // older CLI whose park JSON predates the field gets a fallback —
        // same rule `JobExecutor.driveLoop` applies for its OWN parked path.
        return { type: 'input_required', questionId: parked.question_id ?? this.makeId(), question };
      }
    }
  }
}

/**
 * Narrow an unknown value (loaded from the department binding store,
 * `./bindings.ts`, or its deprecated `PIPELINE_RUNNER_DEPARTMENTS` fallback)
 * back into a `PipelineDriveSpec`, or `undefined` if it is not well-formed
 * enough to drive a run from — same tolerant-parse philosophy `./container.ts`'s
 * `narrowContainerSpec` already uses. Deliberately strict about the two
 * REQUIRED fields (`pipelineRoot`, `startIteration` — a spec missing either
 * cannot build a valid `--root`/`--start` invocation) but tolerant of
 * malformed OPTIONAL fields, each simply omitted.
 */
export function narrowPipelineDriveSpec(raw: unknown): PipelineDriveSpec | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.pipelineRoot !== 'string' || r.pipelineRoot.length === 0) return undefined;
  if (typeof r.startIteration !== 'string' || r.startIteration.length === 0) return undefined;

  const spec: PipelineDriveSpec = { pipelineRoot: r.pipelineRoot, startIteration: r.startIteration };
  if (typeof r.defaultModel === 'string' && r.defaultModel.length > 0) spec.defaultModel = r.defaultModel;
  if (typeof r.defaultEffort === 'string' && r.defaultEffort.length > 0) spec.defaultEffort = r.defaultEffort;
  if (typeof r.variables === 'object' && r.variables !== null && !Array.isArray(r.variables)) {
    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.variables as Record<string, unknown>)) {
      if (typeof value === 'string') variables[key] = value;
    }
    spec.variables = variables;
  }
  return spec;
}
