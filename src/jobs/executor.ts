/**
 * Job executor — runs ONE leased job to a terminal state:
 *
 *   pending → preparing → running ⇄ paused_provider_limit
 *                            │⇄ awaiting_input
 *                            → completed | failed
 *
 * Responsibilities (T2-03):
 *   - workspace prep (isolated per-job checkout — `workspace.ts`),
 *   - T2-05 ADDITIVE: task-dispatch leases (`task` payload + `@task`
 *     pipeline sentinel) resolve their pipeline AFTER checkout through the
 *     injectable `resolveTaskPipeline` seam (default: the reused
 *     `pipeline match` BM25 CLI via this executor's exec seam); no match ⇒
 *     the run FAILS through the existing run_status path. Non-task leases
 *     are untouched.
 *   - invoke `pipeline drive` in the prepared workspace via the exec seam,
 *   - report job lifecycle over WSS (`run_status` started → completed/halted)
 *     through the injected `send` — the ONLY frames this module emits besides
 *     the manager's `accept`,
 *   - provider-limit pause + AUTO-RESUME: a drive exit the detector attributes
 *     to a provider/usage limit parks the job in `paused_provider_limit`
 *     (never fails it), schedules a resume through the injectable clock, and
 *     re-enters drive with `--resume`. Heartbeats (owned by the connection)
 *     keep the lease alive throughout; `pausedUntil` is exposed for the
 *     heartbeat `paused_until` field.
 *
 * c6 (design 04 — D1) additions:
 *   - RESUME MODE (`options.resume`): skip prep entirely and re-enter
 *     `pipeline drive --resume` in the RECORDED checkout — the startup
 *     reconcile's FRESH path (silent: no `run_status started`, F1 "no cloud
 *     state change at all") and the ADOPTION path (`announce: true` — a new
 *     job_id the server just offered, so its `started` is reported). Phase-
 *     specific re-entry: a `paused_provider_limit` record with a future
 *     `paused_until` re-enters the pause window (no hammering); an
 *     `awaiting_input` record does NOT spawn — it re-surfaces the stored
 *     question through the relay and waits. A pinned `content_hash` is
 *     RE-VERIFIED (c4's verifier) before any resume — a workspace that no
 *     longer matches halts instead of resuming.
 *   - DURABLE RECORD writes through the `record` port (the manager hands a
 *     store-bound closure): phase transitions, pause windows, parked
 *     questions — the substrate the reconcile classifies after a daemon death.
 *   - ORDERED COMPLETION (c5 live finding: a run that COMPLETED runner-side
 *     was clobbered to `crashed` because its heartbeat listing dropped before
 *     the terminal events landed): every terminal path awaits
 *     `events.onTerminalFlush` (the shipper's final flush + drain) BEFORE
 *     sending the terminal `run_status`, and the manager only unlists the run
 *     AFTER `start()` resolves — flush terminal events → send run_status →
 *     release/stop listing.
 *   - CANCEL (D8) / SUSPEND (graceful shutdown): `cancel()` aborts the drive
 *     child, unblocks any pause/question wait, and settles WITHOUT a
 *     `run_status` frame (the server initiated — it already disposed of the
 *     run); the manager then deletes record + workspace. `suspend()` likewise
 *     interrupts, but the record is LEFT INTACT (phase current) so the next
 *     boot's reconcile resumes exactly there.
 *
 * NOT this module's job:
 *   - event shipping — the shipper tails the run's events independently; the
 *     `onWorkspaceReady` callback is the composition seam that tells it WHERE
 *     (workspace dir, pipeline root, run id, job JWT for ingest auth).
 *   - the needs-input WSS relay (T1-13) — `NeedsInputRelay` is the seam.
 *
 * SECRETS: the lease's `job_jwt` is surfaced ONLY via `onWorkspaceReady` (the
 * shipper's ingest credential) and never logged OR PERSISTED (the job record
 * carries no JWT — 04); secret VALUES are not delivered here at all
 * (`secret_slugs` is names-only — delivery is a follow-up task).
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
// T2-05 ADDITIVE: the task-dispatch pipeline-resolution seam + its default.
import { cliTaskPipelineResolver, type TaskPipelineResolver } from '../dispatch/matcher';
// f4: the per-RUN isolated agent home (pooled-machine cross-tenant isolation).
import { agentHomeEnv, agentHomesRootFor, disposeAgentHome, provisionAgentHome } from './agent-home';
import {
  buildDriveArgs,
  classifyDriveOutcome,
  defaultProviderLimitDetector,
  type DriveMode,
  type DriveTarget,
  type ProviderLimit,
  type ProviderLimitDetector,
} from './drive';
// f2: reject any EXPLICITLY non-`standalone` `runner:` on a hosted run.
import { assertHostedRunnerAllowed } from './hosted-mode';
import type { JobRecord, RecordedQuestion } from './job-store';
// f3: the cross-machine run-state handoff — the durable cursor, never a session.
import type { RunStateStore } from './run-state';
// f1: hosted `standalone` selection + the org provider key.
import {
  describeHostedProviderKey,
  hostedDriveEnv,
  HOSTED_EXECUTOR,
  redactingLogger,
  resolveHostedCredential,
  type HostedStandaloneOptions,
} from './standalone';
import {
  cliContentHashVerifier,
  prepareWorkspace,
  type ContentHashVerifier,
  type PreparedWorkspace,
  type StartIterationResolver,
} from './workspace';
import { buildRunStatusFrame, RUN_STATUS_OUTCOME_BLOCKED, TASK_PIPELINE_UNRESOLVED, type LeaseMessage, type LeaseTask } from './wire';
import { JobError, type JobExec, type JobFs } from './types';

export type JobState =
  | 'pending'
  | 'preparing'
  | 'running'
  | 'paused_provider_limit'
  | 'awaiting_input'
  | 'completed'
  | 'failed';

/** Terminal result of one job. `cancelled` marks a server-initiated cancel
 *  (no run_status was sent; the manager deletes record + workspace);
 *  `suspended` marks a graceful-shutdown interrupt (record left intact for
 *  the next boot's reconcile). */
