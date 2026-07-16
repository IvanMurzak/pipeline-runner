/**
 * T2-05 integration: a TASK lease through the REAL JobExecutor/JobManager —
 * accept → checkout → `pipeline match` (scripted through the exec seam) →
 * resolved pipeline → `pipeline drive` → run_status. No test spawns a real
 * subprocess, clones a repo, or reads a real pipeline tree: git, match, and
 * drive are all FakeJobExec scripts and the workspace is a FakeJobFs.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher';
import { CaptureLogger, tick } from '../../tests/_helpers';
import {
  DRIVE_COMPLETED,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
  makeTask,
  makeTaskLease,
  matchOutput,
} from '../jobs/_helpers';
import type { JobExecResult } from '../jobs/types';
import { JobExecutor, type JobExecutorOptions, type JobWorkspaceContext } from '../jobs/executor';
import { JobManager } from '../jobs/manager';
import type { TaskDispatchInput, TaskPipelineResolution } from './matcher';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINES_DIR = join(DIR, '.claude', 'pipeline');
const RELEASE_ROOT = join(PIPELINES_DIR, 'release');
const RELEASE_MANIFEST = join(RELEASE_ROOT, 'PIPELINE.md');

const TASK_QUERY = 'Ship the release\nCut a release for the api service\nrelease';

/** An fs pre-seeded so the RESOLVED pipeline's prep succeeds. */
function readyFs(): FakeJobFs {
  const fs = new FakeJobFs();
  fs.existing.add(RELEASE_ROOT);
  fs.listings.set(join(RELEASE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);
  return fs;
}

/** Exec fake: git ok; `pipeline match` → `matchResult`; `pipeline drive` → queue. */
function dispatchExec(matchResult: JobExecResult, driveQueue: JobExecResult[]): FakeJobExec {
  return new FakeJobExec((cmd, args) => {
    if (cmd === 'git') return GIT_OK;
    if (args[0] === 'match') return matchResult;
    const next = driveQueue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
}

function makeExecutor(exec: FakeJobExec, overrides: Partial<JobExecutorOptions> = {}) {
  const sink = new FrameSink();
  const logger = new CaptureLogger();
  const executor = new JobExecutor({
    lease: makeTaskLease(),
    runnerId: 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    fs: readyFs(),
    logger,
    ...overrides,
    exec,
  });
  return { executor, sink, logger };
}

describe('task dispatch — happy path (task → match → resolve → drive)', () => {
  test('checkout, BM25 match via the CLI subprocess, drive the WINNER', async () => {
    const exec = dispatchExec(matchOutput([{ name: 'release', manifest: RELEASE_MANIFEST, score: 4.2 }]), [
      DRIVE_COMPLETED,
    ]);
    const { executor, sink, logger } = makeExecutor(exec);
    const result = await executor.start();

    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });

    // The match runs AFTER the checkout and BEFORE drive.
    const kinds = exec.calls.map((c) => (c.cmd === 'git' ? 'git' : c.args[0]));
    expect(kinds).toEqual(['git', 'git', 'git', 'git', 'match', 'drive']);

    // Exact reused-matcher invocation: `pipeline match` over the checkout's
    // local manifests, query = title + "\n" + body (+ labels hint line).
    const match = exec.calls[4]!;
    expect(match.cmd).toBe('pipeline');
    expect(match.args).toEqual(['match', '--pipelines-dir', PIPELINES_DIR, '--task', TASK_QUERY, '--top', '1']);
    expect(match.opts.cwd).toBe(DIR);

    // Drive runs the RESOLVED pipeline root — identity reaches the server via
    // the normal event/run_status path, no new frames.
    const drive = exec.calls[5]!;
    expect(drive.args).toEqual([
      'drive',
      '--root',
      RELEASE_ROOT,
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
    expect(sink.frames).toEqual([
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'started' },
      { type: 'run_status', run_id: 'run-1', job_id: 'job-1', phase: 'completed', outcome: 'completed' },
    ]);
    expect(logger.joined()).toContain("task task-1 dispatched to pipeline '.claude/pipeline/release'");
  });

  test('onWorkspaceReady points the shipper at the RESOLVED pipeline root', async () => {
    const exec = dispatchExec(matchOutput([{ name: 'release', manifest: RELEASE_MANIFEST, score: 4.2 }]), [
      DRIVE_COMPLETED,
    ]);
    const contexts: JobWorkspaceContext[] = [];
    const { executor } = makeExecutor(exec, { events: { onWorkspaceReady: (ctx) => contexts.push(ctx) } });
    await executor.start();
    expect(contexts).toEqual([
      {
        dir: DIR,
        pipelineRoot: RELEASE_ROOT,
        startIteration: 'steps/01-plan.md',
        job_id: 'job-1',
        run_id: 'run-1',
        job_jwt: 'jwt-secret-1',
        secret_slugs: [], // always [] for task leases (the contract)
      },
    ]);
  });
});

describe('task dispatch — no match ⇒ the run FAILS (never drives a guess)', () => {
  test('zero candidates → run_status halted through the existing path, no drive', async () => {
    const exec = dispatchExec(matchOutput([]), []);
    const { executor, sink } = makeExecutor(exec);
    const result = await executor.start();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('task dispatch found no matching pipeline for task task-1');
    }
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['halted']);
    expect(sink.ofType('run_status')[0]!.halt_reason).toContain('no matching pipeline');
    expect(exec.calls.filter((c) => c.args[0] === 'drive')).toHaveLength(0);
    expect(executor.state).toBe('failed');
  });

  test('a matcher failure (unparseable output) also fails the run', async () => {
    const exec = dispatchExec({ code: 0, stdout: 'garbage', stderr: '' }, []);
    const { executor, sink } = makeExecutor(exec);
    const result = await executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('pipeline match returned unparseable output');
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['halted']);
  });

  test("the '@task' sentinel WITHOUT a task payload fails before any checkout", async () => {
    const exec = dispatchExec(matchOutput([]), []);
    const { executor, sink } = makeExecutor(exec, { lease: makeTaskLease({}, { task: undefined }) });
    const result = await executor.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('carries no task payload');
    expect(exec.calls).toEqual([]); // no checkout wasted
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['halted']);
  });
});

