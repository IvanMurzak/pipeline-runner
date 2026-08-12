/**
 * f4 — the per-run isolated agent home: the overlay, the lifecycle, and the
 * executor's use of both.
 *
 * These are the UNIT assertions. The deliverable — two tenants on one machine,
 * real directories, real child processes, and the proof that nothing crosses in
 * either direction — is `tests/pooling-isolation.test.ts`, because an
 * environment-variable assertion is not an isolation assertion. This file
 * exists so that a regression in the mechanism is caught precisely, not so that
 * it can stand in for the guarantee.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import {
  AbortableHangExec,
  DRIVE_COMPLETED,
  driveAwaiting,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
} from './_helpers';
import { JobError, type JobExecResult } from './types';
import { JobExecutor, type JobExecutorOptions } from './executor';
import { defaultResolveStartIteration } from './workspace';
import { HostedProviderCredential, PROVIDER_KEY_ENV, type ProviderCredentialSource } from './standalone';
import {
  AGENT_HOMES_DIR_NAME,
  agentHomeEnv,
  agentHomeFor,
  agentHomesRootFor,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CONFIG_DIR_NAME,
  disposeAgentHome,
  DISABLE_AUTO_MEMORY_ENV,
  DISABLE_AUTO_MEMORY_VALUE,
  HOME_ENV,
  provisionAgentHome,
  sanitizeRunId,
  USERPROFILE_ENV,
} from './agent-home';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.pipeline', 'release');
const HOMES = agentHomesRootFor(ROOT);

/** SYNTHETIC placeholder. Never a real credential (this task's standing rule). */
const ORG_KEY = 'sk-ant-ORG-synthetic-0000000000';

const orgSource: ProviderCredentialSource = () => new HostedProviderCredential('deliver', ORG_KEY);

