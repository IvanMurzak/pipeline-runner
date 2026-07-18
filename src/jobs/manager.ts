/**
 * Job manager — the lease-acceptance gate, per-runner job registry, and (c6,
 * design 04 — D1) the durable job-state lifecycle:
 *
 *   - Attaches to the connection's dispatcher on `lease` AND (new) `cancel`.
 *   - ACCEPT writes the durable record BEFORE `prepareWorkspace` (04: a crash
 *     at any later point leaves a findable record + workspace).
 *   - STARTUP RECONCILE (`reconcile()` — call BEFORE the client connects):
 *     classifies every record UNRECOVERABLE (drop + best-effort `run_status
 *     halted`, deferred until online) / FRESH (resume NOW in the recorded
 *     checkout — `activeRunIds()` lists it before the first heartbeat) /
 *     STALE (QUARANTINE: no spawn, no listing, no capacity use).
 *   - ADOPTION: a lease whose `run_id` matches a quarantined record and
 *     carries `resume_hint` is validated (pipeline_ref match + pinned-hash
 *     re-verify + substrate present) and resumed in the RECORDED checkout
 *     under the new job_id (record atomically superseded). Validation
 *     failure ⇒ the quarantined leftovers are discarded and the lease falls
 *     through to fresh prep (correctness over resume).
 *   - CANCEL handler (D8, RESTRICTED server producer): kill the run's drive,
 *     delete the record, tear down the workspace — ONLY for runs this runner
 *     owns (active or quarantined); anything else is ignored.
 *   - TERMINAL lifecycle (E6 fix): completed / cleanly-halted / cancelled
 *     jobs get their workspace torn down and record deleted by DEFAULT;
 *     `PIPELINE_RUNNER_WORKSPACE_RETENTION` keeps them for a window (record
 *     tombstoned; `sweepRetention()` reaps expired ones + long-quarantined
 *     leftovers); `PIPELINE_RUNNER_KEEP_WORKSPACES=1` and the 05.2
 *     `preserve_workspace` flag keep everything. Suspended (shutdown) jobs
 *     keep record + workspace untouched — that IS the resume substrate.
 *
 * Preconditions (a declined lease is IGNORED — the protocol has no lease-
 * reject frame; the server re-offers or times the offer out):
 *   - malformed frame                       → warn, ignore
 *   - not registered (no runner_id yet)     → ignore
 *   - draining (server directive/shutdown)  → ignore
 *   - at capacity (active jobs ≥ capacity)  → ignore (QUARANTINED jobs do
 *     not count — a re-offer for one is never declined "at capacity")
 *   - label mismatch                        → warn, ignore
 *   - duplicate job_id of an ACTIVE job     → re-send `accept`, do NOT start
 *     a second run
 *
 * Exposes `activeRunIds` / `runnerStatus` / `pausedUntil` for heartbeat
 * composition, and `touchActiveRecords` as the heartbeat-tick record writer
 * (the connection's `onBeat`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
// T2-05 ADDITIVE: the task-dispatch resolution seam type (passed through).
import type { TaskPipelineResolver } from '../dispatch/matcher';
import { nodeShipperFs } from '../shipper/fs';
import type { ProviderLimit, ProviderLimitDetector } from './drive';
import {
  JobExecutor,
  type JobExecutorEvents,
  type JobResult,
  type NeedsInputRelay,
} from './executor';
import type { JobRecord, JobStore } from './job-store';
import { recordFromLease } from './job-store';
import { classifyRecord, fsSubstrateProbe, type SubstrateProbe } from './reconcile';
import { quarantineGcMs, type RetentionPolicy } from './retention';
import { nodeJobExec, nodeJobFs, type JobExec, type JobFs } from './types';
import { cliContentHashVerifier, sanitizeJobId, type ContentHashVerifier, type StartIterationResolver } from './workspace';
import { buildAcceptFrame, buildRunStatusFrame, isCancelMessage, isLeaseMessage, type LeaseMessage } from './wire';

/** The dispatcher surface the manager needs (matches `core/dispatcher.ts`). */
export interface LeaseSource {
  on(type: string, handler: (frame: WireFrame) => void): () => void;
}

