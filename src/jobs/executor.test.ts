import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import {
  AbortableHangExec,
  DRIVE_COMPLETED,
  DRIVE_HALTED,
  DRIVE_PROVIDER_LIMIT,
  driveAwaiting,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
  makeRecord,
} from './_helpers';
import type { JobRecord } from './job-store';
import { JobError, type JobExecResult } from './types';
import {
  DEFAULT_PROVIDER_LIMIT_PAUSE_MS,
  defaultProviderLimitPauseMs,
  JobExecutor,
  type JobExecutorOptions,
  type JobResult,
  type JobState,
  type ParkedQuestion,
} from './executor';
import { defaultResolveStartIteration } from './workspace';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.claude', 'pipeline', 'release');

/** An fs pre-seeded so the fixture lease's workspace prep succeeds. */
function readyFs(): FakeJobFs {
  const fs = new FakeJobFs();
  fs.existing.add(PIPELINE_ROOT);
  fs.listings.set(join(PIPELINE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);
  return fs;
}

/** Exec fake: git always succeeds; drive results come from the queue. */
function driveExec(queue: JobExecResult[]): FakeJobExec {
  return new FakeJobExec((cmd) => {
    if (cmd === 'git') return GIT_OK;
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
}

interface World {
  executor: JobExecutor;
  exec: FakeJobExec;
  sink: FrameSink;
  clock: FakeClock;
  logger: CaptureLogger;
  states: JobState[];
}

function makeWorld(queue: JobExecResult[], overrides: Partial<JobExecutorOptions> = {}): World {
  // Any injected exec wins (FakeJobExec or the c6 AbortableHangExec — both
  // expose `calls`/`of()`); absent, the shift-queue drive fake applies.
  const exec = overrides.exec !== undefined ? (overrides.exec as FakeJobExec) : driveExec(queue);
  const sink = new FrameSink();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const states: JobState[] = [];
  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    fs: readyFs(),
    clock,
    logger,
    makeId: () => 'q-1',
    // c4: pin the PLAIN LEXICAL resolver by default so this suite's `pipeline`
    // exec assertions (drive-only, via `driveExec`'s shift-queue) are
    // unaffected by the new plan-shelling default — the c4 wiring itself is
    // covered by workspace.test.ts (prepareWorkspace's true default) and the
    // dedicated "default seams reach prepareWorkspace" test below.
    resolveStartIteration: defaultResolveStartIteration,
    ...overrides,
    exec,
    events: { onStateChange: (s) => states.push(s), ...overrides.events },
  });
  return { executor, exec, sink, clock, logger, states };
}

describe('JobExecutor — happy path', () => {
  test('prep → drive → run_status started/completed, result ok', async () => {
    const world = makeWorld([DRIVE_COMPLETED]);
    const result = await world.executor.start();

    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
    expect(world.states).toEqual(['preparing', 'running', 'completed']);
    expect(world.sink.frames).toEqual([
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'started' },
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'completed', outcome: 'completed' },
    ]);

    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
    expect(drive[0]!.opts.cwd).toBe(DIR);
  });

  test('onWorkspaceReady exposes the shipper composition context (incl. job_jwt)', async () => {
    const contexts: unknown[] = [];
    const world = makeWorld([DRIVE_COMPLETED], {
      events: { onWorkspaceReady: (ctx) => contexts.push(ctx) },
    });
    await world.executor.start();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({
      dir: DIR,
      pipelineRoot: PIPELINE_ROOT,
      startIteration: 'steps/01-plan.md',
      job_id: 'job-1',
      run_id: 'run-1',
      job_jwt: 'jwt-secret-1',
      secret_slugs: ['DEPLOY_KEY'],
    });
  });

  test('custom pipeline binary and extra env reach the drive spawn', async () => {
    const world = makeWorld([], {
      exec: new FakeJobExec((cmd) => (cmd === 'git' ? GIT_OK : DRIVE_COMPLETED)),
      pipelineBin: 'bunx-pipeline',
      env: { PIPELINE_STATS_RUNNER: 'headless' },
    });
    await world.executor.start();
    const drive = world.exec.of('bunx-pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.opts.env).toEqual({ PIPELINE_STATS_RUNNER: 'headless' });
  });

  test('the job JWT never appears in any log line', async () => {
    const world = makeWorld([DRIVE_COMPLETED]);
    await world.executor.start();
    expect(world.logger.joined()).not.toContain('jwt-secret-1');
  });
});

