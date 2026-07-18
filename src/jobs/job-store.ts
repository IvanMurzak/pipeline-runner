/**
 * Runner job-state store (c6, design 04 — D1): one durable JSON record per
 * accepted job under `<dataDir>/jobs/<job_id>.json`, so a runner-daemon death
 * never loses a run — the startup reconcile (./reconcile.ts) re-derives every
 * in-flight job from these records and the workspaces they point at.
 *
 * Placement rule (04 §job-state store): the runner DATA dir (same root as the
 * shipper state, `../shipper/fs.ts` `defaultDataDir`), NOT the config dir
 * (identity only) and NOT inside the checkout (records must survive checkout
 * wipes).
 *
 * Contents rule: NO `job_jwt` is ever persisted (secret hygiene — the JWT is
 * short-lived by design; a >TTL resume goes through ADOPTION and gets a fresh
 * one on the new lease; a <TTL same-process resume never lost it). Secret
 * NAMES only (`secret_slugs`, as on the lease), never values.
 *
 * By-run_id uniqueness invariant (04): at most one record per `run_id`.
 * `supersede()` (adoption) writes the new record BEFORE deleting the old one —
 * a crash between the two leaves two records for one run, which `list()`
 * resolves deterministically (newest `accepted_at` wins; the loser is deleted
 * on sight) so a double daemon restart can never reconcile two records onto
 * one run.
 *
 * Writers (04): accept (manager), phase transitions (executor, via the
 * `JobRecordPort` closure the manager hands it), heartbeat ticks (the
 * connection's `onBeat` → `manager.touchActiveRecords()`), terminal
 * finalization + retention GC (manager). All writes are best-effort atomic
 * (`ShipperFileSystem.writeFileText` = tmp + rename).
 */

import { join } from 'node:path';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { ShipperFileSystem } from '../shipper/fs';
import type { ExecutionOverrides, LeaseMessage, PipelineRef } from './wire';
import { sanitizeJobId } from './workspace';

/** Non-terminal job phases a record can persist (04 schema). Terminal
 *  outcomes never live in `phase` — they become the `terminal` tombstone
 *  (retention GC) or delete the record outright. */
export type JobPhase = 'preparing' | 'running' | 'paused_provider_limit' | 'awaiting_input';

/** A parked question as persisted on the record (04 `questions`): everything
 *  the reconcile needs to re-surface it after a daemon death — identity,
 *  resume target, and the question content itself. */
export interface RecordedQuestion {
  question_id: string;
  step_id: string | null;
  iteration_path: string;
  session_id: string | null;
  question: { text: string; context: string | null; options: string[] | null };
}

/** The per-job durable record (04 schema + the additive fields later design
 *  sections pin: `event_seq_base` fencing 06.8.2, `execution_overrides` so a
 *  resumed run keeps its matrix cell's model/effort, the 05.2
 *  `preserve_workspace` flag, and the `terminal` tombstone for retention GC). */
export interface JobRecord {
  job_id: string;
  run_id: string;
  /** The cloud's attempt counter for this run (lease `attempt`; default 1). */
  attempt: number;
  pipeline_ref: PipelineRef;
  /** The job's isolated checkout dir — recorded at ACCEPT (it is derived
   *  deterministically from the job id), so even a crash during `preparing`
   *  leaves a findable workspace. On an ADOPTED record this is the OLD job's
   *  dir (claude sessions are cwd-scoped — the old cwd is the resume
   *  substrate), which is why teardown always uses the RECORDED dir, never
   *  one re-derived from the job id. */
  checkout_dir: string;
  /** Absolute pipeline root inside the checkout; null until prep completed
   *  (a crash before then is UNRECOVERABLE by construction — fresh attempt). */
  pipeline_root: string | null;
  /** Entry iteration relative to the pipeline root; null until prep completed. */
  start_iteration: string | null;
  lease_ttl_s: number;
  /** Declared secret NAMES from the lease. Values are never persisted. */
  secret_slugs: string[];
  /** The lease's matrix-cell overrides (T3-06) — re-applied on resume so the
   *  cell's model/effort survive a daemon death. */
  execution_overrides?: ExecutionOverrides;
  /** Attempt-fencing seq base from the lease (06.8.2) — the shipper starts
   *  this run's `perRunSeq` here so a re-attempt's events can never collide
   *  with a prior attempt's window. */
  event_seq_base?: number;
  phase: JobPhase;
  /** ISO time a provider-limit pause auto-resumes, while `paused_provider_limit`. */
  paused_until: string | null;
  consecutive_pauses: number;
  /** Parked questions awaiting an answer, while `awaiting_input` (newest last). */
  questions: RecordedQuestion[];
  /** 05.2 unshipped-improvements preservation flag: true ⇒ the workspace (and
   *  this record) survive terminal teardown AND retention GC. */
  preserve_workspace?: boolean;
  /** Terminal tombstone: set instead of deleting the record when a retention
   *  window (or preservation) keeps the workspace around — the reconcile
   *  ignores tombstoned records; the retention GC reaps them. */
  terminal?: { outcome: string; at: string };
  accepted_at: string;
  updated_at: string;
}

/** Default lease TTL when a lease/record does not state one (the design's
 *  reference TTL — 03 §F1 "lease TTL 90 s"). */
export const DEFAULT_LEASE_TTL_S = 90;

