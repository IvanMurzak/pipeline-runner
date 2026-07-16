/**
 * Per-job ISOLATED workspace prep: resolve `pipeline_ref` (a checkout
 * reference — sources are NOT in the cloud) into a fresh local checkout the
 * runner can `pipeline drive` in.
 *
 * Isolation rule: one directory per job under the jobs workdir root, torn down
 * and re-created if a stale one exists — no cross-job persistence or leakage.
 * The checkout is a fresh shallow fetch (init → remote add → fetch --depth 1 →
 * checkout --detach FETCH_HEAD), never a shared clone or worktree of some
 * long-lived repo, so concurrent jobs can never see each other's state.
 *
 * ALL git calls go through the injectable `JobExec` seam and all directory
 * work through `JobFs` — tests never touch a real repo or the network.
 *
 * Content-hash verification: the lease may pin `content_hash` (PIPELINE.md +
 * steps/** + scripts/**). The hashing scheme lives in the T1-14 lib which is
 * NOT on this branch, so verification is an injectable seam
 * (`verifyContentHash`); absent a verifier, a pinned hash is logged as
 * unverified and prep continues — FOLLOW-UP: wire the real verifier.
 *
 * T2-05 ADDITIVE: task-dispatch leases (`pipeline` = the `@task` sentinel)
 * resolve their actual pipeline AFTER checkout through the optional
 * `resolvePipeline` seam (the dispatch BM25 matcher); fixed-pipeline prep is
 * unchanged.
 */

import { join } from 'node:path';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import { TASK_PIPELINE_UNRESOLVED, type PipelineRef } from './wire';
import { JobError, type JobExec, type JobExecResult, type JobFs } from './types';

/** Verifies a checked-out pipeline against the lease's pinned content hash. */
export type ContentHashVerifier = (pipelineRootAbs: string, expectedHash: string) => boolean | Promise<boolean>;

/** Resolves the run's entry iteration (root-relative, forward slashes). */
export type StartIterationResolver = (pipelineRootAbs: string, fs: JobFs) => string | null;

export interface PrepareWorkspaceOptions {
  /** The leased job's id — becomes the per-job directory name (sanitized). */
  jobId: string;
  ref: PipelineRef;
  /** The jobs workdir root; each job gets `<root>/<sanitized-job-id>`. */
  root: string;
  exec: JobExec;
  fs: JobFs;
  gitBin?: string;
  logger?: Logger;
  /** Absent ⇒ a pinned hash is logged as unverified (T1-14 follow-up). */
  verifyContentHash?: ContentHashVerifier;
  /** Absent ⇒ `defaultResolveStartIteration` (first `steps/*.md`, sorted). */
  resolveStartIteration?: StartIterationResolver;
  /** T2-05 ADDITIVE — task-dispatch resolution seam: invoked AFTER checkout,
   *  and ONLY when `ref.pipeline` is the `@task` sentinel, to resolve the
   *  actual pipeline (bare name or checkout-relative path) the rest of prep
   *  continues with. Absent ⇒ a sentinel ref fails prep actionably.
   *  Non-sentinel (fixed-pipeline) refs NEVER invoke it — T2-03 behavior is
   *  unchanged. */
  resolvePipeline?: (checkoutDir: string) => string | Promise<string>;
}

export interface PreparedWorkspace {
  /** The job's isolated checkout directory (the project root drive runs in). */
  dir: string;
  /** Absolute path of the pipeline root inside the checkout. */
  pipelineRoot: string;
  /** Entry iteration for `pipeline drive --start`, relative to the pipeline
   *  root (forward slashes, e.g. `steps/01-plan.md`). */
  startIteration: string;
}

/** Filesystem-safe form of a job id (used as the per-job directory name). */
export function sanitizeJobId(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe.replace(/[.-]/g, '').length === 0) throw new JobError(`job id unusable as a directory name: ${jobId}`);
  return safe;
}

/**
 * The pipeline root, relative to the checkout (forward slashes). A bare NAME
 * resolves under the `.claude/pipeline/` convention dir; anything with a path
 * separator is taken as a repo-relative path verbatim.
 */
export function pipelineRootRel(pipeline: string): string {
  const normalized = pipeline.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.includes('..')) throw new JobError(`pipeline path must not traverse upward: ${pipeline}`);
  return normalized.includes('/') ? normalized : `.claude/pipeline/${normalized}`;
}

