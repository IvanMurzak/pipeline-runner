/**
 * Job manager — the lease-acceptance gate and per-runner job registry.
 *
 * Attaches to the connection's dispatcher on the RESERVED `lease` type (the
 * exact hook point `dispatcher.ts` documents for this task) and, for each
 * well-formed lease that passes the preconditions, sends `accept` (echoing the
 * lease's correlation id) and starts a `JobExecutor`.
 *
 * Preconditions (a declined lease is IGNORED — the protocol has no lease-
 * reject frame; the server re-offers or times the offer out):
 *   - malformed frame                       → warn, ignore
 *   - not registered (no runner_id yet)     → ignore
 *   - draining (server directive)           → ignore
 *   - at capacity (active jobs ≥ capacity)  → ignore
 *   - label mismatch (lease asks for a label this runner does not advertise)
 *                                           → warn, ignore
 *   - duplicate job_id of an ACTIVE job     → re-send `accept` (idempotent
 *     re-acknowledgement for a redelivered offer), do NOT start a second run
 *
 * Exposes `activeRunIds` / `runnerStatus` / `pausedUntil` for heartbeat
 * composition (the connection's heartbeat loop currently reports
 * `active_run_ids: []`; wiring these accessors in is a flagged follow-up).
 */

import type { Clock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
// T2-05 ADDITIVE: the task-dispatch resolution seam type (passed through).
import type { TaskPipelineResolver } from '../dispatch/matcher';
import type { ProviderLimit, ProviderLimitDetector } from './drive';
import {
  JobExecutor,
  type JobExecutorEvents,
  type JobResult,
  type NeedsInputRelay,
} from './executor';
import { nodeJobExec, nodeJobFs, type JobExec, type JobFs } from './types';
import type { ContentHashVerifier, StartIterationResolver } from './workspace';
import { buildAcceptFrame, isLeaseMessage, type LeaseMessage } from './wire';

/** The dispatcher surface the manager needs (matches `core/dispatcher.ts`). */
export interface LeaseSource {
  on(type: string, handler: (frame: WireFrame) => void): () => void;
}

export interface JobManagerEvents extends Pick<JobExecutorEvents, 'onWorkspaceReady'> {
  onJobFinished?(result: JobResult): void;
}

export interface JobManagerOptions {
  /** The registered runner id, or null before registration. */
  runnerId(): string | null;
  /** Send a frame on the live connection (online-only; false = dropped). */
  send(frame: WireFrame): boolean;
  /** Jobs workdir root; each job checks out into `<root>/<job-id>`. */
  workspaceRoot: string;
  /** The labels this runner advertises (defaults to accepting any). */
  labels?(): string[];
  /** Max parallel jobs (defaults to 1). */
  capacity?(): number;
  /** True once the server directed `drain` — accept no new leases. */
  draining?(): boolean;
  exec?: JobExec;
  fs?: JobFs;
  gitBin?: string;
  pipelineBin?: string;
  env?: Record<string, string | undefined>;
  needsInput?: NeedsInputRelay;
  detectProviderLimit?: ProviderLimitDetector;
  providerLimitPauseMs?(attempt: number, limit: ProviderLimit): number;
  maxProviderLimitPauses?: number;
  maxQuestions?: number;
  verifyContentHash?: ContentHashVerifier;
  resolveStartIteration?: StartIterationResolver;
  /** T2-05 ADDITIVE — task-dispatch resolution seam, passed through to every
   *  executor. Absent ⇒ each executor defaults to the reused `pipeline match`
   *  BM25 CLI over its exec seam. Non-task leases never invoke it. */
  resolveTaskPipeline?: TaskPipelineResolver;
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  events?: JobManagerEvents;
}

export class JobManager {
  private readonly logger: Logger;
  private readonly exec: JobExec;
  private readonly fs: JobFs;
  private readonly active = new Map<string, JobExecutor>();

  constructor(private readonly options: JobManagerOptions) {
    this.logger = options.logger ?? nullLogger;
    this.exec = options.exec ?? nodeJobExec();
    this.fs = options.fs ?? nodeJobFs();
  }

  /** Attach the lease handler to a dispatcher. Returns the unsubscribe. */
  attach(dispatcher: LeaseSource): () => void {
    return dispatcher.on('lease', (frame) => this.handleLease(frame));
  }

  /** Run ids currently executing (heartbeat `active_run_ids` composition). */
  activeRunIds(): string[] {
    return [...this.active.values()].map((job) => job.runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** 'paused' when every active job is provider-limit-paused (≥1 active). */
  runnerStatus(): 'online' | 'paused' {
    const jobs = [...this.active.values()];
    return jobs.length > 0 && jobs.every((job) => job.state === 'paused_provider_limit') ? 'paused' : 'online';
  }

  /** Earliest scheduled auto-resume among paused jobs (heartbeat `paused_until`). */
  pausedUntil(): string | null {
    const times = [...this.active.values()]
      .map((job) => job.pausedUntil)
      .filter((t): t is string => t !== null)
      .sort();
    return times[0] ?? null;
  }

  /** Route one inbound `lease` frame (the dispatcher handler). */
  handleLease(frame: WireFrame): void {
    if (!isLeaseMessage(frame)) {
      this.logger.warn('malformed lease ignored');
      return;
    }
    const runnerId = this.options.runnerId();
    if (runnerId === null) {
      this.logger.warn(`lease ${frame.job_id} declined — runner not registered yet`);
      return;
    }
    if (this.options.draining?.() === true) {
      this.logger.info(`lease ${frame.job_id} declined — draining`);
      return;
    }
    if (this.active.has(frame.job_id)) {
      // A redelivered offer for a job we already run: re-acknowledge, never
      // start a second executor (accept is idempotent server-side).
      this.logger.info(`duplicate lease for active job ${frame.job_id} — re-acknowledging`);
      this.options.send(buildAcceptFrame(frame, runnerId));
      return;
    }
    const capacity = this.options.capacity?.() ?? 1;
    if (this.active.size >= capacity) {
      this.logger.info(`lease ${frame.job_id} declined — at capacity (${this.active.size}/${capacity})`);
      return;
    }
    const advertised = this.options.labels !== undefined ? new Set(this.options.labels()) : null;
    if (advertised !== null) {
      const unmatched = frame.labels.filter((label) => !advertised.has(label));
      if (unmatched.length > 0) {
        this.logger.warn(`lease ${frame.job_id} declined — unadvertised labels: ${unmatched.join(', ')}`);
        return;
      }
    }
    if (!this.options.send(buildAcceptFrame(frame, runnerId))) {
      this.logger.warn(`lease ${frame.job_id} not accepted — connection not online`);
      return;
    }
    this.logger.info(`lease ${frame.job_id} accepted (run ${frame.run_id})`);
    this.startJob(frame);
  }

  private startJob(lease: LeaseMessage): void {
    const executor = new JobExecutor({
      lease,
      runnerId: this.options.runnerId() ?? '',
      send: (frame) => this.options.send(frame),
      workspaceRoot: this.options.workspaceRoot,
      exec: this.exec,
      fs: this.fs,
      gitBin: this.options.gitBin,
      pipelineBin: this.options.pipelineBin,
      env: this.options.env,
      needsInput: this.options.needsInput,
      detectProviderLimit: this.options.detectProviderLimit,
      providerLimitPauseMs: this.options.providerLimitPauseMs,
      maxProviderLimitPauses: this.options.maxProviderLimitPauses,
      maxQuestions: this.options.maxQuestions,
      verifyContentHash: this.options.verifyContentHash,
      resolveStartIteration: this.options.resolveStartIteration,
      // T2-05 ADDITIVE: task-dispatch seam passthrough (see JobManagerOptions).
      resolveTaskPipeline: this.options.resolveTaskPipeline,
      clock: this.options.clock,
      logger: this.logger,
      makeId: this.options.makeId,
      events: { onWorkspaceReady: this.options.events?.onWorkspaceReady },
    });
    this.active.set(lease.job_id, executor);
    executor
      .start()
      .then((result) => {
        this.options.events?.onJobFinished?.(result);
      })
      .catch((err) => {
        // start() never rejects by contract; this is a last-resort container.
        this.logger.error(`job ${lease.job_id} crashed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.active.delete(lease.job_id);
      });
  }
}

/** The client surface `attachJobExecution` composes over (an `AgentClient`). */
export interface JobClient {
  dispatcher: LeaseSource;
  send(frame: WireFrame): boolean;
}

/**
 * Wire job execution onto a connected agent client: constructs a `JobManager`
 * bound to the client's `send` and attaches its lease handler to the client's
 * dispatcher. Purely additive — with no lease frames arriving, nothing runs.
 */
export function attachJobExecution(client: JobClient, options: Omit<JobManagerOptions, 'send'>): JobManager {
  const manager = new JobManager({ ...options, send: (frame) => client.send(frame) });
  manager.attach(client.dispatcher);
  return manager;
}
