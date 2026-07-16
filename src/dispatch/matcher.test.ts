import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger } from '../../tests/_helpers';
import { FakeJobExec, makeTask, matchOutput } from '../jobs/_helpers';
import { JobError, type JobExecResult } from '../jobs/types';
import {
  buildMatchArgs,
  buildTaskQuery,
  cliTaskPipelineResolver,
  pipelinePathFromManifest,
  PIPELINES_DIR_REL,
} from './matcher';

const CHECKOUT = join('/w', 'job-1');
const PIPELINES_DIR = join(CHECKOUT, '.claude', 'pipeline');

function respondWith(result: JobExecResult): FakeJobExec {
  return new FakeJobExec(() => result);
}

describe('dispatch — task query', () => {
  test('is title + newline + body, labels appended as one hint line', () => {
    expect(buildTaskQuery(makeTask())).toBe('Ship the release\nCut a release for the api service\nrelease');
  });

  test('an empty body leaves just the title (no trailing newline)', () => {
    expect(buildTaskQuery(makeTask({ body: '', labels: [] }))).toBe('Ship the release');
  });

  test('no labels ⇒ no hint line', () => {
    expect(buildTaskQuery(makeTask({ labels: [] }))).toBe('Ship the release\nCut a release for the api service');
  });
});

describe('dispatch — match argv', () => {
  test('builds the exact `pipeline match` invocation (top-1 winner)', () => {
    expect(buildMatchArgs(PIPELINES_DIR, 'fix the login bug')).toEqual([
      'match',
      '--pipelines-dir',
      PIPELINES_DIR,
      '--task',
      'fix the login bug',
      '--top',
      '1',
    ]);
  });
});

describe('dispatch — pipelinePathFromManifest', () => {
  test('a conventional pipeline resolves to its checkout-relative root', () => {
    const manifest = join(PIPELINES_DIR, 'release', 'PIPELINE.md');
    expect(pipelinePathFromManifest(CHECKOUT, manifest)).toBe('.claude/pipeline/release');
  });

  test('a NESTED pipeline keeps its full path (bare name would mis-resolve)', () => {
    const manifest = join(PIPELINES_DIR, 'workflows', 'implement-task', 'PIPELINE.md');
    expect(pipelinePathFromManifest(CHECKOUT, manifest)).toBe('.claude/pipeline/workflows/implement-task');
  });

  test('a manifest outside the checkout is refused', () => {
    expect(() => pipelinePathFromManifest(CHECKOUT, join('/elsewhere', 'PIPELINE.md'))).toThrow(JobError);
  });
});

describe('dispatch — cliTaskPipelineResolver', () => {
  test('spawns `pipeline match` through the exec seam and returns the winner', async () => {
    const exec = respondWith(
      matchOutput([{ name: 'release', manifest: join(PIPELINES_DIR, 'release', 'PIPELINE.md'), score: 4.2 }])
    );
    const logger = new CaptureLogger();
    const resolve = cliTaskPipelineResolver({ exec, logger });
    const resolution = await resolve({ checkoutDir: CHECKOUT, task: makeTask() });

    expect(resolution).toEqual({
      pipeline: '.claude/pipeline/release',
      manifest: join(PIPELINES_DIR, 'release', 'PIPELINE.md'),
      score: 4.2,
    });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.cmd).toBe('pipeline');
    expect(exec.calls[0]!.args).toEqual(
      buildMatchArgs(PIPELINES_DIR, 'Ship the release\nCut a release for the api service\nrelease')
    );
    expect(exec.calls[0]!.opts.cwd).toBe(CHECKOUT);
    expect(logger.joined()).toContain("dispatch matched pipeline '.claude/pipeline/release'");
  });

  test('takes candidates[0] — the CLI already ranked deterministically', async () => {
    const exec = respondWith(
      matchOutput([
        { name: 'release', manifest: join(PIPELINES_DIR, 'release', 'PIPELINE.md'), score: 4.2 },
        { name: 'audit', manifest: join(PIPELINES_DIR, 'audit', 'PIPELINE.md'), score: 1.1 },
      ])
    );
    const resolve = cliTaskPipelineResolver({ exec });
    const resolution = await resolve({ checkoutDir: CHECKOUT, task: makeTask() });
    expect(resolution.pipeline).toBe('.claude/pipeline/release');
  });

  test('a custom pipeline binary and pipelines dir are honored', async () => {
    const exec = respondWith(
      matchOutput([{ name: 'p', manifest: join(CHECKOUT, 'pipelines', 'p', 'PIPELINE.md'), score: 1 }])
    );
    const resolve = cliTaskPipelineResolver({ exec, pipelineBin: 'bunx-pipeline', pipelinesDirRel: 'pipelines' });
    const resolution = await resolve({ checkoutDir: CHECKOUT, task: makeTask() });
    expect(exec.calls[0]!.cmd).toBe('bunx-pipeline');
    expect(exec.calls[0]!.args[2]).toBe(join(CHECKOUT, 'pipelines'));
    expect(resolution.pipeline).toBe('pipelines/p');
  });

  test('ZERO candidates ⇒ JobError naming the task (no-match, never a guess)', async () => {
    const resolve = cliTaskPipelineResolver({ exec: respondWith(matchOutput([])) });
    await expect(resolve({ checkoutDir: CHECKOUT, task: makeTask() })).rejects.toThrow(
      'task dispatch found no matching pipeline for task task-1 (no manifest scored above zero)'
    );
  });

  test('a MISSING pipelines dir (match exit 1) is the same no-match failure', async () => {
    const exec = respondWith({
      code: 1,
      stdout: '',
      stderr: `ERROR: pipelines-dir does not exist or is not a directory: ${PIPELINES_DIR}\n`,
    });
    const resolve = cliTaskPipelineResolver({ exec });
    await expect(resolve({ checkoutDir: CHECKOUT, task: makeTask() })).rejects.toThrow(
      `task dispatch found no matching pipeline for task task-1 (no ${PIPELINES_DIR_REL} directory in the checkout)`
    );
  });

  test('a usage error (exit 2) fails with the exit detail', async () => {
    const exec = respondWith({ code: 2, stdout: '', stderr: 'pipeline match: --pipelines-dir is required\n' });
    const resolve = cliTaskPipelineResolver({ exec });
    await expect(resolve({ checkoutDir: CHECKOUT, task: makeTask() })).rejects.toThrow(
      'pipeline match failed (exit 2): pipeline match: --pipelines-dir is required'
    );
  });

  test('a missing binary (spawn failure) fails actionably', async () => {
    const exec = respondWith({ code: 127, stdout: '', stderr: '', error: 'spawn pipeline ENOENT' });
    const resolve = cliTaskPipelineResolver({ exec });
    await expect(resolve({ checkoutDir: CHECKOUT, task: makeTask() })).rejects.toThrow(
      'pipeline match failed (exit 127): spawn pipeline ENOENT'
    );
  });

  test('unparseable stdout fails without pretending a match', async () => {
    const exec = respondWith({ code: 0, stdout: 'not json at all', stderr: '' });
    const resolve = cliTaskPipelineResolver({ exec });
    await expect(resolve({ checkoutDir: CHECKOUT, task: makeTask() })).rejects.toThrow(
      'pipeline match returned unparseable output'
    );
  });
});