export interface JobManagerEvents extends Pick<JobExecutorEvents, 'onWorkspaceReady' | 'onTerminalFlush'> {
  onJobFinished?(result: JobResult): void;
}

/** What `reconcile()` decided, per record (log/report material). */
export interface ReconcileSummary {
  resumed: JobRecord[];
  quarantined: JobRecord[];
  dropped: Array<{ record: JobRecord; reason: string }>;
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
  /** c6: the durable job-state store. Absent ⇒ no persistence (records,
   *  reconcile, adoption, cancel-of-quarantined and retention GC all no-op —
   *  the pre-c6 in-memory behavior). */
  store?: JobStore;
  /** c6: the substrate probe the reconcile/adoption validate through.
   *  Defaults to the real filesystem + `~/.claude/projects` layout. */
  substrate?: SubstrateProbe;
  /** c6: terminal workspace/record policy (default: immediate delete). */
  retention?: RetentionPolicy;
  clock?: Clock;
  logger?: Logger;
  makeId?(): string;
  events?: JobManagerEvents;
}

const DEFAULT_RETENTION: RetentionPolicy = { keepForever: false, retentionMs: null };

export class JobManager {
  private readonly logger: Logger;
  private readonly exec: JobExec;
  private readonly fs: JobFs;
  private readonly clock: Clock;
  private readonly retention: RetentionPolicy;
  private readonly active = new Map<string, JobExecutor>();
  /** Executor completion promises (graceful shutdown awaits these). */
  private readonly settling = new Map<string, Promise<JobResult>>();
  /** Quarantined records by RUN id (04: stale crash leftovers awaiting the
   *  server's re-offer or cancel — never listed, never counted). */
  private readonly quarantined = new Map<string, JobRecord>();
  /** `run_status halted` frames minted while offline (reconcile drops) —
   *  flushed on the next `onOnline` (best-effort, once). */
  private deferredReports: WireFrame[] = [];
  private substrate_: SubstrateProbe | null;
  private sweepTimer: unknown = null;

  constructor(private readonly options: JobManagerOptions) {
    this.logger = options.logger ?? nullLogger;
    this.exec = options.exec ?? nodeJobExec();
    this.fs = options.fs ?? nodeJobFs();
    this.clock = options.clock ?? systemClock;
    this.retention = options.retention ?? DEFAULT_RETENTION;
    this.substrate_ = options.substrate ?? null;
  }

  private get substrate(): SubstrateProbe {
    if (this.substrate_ === null) {
      this.substrate_ = fsSubstrateProbe(nodeShipperFs(), homedir());
    }
    return this.substrate_;
  }

  /** Attach the lease + cancel handlers to a dispatcher. Returns the unsubscribe. */
  attach(dispatcher: LeaseSource): () => void {
    const offLease = dispatcher.on('lease', (frame) => this.handleLease(frame));
    const offCancel = dispatcher.on('cancel', (frame) => this.handleCancel(frame));
    return () => {
      offLease();
      offCancel();
    };
  }