function readyFs(): FakeJobFs {
  const fs = new FakeJobFs();
  fs.existing.add(PIPELINE_ROOT);
  fs.listings.set(join(PIPELINE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);
  return fs;
}

function driveExec(queue: JobExecResult[]): FakeJobExec {
  return new FakeJobExec((cmd) => {
    if (cmd === 'git') return GIT_OK;
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
}

function makeWorld(queue: JobExecResult[], overrides: Partial<JobExecutorOptions> = {}) {
  const exec = overrides.exec !== undefined ? (overrides.exec as FakeJobExec) : driveExec(queue);
  const fs = (overrides.fs as FakeJobFs) ?? readyFs();
  const sink = new FrameSink();
  const logger = new CaptureLogger();
  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    clock: new FakeClock(),
    logger,
    makeId: () => 'q-1',
    resolveStartIteration: defaultResolveStartIteration,
    ...overrides,
    fs,
    exec,
  });
  return { executor, exec, fs, sink, logger };
}

// ---------------------------------------------------------------------------
// THE OVERLAY
// ---------------------------------------------------------------------------

describe('f4 — agentHomeEnv', () => {
  test('points every home-derived read at this run, and turns auto memory off', () => {
    const env = agentHomeEnv('/homes/run-1');
    expect(env[HOME_ENV]).toBe('/homes/run-1');
    expect(env[USERPROFILE_ENV]).toBe('/homes/run-1');
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(join('/homes/run-1', CLAUDE_CONFIG_DIR_NAME));
    expect(env[DISABLE_AUTO_MEMORY_ENV]).toBe(DISABLE_AUTO_MEMORY_VALUE);
  });

  test('a caller base rides along but cannot re-open ANY of the four', () => {
    // Each of these is a machine value that must lose. The last one is the
    // sharpest: an operator who disabled the disable would silently re-arm
    // cross-tenant memory on every hosted run.
    const env = agentHomeEnv('/homes/run-1', {
      PP_THING: 'kept',
      [HOME_ENV]: '/home/pooled',
      [USERPROFILE_ENV]: 'C:\\Users\\pooled',
      [CLAUDE_CONFIG_DIR_ENV]: '/shared/claude',
      [DISABLE_AUTO_MEMORY_ENV]: '0',
    });
    expect(env.PP_THING).toBe('kept');
    expect(env[HOME_ENV]).toBe('/homes/run-1');
    expect(env[USERPROFILE_ENV]).toBe('/homes/run-1');
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(join('/homes/run-1', CLAUDE_CONFIG_DIR_NAME));
    expect(env[DISABLE_AUTO_MEMORY_ENV]).toBe(DISABLE_AUTO_MEMORY_VALUE);
  });
});

// ---------------------------------------------------------------------------
// THE KEY IS THE RUN
// ---------------------------------------------------------------------------

describe('f4 — one home per RUN', () => {
  test('different runs never resolve to one directory; the same run always does', () => {
    expect(agentHomeFor(HOMES, 'run-a')).not.toBe(agentHomeFor(HOMES, 'run-b'));
    // Stability is the c6-adoption property: the job_id changes, the run_id
    // does not, and the resumed run must find its own transcripts.
    expect(agentHomeFor(HOMES, 'run-a')).toBe(agentHomeFor(HOMES, 'run-a'));
  });

  test('a run id is made filesystem-safe, and an unusable one is refused', () => {
    // Separators are replaced, so a traversal-shaped id collapses into ONE
    // segment and can never climb out of the homes root.
    expect(sanitizeRunId('run/../../etc')).toBe('run-..-..-etc');
    expect(agentHomeFor(HOMES, 'run/../../etc')).toBe(join(HOMES, 'run-..-..-etc'));
    expect(() => sanitizeRunId('///')).toThrow(JobError);
  });

  test('the default root sits beside the checkouts, not inside one', () => {
    expect(agentHomesRootFor('/w')).toBe(join('/w', AGENT_HOMES_DIR_NAME));
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------------

describe('f4 — provisionAgentHome', () => {
  const base = { root: HOMES, checkoutDir: DIR, runId: 'run-1' };

  test('creates the home AND its config dir, so CLAUDE_CONFIG_DIR names a real empty dir', () => {
    const fs = new FakeJobFs();
    const dir = provisionAgentHome({ ...base, fresh: true, fs });
    expect(dir).toBe(join(HOMES, 'run-1'));
    expect(fs.exists(dir)).toBe(true);
    expect(fs.exists(join(dir, CLAUDE_CONFIG_DIR_NAME))).toBe(true);
  });

  test('a FRESH start wipes a stale home (the prepareWorkspace rule)', () => {
    const fs = new FakeJobFs();
    fs.existing.add(join(HOMES, 'run-1'));
    provisionAgentHome({ ...base, fresh: true, fs });
    expect(fs.removed).toContain(join(HOMES, 'run-1'));
  });

  test('a RESUME does NOT wipe — that directory is the transcripts a resume needs', () => {
    const fs = new FakeJobFs();
    fs.existing.add(join(HOMES, 'run-1'));
    provisionAgentHome({ ...base, fresh: false, fs });
    expect(fs.removed).not.toContain(join(HOMES, 'run-1'));
  });

  test('REFUSES a home that overlaps the checkout rather than wiping inside it', () => {
    const fs = new FakeJobFs();
    // The only way to reach this: a job id that sanitizes to `.agent-homes`,
    // making the checkout dir the homes root itself.
    expect(() =>
      provisionAgentHome({ ...base, checkoutDir: join(ROOT, AGENT_HOMES_DIR_NAME), fresh: true, fs })
    ).toThrow(JobError);
  });

  test('a filesystem failure is a JobError, never a silent fall-through', () => {
    const fs = new FakeJobFs();
    fs.mkdirp = () => {
      throw new Error('EACCES');
    };
    expect(() => provisionAgentHome({ ...base, fresh: true, fs })).toThrow(JobError);
  });

  test('disposal is best-effort: a locked directory warns, never throws', () => {
    const fs = new FakeJobFs();
    fs.removeDir = () => {
      throw new Error('EBUSY');
    };
    const logger = new CaptureLogger();
    expect(() => disposeAgentHome(join(HOMES, 'run-1'), fs, logger)).not.toThrow();
    expect(logger.joined()).toContain('teardown failed');
  });
});

// ---------------------------------------------------------------------------
// THROUGH THE EXECUTOR
// ---------------------------------------------------------------------------

describe('f4 — a hosted run drives with an isolated home', () => {
  test('the drive child is pointed at this run’s home, with auto memory off', async () => {
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], {
      // The pooled machine's own environment, carrying a shared home.
      env: { [HOME_ENV]: '/home/pooled', [CLAUDE_CONFIG_DIR_ENV]: '/shared/claude' },
      hostedStandalone: { credential: orgSource },
    });
    await executor.start();

    const home = join(HOMES, 'run-1');
    const env = exec.of('pipeline')[0]!.opts.env!;
    expect(env[HOME_ENV]).toBe(home);
    expect(env[USERPROFILE_ENV]).toBe(home);
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(join(home, CLAUDE_CONFIG_DIR_NAME));
    expect(env[DISABLE_AUTO_MEMORY_ENV]).toBe(DISABLE_AUTO_MEMORY_VALUE);
    // f1's entries are still applied last over ours — the layers compose.
    expect(env[PROVIDER_KEY_ENV]).toBe(ORG_KEY);
  });

  test('EVERY re-entry keeps the same home — a resume must not decay to the machine’s', async () => {
    const { executor, exec } = makeWorld([driveAwaiting(), DRIVE_COMPLETED], {
      hostedStandalone: { credential: orgSource },
      needsInput: { onQuestion: () => 'use host-a' },
    });
    await executor.start();

    const drives = exec.of('pipeline');
    expect(drives).toHaveLength(2);
    for (const call of drives) expect(call.opts.env![HOME_ENV]).toBe(join(HOMES, 'run-1'));
  });

  test('the home is REMOVED when the job ends — nothing of this tenant is left behind', async () => {
    const { executor, fs } = makeWorld([DRIVE_COMPLETED], { hostedStandalone: { credential: orgSource } });
    await executor.start();
    expect(fs.removed).toContain(join(HOMES, 'run-1'));
    expect(fs.exists(join(HOMES, 'run-1'))).toBe(false);
  });

  test('a HALTED job removes it too (the finally covers every exit)', async () => {
    const halted: JobExecResult = { code: 1, stdout: JSON.stringify({ status: 'halted', reason: 'nope' }), stderr: '' };
    const { executor, fs } = makeWorld([halted], { hostedStandalone: { credential: orgSource } });
    await executor.start();
    expect(fs.removed).toContain(join(HOMES, 'run-1'));
  });

  test('a SUSPENDED job KEEPS it — the record stays, and so must its substrate', async () => {
    // Graceful shutdown leaves the record intact for the next boot's reconcile,
    // and `~/.claude/projects/**` is what that reconcile validates against.
    // Wiping here would turn every redeploy into an unrecoverable run.
    const exec = new AbortableHangExec();
    const { executor, fs } = makeWorld([], {
      exec: exec as unknown as FakeJobExec,
      hostedStandalone: { credential: orgSource },
    });
    const done = executor.start();
    await tick();
    executor.suspend();
    await done;
    expect(fs.removed).not.toContain(join(HOMES, 'run-1'));
    expect(fs.exists(join(HOMES, 'run-1'))).toBe(true);
  });

  test('a CANCELLED job removes it (the server disposed of the run)', async () => {
    const exec = new AbortableHangExec();
    const { executor, fs } = makeWorld([], {
      exec: exec as unknown as FakeJobExec,
      hostedStandalone: { credential: orgSource },
    });
    const done = executor.start();
    await tick();
    executor.cancel();
    await done;
    expect(fs.removed).toContain(join(HOMES, 'run-1'));
  });

  test('FAIL CLOSED: a home that cannot be provisioned means no drive process at all', async () => {
    const fs = readyFs();
    const realMkdirp = fs.mkdirp.bind(fs);
    fs.mkdirp = (path: string) => {
      if (path.includes(AGENT_HOMES_DIR_NAME)) throw new Error('EACCES');
      realMkdirp(path);
    };
    const { executor, exec, sink } = makeWorld([], { fs, hostedStandalone: { credential: orgSource } });
    const result = await executor.start();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('isolated agent home could not be provisioned');
    // The whole point: it did not spawn into the pooled machine's own home.
    expect(exec.of('pipeline')).toHaveLength(0);
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'halted']);
  });

  test('an explicit agentHomeRoot is honoured (a fleet may put homes on faster storage)', async () => {
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], {
      agentHomeRoot: join('/fast', 'homes'),
      hostedStandalone: { credential: orgSource },
    });
    await executor.start();
    expect(exec.of('pipeline')[0]!.opts.env![HOME_ENV]).toBe(join('/fast', 'homes', 'run-1'));
  });
});

