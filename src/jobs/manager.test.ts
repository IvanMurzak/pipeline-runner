import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import {
  DRIVE_COMPLETED,
  DRIVE_PROVIDER_LIMIT,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
} from './_helpers';
import type { JobExecResult } from './types';
import { DEFAULT_PROVIDER_LIMIT_PAUSE_MS, type JobResult } from './executor';
import { attachJobExecution, JobManager, type JobManagerOptions } from './manager';

const ROOT = join('/w');

/** Seed the fs so a given job id's fixture workspace prepares successfully. */
function seedJob(fs: FakeJobFs, jobId: string): void {
  const pipelineRoot = join(ROOT, jobId, '.claude', 'pipeline', 'release');
  fs.existing.add(pipelineRoot);
  fs.listings.set(join(pipelineRoot, 'steps'), ['01-plan.md']);
}

interface World {
  manager: JobManager;
  dispatcher: Dispatcher;
  exec: FakeJobExec;
  fs: FakeJobFs;
  sink: FrameSink;
  clock: FakeClock;
  logger: CaptureLogger;
  finished: JobResult[];
}

function makeWorld(
  respondDrive: (args: string[]) => JobExecResult | Promise<JobExecResult>,
  overrides: Partial<JobManagerOptions> = {}
): World {
  const dispatcher = new Dispatcher();
  const exec = new FakeJobExec((cmd, args) => (cmd === 'git' ? GIT_OK : respondDrive(args)));
  const fs = new FakeJobFs();
  seedJob(fs, 'job-1');
  seedJob(fs, 'job-2');
  const sink = new FrameSink();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const finished: JobResult[] = [];
  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    labels: () => ['os:linux', 'repo:acme/api'],
    exec,
    fs,
    clock,
    logger,
    events: { onJobFinished: (result) => finished.push(result) },
    ...overrides,
  });
  manager.attach(dispatcher);
  return { manager, dispatcher, exec, fs, sink, clock, logger, finished };
}

describe('JobManager — accept round-trip', () => {
  test('lease in → accept out with the echoed correlation id and this runner id', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease({ id: 'corr-7' }));
    await tick();

    expect(world.sink.ofType('accept')).toEqual([
      { type: 'accept', id: 'corr-7', runner_id: 'r-1', job_id: 'job-1', run_id: 'run-1' },
    ]);
    // The full pipeline ran: checkout + drive + lifecycle frames.
    expect(world.exec.of('pipeline')).toHaveLength(1);
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(world.finished).toEqual([{ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' }]);
    expect(world.manager.activeCount).toBe(0); // job finished and deregistered
  });

  test('a malformed lease is ignored (no accept, no job)', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch({ type: 'lease', job_id: 'job-1' }); // missing everything else
    expect(world.sink.frames).toEqual([]);
    expect(world.manager.activeCount).toBe(0);
    expect(world.logger.joined()).toContain('malformed lease ignored');
  });
});