describe('task dispatch — the resolution seam', () => {
  test('an injected resolver replaces the CLI matcher (no match subprocess)', async () => {
    const seen: TaskDispatchInput[] = [];
    const resolution: TaskPipelineResolution = { pipeline: '.claude/pipeline/release', manifest: RELEASE_MANIFEST, score: 9 };
    const exec = dispatchExec(matchOutput([]), [DRIVE_COMPLETED]);
    const { executor } = makeExecutor(exec, {
      resolveTaskPipeline: async (input) => {
        seen.push(input);
        return resolution;
      },
    });
    const result = await executor.start();

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ checkoutDir: DIR, task: makeTask() }]);
    expect(exec.calls.filter((c) => c.args[0] === 'match')).toHaveLength(0); // seam replaced the CLI
    expect(exec.calls.filter((c) => c.args[0] === 'drive')[0]!.args).toContain(RELEASE_ROOT);
  });

  test('a NON-task lease NEVER invokes the seam and behaves as T2-03 (regression)', async () => {
    const exec = new FakeJobExec((cmd) => (cmd === 'git' ? GIT_OK : DRIVE_COMPLETED));
    const { executor, sink } = makeExecutor(exec, {
      lease: makeLease(),
      resolveTaskPipeline: () => {
        throw new Error('the dispatch seam must never fire for a fixed-pipeline lease');
      },
    });
    const result = await executor.start();

    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
    const kinds = exec.calls.map((c) => (c.cmd === 'git' ? 'git' : c.args[0]));
    expect(kinds).toEqual(['git', 'git', 'git', 'git', 'drive']); // no match spawn
    expect(exec.calls[4]!.args).toEqual([
      'drive',
      '--root',
      RELEASE_ROOT,
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
  });
});

describe('task dispatch — through the JobManager', () => {
  test('a task lease is accepted and dispatched end-to-end (default CLI matcher)', async () => {
    const dispatcher = new Dispatcher();
    const exec = dispatchExec(matchOutput([{ name: 'release', manifest: RELEASE_MANIFEST, score: 4.2 }]), [
      DRIVE_COMPLETED,
    ]);
    const sink = new FrameSink();
    const finished: unknown[] = [];
    const manager = new JobManager({
      runnerId: () => 'r-1',
      send: sink.send,
      workspaceRoot: ROOT,
      labels: () => ['os:linux'],
      exec,
      fs: readyFs(),
      events: { onJobFinished: (result) => finished.push(result) },
    });
    manager.attach(dispatcher);
    dispatcher.dispatch(makeTaskLease());
    await tick();

    expect(sink.ofType('accept')).toEqual([
      { type: 'accept', id: 'corr-1', runner_id: 'r-1', job_id: 'job-1', run_id: 'run-1' },
    ]);
    expect(exec.calls.filter((c) => c.args[0] === 'match')).toHaveLength(1);
    expect(finished).toEqual([{ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' }]);
    expect(manager.activeCount).toBe(0);
  });

  test('resolveTaskPipeline passes through the manager to the executor', async () => {
    const dispatcher = new Dispatcher();
    const exec = new FakeJobExec((cmd) => (cmd === 'git' ? GIT_OK : DRIVE_COMPLETED));
    const sink = new FrameSink();
    let resolved = 0;
    const manager = new JobManager({
      runnerId: () => 'r-1',
      send: sink.send,
      workspaceRoot: ROOT,
      labels: () => ['os:linux'],
      exec,
      fs: readyFs(),
      resolveTaskPipeline: async () => {
        resolved += 1;
        return { pipeline: '.claude/pipeline/release', manifest: RELEASE_MANIFEST, score: 1 };
      },
    });
    manager.attach(dispatcher);
    dispatcher.dispatch(makeTaskLease());
    await tick();

    expect(resolved).toBe(1);
    expect(exec.calls.filter((c) => c.args[0] === 'match')).toHaveLength(0);
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
  });
});