describe('f4 — a NON-hosted runner is completely unchanged', () => {
  test('no home overlay, no provisioning, no teardown', async () => {
    // A local runner runs on the USER's machine: that home is theirs, holds
    // their own configuration, and there is exactly one tenant. Relocating it
    // would break their setup to solve a problem they do not have.
    const { executor, exec, fs } = makeWorld([DRIVE_COMPLETED]); // no hostedStandalone
    await executor.start();

    expect(exec.of('pipeline')[0]!.opts.env).toBeUndefined();
    expect(fs.made.some((path) => path.includes(AGENT_HOMES_DIR_NAME))).toBe(false);
    expect(fs.removed.some((path) => path.includes(AGENT_HOMES_DIR_NAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CROSS-REPOSITORY DRIFT TRIPWIRES
// ---------------------------------------------------------------------------

describe('f4 — constants owned by Claude Code, mirrored here', () => {
  test('the isolation levers are pinned by name and value', () => {
    // A rename upstream is silent here, and the failure is that we stop closing
    // the input while still believing we do — the same argument f1 makes for
    // the provider-key ladder's variable names.
    expect(CLAUDE_CONFIG_DIR_ENV).toBe('CLAUDE_CONFIG_DIR');
    expect(DISABLE_AUTO_MEMORY_ENV).toBe('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(DISABLE_AUTO_MEMORY_VALUE).toBe('1');
    expect(CLAUDE_CONFIG_DIR_NAME).toBe('.claude');
  });
});