export type JobResult =
  | { job_id: string; run_id: string; ok: true; outcome: string }
  | { job_id: string; run_id: string; ok: false; reason: string; cancelled?: boolean; suspended?: boolean };

/** A parked needs-input question surfaced to the relay seam. */
export interface ParkedQuestion {
  job_id: string;
  run_id: string;
  /** Stable question identity for the relay round-trip (echoed by the
   *  answer). Sourced from drive's park JSON when present (06.2.1, b2's
   *  `pipeline-cli` contract); an older CLI whose park JSON predates the
   *  field gets an executor-minted fallback (06.2.2) — round-trips
   *  identically either way. */
  question_id: string;
  step_id: string | null;
  iteration_path: string;
  session_id: string | null;
  question: { text: string; context: string | null; options: string[] | null };
}

/**
 * The needs-input seam (T1-13 plugs the WSS relay in here). Resolve with the
 * answer text to feed `drive --resume --answer`, or null to give up on the
 * question (the job fails with an actionable reason).
 */
export interface NeedsInputRelay {
  onQuestion(parked: ParkedQuestion): Promise<string | null> | string | null;
}

/** Default relay: no transport attached yet — a parked question fails the job. */
export const autoFailNeedsInputRelay: NeedsInputRelay = {
  onQuestion: () => null,
};

/** Everything the shipper needs to be pointed at this job (composition seam). */
export interface JobWorkspaceContext extends PreparedWorkspace {
  job_id: string;
  run_id: string;
  /** Ingest credential for job-scoped HTTPS calls. SECRET — never log.
   *  EMPTY STRING on a reconcile (FRESH) resume: the in-memory JWT died with
   *  the previous daemon and is never persisted (04) — the WSS upload
   *  transport authenticates via the runner token, so shipping still works. */
  job_jwt: string;
  /** Declared secret NAMES (values are a follow-up delivery task). */
  secret_slugs: string[];
  /** Attempt-fencing seq base (06.8.2): when the lease/record carries one,
   *  the shipper starts this run's seq counter here. */
  event_seq_base?: number;
}

/** The durable-record port (c6): a store-bound closure the manager hands the
 *  executor so phase transitions persist without the executor knowing the
 *  store. Absent ⇒ nothing persists (standalone/test use). */
export interface JobRecordPort {
  update(patch: Partial<JobRecord>): void;
}

/** Resume-mode input (c6): the durable record to re-enter, and whether to
 *  announce a `run_status started` (adoption: yes — new job_id; reconcile
 *  FRESH resume: no — F1 "no cloud state change at all"). */
export interface ResumeContext {
  record: JobRecord;
  announce: boolean;
}

/** Default pause before the first provider-limit resume attempt. */
export const DEFAULT_PROVIDER_LIMIT_PAUSE_MS = 5 * 60_000;
/** Cap for the default exponential pause ladder. */
export const MAX_PROVIDER_LIMIT_PAUSE_MS = 60 * 60_000;
/** Default cap on CONSECUTIVE provider-limit pauses before the job fails. */
export const DEFAULT_MAX_PROVIDER_LIMIT_PAUSES = 48;
/** Default cap on needs-input questions per job (mirrors drive's per-step 3). */
export const DEFAULT_MAX_QUESTIONS = 3;

/** Default backoff: provider-stated window, else 5m·2ⁿ capped at 60m. */
export function defaultProviderLimitPauseMs(attempt: number, limit: ProviderLimit): number {
  if (limit.retry_after_ms !== undefined && limit.retry_after_ms > 0) return limit.retry_after_ms;
  return Math.min(DEFAULT_PROVIDER_LIMIT_PAUSE_MS * 2 ** attempt, MAX_PROVIDER_LIMIT_PAUSE_MS);
}

export interface JobExecutorEvents {
  onStateChange?(state: JobState): void;
  /** The shipper-composition seam: fired once the workspace is prepared. */
  onWorkspaceReady?(context: JobWorkspaceContext): void;
  /** ORDERED COMPLETION (c6, c5 race): awaited BEFORE any terminal
   *  `run_status` is sent — the shipper lifecycle implements it as the final
   *  flush + drain of this job's journal, so the terminal events reach the
   *  server before the frame that lets the cloud stop expecting them. */
  onTerminalFlush?(jobId: string): Promise<void> | void;
  onFinished?(result: JobResult): void;
}