describe('JobManager — preconditions', () => {
  test('declined before registration (no runner_id yet)', () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { runnerId: () => null });
    world.dispatcher.dispatch(makeLease());
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('runner not registered');
  });

  test('declined while draining', () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { draining: () => true });
    world.dispatcher.dispatch(makeLease());
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('draining');
  });

  test('declined at capacity while a job is in flight', async () => {
    let releaseFirst: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (releaseFirst = resolve)));
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    await tick();
    expect(world.manager.activeCount).toBe(1);

    world.dispatcher.dispatch(makeLease({ id: 'c2', job_id: 'job-2', run_id: 'run-2' }));
    expect(world.sink.ofType('accept')).toHaveLength(1); // job-2 declined
    expect(world.logger.joined()).toContain('at capacity (1/1)');

    releaseFirst(DRIVE_COMPLETED);
    await tick();
    expect(world.manager.activeCount).toBe(0);
  });

  test('a higher capacity() admits parallel jobs', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { capacity: () => 2 });
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    world.dispatcher.dispatch(makeLease({ id: 'c2', job_id: 'job-2', run_id: 'run-2' }));
    await tick();
    expect(world.sink.ofType('accept')).toHaveLength(2);
    expect(world.finished).toHaveLength(2);
  });

  test('a redelivered lease for an ACTIVE job re-acknowledges without a second run', async () => {
    let release: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (release = resolve)));
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    await tick();
    world.dispatcher.dispatch(makeLease({ id: 'c1-redelivery' }));

    const accepts = world.sink.ofType('accept');
    expect(accepts).toHaveLength(2);
    expect(accepts[1]!.id).toBe('c1-redelivery');
    expect(world.manager.activeCount).toBe(1);
    expect(world.exec.of('pipeline')).toHaveLength(1); // never started twice

    release(DRIVE_COMPLETED);
    await tick();
  });

  test('declined when the lease asks for an unadvertised label', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease({ labels: ['os:linux', 'gpu'] }));
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('unadvertised labels: gpu');
  });

  test('without a labels() accessor any label set is admitted', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { labels: undefined });
    world.dispatcher.dispatch(makeLease({ labels: ['anything'] }));
    await tick();
    expect(world.sink.ofType('accept')).toHaveLength(1);
  });

  test('an offline connection means no accept and no job start', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.sink.online = false;
    world.dispatcher.dispatch(makeLease());
    expect(world.manager.activeCount).toBe(0);
    expect(world.exec.calls).toHaveLength(0);
    expect(world.logger.joined()).toContain('not accepted — connection not online');
  });
});

describe('JobManager — heartbeat composition accessors', () => {
  test('activeRunIds reflects in-flight runs and empties on completion', async () => {
    let release: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (release = resolve)));
    expect(world.manager.activeRunIds()).toEqual([]);
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.manager.activeRunIds()).toEqual(['run-1']);
    release(DRIVE_COMPLETED);
    await tick();
    expect(world.manager.activeRunIds()).toEqual([]);
  });

  test('runnerStatus/pausedUntil surface a provider-limit pause', async () => {
    const results = [DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED];
    const world = makeWorld(() => results.shift()!);
    expect(world.manager.runnerStatus()).toBe('online');
    world.dispatcher.dispatch(makeLease());
    await tick();

    expect(world.manager.runnerStatus()).toBe('paused');
    expect(world.manager.pausedUntil()).toBe(new Date(DEFAULT_PROVIDER_LIMIT_PAUSE_MS).toISOString());

    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    expect(world.manager.runnerStatus()).toBe('online');
    expect(world.manager.pausedUntil()).toBeNull();
  });
});

describe('attachJobExecution', () => {
  test('composes over an AgentClient-shaped surface (dispatcher + send)', async () => {
    const dispatcher = new Dispatcher();
    const sink = new FrameSink();
    const exec = new FakeJobExec((cmd) => (cmd === 'git' ? GIT_OK : DRIVE_COMPLETED));
    const fs = new FakeJobFs();
    seedJob(fs, 'job-1');
    const manager = attachJobExecution(
      { dispatcher, send: sink.send },
      { runnerId: () => 'r-1', workspaceRoot: ROOT, exec, fs, clock: new FakeClock() }
    );
    dispatcher.dispatch(makeLease());
    await tick();
    expect(sink.ofType('accept')).toHaveLength(1);
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(manager.activeCount).toBe(0);
  });

  test('importing + attaching alone starts nothing (construction-time-lazy)', () => {
    const dispatcher = new Dispatcher();
    const sink = new FrameSink();
    const exec = new FakeJobExec(() => GIT_OK);
    const clock = new FakeClock();
    attachJobExecution(
      { dispatcher, send: sink.send },
      { runnerId: () => 'r-1', workspaceRoot: ROOT, exec, fs: new FakeJobFs(), clock }
    );
    expect(exec.calls).toHaveLength(0);
    expect(sink.frames).toEqual([]);
    expect(clock.pendingCount).toBe(0);
  });
});