// c4 (06.4/06.5): when the verifyContentHash / resolveStartIteration seams
// are NOT overridden, prep must shell `pipeline hash` / `pipeline plan`
// through the SAME `pipelineBin` drive uses — previously the executor never
// threaded `this.pipelineBin` into `prepareWorkspace` at all, so this proves
// that wire (not just workspace.ts's own default construction, covered in
// workspace.test.ts) actually reaches the executor layer.
describe('JobExecutor — c4 default hash/plan seams reach prepareWorkspace', () => {
  test('the SAME custom pipelineBin verifies the pinned hash and resolves start-iteration via plan', async () => {
    const exec = new FakeJobExec((cmd, args) => {
      if (cmd === 'git') return GIT_OK;
      if (args[0] === 'hash') return { code: 0, stdout: JSON.stringify({ content_hash: 'sha256:abc' }), stderr: '' };
      if (args[0] === 'plan') return { code: 0, stdout: JSON.stringify({ steps: [{ rel: '01-plan.md' }] }), stderr: '' };
      return DRIVE_COMPLETED;
    });
    const lease = makeLease({ pipeline_ref: { ...makeLease().pipeline_ref, content_hash: 'sha256:abc' } });
    const world = makeWorld([], {
      exec,
      lease,
      pipelineBin: 'custom-pipeline',
      // Defeat makeWorld's baseline lexical override — exercise the TRUE
      // defaults (cliContentHashVerifier / cliStartIterationResolver).
      resolveStartIteration: undefined,
      verifyContentHash: undefined,
    });

    const result = await world.executor.start();
    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });

    const hashCall = world.exec.calls.find((c) => c.args[0] === 'hash');
    const planCall = world.exec.calls.find((c) => c.args[0] === 'plan');
    const driveCall = world.exec.calls.find((c) => c.args[0] === 'drive');
    expect(hashCall).toEqual({ cmd: 'custom-pipeline', args: ['hash', '--root', PIPELINE_ROOT, '--json'], opts: {} });
    expect(planCall).toEqual({ cmd: 'custom-pipeline', args: ['plan', '--root', PIPELINE_ROOT, '--json'], opts: {} });
    expect(driveCall?.cmd).toBe('custom-pipeline');
  });

  test('a hash mismatch on the default verifier halts prep before any drive spawn', async () => {
    const exec = new FakeJobExec((cmd, args) => {
      if (cmd === 'git') return GIT_OK;
      if (args[0] === 'hash') return { code: 0, stdout: JSON.stringify({ content_hash: 'sha256:actual' }), stderr: '' };
      return DRIVE_COMPLETED;
    });
    const lease = makeLease({ pipeline_ref: { ...makeLease().pipeline_ref, content_hash: 'sha256:expected' } });
    const world = makeWorld([], {
      exec,
      lease,
      resolveStartIteration: undefined,
      verifyContentHash: undefined,
    });

    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('content hash mismatch (expected sha256:expected, got sha256:actual)');
    }
    expect(world.exec.calls.some((c) => c.args[0] === 'drive')).toBe(false);
  });
});

