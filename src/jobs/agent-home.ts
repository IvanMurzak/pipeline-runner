/**
 * agent-home.ts — THE PER-RUN AGENT HOME (f4,
 * `.taskflow/2026-08-03-execution-modes/` 01-modes.md E13).
 *
 * f1 pinned the executor and the org's provider key. `settingSources:
 * ["project"]` — when the CLI eventually exposes it — closes `user` and `local`
 * scope. **Neither closes the two inputs that are read REGARDLESS of
 * `settingSources`:**
 *
 *   - the global `~/.claude.json`
 *   - auto memory, at `~/.claude/projects/<encoded-project>/memory/`
 *
 * Upstream is explicit that this is the caller's problem: *"Do not rely on
 * default `query()` options for multi-tenant isolation."*
 *
 * ── THE FAILURE THIS EXISTS TO PREVENT ────────────────────────────────────
 *
 * "One org's accumulated memory loads into another org's run." On a fresh
 * per-run container both inputs are empty, which is what makes today
 * survivable — and that premise is a DEPLOYMENT property, not a code one. At
 * fleet width machines get pooled (E13), and the moment two tenants' runs share
 * a machine's `$HOME`, tenant A's memory and tenant A's global config are read
 * into tenant B's run. Every symptom is invisible: the run succeeds, the
 * records are well-formed, the output is merely… informed by somebody else's
 * project.
 *
 * So this module's guarantee is not "the operator will provision fresh
 * containers". It is that the drive child's `$HOME` is DETERMINED HERE, per
 * run, and that a run whose home cannot be provisioned does not start.
 *
 * ── FRESH, NOT WIPED-AFTERWARDS — AND KEYED BY THE RUN ────────────────────
 *
 * The spec allows either "wipe between runs" or "a fresh home per run". This
 * module does **fresh per run**, because a wipe-afterwards is only as good as
 * the cleanup that performs it: a daemon killed between two tenants leaves the
 * previous tenant's home in place, and the NEXT tenant is the one who would
 * have had to clean it. A fresh path means the next tenant never reads the
 * previous tenant's directory *at all*, so isolation does not depend on
 * teardown succeeding. Teardown still happens ({@link disposeAgentHome}) — it
 * just is not what the guarantee rests on.
 *
 * The key is the **run id, not the job id**, and that is deliberate:
 *
 *   - a run belongs to exactly one tenant, so run-keying is exactly the
 *     isolation boundary — no two tenants can ever resolve to one directory;
 *   - c6's ADOPTION path changes the `job_id` while keeping the `run_id`
 *     (`manager.ts#adoptOrReplace`). Job-keying would hand an adopted run a
 *     brand-new empty home and destroy the very substrate it resumes from.
 *
 * A FRESH START still wipes ({@link ProvisionAgentHomeOptions.fresh}), exactly
 * mirroring `prepareWorkspace`'s stale-checkout rule: a re-`--start` of a run
 * is a new beginning, a `--resume` is not.
 *
 * ── WHAT THE OVERLAY SETS, AND WHY EACH ONE ───────────────────────────────
 *
 *   `HOME`                             POSIX `~` — where `.claude.json` and
 *                                      `.claude/projects/**` resolve
 *   `USERPROFILE`                      the same thing on Windows (`os.homedir()`
 *                                      reads it there, `HOME` here)
 *   `CLAUDE_CONFIG_DIR`                the documented lever. Belt AND braces: if
 *                                      the global config lives at `~/.claude.json`
 *                                      the fresh `HOME` closes it; if it lives at
 *                                      `<config dir>/.claude.json` this closes it.
 *                                      One of the two is redundant on any given
 *                                      version — which one is not ours to know.
 *   `CLAUDE_CODE_DISABLE_AUTO_MEMORY`  `1`, UNCONDITIONALLY. At one runner it is
 *                                      moot; under pooling it is mandatory, and
 *                                      setting it always costs nothing and
 *                                      removes the question.
 *
 * All four are applied LAST over any caller base, and are not overridable —
 * same discipline as `standalone.ts`'s two provider-key entries, and for the
 * same reason: a caller quietly re-adding `HOME` (or `…DISABLE_AUTO_MEMORY=0`)
 * is the bug this module exists to make impossible.
 *
 * ── WHAT THIS DOES **NOT** DO ─────────────────────────────────────────────
 *
 * This is filesystem isolation, not a sandbox. `docs/hosted-standalone.md` §3
 * records that hosted jobs run directly on the host as the runner's own OS
 * user, and f4 does not change that: a repository hook can still read any
 * absolute path this user can read. What f4 removes is the *ambient* path —
 * `~` no longer resolves anywhere a previous tenant wrote.
 *
 * Nor does it touch SERVER-MANAGED settings, which arrive over the network when
 * the process authenticates with an organisation credential. Those are fetched,
 * not read off this disk, so no filesystem isolation removes them. That is
 * expected and correct — see `docs/runner-pooling-isolation.md` §5.
 */

import { join } from 'node:path';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import { JobError, type JobFs } from './types';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Per-run homes live under `<workspaceRoot>/<this>` by default. Dot-prefixed
 *  so it reads as infrastructure beside the job checkouts, never as one. */
export const AGENT_HOMES_DIR_NAME = '.agent-homes';

/** POSIX home. */
export const HOME_ENV = 'HOME';
/** Windows home — what `os.homedir()` reads there. */
export const USERPROFILE_ENV = 'USERPROFILE';

