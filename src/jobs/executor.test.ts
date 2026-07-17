import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import {
  DRIVE_COMPLETED,
  DRIVE_HALTED,
  DRIVE_PROVIDER_LIMIT,
  driveAwaiting,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
} from './_helpers';
import type { JobExecResult } from './types';
import {
  DEFAULT_PROVIDER_LIMIT_PAUSE_MS,
  defaultProviderLimitPauseMs,
  JobExecutor,
  type JobExecutorOptions,
  type JobState,
  type ParkedQuestion,
} from './executor';

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
  const exec = overrides.exec instanceof FakeJobExec ? overrides.exec : driveExec(queue);
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