describe('JobExecutor — matrix execution overrides (T3-06)', () => {
  test('a cell override threads model+effort into the drive spawn as run-level defaults', async () => {
    const world = makeWorld([DRIVE_COMPLETED], {
      lease: makeLease({ execution_overrides: { model: 'opus', effort: 'high' } }),
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(true);
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--default-model',
      'opus',
      '--default-effort',
      'high',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
  });

  test('a partial override (effort only) emits ONLY --default-effort', async () => {
    const world = makeWorld([DRIVE_COMPLETED], {
      lease: makeLease({ execution_overrides: { effort: 'max' } }),
    });
    await world.executor.start();
    const args = world.exec.of('pipeline')[0]!.args;
    expect(args).toContain('--default-effort');
    expect(args).toContain('max');
    expect(args).not.toContain('--default-model');
  });

  test('the override persists across a provider-limit auto-resume (every invocation carries it)', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      lease: makeLease({ execution_overrides: { model: 'sonnet' } }),
    });
    const done = world.executor.start();
    await tick();
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    expect((await done).ok).toBe(true);
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(2);
    // The resume (2nd) invocation still carries the cell's model.
    expect(drive[1]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--default-model',
      'sonnet',
      '--resume',
      '--json',
    ]);
  });

  test('an EMPTY execution_overrides object drives byte-identically to no override', async () => {
    const world = makeWorld([DRIVE_COMPLETED], {
      lease: makeLease({ execution_overrides: {} }),
    });
    await world.executor.start();
    expect(world.exec.of('pipeline')[0]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
  });
});

describe('JobExecutor — lease variables (env-variables d1)', () => {
  test('a lease with variables: START carries --var flags AND run_status started echoes variables_applied (names only)', async () => {
    const world = makeWorld([DRIVE_COMPLETED], {
      lease: makeLease({ variables: { PP_SERVICE: 'payments', PP_CHANNEL: '#releases' } }),
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(true);

    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--var',
      'PP_CHANNEL=#releases',
      '--var',
      'PP_SERVICE=payments',
      '--json',
    ]);

    const started = world.sink.ofType('run_status')[0] as Record<string, unknown>;
    expect(started).toEqual({
      type: 'run_status',
      run_id: 'run-1',
      job_id: 'job-1',
      phase: 'started',
      variables_applied: ['PP_CHANNEL', 'PP_SERVICE'],
    });
    // NAMES ONLY — no value ever rides the echo.
    expect(JSON.stringify(started)).not.toContain('payments');
    expect(JSON.stringify(started)).not.toContain('releases');
  });

  test('a provider-limit auto-resume does NOT repeat --var (D11: START only)', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      lease: makeLease({ variables: { PP_SERVICE: 'payments' } }),
    });
    const done = world.executor.start();
    await tick();
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    expect((await done).ok).toBe(true);

    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(2);
    expect(drive[0]!.args).toContain('--var');
    expect(drive[1]!.args).not.toContain('--var');
    expect(drive[1]!.args).toEqual(['drive', '--root', PIPELINE_ROOT, '--run-id', 'run-1', '--resume', '--json']);
  });

  test('a needs-input answer resume does NOT repeat --var (D11: START only)', async () => {
    const world = makeWorld([driveAwaiting(), DRIVE_COMPLETED], {
      lease: makeLease({ variables: { PP_SERVICE: 'payments' } }),
      needsInput: { onQuestion: () => 'host-a' },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(true);

    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(2);
    expect(drive[0]!.args).toContain('--var');
    expect(drive[1]!.args).not.toContain('--var');
    expect(drive[1]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
  });

  test('a lease WITHOUT variables drives + reports byte-identically to today (regression)', async () => {
    const world = makeWorld([DRIVE_COMPLETED]); // makeLease() default carries no `variables`
    await world.executor.start();
    expect(world.exec.of('pipeline')[0]!.args).not.toContain('--var');
    expect(world.sink.frames).toEqual([
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'started' },
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'completed', outcome: 'completed' },
    ]);
    expect('variables_applied' in (world.sink.ofType('run_status')[0] as Record<string, unknown>)).toBe(false);
  });

  test('an EMPTY lease variables map still echoes variables_applied: [] (distinguishable from absent)', async () => {
    const world = makeWorld([DRIVE_COMPLETED], { lease: makeLease({ variables: {} }) });
    await world.executor.start();
    expect(world.exec.of('pipeline')[0]!.args).not.toContain('--var');
    const started = world.sink.ofType('run_status')[0] as Record<string, unknown>;
    expect(started.variables_applied).toEqual([]);
  });

  test('variables and a matrix-cell execution override compose on the SAME start invocation', async () => {
    const world = makeWorld([DRIVE_COMPLETED], {
      lease: makeLease({ execution_overrides: { model: 'opus' }, variables: { PP_SERVICE: 'payments' } }),
    });
    await world.executor.start();
    expect(world.exec.of('pipeline')[0]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--default-model',
      'opus',
      '--start',
      'steps/01-plan.md',
      '--var',
      'PP_SERVICE=payments',
      '--json',
    ]);
  });
});