  /** Run ids currently executing (heartbeat `active_run_ids` composition).
   *  Paused and awaiting-input jobs ARE listed (invariant, 06.3); QUARANTINED
   *  runs are NOT (their leases are already expired server-side — listing
   *  them would be a lie). */
  activeRunIds(): string[] {
    return [...this.active.values()].map((job) => job.runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  get quarantinedCount(): number {
    return this.quarantined.size;
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

  // ── c6: startup reconcile ──────────────────────────────────────────────────

  /**
   * Scan the job-state store and act on every record (04 §Startup reconcile).
   * CALL BEFORE THE CLIENT CONNECTS — the classification is synchronous, and
   * FRESH resumes are seated in the active map before returning, so the very
   * first heartbeat's `active_run_ids` is already truthful. (The resumed
   * drives themselves run in the background, like any job.)
   */
  reconcile(): ReconcileSummary {
    const summary: ReconcileSummary = { resumed: [], quarantined: [], dropped: [] };
    const store = this.options.store;
    if (store === undefined) return summary;
    const now = this.clock.now();
    for (const record of store.list()) {
      if (record.terminal !== undefined) continue; // tombstone — retention GC's business
      const verdict = classifyRecord(record, now, this.substrate);
      switch (verdict.kind) {
        case 'unrecoverable': {
          this.logger.warn(
            `job ${record.job_id} (run ${record.run_id}) unrecoverable — ${verdict.reason}; dropping record`
          );
          // Best-effort `run_status halted`: the connection is not up yet
          // (reconcile runs pre-connect), so defer until the first online.
          this.deferredReports.push(
            buildRunStatusFrame(record.run_id, record.job_id, 'halted', {
              halt_reason: `resume state lost/expired (${verdict.reason})`,
            })
          );
          store.remove(record.job_id);
          this.teardownWorkspace(record, 'unrecoverable');
          summary.dropped.push({ record, reason: verdict.reason });
          break;
        }
        case 'fresh': {
          this.logger.info(`job ${record.job_id} (run ${record.run_id}) fresh — resuming in ${record.checkout_dir}`);
          store.touch(record.job_id);
          this.resumeJob(record, { announce: false, lease: leaseFromRecord(record) });
          summary.resumed.push(record);
          break;
        }
        case 'stale': {
          this.logger.info(
            `job ${record.job_id} (run ${record.run_id}) stale — QUARANTINED (awaiting re-offer or cancel)`
          );
          this.quarantined.set(record.run_id, record);
          summary.quarantined.push(record);
          break;
        }
      }
    }
    return summary;
  }

  /** Flush reports minted while offline (wire to the client's `onOnline`). */
  flushDeferredReports(): void {
    const frames = this.deferredReports;
    this.deferredReports = [];
    for (const frame of frames) {
      if (!this.options.send(frame)) this.deferredReports.push(frame);
    }
  }

  // ── c6: heartbeat-tick record writer ───────────────────────────────────────

  /** Renew `updated_at` on every ACTIVE job's record (the heartbeat-tick
   *  writer, 04) — a live runner's records stay FRESH so a quick restart
   *  resumes without arbitration. Quarantined records are NOT touched (their
   *  staleness is the signal). */
  touchActiveRecords(): void {
    const store = this.options.store;
    if (store === undefined) return;
    for (const jobId of this.active.keys()) store.touch(jobId);
  }

  // ── c6: graceful shutdown ──────────────────────────────────────────────────

  /**
   * Suspend every active job (SIGTERM the drive children via the exec-seam
   * abort; records stay on disk, phase current) and resolve once their
   * executors settle. Records are touched first so a prompt service restart
   * classifies them FRESH.
   */
  async suspendAll(): Promise<void> {
    this.touchActiveRecords();
    const pending = [...this.settling.values()];
    for (const job of this.active.values()) job.suspend();
    await Promise.allSettled(pending);
  }

  // ── c6: retention GC ───────────────────────────────────────────────────────

  /**
   * Reap (a) tombstoned terminal records whose retention window expired and
   * (b) quarantined/orphaned non-terminal records idle past the quarantine
   * window (F2: a run reassigned to another runner never sends this runner a
   * cancel — GC is how those leftovers go away). `keepForever` and
   * `preserve_workspace` are honored. Returns reaped job ids.
   */
  sweepRetention(): string[] {
    const store = this.options.store;
    if (store === undefined || this.retention.keepForever) return [];
    const reaped: string[] = [];
    const now = this.clock.now();
    const quarantineWindow = quarantineGcMs(this.retention);
    for (const record of store.list()) {
      if (this.active.has(record.job_id)) continue;
      if (record.preserve_workspace === true) continue;
      if (record.terminal !== undefined) {
        const age = now - Date.parse(record.terminal.at);
        if (this.retention.retentionMs !== null && age < this.retention.retentionMs) continue;
        this.teardownWorkspace(record, 'retention window expired');
        store.remove(record.job_id);
        reaped.push(record.job_id);
        continue;
      }
      const idle = now - Date.parse(record.updated_at);
      if (Number.isFinite(idle) && idle < quarantineWindow) continue;
      this.logger.info(`job ${record.job_id} (run ${record.run_id}) idle past the quarantine window — reaping`);
      this.teardownWorkspace(record, 'quarantine window expired');
      store.remove(record.job_id);
      this.quarantined.delete(record.run_id);
      reaped.push(record.job_id);
    }
    return reaped;
  }

  /** Re-arm a periodic `sweepRetention` on the injectable clock. Returns stop. */
  startRetentionSweeps(intervalMs: number): () => void {
    const tick = (): void => {
      this.sweepRetention();
      this.sweepTimer = this.clock.setTimeout(tick, intervalMs);
    };
    this.sweepTimer = this.clock.setTimeout(tick, intervalMs);
    return () => {
      if (this.sweepTimer !== null) {
        this.clock.clearTimeout(this.sweepTimer);
        this.sweepTimer = null;
      }
    };
  }

  // ── Inbound frames ─────────────────────────────────────────────────────────

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
      // Quarantined jobs deliberately do NOT count here (04): the re-offer
      // for a quarantined run must never be declined "at capacity".
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

    // c6: a lease for a QUARANTINED run routes through adoption arbitration
    // (async — hash re-verify shells out). Everything else preps fresh.
    const parked = this.quarantined.get(frame.run_id);
    if (parked !== undefined) {
      void this.adoptOrReplace(frame, parked).catch((err) => {
        this.logger.error(
          `adoption arbitration for run ${frame.run_id} crashed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return;
    }
    this.startJob(frame);
  }

  /** c6: the runner-side `cancel` HANDLER (D8; previously RESERVED_UNHANDLED).
   *  Kills an owned active run (no run_status — the server initiated) or
   *  discards an owned quarantined record; anything else is ignored. */
  handleCancel(frame: WireFrame): void {
    if (!isCancelMessage(frame)) {
      this.logger.warn('malformed cancel ignored');
      return;
    }
    for (const [jobId, job] of this.active) {
      if (job.runId !== frame.run_id) continue;
      if (frame.job_id !== undefined && frame.job_id !== jobId) continue;
      this.logger.info(`cancel: killing active job ${jobId} (run ${frame.run_id})${frame.reason ? ` — ${frame.reason}` : ''}`);
      job.cancel(); // finalizeJob (on settle) deletes record + workspace
      return;
    }
    const parked = this.quarantined.get(frame.run_id);
    if (parked !== undefined && (frame.job_id === undefined || frame.job_id === parked.job_id)) {
      this.logger.info(`cancel: discarding quarantined job ${parked.job_id} (run ${frame.run_id})`);
      this.discardQuarantined(parked, 'cancelled by server');
      return;
    }
    this.logger.info(`cancel for run ${frame.run_id} — not owned by this runner, ignored`);
  }

  // ── c6: adoption ───────────────────────────────────────────────────────────

  /**
   * Adoption arbitration (04 §Adoption): the lease was already ACCEPTED (the
   * offer must not time out while we verify). A `resume_hint` lease whose
   * recorded substrate validates resumes in the RECORDED checkout under the
   * new job_id (record superseded atomically). Anything else discards the
   * quarantined leftovers (by-run_id uniqueness — at most one record per
   * run) and preps fresh.
   */
  private async adoptOrReplace(lease: LeaseMessage, record: JobRecord): Promise<void> {
    const refusal = lease.resume_hint === true ? await this.validateAdoption(lease, record) : 'lease carries no resume_hint';
    if (refusal !== null) {
      this.logger.warn(
        `adoption of run ${lease.run_id} declined (${refusal}) — discarding quarantined workspace, preparing fresh`
      );
      this.discardQuarantined(record, refusal);
      this.startJob(lease);
      return;
    }
    const nowIso = new Date(this.clock.now()).toISOString();
    const adopted: JobRecord = {
      ...record,
      job_id: lease.job_id,
      attempt: lease.attempt ?? record.attempt + 1,
      pipeline_ref: lease.pipeline_ref,
      lease_ttl_s: lease.lease_ttl_s ?? record.lease_ttl_s,
      secret_slugs: lease.secret_slugs,
      ...(lease.execution_overrides !== undefined ? { execution_overrides: lease.execution_overrides } : {}),
      ...(lease.event_seq_base !== undefined ? { event_seq_base: lease.event_seq_base } : {}),
      accepted_at: nowIso,
      updated_at: nowIso,
    };
    this.options.store?.supersede(record.job_id, adopted);
    this.quarantined.delete(record.run_id);
    this.logger.info(
      `run ${lease.run_id} ADOPTED: job ${record.job_id} → ${lease.job_id} (attempt ${adopted.attempt}) in recorded ${record.checkout_dir}`
    );
    // The REAL lease drives the resume: fresh job_jwt, fenced seqs; announce
    // the new job's `started`.
    this.resumeJob(adopted, { announce: true, lease });
  }

  /** Null = adopt; otherwise the refusal reason (fall through to fresh prep). */
  private async validateAdoption(lease: LeaseMessage, record: JobRecord): Promise<string | null> {
    const recorded = record.pipeline_ref;
    const offered = lease.pipeline_ref;
    if (recorded.repo !== offered.repo || recorded.ref !== offered.ref || recorded.pipeline !== offered.pipeline) {
      return `pipeline_ref mismatch (recorded ${recorded.repo}@${recorded.ref}:${recorded.pipeline}, offered ${offered.repo}@${offered.ref}:${offered.pipeline})`;
    }
    const pinned = offered.content_hash;
    if (pinned !== undefined && pinned !== null) {
      if (recorded.content_hash !== undefined && recorded.content_hash !== null && recorded.content_hash !== pinned) {
        return `content_hash mismatch (recorded ${recorded.content_hash}, offered ${pinned})`;
      }
    }
    if (!this.substrate.checkoutExists(record)) return 'recorded checkout missing';
    if (!this.substrate.nextJsonExists(record)) return 'next.json missing';
    if (!this.substrate.transcriptsPresent(record)) return 'step session transcript missing';
    if (pinned !== undefined && pinned !== null && record.pipeline_root !== null) {
      // Pinned-hash RE-VERIFY on adoption (06 §hash chain, c4's verifier).
      const verify =
        this.options.verifyContentHash ??
        cliContentHashVerifier({
          exec: this.exec,
          pipelineBin: this.options.pipelineBin ?? 'pipeline',
          logger: this.logger,
        });
      try {
        const ok = await verify(record.pipeline_root, pinned);
        if (!ok) return `content hash re-verify failed for ${pinned}`;
      } catch (err) {
        return `content hash re-verify failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return null;
  }

  /** Drop a quarantined record + workspace (adoption refusal / cancel). */
  private discardQuarantined(record: JobRecord, why: string): void {
    this.quarantined.delete(record.run_id);
    this.options.store?.remove(record.job_id);
    if (this.retention.keepForever || record.preserve_workspace === true) {
      this.logger.info(`quarantined workspace ${record.checkout_dir} kept (${why}; preservation active)`);
      return;
    }
    this.teardownWorkspace(record, why);
  }

  // ── Job execution ──────────────────────────────────────────────────────────

  /** Fresh-prep path: record written at ACCEPT, before any prep I/O (04). */
  private startJob(lease: LeaseMessage): void {
    const checkoutDir = join(this.options.workspaceRoot, sanitizeJobId(lease.job_id));
    this.options.store?.write(recordFromLease(lease, checkoutDir, new Date(this.clock.now()).toISOString()));
    this.launch(lease, undefined);
  }

  /** Resume path (reconcile FRESH / adoption): recorded checkout, no prep. */
  private resumeJob(record: JobRecord, opts: { announce: boolean; lease: LeaseMessage }): void {
    this.launch(opts.lease, { record, announce: opts.announce });
  }

  private launch(lease: LeaseMessage, resume: { record: JobRecord; announce: boolean } | undefined): void {
    const store = this.options.store;
    const jobId = lease.job_id;
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
      // c6: the durable-record port — executor phase transitions persist.
      record: store === undefined ? undefined : { update: (patch) => store.update(jobId, patch) },
      resume,
      clock: this.options.clock,
      logger: this.logger,
      makeId: this.options.makeId,
      events: {
        onWorkspaceReady: this.options.events?.onWorkspaceReady,
        onTerminalFlush: this.options.events?.onTerminalFlush,
      },
    });
    this.active.set(jobId, executor);
    const settled = executor
      .start()
      .then((result) => {
        this.options.events?.onJobFinished?.(result);
        this.finalizeJob(result);
        return result;
      })
      .catch((err) => {
        // start() never rejects by contract; this is a last-resort container.
        this.logger.error(`job ${jobId} crashed: ${err instanceof Error ? err.message : String(err)}`);
        return { job_id: jobId, run_id: lease.run_id, ok: false, reason: 'executor crashed' } as JobResult;
      })
      .finally(() => {
        // Unlisted only AFTER start() resolved — i.e. after the ordered
        // completion (flush → run_status) finished (c6, c5 race).
        this.active.delete(jobId);
        this.settling.delete(jobId);
      });
    this.settling.set(jobId, settled);
  }

  // ── c6: terminal record + workspace lifecycle (E6 fix, D15) ───────────────

  private finalizeJob(result: JobResult): void {
    const store = this.options.store;
    if (!result.ok && result.suspended === true) {
      // Graceful shutdown: the record IS the resume substrate — keep both.
      return;
    }
    const record = store?.read(result.job_id) ?? null;
    const checkoutDir = record?.checkout_dir ?? join(this.options.workspaceRoot, sanitizeJobId(result.job_id));
    if (!result.ok && result.cancelled === true) {
      // Server cancel: record + workspace gone (keepForever still honored —
      // an operator that said "keep everything" means it).
      store?.remove(result.job_id);
      if (!this.retention.keepForever) {
        this.teardownWorkspace({ job_id: result.job_id, checkout_dir: checkoutDir }, 'cancelled');
      }
      return;
    }
    const outcome = result.ok ? result.outcome : `halted: ${result.reason}`;
    if (this.retention.keepForever || record?.preserve_workspace === true) {
      // Tombstone so the reconcile never resumes it; GC skips preserved ones.
      store?.update(result.job_id, { terminal: { outcome, at: new Date(this.clock.now()).toISOString() } });
      return;
    }
    if (this.retention.retentionMs !== null) {
      store?.update(result.job_id, { terminal: { outcome, at: new Date(this.clock.now()).toISOString() } });
      return; // sweepRetention reaps after the window
    }
    // Default: immediate reap (the E6 leak fix).
    store?.remove(result.job_id);
    this.teardownWorkspace({ job_id: result.job_id, checkout_dir: checkoutDir }, 'terminal');
  }

  private teardownWorkspace(record: Pick<JobRecord, 'job_id' | 'checkout_dir'>, why: string): void {
    try {
      this.fs.removeDir(record.checkout_dir);
      this.logger.info(`workspace ${record.checkout_dir} removed (${why})`);
    } catch (err) {
      this.logger.warn(
        `workspace teardown failed for ${record.checkout_dir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/** Synthesize the executor input for a reconcile (FRESH) resume: the daemon
 *  that accepted the real lease is gone, and the record deliberately persists
 *  no `job_jwt` (04) — so the resumed job runs with an EMPTY one (the WSS
 *  upload transport authenticates via the runner token; a >TTL death gets a
 *  fresh JWT through adoption instead). */
export function leaseFromRecord(record: JobRecord): LeaseMessage {
  return {
    type: 'lease',
    job_id: record.job_id,
    run_id: record.run_id,
    pipeline_ref: record.pipeline_ref,
    labels: [],
    job_jwt: '',
    secret_slugs: record.secret_slugs,
    lease_ttl_s: record.lease_ttl_s,
    attempt: record.attempt,
    ...(record.execution_overrides !== undefined ? { execution_overrides: record.execution_overrides } : {}),
    ...(record.event_seq_base !== undefined ? { event_seq_base: record.event_seq_base } : {}),
  };
}

/** The client surface `attachJobExecution` composes over (an `AgentClient`). */
export interface JobClient {
  dispatcher: LeaseSource;
  send(frame: WireFrame): boolean;
}

/**
 * Wire job execution onto a connected agent client: constructs a `JobManager`
 * bound to the client's `send` and attaches its lease + cancel handlers to
 * the client's dispatcher. Purely additive — with no frames arriving, nothing
 * runs.
 */
export function attachJobExecution(client: JobClient, options: Omit<JobManagerOptions, 'send'>): JobManager {
  const manager = new JobManager({ ...options, send: (frame) => client.send(frame) });
  manager.attach(client.dispatcher);
  return manager;
}
