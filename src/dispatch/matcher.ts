/**
 * Task-dispatch pipeline resolution (T2-05) — the runner half of the task
 * queue. A task lease (`pipeline_ref.pipeline === '@task'` + a `task`
 * payload) names WHAT to do, not WHICH pipeline: after the normal workspace
 * checkout the runner resolves the pipeline by matching the task text
 * (`title` + `"\n"` + `body`, labels appended as hint terms) against the
 * checked-out project's LOCAL pipeline manifests — manifests never reach the
 * cloud, so the match MUST happen here.
 *
 * The BM25 scoring itself is NOT implemented in this package — it is REUSED
 * via the `pipeline match` CLI subprocess (`pipeline-cli
 * src/commands/match.ts`, engine: `pipeline-cli src/lib/match.ts` — the same
 * deterministic Okapi-BM25 + Scope.Out hard-filter matcher behind
 * `/pipeline:dispatch` tier 1). The CLI is installed alongside the agent on a
 * runner (the very binary the executor already shells out to for `pipeline
 * drive`), and the spawn goes through the SAME injectable `JobExec` seam, so
 * tests script the match result and never spawn a real process.
 *
 * Import-inert: importing this module (and constructing a resolver) spawns
 * nothing and touches no filesystem.
 */

import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import { JobError, type JobExec, type JobExecResult } from '../jobs/types';
import type { LeaseTask } from '../jobs/wire';

/** Everything a resolver needs to pick a task lease's pipeline. */
export interface TaskDispatchInput {
  /** The job's isolated checkout directory (the prepared workspace `dir`). */
  checkoutDir: string;
  /** The lease's task payload (title/body/labels — the match input). */
  task: LeaseTask;
}

/** A resolved task-dispatch pipeline (the matcher's winner). */
export interface TaskPipelineResolution {
  /** The resolved pipeline identity for the executor to drive: a
   *  checkout-relative path (forward slashes, e.g.
   *  `.claude/pipeline/release`) that `pipelineRootRel` resolves verbatim. */
  pipeline: string;
  /** The winning manifest's path exactly as the matcher reported it. */
  manifest: string;
  /** The winner's BM25 score (matcher-rounded). */
  score: number;
}

/**
 * The pipeline-resolution seam (injectable on `JobExecutor`/`JobManager`).
 * Resolves a task lease's pipeline from the checked-out project; throws
 * `JobError` with an actionable reason when NO pipeline matches or the
 * matcher itself fails — the executor reports the run FAILED through the
 * existing run_status/events path (never drives an arbitrary pipeline).
 */
export type TaskPipelineResolver = (input: TaskDispatchInput) => Promise<TaskPipelineResolution>;

/** The conventional pipelines tree the matcher scans, checkout-relative. */
export const PIPELINES_DIR_REL = '.claude/pipeline';

/**
 * The BM25 query for a task: `title + "\n" + body` (the protocol contract),
 * with `labels` appended as one trailing line of hint terms when present —
 * the protocol declares task labels "routing/BM25 hints", and extra query
 * terms are exactly how BM25 consumes hints (absent from every manifest they
 * score zero and change nothing).
 */
export function buildTaskQuery(task: LeaseTask): string {
  const text = `${task.title}\n${task.body}`.trim();
  return task.labels.length > 0 ? `${text}\n${task.labels.join(' ')}` : text;
}

/** The exact `pipeline` argv for one dispatch match (top-1 = the winner). */
export function buildMatchArgs(pipelinesDir: string, query: string): string[] {
  return ['match', '--pipelines-dir', pipelinesDir, '--task', query, '--top', '1'];
}

/**
 * The winning manifest's pipeline identity: its directory relative to the
 * checkout, forward slashes (contains `/`, so the workspace's
 * `pipelineRootRel` takes it verbatim — nested pipelines resolve correctly,
 * unlike the bare candidate `name`).
 */