describe('JobExecutor — failure paths', () => {
  test('drive halt → run_status halted with the reason, result failed', async () => {
    const world = makeWorld([DRIVE_HALTED]);
    const result = await world.executor.start();
    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: false, reason: 'step 02 halted: tests failed' });
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'halted']);
    expect(world.sink.ofType('run_status')[1]!.halt_reason).toBe('step 02 halted: tests failed');
    expect(world.states).toEqual(['preparing', 'running', 'failed']);
  });

  test('workspace prep failure → halted report, failed result, drive never spawned', async () => {
    const exec = new FakeJobExec((cmd, args) =>
      cmd === 'git' && args.includes('fetch') ? { code: 128, stdout: '', stderr: 'fatal: repo not found' } : GIT_OK
    );
    const world = makeWorld([], { exec });
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('workspace prep failed: git fetch main failed');
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['halted']);
    expect(world.exec.of('pipeline')).toHaveLength(0);
  });

  test('an offline connection drops lifecycle frames but the job still finishes', async () => {
    const world = makeWorld([DRIVE_COMPLETED]);
    world.sink.online = false;
    const result = await world.executor.start();
    expect(result.ok).toBe(true);
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain("run_status 'started' not sent");
  });

  test('a second start() is refused without disturbing state', async () => {
    const world = makeWorld([DRIVE_COMPLETED]);
    await world.executor.start();
    const again = await world.executor.start();
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('executor already started');
    expect(world.executor.state).toBe('completed');
  });
});