export interface JobExecutorOptions {
  lease: LeaseMessage;
  runnerId: string;
  /** Send a frame on the live connection (online-only; false = dropped). */
  send(frame: WireFrame): boolean;
  /** Jobs workdir root; the job checks out into `<root>/<job-id>`. */
  workspaceRoot: string;
  exec: JobExec;
  fs: JobFs;
  gitBin?: string;
  /** The `pipeline` CLI binary — used for `drive`, task-dispatch matching,
   *  and (by default, c4) content-hash verification + start-iteration
   *  resolution. ONE binary for the whole job. */
  pipelineBin?: string;
  /** EXTRA env for drive invocations (secret injection is a follow-up). */
  env?: Record<string, string | undefined>;
  /** f1 — HOSTED `standalone` mode. Its PRESENCE makes this a hosted runner:
   *  drive is pinned to `--executor=claude-sdk` (E3 — the only mode that can
   *  run on our hardware) and the provider key comes from the ORG's credential
   *  through `jobs/standalone.ts`, never from anything on this machine.
   *
   *  ABSENT ⇒ every existing behaviour is untouched: no flag, no env overlay,
   *  no credential resolution, byte-identical argv. A local runner is exactly
   *  what it was. */
  hostedStandalone?: HostedStandaloneOptions;
  /** f4 — root for the PER-RUN isolated agent homes a hosted run's drive child
   *  gets as its `$HOME` (`./agent-home.ts`). Defaults to
   *  `<workspaceRoot>/.agent-homes`, so isolation is the behaviour of a hosted
   *  runner that configured nothing, not of one that remembered to.
   *
   *  Read ONLY on the hosted path: a local runner's drive child keeps the
   *  user's own home, which is theirs and holds their own configuration. */
  agentHomeRoot?: string;
  needsInput?: NeedsInputRelay;
  detectProviderLimit?: ProviderLimitDetector;
  /** Pause length before resume attempt N (0-based) for a detected limit. */
  providerLimitPauseMs?(attempt: number, limit: ProviderLimit): number;
  maxProviderLimitPauses?: number;
  maxQuestions?: number;
  verifyContentHash?: ContentHashVerifier;
  resolveStartIteration?: StartIterationResolver;
  /** T2-05 ADDITIVE — the task-dispatch resolution seam: resolves a TASK
   *  lease's pipeline AFTER checkout (BM25 over the checkout's local
   *  manifests). Default: `pipeline match` through THIS executor's `exec`
   *  seam (`cliTaskPipelineResolver` — same binary as drive, so tests script
   *  it and never spawn). Non-task leases NEVER invoke it. */
  resolveTaskPipeline?: TaskPipelineResolver;
  /** f3 — CROSS-MACHINE resume. Its presence lets a run that was released by
   *  one machine be picked up by another: the durable cursor is published after
   *  every drive invocation and restored into a fresh checkout when the server
   *  re-offers the run here with `resume_hint`.
   *
   *  Only the cursor travels. SDK session files and their transcripts stay on
   *  the machine that made them, by decision — see `./run-state.ts` and
   *  `docs/cross-machine-resume.md`.
   *
   *  ABSENT ⇒ nothing is published, nothing is fetched, and every existing
   *  path behaves exactly as it did: same-machine resume is unaffected. */
  runState?: RunStateStore;
  /** c6: the durable-record port (phase transitions persist through it). */
  record?: JobRecordPort;
  /** c6: resume mode — re-enter the recorded state instead of preparing. */
  resume?: ResumeContext;
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  events?: JobExecutorEvents;
}

export class JobExecutor {
  private readonly clock: Clock;
  /** Not `readonly`: a hosted standalone job REPLACES this with a redacting
   *  wrapper (f1) the moment the org credential is resolved, so every later
   *  log call on this executor is covered by construction rather than by each
   *  call site remembering. */
  private logger: Logger;
  private readonly makeId: () => string;
  private readonly needsInput: NeedsInputRelay;
  private readonly detectLimit: ProviderLimitDetector;
  private readonly pauseMsFor: (attempt: number, limit: ProviderLimit) => number;
  private readonly maxPauses: number;
  private readonly maxQuestions: number;
  private readonly pipelineBin: string;
  /** T2-05 ADDITIVE: the task-dispatch matcher (see `resolveTaskPipeline`). */
  private readonly taskResolver: TaskPipelineResolver;

  private state_: JobState = 'pending';
  private pausedUntil_: string | null = null;
  private resumeTimer: unknown = null;
  private resumeEarly: (() => void) | null = null;
  private consecutivePauses = 0;
  private questions = 0;

  // c6 interruption plumbing: `cancel()` (server cancel — no run_status) and
  // `suspend()` (graceful shutdown — record kept) share one mechanism: abort
  // the in-flight drive child, fire any pause/question waiter, and let the
  // drive loop observe the flag at its next await boundary.
  private cancelled_ = false;
  private suspended_ = false;
  private readonly abort = new AbortController();
  private interruptWaiters: Array<() => void> = [];

  constructor(private readonly options: JobExecutorOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.needsInput = options.needsInput ?? autoFailNeedsInputRelay;
    this.detectLimit = options.detectProviderLimit ?? defaultProviderLimitDetector;
    this.pauseMsFor = options.providerLimitPauseMs ?? defaultProviderLimitPauseMs;
    this.maxPauses = options.maxProviderLimitPauses ?? DEFAULT_MAX_PROVIDER_LIMIT_PAUSES;
    this.maxQuestions = options.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
    this.pipelineBin = options.pipelineBin ?? 'pipeline';
    // T2-05 ADDITIVE: default the task-dispatch seam to the reused CLI matcher
    // over this executor's OWN exec seam (constructing it spawns nothing).
    this.taskResolver =
      options.resolveTaskPipeline ??
      cliTaskPipelineResolver({ exec: options.exec, pipelineBin: this.pipelineBin, logger: this.logger });
  }

  get state(): JobState {
    return this.state_;
  }

  get jobId(): string {
    return this.options.lease.job_id;
  }

  get runId(): string {
    return this.options.lease.run_id;
  }

  /** ISO time auto-resume is scheduled for, while `paused_provider_limit`. */
  get pausedUntil(): string | null {
    return this.pausedUntil_;
  }

  /** Fire a scheduled provider-limit resume NOW (manual override seam). */
  resumeNow(): void {
    this.resumeEarly?.();
  }

  /** Server `cancel` (c6, D8): kill the drive child, unblock any wait, settle
   *  WITHOUT a run_status frame. The manager deletes record + workspace. */
  cancel(): void {
    if (this.cancelled_ || this.suspended_) return;
    this.cancelled_ = true;
    this.interruptNow();
  }

  /** Graceful-shutdown interrupt (c6): kill the drive child (its state is
   *  durable per step), settle without reporting, LEAVE the record intact —
   *  the next boot's reconcile resumes exactly here. */
  suspend(): void {
    if (this.cancelled_ || this.suspended_) return;
    this.suspended_ = true;
    this.interruptNow();
  }