/**
 * ⚠ CROSS-REPOSITORY CONSTANTS. These three names are owned by Claude Code /
 * the Agent SDK, not by this package, so a rename upstream is silent here — and
 * the failure mode is that we stop closing the input while still believing we
 * do. `agent-home.test.ts` pins all three, exactly as `standalone.test.ts` pins
 * the provider-key ladder's variable names.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const DISABLE_AUTO_MEMORY_ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
export const DISABLE_AUTO_MEMORY_VALUE = '1';

/** The config directory's name under a home (`~/.claude`). */
export const CLAUDE_CONFIG_DIR_NAME = '.claude';

/** The global config file every tenant must get its own (empty) copy of. */
export const CLAUDE_GLOBAL_CONFIG_FILE = '.claude.json';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The default per-run home ROOT for a runner whose checkouts live under
 *  `workspaceRoot`. One tree, disposed the same way the checkouts are. */
export function agentHomesRootFor(workspaceRoot: string): string {
  return join(workspaceRoot, AGENT_HOMES_DIR_NAME);
}

/** Filesystem-safe form of a run id. The SAME rule `sanitizeJobId`
 *  (`workspace.ts`) applies to job ids, restated so a failure names the
 *  identifier that actually failed. */
export function sanitizeRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '-');
  if (safe.replace(/[.-]/g, '').length === 0) throw new JobError(`run id unusable as a directory name: ${runId}`);
  return safe;
}

/** This run's isolated home directory: `<root>/<sanitized-run-id>`. Pure. */
export function agentHomeFor(root: string, runId: string): string {
  return join(root, sanitizeRunId(runId));
}

/** Normalized for containment comparison (Windows separators + case). */
function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** True when `a` and `b` are the same path, or one contains the other. */
function pathsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface ProvisionAgentHomeOptions {
  /** THE key (see the header: never the job id). */
  runId: string;
  /** The per-run home root — `agentHomesRootFor(workspaceRoot)` by default. */
  root: string;
  /** The job's checkout, for the overlap guard below. */
  checkoutDir: string;
  /**
   * True on a fresh `--start`, false on a resume/adoption re-entry.
   *
   * A fresh start WIPES any directory already at this path — the same rule
   * `prepareWorkspace` applies to a stale checkout. A resume must NOT, because
   * this directory holds `.claude/projects/**` transcripts, which are precisely
   * the substrate c6's reconcile refuses to resume without.
   */
  fresh: boolean;
  fs: JobFs;
  logger?: Logger;
}

/**
 * Create this run's isolated home and return its absolute path. Throws
 * `JobError` when it cannot be created — callers FAIL THE JOB rather than
 * spawning into the machine's own home, which is the whole point.
 */
export function provisionAgentHome(options: ProvisionAgentHomeOptions): string {
  const { fs, root, checkoutDir } = options;
  const logger = options.logger ?? nullLogger;
  const dir = agentHomeFor(root, options.runId);

  // The home and the checkout must be disjoint trees. They are by construction
  // (`<workspaceRoot>/.agent-homes/<run>` vs `<workspaceRoot>/<job>`) — unless a
  // job id sanitizes to exactly `.agent-homes`, in which case the checkout IS
  // the homes root. Refusing costs one comparison; the alternative is a wipe
  // inside a tenant's own checkout.
  if (pathsOverlap(dir, checkoutDir)) {
    throw new JobError(
      `isolated agent home ${dir} overlaps the job checkout ${checkoutDir} — refusing to provision`
    );
  }

  try {
    fs.mkdirp(root);
    if (options.fresh && fs.exists(dir)) {
      logger.info(`removing stale agent home at ${dir}`);
      fs.removeDir(dir);
    }
    fs.mkdirp(dir);
    // Create the config dir explicitly so `CLAUDE_CONFIG_DIR` names a real,
    // EMPTY directory from the first instant of the run rather than whatever a
    // child would otherwise make of a missing path.
    fs.mkdirp(join(dir, CLAUDE_CONFIG_DIR_NAME));
  } catch (err) {
    throw new JobError(
      `isolated agent home could not be provisioned at ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return dir;
}

/**
 * Remove a run's home. Best-effort — a failure here is logged, never thrown:
 * the next tenant's isolation does not depend on it (that is what run-keyed
 * fresh paths buy), so a locked file must not fail an otherwise-finished job.
 *
 * NOT subject to `PIPELINE_RUNNER_KEEP_WORKSPACES` / the retention window.
 * Retention keeps a CHECKOUT so an operator can debug a run; a tenant's
 * accumulated agent state is not debugging material, and "keep everything" must
 * not quietly become "keep one tenant's memory next to another tenant's run".
 */
export function disposeAgentHome(homeDir: string, fs: JobFs, logger: Logger = nullLogger): void {
  try {
    fs.removeDir(homeDir);
    logger.info(`agent home ${homeDir} removed`);
  } catch (err) {
    logger.warn(`agent home teardown failed for ${homeDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

/**
 * The environment OVERLAY entries that point a drive child at `homeDir` and
 * turn auto memory off.
 *
 * `base` lets a caller's own overlay ride along; the four entries are applied
 * LAST and are not overridable — see the header. Compose with f1's:
 *
 * ```ts
 * hostedDriveEnv(credential, agentHomeEnv(home, options.env))
 * ```
 *
 * which yields `caller < agent home < provider key`, each layer owning its own
 * entries and none able to re-open a layer below it.
 */
export function agentHomeEnv(
  homeDir: string,
  base?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...base,
    [HOME_ENV]: homeDir,
    [USERPROFILE_ENV]: homeDir,
    [CLAUDE_CONFIG_DIR_ENV]: join(homeDir, CLAUDE_CONFIG_DIR_NAME),
    [DISABLE_AUTO_MEMORY_ENV]: DISABLE_AUTO_MEMORY_VALUE,
  };
}
