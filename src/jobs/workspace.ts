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
 * Content-hash verification (06.4, closes B1): the lease may pin
 * `content_hash` (PIPELINE.md + steps/** + scripts/**). `verifyContentHash`
 * is an injectable seam; absent an override, the DEFAULT
 * (`cliContentHashVerifier`) shells the SAME `pipelineBin` drive uses —
 * `pipeline hash --root <abs> --json` — and compares against the pin. A
 * mismatch fails prep closed (JobError, F7); a CLI that predates the `hash`
 * command is compat (warn + proceed, counted via the log).
 *
 * Start-iteration resolution (06.5, closes B4): `resolveStartIteration` is
 * likewise an injectable seam; absent an override, the DEFAULT
 * (`cliStartIterationResolver`) shells `pipeline plan --root <abs> --json`
 * (`computePlan` is the single authority for step ordering, graph entry, and
 * target families) and takes the plan's first enumerated step. A CLI that
 * predates (or returns unusable output for) `plan --json` falls back to the
 * flat lexical rule (`defaultResolveStartIteration`) — this is a
 * correctness concern, not a security boundary, so it degrades gracefully
 * rather than failing prep.
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
export type StartIterationResolver = (pipelineRootAbs: string, fs: JobFs) => string | null | Promise<string | null>;

export interface PrepareWorkspaceOptions {
  /** The leased job's id — becomes the per-job directory name (sanitized). */
  jobId: string;
  ref: PipelineRef;
  /** The jobs workdir root; each job gets `<root>/<sanitized-job-id>`. */
  root: string;
  exec: JobExec;
  fs: JobFs;
  gitBin?: string;
  /** The `pipeline` CLI binary — the SAME one drive shells out to; used by
   *  the DEFAULT hash-verify / start-iteration resolvers below when their
   *  seam overrides are absent. Defaults to `'pipeline'`. */
  pipelineBin?: string;
  logger?: Logger;
  /** Absent ⇒ the default `cliContentHashVerifier` (shells `pipelineBin`'s
   *  `hash --json`, 06.4). */
  verifyContentHash?: ContentHashVerifier;
  /** Absent ⇒ the default `cliStartIterationResolver` (shells `pipelineBin`'s
   *  `plan --json`, 06.5; falls back to `defaultResolveStartIteration` on an
   *  old CLI). */
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

/** True when an exec result indicates the binary predates this subcommand
 *  (`pipeline: unknown command '<name>'`, cli.ts's default-case message) or
 *  the `pipeline` binary is missing entirely (`JobExec`'s code-127
 *  contract) — both are compat cases, never a security-relevant failure. */
function isUnsupportedCommand(result: JobExecResult): boolean {
  return result.code === 127 || /unknown command/i.test(result.stderr);
}

// ── verifyContentHash default: shells `pipeline hash --json` (06.4) ─────────

export interface CliHashVerifierOptions {
  /** The async subprocess seam — the SAME one the checkout/drive use. */
  exec: JobExec;
  /** The `pipeline` CLI binary (defaults to `pipeline`, like drive). */
  pipelineBin?: string;
  logger?: Logger;
}

/** Parse `pipeline hash --json` stdout (`{"content_hash":"sha256:<hex>"}`)
 *  into the reported hash, or null when unparseable/missing. */
function parseHashJson(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>).content_hash;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The default `verifyContentHash` (06.4, closes B1: a pinned hash was
 * previously accepted unverified): shells the SAME `pipelineBin` drive uses —
 * `pipeline hash --root <abs> --json` — and compares the reported hash to
 * the lease's pin. A mismatch THROWS `JobError` directly, in the exact
 * `03-flows.md` §F7 shape (`content hash mismatch (expected …, got …)`) —
 * rather than returning `false` — so the reason string carries the ACTUAL
 * computed hash too; the generic `!ok` message `prepareWorkspace` falls back
 * to below (for a directly-injected boolean verifier) only ever has the
 * expected side. A CLI that predates the `hash` command (unknown command /
 * binary missing) is compat: warn + treat as verified (counted via the warn
 * log) rather than failing a pinned lease the runner simply cannot check yet.
 */
export function cliContentHashVerifier(options: CliHashVerifierOptions): ContentHashVerifier {
  const bin = options.pipelineBin ?? 'pipeline';
  const logger = options.logger ?? nullLogger;
  return async (pipelineRootAbs, expectedHash) => {
    const result = await options.exec.run(bin, ['hash', '--root', pipelineRootAbs, '--json']);
    if (isUnsupportedCommand(result)) {
      logger.warn(
        `pipeline hash unsupported by this CLI (predates the hash command) — content_hash ${expectedHash} not verified, proceeding (compat)`
      );
      return true;
    }
    const actual = result.code === 0 ? parseHashJson(result.stdout) : null;
    if (actual === null) {
      throw new JobError(`pipeline hash failed (exit ${result.code ?? 'none'})${execDetail(result)}`);
    }
    if (actual !== expectedHash) {
      throw new JobError(`content hash mismatch (expected ${expectedHash}, got ${actual})`);
    }
    return true;
  };
}

// ── resolveStartIteration default: shells `pipeline plan --json` (06.5) ─────

export interface CliPlanResolverOptions {
  /** The async subprocess seam — the SAME one the checkout/drive use. */
  exec: JobExec;
  /** The `pipeline` CLI binary (defaults to `pipeline`, like drive). */
  pipelineBin?: string;
  logger?: Logger;
}

/** The entry step's `steps/`-relative path from `pipeline plan --json`
 *  stdout (`plan.steps[0].rel` — the SAME field `pipeline next`'s own init
 *  and `pipeline-ui`'s launcher use as a run's entry point). Null when the
 *  output carries no usable entry (unparseable JSON, no `steps` array, or an
 *  empty plan). */
function parsePlanEntryRel(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const steps = (parsed as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const first: unknown = steps[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return null;
  const rel = (first as Record<string, unknown>).rel;
  return typeof rel === 'string' && rel.length > 0 ? rel : null;
}

/**
 * The default `resolveStartIteration` (06.5, closes B4: the lexically-first
 * `steps/*.md` file was used even when it wasn't the pipeline's real entry):
 * shells the SAME `pipelineBin` drive uses — `pipeline plan --root <abs>
 * --json` (`computePlan` is the single authority for step ordering, graph
 * entry, and target families) — and takes the plan's first enumerated step.
 * Output the CLI cannot be trusted to have supplied correctly (predates the
 * command, unparseable JSON, no steps) falls back to the flat lexical rule
 * (`defaultResolveStartIteration`) — start-iteration resolution is a
 * correctness concern, not a security boundary, so graceful degradation to
 * the historical behavior beats failing prep outright.
 */
export function cliStartIterationResolver(options: CliPlanResolverOptions): StartIterationResolver {
  const bin = options.pipelineBin ?? 'pipeline';
  const logger = options.logger ?? nullLogger;
  return async (pipelineRootAbs, fs) => {
    const result = await options.exec.run(bin, ['plan', '--root', pipelineRootAbs, '--json']);
    const rel = isUnsupportedCommand(result) ? null : parsePlanEntryRel(result.stdout);
    if (rel === null) {
      logger.warn(
        `pipeline plan unavailable or unusable for start-iteration resolution (exit ${result.code ?? 'none'})` +
          `${execDetail(result)} — falling back to the lexical entry rule`
      );
      return defaultResolveStartIteration(pipelineRootAbs, fs);
    }
    return `steps/${rel}`;
  };
}

/**
 * Prepare the job's isolated workspace. Throws `JobError` with an actionable
 * message on any failure (git failure detail included, never the job JWT).
 */
export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<PreparedWorkspace> {
  const { ref, exec, fs } = options;
  const git = options.gitBin ?? 'git';
  const pipelineBin = options.pipelineBin ?? 'pipeline';
  const logger = options.logger ?? nullLogger;
  const dir = join(options.root, sanitizeJobId(options.jobId));

  // Fresh per-job directory: a stale one (crashed prior attempt) is removed —
  // no cross-job (or cross-attempt) leakage. c6 (04 §lifecycle): this stale-
  // wipe applies to NON-RESUME preps only, structurally — the resume/adoption
  // paths never call prepareWorkspace at all (the recorded checkout IS the
  // resume substrate; wiping it here would destroy exactly what D1 preserves).
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
    const verify = options.verifyContentHash ?? cliContentHashVerifier({ exec, pipelineBin, logger });
    const ok = await verify(pipelineRoot, ref.content_hash);
    if (!ok) {
      // Only reachable via a directly-injected boolean verifier — the
      // default `cliContentHashVerifier` throws its own detailed JobError
      // (expected + ACTUAL hash) on mismatch instead of returning false.
      throw new JobError(
        `pipeline content hash mismatch: checkout of ${rel} @ ${ref.ref} does not match pinned ${ref.content_hash}`
      );
    }
  }

  const resolveStart = options.resolveStartIteration ?? cliStartIterationResolver({ exec, pipelineBin, logger });
  const startIteration = await resolveStart(pipelineRoot, fs);
  if (startIteration === null) {
    throw new JobError(`pipeline has no entry iteration (no steps/*.md under ${rel})`);
  }

  return { dir, pipelineRoot, startIteration };
}