  private interruptNow(): void {
    this.abort.abort();
    this.resumeEarly?.();
    const waiters = this.interruptWaiters;
    this.interruptWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** A promise that resolves (with null) when cancel/suspend fires — raced
   *  against the needs-input await so a parked job can be interrupted. */
  private interrupted(): Promise<null> {
    return new Promise((resolve) => {
      if (this.cancelled_ || this.suspended_) {
        resolve(null);
        return;
      }
      this.interruptWaiters.push(() => resolve(null));
    });
  }

  /** The pending interrupt's terminal result, or null when none fired. */
  private interruptResult(): JobResult | null {
    if (this.suspended_) {
      const result: JobResult = {
        job_id: this.jobId,
        run_id: this.runId,
        ok: false,
        reason: 'suspended for shutdown',
        suspended: true,
      };
      this.options.events?.onFinished?.(result);
      this.logger.info(`job ${this.jobId}: suspended for shutdown (record kept)`);
      return result;
    }
    if (this.cancelled_) {
      this.setState('failed');
      // f3: a server cancel bypasses reportTerminal (no run_status by design),
      // so drop the published cursor here — a cancelled run must not be
      // resumable on another machine.
      this.discardRunState();
      const result: JobResult = {
        job_id: this.jobId,
        run_id: this.runId,
        ok: false,
        reason: 'cancelled by server',
        cancelled: true,
      };
      this.options.events?.onFinished?.(result);
      this.logger.info(`job ${this.jobId}: cancelled by server`);
      return result;
    }
    return null;
  }

  /** Run the job to a terminal state. Resolves (never rejects) with the result. */
  async start(): Promise<JobResult> {
    if (this.state_ !== 'pending') {
      // Double-start guard: report the error without disturbing the live run.
      return { job_id: this.jobId, run_id: this.runId, ok: false, reason: 'executor already started' };
    }
    if (this.options.resume !== undefined) {
      return this.startResume(this.options.resume);
    }
    const lease = this.options.lease;
    this.setState('preparing');

    // T2-05 ADDITIVE: task-dispatch coherence — the `@task` sentinel is only
    // meaningful WITH a task payload (presence rule: `task` ⇔ sentinel). A
    // sentinel lease without one has nothing to match on: fail actionably
    // before wasting a checkout. Fixed-pipeline leases never hit this.
    const task = lease.task;
    if (task === undefined && lease.pipeline_ref.pipeline === TASK_PIPELINE_UNRESOLVED) {
      const reason = `lease pipeline is the task sentinel '${TASK_PIPELINE_UNRESOLVED}' but the lease carries no task payload`;
      await this.reportTerminal('halted', { halt_reason: reason });
      return this.fail(reason);
    }

    let workspace: PreparedWorkspace;
    try {
      workspace = await prepareWorkspace({
        jobId: lease.job_id,
        ref: lease.pipeline_ref,
        root: this.options.workspaceRoot,
        exec: this.options.exec,
        fs: this.options.fs,
        gitBin: this.options.gitBin,
        // c4: the SAME binary drive shells out to — the DEFAULT hash-verify /
        // start-iteration resolvers (workspace.ts) use it to shell `pipeline
        // hash`/`pipeline plan` when the seams below are absent.
        pipelineBin: this.pipelineBin,
        logger: this.logger,
        verifyContentHash: this.options.verifyContentHash,
        resolveStartIteration: this.options.resolveStartIteration,
        // T2-05 ADDITIVE: a task lease resolves its pipeline AFTER checkout
        // via the dispatch matcher; a resolution failure throws JobError and
        // is reported through the SAME prep-failure path below.
        resolvePipeline: task === undefined ? undefined : (checkoutDir) => this.dispatchTask(checkoutDir, task),
      });
    } catch (err) {
      const interrupted = this.interruptResult();
      if (interrupted !== null) return interrupted;
      const reason = `workspace prep failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.reportTerminal('halted', { halt_reason: reason });
      return this.fail(reason);
    }
    {
      const interrupted = this.interruptResult();
      if (interrupted !== null) return interrupted;
    }
    // c6: the record gains its resume substrate the moment it exists —
    // pipeline_root + start_iteration are what the reconcile drives from.
    this.options.record?.update({ pipeline_root: workspace.pipelineRoot, start_iteration: workspace.startIteration });
    this.options.events?.onWorkspaceReady?.({
      ...workspace,
      job_id: lease.job_id,
      run_id: lease.run_id,
      job_jwt: lease.job_jwt,
      secret_slugs: lease.secret_slugs,
      ...(lease.event_seq_base !== undefined ? { event_seq_base: lease.event_seq_base } : {}),
    });

    // The `variables_applied` echo (names only, NEVER values — [06 §5]): the
    // ONLY way cloud can detect a pre-d1 runner silently dropping the lease's
    // `variables` field. Present (even as `[]`) iff the lease carries the
    // field at all; a lease predating it omits `variables_applied` entirely,
    // keeping the `started` frame byte-identical to today. Sorted for the
    // same determinism reason as buildDriveArgs's `--var` ordering.
    const variablesApplied =
      lease.variables !== undefined ? Object.keys(lease.variables).sort((a, b) => a.localeCompare(b)) : undefined;

    this.setState('running');
    this.options.record?.update({ phase: 'running' });
    this.report('started', { variables_applied: variablesApplied });
    this.logger.info(`job ${lease.job_id}: drive starting (run ${lease.run_id})`);

    // T3-06: a matrix cell's execution_overrides become RUN-LEVEL drive
    // defaults, derived ONCE so every invocation (start / resume / answer)
    // carries the same model + effort.
    const overrides = lease.execution_overrides;
    const driveTarget: DriveTarget = {
      pipelineRoot: workspace.pipelineRoot,
      runId: lease.run_id,
      ...(overrides?.model ? { defaultModel: overrides.model } : {}),
      ...(overrides?.effort ? { defaultEffort: overrides.effort } : {}),
      // env-variables d1: the lease's frozen `PP_*` map — `--var` on the START
      // invocation ONLY (buildDriveArgs enforces this structurally).
      ...(lease.variables !== undefined ? { variables: lease.variables } : {}),
    };

    // ── f3: cross-machine handoff ──────────────────────────────────────────
    // We are on the FRESH-prep path, which means this machine holds no record
    // for this run — either it is genuinely new, or it was released elsewhere
    // and the server re-offered it here. `resume_hint` is the server telling us
    // which; a run that has moved has a published cursor waiting.
    //
    // Restoring it turns `--start` into `--resume`, and the engine picks up at
    // the step the cursor names. No session file comes with it, so the step it
    // lands on spawns fresh — that is the decision, not an omission.
    const handoff = this.adoptPublishedRunState(workspace);
    if (handoff !== null) return this.driveLoop(workspace, driveTarget, handoff);

    return this.driveLoop(workspace, driveTarget, { kind: 'start', startIteration: workspace.startIteration });
  }

  /**
   * f3: restore a run released by ANOTHER machine into this fresh checkout.
   * Returns the drive mode to use, or null to start normally.
   *
   * Deliberately narrow. Only a `resume_hint` lease is considered, so an
   * ordinary new run never consults the store; and a refusal (no bundle, a
   * cursor naming machine-local paths, local state already present) always
   * falls through to a clean `--start` rather than resuming over a guess.
   */
  private adoptPublishedRunState(workspace: PreparedWorkspace): DriveMode | null {
    const lease = this.options.lease;
    const store = this.options.runState;
    if (store === undefined || lease.resume_hint !== true) return null;
    const bundle = store.fetch(lease.run_id);
    if (bundle === null) {
      this.logger.info(`job ${lease.job_id}: resume_hint but no published run state for run ${lease.run_id} — starting fresh`);
      return null;
    }
    const restored = store.restore(bundle, { pipelineRoot: workspace.pipelineRoot, runId: lease.run_id });
    if (!restored.restored) {
      this.logger.warn(`job ${lease.job_id}: published run state for run ${lease.run_id} not restored (${restored.reason}) — starting fresh`);
      return null;
    }
    this.logger.info(
      `job ${lease.job_id}: run ${lease.run_id} ADOPTED FROM ANOTHER MACHINE — cursor captured ${bundle.captured_at} ` +
        `restored into ${workspace.pipelineRoot}; step sessions are NOT carried, the current step spawns fresh` +
        (restored.pending_question ? '; a question was outstanding at capture and will be asked again' : '')
    );
    return { kind: 'resume' };
  }

  /**
   * f3: publish the durable cursor so another machine could take this run over.
   *
   * Called after EVERY drive invocation returns — the same "one funnel"
   * argument the hosted block above uses. That is also the only correct moment:
   * between invocations the run is quiescent and `next.json` has just been
   * persisted, so what we publish is never a torn read of a live cursor.
   *
   * Best-effort by construction. A handoff store is an optimisation on top of
   * single-machine resume, and a run must never fail because shared storage
   * hiccuped.
   */
  private publishRunState(workspace: PreparedWorkspace): void {
    const store = this.options.runState;
    if (store === undefined) return;
    try {
      const published = store.publish({ pipelineRoot: workspace.pipelineRoot, runId: this.runId });
      if (published.bundle === null) {
        this.logger.info(`job ${this.jobId}: run state not published (${published.reason})`);
      }
    } catch (err) {
      this.logger.warn(`job ${this.jobId}: publishing run state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** f3: the run reached a terminal outcome — no other machine should resume it. */
  private discardRunState(): void {
    const store = this.options.runState;
    if (store === undefined) return;
    try {
      store.discard(this.runId);
    } catch (err) {
      this.logger.warn(`job ${this.jobId}: discarding run state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * c6 resume mode: re-enter a recorded run in its RECORDED checkout. No
   * prep, no wipe; a pinned `content_hash` is re-verified first (04 reconcile
   * step 4 / 06.4); phase-specific re-entry for pause windows and parked
   * questions. `announce` (adoption) sends the new job's `run_status started`;
   * a reconcile FRESH resume stays silent (F1).
   */
  private async startResume(resume: ResumeContext): Promise<JobResult> {
    const lease = this.options.lease;
    const record = resume.record;
    if (record.pipeline_root === null || record.start_iteration === null) {
      // Callers only resume classified-recoverable records; this is a guard.
      const reason = 'resume state incomplete (no recorded pipeline root)';
      await this.reportTerminal('halted', { halt_reason: reason });
      return this.fail(reason);
    }
    const workspace: PreparedWorkspace = {
      dir: record.checkout_dir,
      pipelineRoot: record.pipeline_root,
      startIteration: record.start_iteration,
    };

    // Re-verify a pinned content hash before ANY resume (04: "a workspace
    // that no longer matches halts instead of resuming").
    const pinned = record.pipeline_ref.content_hash;
    if (pinned !== undefined && pinned !== null) {
      const verify =
        this.options.verifyContentHash ??
        cliContentHashVerifier({ exec: this.options.exec, pipelineBin: this.pipelineBin, logger: this.logger });
      try {
        const ok = await verify(workspace.pipelineRoot, pinned);
        if (!ok) throw new JobError(`pipeline content hash mismatch: workspace no longer matches pinned ${pinned}`);
      } catch (err) {
        const reason = `resume refused: ${err instanceof Error ? err.message : String(err)}`;
        await this.reportTerminal('halted', { halt_reason: reason });
        return this.fail(reason);
      }
    }

    // Restore the counters the record persisted (pause ladder position and
    // question budget survive the daemon death).
    this.consecutivePauses = record.consecutive_pauses;
    this.questions = record.questions.length;

    this.options.events?.onWorkspaceReady?.({
      ...workspace,
      job_id: lease.job_id,
      run_id: lease.run_id,
      job_jwt: lease.job_jwt,
      secret_slugs: lease.secret_slugs,
      ...(record.event_seq_base !== undefined ? { event_seq_base: record.event_seq_base } : {}),
    });

    if (resume.announce) {
      // Adoption: the server just offered THIS job_id — report its lifecycle
      // start (no variables echo: variables are frozen at run init and never
      // re-sent on resume).
      this.report('started');
    }
    this.logger.info(
      `job ${lease.job_id}: resuming run ${lease.run_id} in recorded checkout ${record.checkout_dir} (phase ${record.phase})`
    );

    const overrides = lease.execution_overrides ?? record.execution_overrides;
    const driveTarget: DriveTarget = {
      pipelineRoot: workspace.pipelineRoot,
      runId: lease.run_id,
      ...(overrides?.model ? { defaultModel: overrides.model } : {}),
      ...(overrides?.effort ? { defaultEffort: overrides.effort } : {}),
      // NEVER variables on a resume: frozen at init (D11), structurally
      // dropped by buildDriveArgs for non-start modes anyway.
    };

    // Phase-specific re-entry (04 reconcile step 3).
    if (record.phase === 'awaiting_input' && record.questions.length > 0) {
      // Do NOT spawn — re-surface the stored question and wait for the answer.
      const stored = record.questions[record.questions.length - 1]!;
      this.setState('awaiting_input');
      const answered = await this.askRelay(this.parkedFromRecord(stored));
      if (answered.settled !== null) return answered.settled;
      this.setState('running');
      this.options.record?.update({ phase: 'running', questions: [] });
      return this.driveLoop(workspace, driveTarget, {
        kind: 'answer',
        startIteration: stored.iteration_path,
        answer: answered.answer,
      });
    }

    if (record.phase === 'paused_provider_limit' && record.paused_until !== null) {
      const remaining = Date.parse(record.paused_until) - this.clock.now();
      if (Number.isFinite(remaining) && remaining > 0) {
        // Re-enter the pause window — no hammering the provider (F4).
        this.pausedUntil_ = record.paused_until;
        this.setState('paused_provider_limit');
        this.logger.info(`job ${lease.job_id}: restoring provider-limit pause until ${record.paused_until}`);
        await this.pause(remaining);
        this.pausedUntil_ = null;
        const interrupted = this.interruptResult();
        if (interrupted !== null) return interrupted;
      }
    }

    this.setState('running');
    this.options.record?.update({ phase: 'running', paused_until: null });
    return this.driveLoop(workspace, driveTarget, { kind: 'resume' });
  }

  /**
   * The shared drive loop's PREAMBLE AND RESOURCE SCOPE: everything a hosted
   * run decides once, before the first spawn and for every re-entry
   * {@link runDriveLoop} makes, plus the `finally` that releases what it took.
   *
   * The split is f4's, for one reason: the per-run agent home is a resource
   * with a LIFETIME, and a `finally` is the only way to be sure it is released
   * down every one of the loop's exits — completed, halted, failed, cancelled,
   * or a throw nobody predicted.
   */
  private async driveLoop(workspace: PreparedWorkspace, driveTarget: DriveTarget, initial: DriveMode): Promise<JobResult> {
    const lease = this.options.lease;

    // ── f1: hosted `standalone` ────────────────────────────────────────────
    // Applied HERE because this is the one funnel every drive invocation
    // passes through — the initial start AND every resume/answer re-entry,
    // for both the fresh path and c6's recorded-resume path. Deciding it at
    // the two `DriveTarget` construction sites instead would leave the
    // executor pin and the key overlay to be re-stated correctly in each,
    // which is precisely how one of them eventually drifts.
    //
    // FAIL CLOSED: an unresolvable org credential ends the job before any
    // process is spawned. The alternative — spawning and letting c1's ladder
    // find whatever this machine happens to carry — is the cross-tenant
    // billing failure this whole path exists to prevent.
    let driveEnv = this.options.env;
    /** f4: this run's isolated home, once provisioned — the `finally` below
     *  releases it. Null on a local run: nothing was provisioned to release. */
    let agentHome: string | null = null;
    const hosted = this.options.hostedStandalone;
    if (hosted !== undefined) {
      // f2: REJECT any EXPLICITLY non-`standalone` `runner:` before anything
      // else in this block — before the org credential is resolved (a
      // control-plane call) and before any process is spawned. An absent key
      // is allowed through (E10's default must not become an accidental
      // gate); only a declared `session`/`manager`/`driver` (or v1's
      // `headless`) is refused. See `hosted-mode.ts` for why this cannot use
      // the already-resolved `Plan.runner`/`Manifest.runner`.
      try {
        assertHostedRunnerAllowed(workspace.pipelineRoot, this.options.fs);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.reportTerminal('halted', { halt_reason: reason });
        return this.fail(reason);
      }

      let credential;
      try {
        credential = await resolveHostedCredential(hosted.credential, {
          jobId: lease.job_id,
          runId: lease.run_id,
          jobJwt: lease.job_jwt,
          secretSlugs: lease.secret_slugs,
        });
      } catch (err) {
        const reason = `hosted standalone run cannot start: ${err instanceof Error ? err.message : String(err)}`;
        await this.reportTerminal('halted', { halt_reason: reason });
        return this.fail(reason);
      }
      // Layer two, runner-side, armed BEFORE the key can reach any log line.
      this.logger = redactingLogger(this.logger, credential);

      // ── f4: the per-RUN isolated agent home ──────────────────────────────
      // `settingSources` — even once the CLI can pin it — does not close the
      // global `~/.claude.json` or auto memory. On a POOLED machine those are
      // one tenant's state loading into another tenant's run, and nothing about
      // the failure is visible. So the child's `$HOME` is determined here.
      //
      // FAIL CLOSED, exactly like the credential above: a home we could not
      // provision means we do not know what the child would read, and spawning
      // into the machine's own home is the leak this exists to prevent.
      try {
        agentHome = provisionAgentHome({
          // The RUN, never the job: c6 adoption re-keys the job_id and would
          // otherwise resume into a brand-new empty home (see agent-home.ts).
          runId: lease.run_id,
          root: this.options.agentHomeRoot ?? agentHomesRootFor(this.options.workspaceRoot),
          checkoutDir: workspace.dir,
          // A fresh `--start` wipes a stale home; a resume must not — that
          // directory holds the transcripts a resume is validated against.
          fresh: initial.kind === 'start',
          fs: this.options.fs,
          logger: this.logger,
        });
      } catch (err) {
        const reason = `hosted standalone run cannot start: ${err instanceof Error ? err.message : String(err)}`;
        await this.reportTerminal('halted', { halt_reason: reason });
        return this.fail(reason);
      }

      driveTarget = { ...driveTarget, executor: HOSTED_EXECUTOR };
      // Layered so each module's entries are applied last over the one below:
      // caller base < agent home (f4) < provider key (f1). No layer can re-open
      // a layer beneath it.
      driveEnv = hostedDriveEnv(credential, agentHomeEnv(agentHome, this.options.env));
      // Length and source only — never the value (this package's standing rule).
      this.logger.info(
        `job ${lease.job_id}: hosted standalone — --executor=${HOSTED_EXECUTOR}, ` +
          `${describeHostedProviderKey(credential)}, isolated home ${agentHome} (auto memory off)`
      );
    }

    try {
      return await this.runDriveLoop(workspace, driveTarget, initial, driveEnv);
    } finally {
      // A SUSPENDED job keeps its home: the record is left intact for the next
      // boot's reconcile, and this directory holds that resume's substrate —
      // the same reason `manager.ts#finalizeJob` keeps a suspended checkout.
      // Every other exit is terminal, and leaves nothing of this tenant behind.
      if (agentHome !== null && !this.suspended_) {
        disposeAgentHome(agentHome, this.options.fs, this.logger);
      }
    }
  }

  /** The drive loop proper: invoke → detect limit → classify → repeat. */
  private async runDriveLoop(
    workspace: PreparedWorkspace,
    driveTarget: DriveTarget,
    initial: DriveMode,
    driveEnv: Record<string, string | undefined> | undefined
  ): Promise<JobResult> {
    const lease = this.options.lease;
    let mode: DriveMode = initial;
    for (;;) {
      const args = buildDriveArgs(driveTarget, mode);
      const result = await this.options.exec.run(this.pipelineBin, args, {
        cwd: workspace.dir,
        env: driveEnv,
        signal: this.abort.signal,
      });
      // f3: BEFORE the interrupt check, so a graceful-shutdown suspend — the
      // release that most often precedes a pickup elsewhere — publishes the
      // cursor it just stopped on instead of stranding the run on this box.
      this.publishRunState(workspace);
      {
        const interrupted = this.interruptResult();
        if (interrupted !== null) return interrupted;
      }

      // Provider limit takes precedence over exit-code classification: the job
      // PAUSES (auto-resume) instead of failing. Heartbeats keep the lease.
      const limit = this.detectLimit(result);
      if (limit !== null) {
        this.consecutivePauses += 1;
        if (this.consecutivePauses > this.maxPauses) {
          const reason = `provider limit persisted through ${this.maxPauses} pauses: ${limit.reason}`;
          await this.reportTerminal('halted', { halt_reason: reason });
          return this.fail(reason);
        }
        const pauseMs = this.pauseMsFor(this.consecutivePauses - 1, limit);
        this.pausedUntil_ = new Date(this.clock.now() + pauseMs).toISOString();
        this.setState('paused_provider_limit');
        this.options.record?.update({
          phase: 'paused_provider_limit',
          paused_until: this.pausedUntil_,
          consecutive_pauses: this.consecutivePauses,
        });
        this.logger.info(
          `job ${lease.job_id}: provider limit (${limit.reason}) — paused until ${this.pausedUntil_} ` +
            `(pause ${this.consecutivePauses}/${this.maxPauses})`
        );
        await this.pause(pauseMs);
        this.pausedUntil_ = null;
        {
          const interrupted = this.interruptResult();
          if (interrupted !== null) return interrupted;
        }
        this.setState('running');
        this.options.record?.update({ phase: 'running', paused_until: null });
        this.logger.info(`job ${lease.job_id}: resuming after provider-limit pause`);
        mode = { kind: 'resume' };
        continue;
      }
      this.consecutivePauses = 0;

      const outcome = classifyDriveOutcome(result);
      switch (outcome.kind) {
        case 'completed': {
          // ORDERED COMPLETION (c6): terminal events flush BEFORE run_status,
          // and the manager unlists the run only after start() resolves.
          await this.reportTerminal('completed', { outcome: outcome.outcome });
          this.setState('completed');
          const done: JobResult = { job_id: lease.job_id, run_id: lease.run_id, ok: true, outcome: outcome.outcome };
          this.options.events?.onFinished?.(done);
          this.logger.info(`job ${lease.job_id}: completed (${outcome.outcome})`);
          return done;
        }
        case 'awaiting_input': {
          this.questions += 1;
          if (this.questions > this.maxQuestions) {
            const reason = `needs-input question limit reached (${this.maxQuestions})`;
            await this.reportTerminal('halted', { halt_reason: reason });
            return this.fail(reason);
          }
          this.setState('awaiting_input');
          // 06.2.2: drive's park JSON carries the question_id — use it
          // verbatim; mint a fallback ONLY for an older CLI that omits it.
          const parked: ParkedQuestion = {
            job_id: lease.job_id,
            run_id: lease.run_id,
            ...outcome.parked,
            question_id: outcome.parked.question_id ?? this.makeId(),
          };
          this.options.record?.update({ phase: 'awaiting_input', questions: [this.recordedFromParked(parked)] });
          const answered = await this.askRelay(parked);
          if (answered.settled !== null) return answered.settled;
          this.setState('running');
          this.options.record?.update({ phase: 'running', questions: [] });
          mode = { kind: 'answer', startIteration: outcome.parked.iteration_path, answer: answered.answer };
          continue;
        }
        case 'halted': {
          await this.reportTerminal('halted', { halt_reason: outcome.reason });
          return this.fail(outcome.reason);
        }
        case 'blocked': {
          // c1: still a `phase:'halted'` frame (the enum is closed) but with
          // the structured `outcome:'blocked'` alongside it, so the cloud
          // learns this was a nested-blocker delegation rather than an
          // opaque halt — see ./drive.ts DriveOutcome and ./wire.ts.
          await this.reportTerminal('halted', { halt_reason: outcome.reason, outcome: RUN_STATUS_OUTCOME_BLOCKED });
          return this.fail(outcome.reason);
        }
        case 'failed': {
          await this.reportTerminal('halted', { halt_reason: outcome.reason });
          return this.fail(outcome.reason);
        }
      }
    }
  }

  /** Ask the relay for an answer, racing server cancel / shutdown suspend.
   *  Returns either the answer text or the settled terminal result. */
  private async askRelay(parked: ParkedQuestion): Promise<{ answer: string; settled: null } | { answer: null; settled: JobResult }> {
    let answer: string | null;
    try {
      answer = await Promise.race([Promise.resolve(this.needsInput.onQuestion(parked)), this.interrupted()]);
    } catch (err) {
      const reason = `needs-input relay failed: ${err instanceof Error ? err.message : String(err)}`;
      await this.reportTerminal('halted', { halt_reason: reason });
      return { answer: null, settled: this.fail(reason) };
    }
    {
      const interrupted = this.interruptResult();
      if (interrupted !== null) return { answer: null, settled: interrupted };
    }
    if (answer === null || answer.trim().length === 0) {
      const reason = 'run parked on a needs-input question and no relay/answer is available (T1-13 not wired)';
      await this.reportTerminal('halted', { halt_reason: reason });
      return { answer: null, settled: this.fail(reason) };
    }
    return { answer, settled: null };
  }

  private parkedFromRecord(stored: RecordedQuestion): ParkedQuestion {
    return {
      job_id: this.jobId,
      run_id: this.runId,
      question_id: stored.question_id,
      step_id: stored.step_id,
      iteration_path: stored.iteration_path,
      session_id: stored.session_id,
      question: stored.question,
    };
  }

  private recordedFromParked(parked: ParkedQuestion): RecordedQuestion {
    return {
      question_id: parked.question_id,
      step_id: parked.step_id,
      iteration_path: parked.iteration_path,
      session_id: parked.session_id,
      question: parked.question,
    };
  }

  /** T2-05 ADDITIVE: resolve a task lease's pipeline (dispatch matcher seam). */
  private async dispatchTask(checkoutDir: string, task: LeaseTask): Promise<string> {
    const resolution = await this.taskResolver({ checkoutDir, task });
    this.logger.info(
      `job ${this.jobId}: task ${task.task_id} dispatched to pipeline '${resolution.pipeline}' (score ${resolution.score})`
    );
    return resolution.pipeline;
  }

  private setState(state: JobState): void {
    if (this.state_ === state) return;
    this.state_ = state;
    this.options.events?.onStateChange?.(state);
  }

  private fail(reason: string): JobResult {
    this.setState('failed');
    const result: JobResult = { job_id: this.jobId, run_id: this.runId, ok: false, reason };
    this.options.events?.onFinished?.(result);
    this.logger.warn(`job ${this.jobId}: failed — ${reason}`);
    return result;
  }

  private report(
    phase: 'started' | 'completed' | 'halted',
    detail?: { outcome?: string; halt_reason?: string; variables_applied?: string[] }
  ): void {
    const frame = buildRunStatusFrame(this.runId, this.jobId, phase, detail);
    if (!this.options.send(frame)) {
      // Not online right now — the authoritative record is the event journal
      // (shipper's transport retries); lifecycle frames are best-effort.
      this.logger.warn(`job ${this.jobId}: run_status '${phase}' not sent (connection not online)`);
    }
  }

  /**
   * ORDERED COMPLETION (c6, closing the runner's side of the c5 race): await
   * the shipper's terminal flush BEFORE the terminal `run_status` frame, so
   * by the time the cloud sees the frame — and by the time this run drops out
   * of `active_run_ids` (which only happens after `start()` resolves) — the
   * terminal events are already on their way up. A flush failure is contained
   * (logged): the frame still goes out; the spool retries in the background.
   */
  private async reportTerminal(
    phase: 'completed' | 'halted',
    detail?: { outcome?: string; halt_reason?: string }
  ): Promise<void> {
    try {
      await this.options.events?.onTerminalFlush?.(this.jobId);
    } catch (err) {
      this.logger.warn(
        `job ${this.jobId}: terminal event flush failed (${err instanceof Error ? err.message : String(err)}) — sending run_status anyway`
      );
    }
    // f3: the one funnel every terminal outcome passes through, so a finished
    // run can never be picked up somewhere else from a leftover cursor.
    this.discardRunState();
    this.report(phase, detail);
  }

  /** Wait out a provider-limit pause on the injectable clock. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.resumeTimer !== null) {
          this.clock.clearTimeout(this.resumeTimer);
          this.resumeTimer = null;
        }
        this.resumeEarly = null;
        resolve();
      };
      this.resumeTimer = this.clock.setTimeout(finish, ms);
      this.resumeEarly = finish;
    });
  }
}