describe('JobExecutor — needs-input seam', () => {
  test('a parked question (older-CLI shape, no question_id) is surfaced with an executor-minted fallback id, and the answer resumes the SAME iteration (06.2.2)', async () => {
    const parkedSeen: ParkedQuestion[] = [];
    const world = makeWorld([driveAwaiting(), DRIVE_COMPLETED], {
      needsInput: {
        onQuestion: (parked) => {
          parkedSeen.push(parked);
          return 'host-a';
        },
      },
    });
    const result = await world.executor.start();

    expect(result.ok).toBe(true);
    expect(parkedSeen).toEqual([
      {
        job_id: 'job-1',
        run_id: 'run-1',
        question_id: 'q-1', // minted (makeId stub) — driveAwaiting() carries none
        step_id: '02-deploy',
        iteration_path: 'steps/02-deploy.md',
        session_id: 'sess-1',
        question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] },
      },
    ]);
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(2);
    expect(drive[1]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
    expect(world.states).toContain('awaiting_input');
  });

  test('a parked question carrying drive-minted question_id (06.2.1, b2 contract) is passed through VERBATIM — never re-minted', async () => {
    const parkedSeen: ParkedQuestion[] = [];
    const world = makeWorld([driveAwaiting('steps/02-deploy.md', 'Which host?', 'drive-q-42'), DRIVE_COMPLETED], {
      needsInput: {
        onQuestion: (parked) => {
          parkedSeen.push(parked);
          return 'host-a';
        },
      },
    });
    const result = await world.executor.start();

    expect(result.ok).toBe(true);
    expect(parkedSeen).toHaveLength(1);
    expect(parkedSeen[0]!.question_id).toBe('drive-q-42'); // NOT 'q-1' — the makeId stub never fires
  });

  test('the DEFAULT seam auto-fails a parked question (no relay wired yet)', async () => {
    const world = makeWorld([driveAwaiting()]);
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no relay/answer is available');
    expect(world.exec.of('pipeline')).toHaveLength(1); // no resume attempted
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'halted']);
  });

  test('a throwing relay fails the job with the relay error', async () => {
    const world = makeWorld([driveAwaiting()], {
      needsInput: {
        onQuestion: () => {
          throw new Error('relay transport down');
        },
      },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('needs-input relay failed: relay transport down');
  });

  test('the per-job question limit halts a question loop', async () => {
    const world = makeWorld([driveAwaiting(), driveAwaiting()], {
      maxQuestions: 1,
      needsInput: { onQuestion: () => 'answer' },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('needs-input question limit reached (1)');
    expect(world.exec.of('pipeline')).toHaveLength(2);
  });
});

describe('JobExecutor — provider-limit pause + auto-resume', () => {
  test('a detected limit pauses (never fails), then auto-resumes with --resume', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED]);
    const done = world.executor.start();
    await tick();

    expect(world.executor.state).toBe('paused_provider_limit');
    expect(world.executor.pausedUntil).toBe(new Date(DEFAULT_PROVIDER_LIMIT_PAUSE_MS).toISOString());
    // No terminal frame while paused — the job is alive, heartbeats hold the lease.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);

    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    const result = await done;

    expect(result.ok).toBe(true);
    expect(world.executor.state).toBe('completed');
    expect(world.executor.pausedUntil).toBeNull();
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(2);
    expect(drive[1]!.args).toEqual(['drive', '--root', PIPELINE_ROOT, '--run-id', 'run-1', '--resume', '--json']);
    expect(world.states).toEqual(['preparing', 'running', 'paused_provider_limit', 'running', 'completed']);
  });

  test('a provider-stated retry window drives the pause length', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      detectProviderLimit: (r) => (r.code === 0 ? null : { reason: 'stated window', retry_after_ms: 1234 }),
    });
    const done = world.executor.start();
    await tick();
    expect(world.executor.pausedUntil).toBe(new Date(1234).toISOString());
    world.clock.advance(1234);
    await tick();
    expect((await done).ok).toBe(true);
  });

  test('the pause cap fails the job once the limit persists', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_PROVIDER_LIMIT], { maxProviderLimitPauses: 1 });
    const done = world.executor.start();
    await tick();
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    const result = await done;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('provider limit persisted through 1 pauses');
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'halted']);
  });

  test('the consecutive-pause counter resets after a limit-free invocation', async () => {
    // limit → pause → awaiting (progress! counter resets) → limit → pause →
    // completed. With maxProviderLimitPauses:1 this only passes if the reset
    // happens — otherwise the second limit would exceed the cap.
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, driveAwaiting(), DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      maxProviderLimitPauses: 1,
      needsInput: { onQuestion: () => 'host-a' },
    });
    const done = world.executor.start();
    await tick();
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    const result = await done;
    expect(result.ok).toBe(true);
    expect(world.exec.of('pipeline')).toHaveLength(4);
  });

  test('resumeNow() ends a pause without waiting out the clock', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED]);
    const done = world.executor.start();
    await tick();
    expect(world.executor.state).toBe('paused_provider_limit');
    world.executor.resumeNow();
    await tick();
    expect((await done).ok).toBe(true);
    expect(world.clock.pendingCount).toBe(0); // the pause timer was cleared
  });
});

