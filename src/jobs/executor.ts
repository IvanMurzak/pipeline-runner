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
 *     heartbeat `paused_until` field (composition is a follow-up).
 *
 * NOT this module's job:
 *   - event shipping — the shipper tails the run's events independently; the
 *     `onWorkspaceReady` callback is the composition seam that tells it WHERE
 *     (workspace dir, pipeline root, run id, job JWT for ingest auth).
 *   - the needs-input WSS relay (T1-13) — `NeedsInputRelay` is the seam. The
 *     default auto-fails a parked question (no relay is attached yet); the
 *     relay task plugs in an implementation that round-trips the question to
 *     the control plane and resolves with the user's answer.
 *
 * SECRETS: the lease's `job_jwt` is surfaced ONLY via `onWorkspaceReady` (the
 * shipper's ingest credential) and never logged; secret VALUES are not
 * delivered here at all (`secret_slugs` is names-only — delivery is a
 * follow-up task).
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
// T2-05 ADDITIVE: the task-dispatch pipeline-resolution seam + its default.
import { cliTaskPipelineResolver, type TaskPipelineResolver } from '../dispatch/matcher';
import {
  buildDriveArgs,
  classifyDriveOutcome,
  defaultProviderLimitDetector,
  type DriveMode,
  type DriveTarget,
  type ProviderLimit,
  type ProviderLimitDetector,
} from './drive';
import { prepareWorkspace, type ContentHashVerifier, type PreparedWorkspace, type StartIterationResolver } from './workspace';
import { buildRunStatusFrame, TASK_PIPELINE_UNRESOLVED, type LeaseMessage, type LeaseTask } from './wire';
import type { JobExec, JobFs } from './types';

export type JobState =
  | 'pending'
  | 'preparing'
  | 'running'
  | 'paused_provider_limit'
  | 'awaiting_input'
  | 'completed'
  | 'failed';

/** Terminal result of one job. */
export type JobResult =
  | { job_id: string; run_id: string; ok: true; outcome: string }
  | { job_id: string; run_id: string; ok: false; reason: string };

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
  /** Ingest credential for job-scoped HTTPS calls. SECRET — never log. */
  job_jwt: string;
  /** Declared secret NAMES (values are a follow-up delivery task). */
  secret_slugs: string[];
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
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  events?: JobExecutorEvents;
}

export class JobExecutor {
  private readonly clock: Clock;
  private readonly logger: Logger;
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