/**
 * Default entry-iteration resolution: the lexically-first `steps/*.md` (step
 * files carry ordering prefixes, e.g. `01-plan.md`). A pipeline-manifest-aware
 * resolver (computePlan lives in pipeline-cli, not this package) can be
 * injected via `resolveStartIteration` — FOLLOW-UP once shared.
 */
export const defaultResolveStartIteration: StartIterationResolver = (pipelineRootAbs, fs) => {
  const names = fs
    .listDir(join(pipelineRootAbs, 'steps'))
    .filter((name) => name.endsWith('.md'))
    .sort();
  return names.length > 0 ? `steps/${names[0]}` : null;
};

/** First line of stderr/stdout, trimmed and capped — for JobError messages. */
function execDetail(result: JobExecResult): string {
  const text = (result.stderr || result.stdout || result.error || '').trim().split('\n')[0] ?? '';
  const capped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  return capped.length > 0 ? `: ${capped}` : '';
}

/**
 * Prepare the job's isolated workspace. Throws `JobError` with an actionable
 * message on any failure (git failure detail included, never the job JWT).
 */
export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  const { ref, exec, fs } = options;
  const git = options.gitBin ?? 'git';
  const logger = options.logger ?? nullLogger;
  const dir = join(options.root, sanitizeJobId(options.jobId));

  // Fresh per-job directory: a stale one (crashed prior attempt) is removed —
  // no cross-job (or cross-attempt) leakage.
  fs.mkdirp(options.root);
  if (fs.exists(dir)) {
    logger.info(`removing stale workspace at ${dir}`);
    fs.removeDir(dir);
  }
  fs.mkdirp(dir);

  // Shallow, deterministic checkout of exactly the requested ref. `fetch <ref>`
  // handles branches, tags, and (on servers that allow it) commit shas alike.
  const steps: Array<{ what: string; args: string[] }> = [
    { what: 'init', args: ['init', dir] },
    { what: 'remote add', args: ['-C', dir, 'remote', 'add', 'origin', ref.repo] },
    { what: `fetch ${ref.ref}`, args: ['-C', dir, 'fetch', '--depth', '1', 'origin', ref.ref] },
    { what: 'checkout', args: ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'] },
  ];
  for (const step of steps) {
    const result = await exec.run(git, step.args);
    if (result.code !== 0) {
      throw new JobError(`git ${step.what} failed (exit ${result.code ?? 'none'})${execDetail(result)}`);
    }
  }

  // T2-05 ADDITIVE: a task-dispatch lease carries the `@task` sentinel — the
  // real pipeline is resolved from the CHECKED-OUT project's local manifests
  // (BM25 dispatch seam), never from the lease. A fixed-pipeline lease takes
  // the original path byte-for-byte (`pipeline === ref.pipeline`).
  let pipeline = ref.pipeline;
  if (pipeline === TASK_PIPELINE_UNRESOLVED) {
    if (options.resolvePipeline === undefined) {
      throw new JobError(
        `lease pipeline is the task sentinel '${TASK_PIPELINE_UNRESOLVED}' but no pipeline resolver is wired`
      );
    }
    pipeline = await options.resolvePipeline(dir);
  }

  const rel = pipelineRootRel(pipeline);
  const pipelineRoot = join(dir, ...rel.split('/'));
  if (!fs.exists(pipelineRoot)) {
    throw new JobError(`pipeline root not found in checkout: ${rel} (repo ${ref.repo} @ ${ref.ref})`);
  }

  if (ref.content_hash !== undefined && ref.content_hash !== null) {
    if (options.verifyContentHash !== undefined) {
      const ok = await options.verifyContentHash(pipelineRoot, ref.content_hash);
      if (!ok) {
        throw new JobError(
          `pipeline content hash mismatch: checkout of ${rel} @ ${ref.ref} does not match pinned ${ref.content_hash}`
        );
      }
    } else {
      // T1-14 hash lib is not vendored here yet — do not fail a pinned lease.
      logger.warn(`lease pins content_hash ${ref.content_hash} but no verifier is wired — proceeding unverified`);
    }
  }

  const resolveStart = options.resolveStartIteration ?? defaultResolveStartIteration;
  const startIteration = resolveStart(pipelineRoot, fs);
  if (startIteration === null) {
    throw new JobError(`pipeline has no entry iteration (no steps/*.md under ${rel})`);
  }

  return { dir, pipelineRoot, startIteration };
}