describe('defaultProviderLimitPauseMs', () => {
  test('exponential from the default, capped at an hour', () => {
    expect(defaultProviderLimitPauseMs(0, { reason: 'x' })).toBe(5 * 60_000);
    expect(defaultProviderLimitPauseMs(1, { reason: 'x' })).toBe(10 * 60_000);
    expect(defaultProviderLimitPauseMs(4, { reason: 'x' })).toBe(60 * 60_000);
    expect(defaultProviderLimitPauseMs(10, { reason: 'x' })).toBe(60 * 60_000);
  });

  test('a provider-stated window wins', () => {
    expect(defaultProviderLimitPauseMs(3, { reason: 'x', retry_after_ms: 42 })).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// c6 (design 04 — D1): resume mode, durable-record port, ordered completion,
// cancel/suspend interruption.
// ─────────────────────────────────────────────────────────────────────────────

describe('JobExecutor — c6 resume mode', () => {
  const RECORD_DIR = join('/w', 'job-old');

  function resumeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
    return makeRecord({
      job_id: 'job-1',
      run_id: 'run-1',
      checkout_dir: RECORD_DIR,
      pipeline_root: join(RECORD_DIR, '.claude', 'pipeline', 'release'),
      start_iteration: 'steps/01-plan.md',
      ...overrides,
    });
  }

  test('FRESH resume: no prep, no wipe, `--resume` in the recorded checkout, NO started frame (F1)', async () => {
    const record = resumeRecord();
    const world = makeWorld([DRIVE_COMPLETED], { resume: { record, announce: false } });
    const result = await world.executor.start();

    expect(result.ok).toBe(true);
    expect(world.exec.of('git')).toHaveLength(0); // never re-prepped
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toEqual(['drive', '--root', record.pipeline_root!, '--run-id', 'run-1', '--resume', '--json']);
    expect(drive[0]!.opts.cwd).toBe(RECORD_DIR); // the RECORDED dir is the resume substrate
    // F1 "no cloud state change at all": completed only, no `started`.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['completed']);
  });

  test('ADOPTION resume (announce): the new job announces `started` before driving', async () => {
    const record = resumeRecord();
    const world = makeWorld([DRIVE_COMPLETED], { resume: { record, announce: true } });
    await world.executor.start();
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
  });

  test('recorded execution_overrides are re-applied on resume', async () => {
    const record = resumeRecord({ execution_overrides: { model: 'opus', effort: 'max' } });
    const world = makeWorld([DRIVE_COMPLETED], { resume: { record, announce: false } });
    await world.executor.start();
    expect(world.exec.of('pipeline')[0]!.args).toEqual([
      'drive',
      '--root',
      record.pipeline_root!,
      '--run-id',
      'run-1',
      '--default-model',
      'opus',
      '--default-effort',
      'max',
      '--resume',
      '--json',
    ]);
  });

  test('paused-window restore: no drive spawn until the recorded paused_until passes', async () => {
    const record = resumeRecord({
      phase: 'paused_provider_limit',
      paused_until: new Date(60_000).toISOString(),
      consecutive_pauses: 3,
    });
    const world = makeWorld([DRIVE_COMPLETED], { resume: { record, announce: false } });
    const done = world.executor.start();
    await tick();
    expect(world.exec.of('pipeline')).toHaveLength(0); // window restored, not hammered
    expect(world.executor.state).toBe('paused_provider_limit');
    expect(world.executor.pausedUntil).toBe(record.paused_until);

    world.clock.advance(60_000);
    const result = await done;
    expect(result.ok).toBe(true);
    expect(world.exec.of('pipeline')[0]!.args).toContain('--resume');
  });

  test('a paused record whose window already passed resumes immediately', async () => {
    const record = resumeRecord({ phase: 'paused_provider_limit', paused_until: new Date(0).toISOString() });
    const world = makeWorld([DRIVE_COMPLETED], { resume: { record, announce: false } });
    world.clock.advance(1); // now > paused_until
    const result = await world.executor.start();
    expect(result.ok).toBe(true);
    expect(world.exec.of('pipeline')).toHaveLength(1);
  });

  test('awaiting_input re-surface: NO spawn; the stored question goes to the relay; the answer drives `--answer`', async () => {
    const stored = {
      question_id: 'q-stored',
      step_id: '02-deploy',
      iteration_path: 'steps/02-deploy.md',
      session_id: 'sess-1',
      question: { text: 'Which host?', context: null, options: null },
    };
    const record = resumeRecord({ phase: 'awaiting_input', questions: [stored] });
    const asked: ParkedQuestion[] = [];
    const world = makeWorld([DRIVE_COMPLETED], {
      resume: { record, announce: false },
      needsInput: {
        onQuestion: (parked) => {
          asked.push(parked);
          expect(world.exec.of('pipeline')).toHaveLength(0); // re-surfaced BEFORE any spawn
          return 'prod-3';
        },
      },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question_id).toBe('q-stored'); // identity preserved across the daemon death
    expect(world.exec.of('pipeline')[0]!.args).toEqual([
      'drive',
      '--root',
      record.pipeline_root!,
      '--run-id',
      'run-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'prod-3',
      '--json',
    ]);
  });

  test('pinned content_hash is RE-VERIFIED before resume — mismatch halts instead of resuming', async () => {
    const record = resumeRecord({
      pipeline_ref: { repo: 'git@example.com:acme/api.git', ref: 'main', pipeline: 'release', content_hash: 'sha256:aaa' },
    });
    const world = makeWorld([DRIVE_COMPLETED], {
      resume: { record, announce: false },
      verifyContentHash: () => {
        throw new JobError('content hash mismatch (expected sha256:aaa, got sha256:bbb)');
      },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('resume refused');
    expect(world.exec.of('pipeline')).toHaveLength(0); // never drove
    const halted = world.sink.ofType('run_status');
    expect(halted).toHaveLength(1);
    expect(halted[0]!.phase).toBe('halted');
    expect(String(halted[0]!.halt_reason)).toContain('content hash mismatch');
  });

  test('resume restores the pause ladder from the record', async () => {
    // consecutive_pauses restored: one more limit pause uses attempt index 1
    // of the pause policy (not 0), proving the ladder position survived.
    const attempts: number[] = [];
    const record = resumeRecord({ consecutive_pauses: 1 });
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      resume: { record, announce: false },
      providerLimitPauseMs: (attempt) => {
        attempts.push(attempt);
        return 1_000;
      },
    });
    const done = world.executor.start();
    await tick();
    world.clock.advance(1_000);
    await done;
    expect(attempts).toEqual([1]);
  });
});

describe('JobExecutor — c6 durable-record port', () => {
  test('fresh path: prep substrate, then phase transitions, persist through the port', async () => {
    const patches: Array<Partial<JobRecord>> = [];
    const world = makeWorld([driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-7'), DRIVE_COMPLETED], {
      record: { update: (patch) => patches.push(patch) },
      needsInput: { onQuestion: () => 'prod' },
    });
    await world.executor.start();

    expect(patches[0]).toEqual({ pipeline_root: PIPELINE_ROOT, start_iteration: 'steps/01-plan.md' });
    expect(patches[1]).toEqual({ phase: 'running' });
    expect(patches[2]!.phase).toBe('awaiting_input');
    expect(patches[2]!.questions).toEqual([
      {
        question_id: 'q-7',
        step_id: '02-deploy',
        iteration_path: 'steps/02-deploy.md',
        session_id: 'sess-1',
        question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] },
      },
    ]);
    expect(patches[3]).toEqual({ phase: 'running', questions: [] });
  });

  test('provider-limit pause persists paused_until + consecutive_pauses', async () => {
    const patches: Array<Partial<JobRecord>> = [];
    const world = makeWorld([DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED], {
      record: { update: (patch) => patches.push(patch) },
    });
    const done = world.executor.start();
    await tick();
    const paused = patches.find((p) => p.phase === 'paused_provider_limit');
    expect(paused).toBeDefined();
    expect(paused!.consecutive_pauses).toBe(1);
    expect(typeof paused!.paused_until).toBe('string');
    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await done;
    expect(patches[patches.length - 1]).toEqual({ phase: 'running', paused_until: null });
  });
});

describe('JobExecutor — c6 ordered completion (the c5 terminal-state race)', () => {
  test('terminal events FLUSH before the terminal run_status frame goes out', async () => {
    const order: string[] = [];
    const world = makeWorld([DRIVE_COMPLETED], {
      send: (frame) => {
        order.push(`frame:${String(frame.type)}:${String((frame as { phase?: string }).phase)}`);
        return true;
      },
      events: {
        onTerminalFlush: async () => {
          order.push('flush:start');
          await tick(); // a real flush takes time — the frame must still wait
          order.push('flush:end');
        },
      },
    });
    await world.executor.start();
    const flushEnd = order.indexOf('flush:end');
    const terminal = order.indexOf('frame:run_status:completed');
    expect(flushEnd).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(flushEnd); // flush → run_status, strictly ordered
  });

  test('halted paths flush first too, and a flush failure never swallows the frame', async () => {
    const order: string[] = [];
    const world = makeWorld([DRIVE_HALTED], {
      send: (frame) => {
        order.push(`frame:${String((frame as { phase?: string }).phase)}`);
        return true;
      },
      events: {
        onTerminalFlush: async () => {
          order.push('flush');
          throw new Error('spool exploded');
        },
      },
    });
    const result = await world.executor.start();
    expect(result.ok).toBe(false);
    expect(order).toEqual(['frame:started', 'flush', 'frame:halted']);
  });
});

describe('JobExecutor — c6 cancel / suspend', () => {
  test('cancel mid-drive: child aborted, NO terminal run_status, result flagged cancelled', async () => {
    const exec = new AbortableHangExec();
    const world = makeWorld([], { exec: exec as unknown as FakeJobExec });
    const done = world.executor.start();
    await tick(); // drive is in flight (hanging)
    expect(exec.of('pipeline')).toHaveLength(1);

    world.executor.cancel();
    const result = await done;
    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: false, reason: 'cancelled by server', cancelled: true });
    // `started` only — the server initiated the cancel; no halted frame.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
  });

  test('suspend mid-drive: child aborted, result flagged suspended (record stays — manager contract)', async () => {
    const exec = new AbortableHangExec();
    const finished: JobResult[] = [];
    const world = makeWorld([], {
      exec: exec as unknown as FakeJobExec,
      events: { onFinished: (r) => finished.push(r) },
    });
    const done = world.executor.start();
    await tick();
    world.executor.suspend();
    const result = await done;
    expect(result.ok).toBe(false);
    expect((result as { suspended?: boolean }).suspended).toBe(true);
    expect(finished).toHaveLength(1);
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
  });

  test('cancel while parked on a question unblocks the relay await', async () => {
    const world = makeWorld([driveAwaiting()], {
      needsInput: { onQuestion: () => new Promise<string | null>(() => {}) }, // answer never comes
    });
    const done = world.executor.start();
    await tick();
    expect(world.executor.state).toBe('awaiting_input');
    world.executor.cancel();
    const result = await done;
    expect((result as { cancelled?: boolean }).cancelled).toBe(true);
  });

  test('suspend during a provider-limit pause exits without another spawn', async () => {
    const world = makeWorld([DRIVE_PROVIDER_LIMIT]);
    const done = world.executor.start();
    await tick();
    expect(world.executor.state).toBe('paused_provider_limit');
    world.executor.suspend();
    const result = await done;
    expect((result as { suspended?: boolean }).suspended).toBe(true);
    expect(world.exec.of('pipeline')).toHaveLength(1); // no post-suspend resume spawn
  });
});