  /** Run the job to a terminal state. Resolves (never rejects) with the result. */
  async start(): Promise<JobResult> {
    if (this.state_ !== 'pending') {
      // Double-start guard: report the error without disturbing the live run.
      return { job_id: this.jobId, run_id: this.runId, ok: false, reason: 'executor already started' };
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
      this.report('halted', { halt_reason: reason });
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
        // hash`/`pipeline plan` when `verifyContentHash`/`resolveStartIteration`
        // below are absent (previously unwired: prep always fell through to
        // the warn-unverified / lexical-only defaults regardless of this
        // field).
        pipelineBin: this.pipelineBin,
        logger: this.logger,
        verifyContentHash: this.options.verifyContentHash,
        resolveStartIteration: this.options.resolveStartIteration,
        // T2-05 ADDITIVE: a task lease resolves its pipeline AFTER checkout
        // via the dispatch matcher; a resolution failure (no match, matcher
        // error) throws JobError and is reported through the SAME prep-failure
        // path below (run_status halted → run FAILED — no new signaling). The
        // seam only ever fires on the `@task` sentinel, so a non-task lease
        // behaves exactly as T2-03.
        resolvePipeline: task === undefined ? undefined : (checkoutDir) => this.dispatchTask(checkoutDir, task),
      });
    } catch (err) {
      const reason = `workspace prep failed: ${err instanceof Error ? err.message : String(err)}`;
      this.report('halted', { halt_reason: reason });
      return this.fail(reason);
    }
    this.options.events?.onWorkspaceReady?.({
      ...workspace,
      job_id: lease.job_id,
      run_id: lease.run_id,
      job_jwt: lease.job_jwt,
      secret_slugs: lease.secret_slugs,
    });

    // The `variables_applied` echo (names only, NEVER values — [06 §5]): the
    // ONLY way cloud can detect a pre-d1 runner silently dropping the lease's
    // `variables` field. Present (even as `[]`) iff the lease carries the
    // field at all (`!== undefined`, the SAME presence check `driveTarget`
    // uses below for this lease field); a lease predating it omits
    // `variables_applied` entirely, keeping the `started` frame byte-identical
    // to today. Sorted for the same determinism reason as buildDriveArgs's
    // `--var` ordering. Computed and reported HERE — immediately after
    // `onWorkspaceReady`, exactly where `setState('running')`/`report('started')`
    // have always fired — rather than after the drive-target assembly below,
    // so a future bug in THAT assembly can never delay or swallow this report
    // (`start()` never rejects by contract).
    const variablesApplied =
      lease.variables !== undefined ? Object.keys(lease.variables).sort((a, b) => a.localeCompare(b)) : undefined;

    this.setState('running');
    this.report('started', { variables_applied: variablesApplied });
    this.logger.info(`job ${lease.job_id}: drive starting (run ${lease.run_id})`);

    // T3-06: a matrix cell's execution_overrides become RUN-LEVEL drive
    // defaults, derived ONCE so every invocation (start / resume / answer)
    // carries the same model + effort. An absent/empty override yields a target
    // with no default fields ⇒ buildDriveArgs emits no extra flags (unchanged).
    const overrides = lease.execution_overrides;
    // env-variables design (task d1): the lease's frozen `PP_*` map, if any —
    // mapped to `--var` on the START invocation ONLY (buildDriveArgs enforces
    // this structurally; see its doc). Absent ⇒ no field ⇒ no flags, ever.
    const driveTarget: DriveTarget = {
      pipelineRoot: workspace.pipelineRoot,
      runId: lease.run_id,
      ...(overrides?.model ? { defaultModel: overrides.model } : {}),
      ...(overrides?.effort ? { defaultEffort: overrides.effort } : {}),
      ...(lease.variables !== undefined ? { variables: lease.variables } : {}),
    };

    let mode: DriveMode = { kind: 'start', startIteration: workspace.startIteration };
    for (;;) {
      const args = buildDriveArgs(driveTarget, mode);
      const result = await this.options.exec.run(this.pipelineBin, args, {
        cwd: workspace.dir,
        env: this.options.env,
      });

      // Provider limit takes precedence over exit-code classification: the job
      // PAUSES (auto-resume) instead of failing. Heartbeats keep the lease.
      const limit = this.detectLimit(result);
      if (limit !== null) {
        this.consecutivePauses += 1;
        if (this.consecutivePauses > this.maxPauses) {
          const reason = `provider limit persisted through ${this.maxPauses} pauses: ${limit.reason}`;
          this.report('halted', { halt_reason: reason });
          return this.fail(reason);
        }
        const pauseMs = this.pauseMsFor(this.consecutivePauses - 1, limit);
        this.pausedUntil_ = new Date(this.clock.now() + pauseMs).toISOString();
        this.setState('paused_provider_limit');
        this.logger.info(
          `job ${lease.job_id}: provider limit (${limit.reason}) — paused until ${this.pausedUntil_} ` +
            `(pause ${this.consecutivePauses}/${this.maxPauses})`
        );
        await this.pause(pauseMs);
        this.pausedUntil_ = null;
        this.setState('running');
        this.logger.info(`job ${lease.job_id}: resuming after provider-limit pause`);
        mode = { kind: 'resume' };
        continue;
      }
      this.consecutivePauses = 0;

      const outcome = classifyDriveOutcome(result);
      switch (outcome.kind) {
        case 'completed': {
          this.report('completed', { outcome: outcome.outcome });
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
            this.report('halted', { halt_reason: reason });
            return this.fail(reason);
          }
          this.setState('awaiting_input');
          // 06.2.2: drive's park JSON carries the question_id (b2's
          // `pipeline-cli` contract, 06.2.1) — use it verbatim so the relay
          // and drive's OWN session file agree on the identity. An older CLI
          // that predates the field reports `question_id: null`; the
          // executor mints a fallback ONLY in that case (never overrides a
          // drive-provided id).
          const parked: ParkedQuestion = {
            job_id: lease.job_id,
            run_id: lease.run_id,
            ...outcome.parked,
            question_id: outcome.parked.question_id ?? this.makeId(),
          };
          let answer: string | null;
          try {
            answer = await this.needsInput.onQuestion(parked);
          } catch (err) {
            const reason = `needs-input relay failed: ${err instanceof Error ? err.message : String(err)}`;
            this.report('halted', { halt_reason: reason });
            return this.fail(reason);
          }
          if (answer === null || answer.trim().length === 0) {
            const reason = 'run parked on a needs-input question and no relay/answer is available (T1-13 not wired)';
            this.report('halted', { halt_reason: reason });
            return this.fail(reason);
          }
          this.setState('running');
          mode = { kind: 'answer', startIteration: outcome.parked.iteration_path, answer };
          continue;
        }
        case 'halted': {
          this.report('halted', { halt_reason: outcome.reason });
          return this.fail(outcome.reason);
        }
        case 'failed': {
          this.report('halted', { halt_reason: outcome.reason });
          return this.fail(outcome.reason);
        }
      }
    }
  }

  /** T2-05 ADDITIVE: resolve a task lease's pipeline (dispatch matcher seam).
   *  Returns the resolved pipeline identity for workspace prep to continue
   *  with; the resolved identity then flows to the server through the normal
   *  event upload (the shipper tails the resolved pipeline root). */
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
