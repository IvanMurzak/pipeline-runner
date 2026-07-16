import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger } from '../../tests/_helpers';
import { FakeJobExec, FakeJobFs, GIT_OK, makeLease } from './_helpers';
import { JobError } from './types';
import {
  defaultResolveStartIteration,
  pipelineRootRel,
  prepareWorkspace,
  sanitizeJobId,
  type PrepareWorkspaceOptions,
} from './workspace';

const ROOT = join('/tmp', 'jobs');

/** A fs pre-seeded so the standard fixture lease prepares successfully. */
function readyFs(dir: string, pipelineRel = '.claude/pipeline/release'): FakeJobFs {
  const fs = new FakeJobFs();
  const pipelineRoot = join(dir, ...pipelineRel.split('/'));
  fs.existing.add(pipelineRoot);
  fs.listings.set(join(pipelineRoot, 'steps'), ['02-ship.md', '01-plan.md', 'notes.txt']);
  return fs;
}

function options(fs: FakeJobFs, exec: FakeJobExec, extra: Partial<PrepareWorkspaceOptions> = {}): PrepareWorkspaceOptions {
  return { jobId: 'job-1', ref: makeLease().pipeline_ref, root: ROOT, exec, fs, ...extra };
}

describe('sanitizeJobId', () => {
  test('keeps safe characters, replaces the rest', () => {
    expect(sanitizeJobId('job_1.A-b')).toBe('job_1.A-b');
    expect(sanitizeJobId('job/1:2 x')).toBe('job-1-2-x');
  });

  test('rejects ids that sanitize to nothing usable', () => {
    expect(() => sanitizeJobId('../..')).toThrow(JobError);
  });
});

describe('pipelineRootRel', () => {
  test('a bare name resolves under .claude/pipeline/', () => {
    expect(pipelineRootRel('release')).toBe('.claude/pipeline/release');
  });

  test('a path is taken verbatim (normalized)', () => {
    expect(pipelineRootRel('./custom/pipelines/deploy/')).toBe('custom/pipelines/deploy');
    expect(pipelineRootRel('custom\\pipelines\\deploy')).toBe('custom/pipelines/deploy');
  });

  test('rejects upward traversal', () => {
    expect(() => pipelineRootRel('../outside')).toThrow(JobError);
  });
});

describe('defaultResolveStartIteration', () => {
  test('picks the lexically-first steps/*.md', () => {
    const fs = new FakeJobFs();
    fs.listings.set(join('/p', 'steps'), ['10-last.md', '01-first.md', 'README.txt']);
    expect(defaultResolveStartIteration('/p', fs)).toBe('steps/01-first.md');
  });

  test('null when there are no step files', () => {
    expect(defaultResolveStartIteration('/p', new FakeJobFs())).toBeNull();
  });
});

describe('prepareWorkspace', () => {
  const dir = join(ROOT, 'job-1');

  test('runs the exact shallow-checkout git sequence and resolves the workspace', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const fs = readyFs(dir);
    const ws = await prepareWorkspace(options(fs, exec));

    expect(exec.calls.map((c) => c.args)).toEqual([
      ['init', dir],
      ['-C', dir, 'remote', 'add', 'origin', 'git@example.com:acme/api.git'],
      ['-C', dir, 'fetch', '--depth', '1', 'origin', 'main'],
      ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'],
    ]);
    expect(exec.calls.every((c) => c.cmd === 'git')).toBe(true);
    expect(ws.dir).toBe(dir);
    expect(ws.pipelineRoot).toBe(join(dir, '.claude', 'pipeline', 'release'));
    expect(ws.startIteration).toBe('steps/01-plan.md');
  });

  test('a stale per-job directory is removed first (no cross-attempt leakage)', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const fs = readyFs(dir);
    fs.existing.add(dir); // stale leftover from a crashed attempt
    await prepareWorkspace(options(fs, exec));
    expect(fs.removed).toEqual([dir]);
    expect(fs.made).toContain(dir);
  });

  test('a git failure surfaces the verb and stderr detail', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args.includes('fetch') ? { code: 128, stdout: '', stderr: 'fatal: could not read from remote\nmore' } : GIT_OK
    );
    await expect(prepareWorkspace(options(readyFs(dir), exec))).rejects.toThrow(
      'git fetch main failed (exit 128): fatal: could not read from remote'
    );
  });

  test('a missing pipeline root in the checkout is an actionable failure', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const fs = new FakeJobFs(); // nothing seeded — checkout has no pipeline
    await expect(prepareWorkspace(options(fs, exec))).rejects.toThrow('pipeline root not found in checkout');
  });

  test('a path-shaped pipeline_ref.pipeline resolves verbatim', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const fs = readyFs(dir, 'tools/pipelines/deploy');
    const ref = { ...makeLease().pipeline_ref, pipeline: 'tools/pipelines/deploy' };
    const ws = await prepareWorkspace(options(fs, exec, { ref }));
    expect(ws.pipelineRoot).toBe(join(dir, 'tools', 'pipelines', 'deploy'));
  });

  test('no steps/*.md → actionable failure', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const fs = readyFs(dir);
    fs.listings.clear();
    await expect(prepareWorkspace(options(fs, exec))).rejects.toThrow('no entry iteration');
  });

  test('a pinned content_hash without a verifier warns and proceeds', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const logger = new CaptureLogger();
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha-abc' };
    await prepareWorkspace(options(readyFs(dir), exec, { ref, logger }));
    expect(logger.joined()).toContain('content_hash sha-abc but no verifier is wired');
  });

  test('a verifier mismatch fails the prep', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha-abc' };
    await expect(
      prepareWorkspace(options(readyFs(dir), exec, { ref, verifyContentHash: () => false }))
    ).rejects.toThrow('content hash mismatch');
  });

  test('a passing verifier is invoked with the pipeline root and pinned hash', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const seen: Array<[string, string]> = [];
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha-abc' };
    await prepareWorkspace(
      options(readyFs(dir), exec, {
        ref,
        verifyContentHash: (rootAbs, hash) => {
          seen.push([rootAbs, hash]);
          return true;
        },
      })
    );
    expect(seen).toEqual([[join(dir, '.claude', 'pipeline', 'release'), 'sha-abc']]);
  });

  test('an unpinned lease (content_hash null) skips verification silently', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const logger = new CaptureLogger();
    let called = false;
    await prepareWorkspace(
      options(readyFs(dir), exec, {
        logger,
        verifyContentHash: () => {
          called = true;
          return true;
        },
      })
    );
    expect(called).toBe(false);
    expect(logger.joined()).not.toContain('content_hash');
  });
});