/** Build the accept-time record for a lease (04: written atomically at accept,
 *  BEFORE `prepareWorkspace`). */
export function recordFromLease(lease: LeaseMessage, checkoutDir: string, nowIso: string): JobRecord {
  return {
    job_id: lease.job_id,
    run_id: lease.run_id,
    attempt: lease.attempt ?? 1,
    pipeline_ref: lease.pipeline_ref,
    checkout_dir: checkoutDir,
    pipeline_root: null,
    start_iteration: null,
    lease_ttl_s: lease.lease_ttl_s ?? DEFAULT_LEASE_TTL_S,
    secret_slugs: lease.secret_slugs,
    ...(lease.execution_overrides !== undefined ? { execution_overrides: lease.execution_overrides } : {}),
    ...(lease.event_seq_base !== undefined ? { event_seq_base: lease.event_seq_base } : {}),
    phase: 'preparing',
    paused_until: null,
    consecutive_pauses: 0,
    questions: [],
    accepted_at: nowIso,
    updated_at: nowIso,
  };
}

/** Minimal structural check on a parsed record — enough to trust the fields
 *  the reconcile/GC read. Anything else rides through untouched (additive). */
function isJobRecord(value: unknown): value is JobRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.job_id === 'string' &&
    typeof record.run_id === 'string' &&
    typeof record.checkout_dir === 'string' &&
    typeof record.phase === 'string' &&
    typeof record.updated_at === 'string' &&
    typeof record.accepted_at === 'string'
  );
}

export interface JobStoreOptions {
  fs: ShipperFileSystem;
  /** The records directory: `<dataDir>/jobs`. */
  dir: string;
  clock?: Clock;
  logger?: Logger;
}

export class JobStore {
  private readonly fs: ShipperFileSystem;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly options: JobStoreOptions) {
    this.fs = options.fs;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
  }

  get dir(): string {
    return this.options.dir;
  }

  pathFor(jobId: string): string {
    return join(this.options.dir, `${sanitizeJobId(jobId)}.json`);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Write a record verbatim (best-effort atomic: tmp + rename). */
  write(record: JobRecord): void {
    this.fs.mkdirp(this.options.dir);
    this.fs.writeFileText(this.pathFor(record.job_id), JSON.stringify(record, null, 2) + '\n');
  }

  /** Read one record; null when missing. A CORRUPT file is set aside as
   *  `.corrupt` (kept for forensics, never re-read) and reported null. */
  read(jobId: string): JobRecord | null {
    return this.readPath(this.pathFor(jobId));
  }

  private readPath(path: string): JobRecord | null {
    const text = this.fs.readFileText(path);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isJobRecord(parsed)) {
      this.logger.warn(`job record unreadable — set aside as ${path}.corrupt`);
      try {
        this.fs.rename(path, `${path}.corrupt`);
      } catch {
        /* best-effort */
      }
      return null;
    }
    return parsed;
  }

  /** Read-modify-write: apply a patch and renew `updated_at`. No-op (null)
   *  when the record does not exist. */
  update(jobId: string, patch: Partial<JobRecord>): JobRecord | null {
    const current = this.read(jobId);
    if (current === null) return null;
    const next: JobRecord = { ...current, ...patch, updated_at: this.nowIso() };
    this.write(next);
    return next;
  }

  /** Renew `updated_at` only (the heartbeat-tick writer — 04: a live runner's
   *  records must stay FRESH so a quick restart resumes without arbitration). */
  touch(jobId: string): void {
    this.update(jobId, {});
  }

  /** Delete a record (missing is a no-op). */
  remove(jobId: string): void {
    this.fs.remove(this.pathFor(jobId));
  }

  /**
   * Atomic supersede-on-adoption (04): persist the NEW record (new job_id,
   * same run_id, old checkout_dir) and only THEN delete the old one. A crash
   * between the two leaves both on disk — `list()`'s by-run_id resolution
   * (newest `accepted_at` wins, loser deleted) makes the overlap harmless.
   */
  supersede(oldJobId: string, next: JobRecord): void {
    this.write(next);
    if (oldJobId !== next.job_id) this.remove(oldJobId);
  }

  /**
   * All records, with the by-run_id uniqueness invariant ENFORCED: when two
   * records claim the same `run_id` (a crash mid-supersede), the newest
   * `accepted_at` (ties: newest `updated_at`) survives and the older record
   * is deleted on the spot — never returned, never resumable.
   */
  list(): JobRecord[] {
    const entries = this.fs.listDir(this.options.dir);
    if (entries === null) return [];
    const byRun = new Map<string, JobRecord>();
    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
      const record = this.readPath(join(this.options.dir, entry.name));
      if (record === null) continue;
      const rival = byRun.get(record.run_id);
      if (rival === undefined) {
        byRun.set(record.run_id, record);
        continue;
      }
      const keepNew =
        record.accepted_at > rival.accepted_at ||
        (record.accepted_at === rival.accepted_at && record.updated_at >= rival.updated_at);
      const loser = keepNew ? rival : record;
      const winner = keepNew ? record : rival;
      byRun.set(record.run_id, winner);
      this.logger.warn(
        `duplicate job records for run ${record.run_id} — keeping ${winner.job_id}, deleting ${loser.job_id} (by-run_id uniqueness)`
      );
      this.remove(loser.job_id);
    }
    return [...byRun.values()];
  }
}