export function pipelinePathFromManifest(checkoutDir: string, manifestPath: string): string {
  const rel = relative(checkoutDir, dirname(manifestPath)).replace(/\\/g, '/');
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new JobError(`matched manifest is outside the job checkout: ${manifestPath}`);
  }
  return rel;
}

/** The slice of a `pipeline match` candidate the resolver consumes. */
interface MatchCandidate {
  name: string;
  manifest: string;
  score: number;
}

/** Parse `pipeline match` stdout into its candidates; null ⇒ malformed. */
function parseCandidates(stdout: string): MatchCandidate[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const list = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(list)) return null;
  const out: MatchCandidate[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.manifest !== 'string') return null;
    out.push({
      name: record.name,
      manifest: record.manifest,
      score: typeof record.score === 'number' ? record.score : 0,
    });
  }
  return out;
}

/** First line of stderr/stdout, trimmed and capped — for JobError messages. */
function execDetail(result: JobExecResult): string {
  const text = (result.stderr || result.stdout || result.error || '').trim().split('\n')[0] ?? '';
  const capped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  return capped.length > 0 ? `: ${capped}` : '';
}

function noMatchReason(task: LeaseTask, detail: string): string {
  return `task dispatch found no matching pipeline for task ${task.task_id} (${detail})`;
}

export interface CliMatcherOptions {
  /** The async subprocess seam — the SAME one the executor drives with, so a
   *  test's FakeJobExec scripts the match result too. */
  exec: JobExec;
  /** The `pipeline` CLI binary (defaults to `pipeline`, like drive). */
  pipelineBin?: string;
  /** Pipelines tree relative to the checkout (default `.claude/pipeline`). */
  pipelinesDirRel?: string;
  logger?: Logger;
}

/**
 * The default resolver: shell out to `pipeline match` (deterministic, LLM-free
 * BM25 — see the module header) and take the top candidate. Failure modes:
 *   - no `.claude/pipeline` dir (match exit 1)   → JobError, no-match
 *   - zero candidates (empty project / no score) → JobError, no-match
 *   - any other exit / unparseable output        → JobError with the detail
 */
export function cliTaskPipelineResolver(options: CliMatcherOptions): TaskPipelineResolver {
  const bin = options.pipelineBin ?? 'pipeline';
  const dirRel = options.pipelinesDirRel ?? PIPELINES_DIR_REL;
  const logger = options.logger ?? nullLogger;
  return async ({ checkoutDir, task }) => {
    const pipelinesDir = join(checkoutDir, ...dirRel.split('/'));
    const result = await options.exec.run(bin, buildMatchArgs(pipelinesDir, buildTaskQuery(task)), {
      cwd: checkoutDir,
    });
    if (result.code !== 0) {
      // Exit 1 with the CLI's dir-missing message = the project simply has no
      // pipelines — the same terminal condition as zero candidates.
      if (result.code === 1 && /pipelines-dir does not exist/i.test(result.stderr)) {
        throw new JobError(noMatchReason(task, `no ${dirRel} directory in the checkout`));
      }
      throw new JobError(`pipeline match failed (exit ${result.code ?? 'none'})${execDetail(result)}`);
    }
    const candidates = parseCandidates(result.stdout);
    if (candidates === null) {
      throw new JobError(`pipeline match returned unparseable output${execDetail(result)}`);
    }
    if (candidates.length === 0) {
      throw new JobError(noMatchReason(task, 'no manifest scored above zero'));
    }
    // candidates[0] IS the deterministic winner: the CLI sorts by descending
    // BM25 score, ties broken by ascending name (codepoint order).
    const winner = candidates[0];
    const pipeline = pipelinePathFromManifest(checkoutDir, winner.manifest);
    logger.info(`task ${task.task_id}: dispatch matched pipeline '${pipeline}' (score ${winner.score})`);
    return { pipeline, manifest: winner.manifest, score: winner.score };
  };
}
