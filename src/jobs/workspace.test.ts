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

/** Baseline options. `resolveStartIteration` defaults to the plain LEXICAL
 *  resolver — tests unrelated to c4's plan-based default (the git-checkout
 *  mechanics, hash verification, etc.) should not incidentally also shell
 *  `pipeline plan`. Pass `{ resolveStartIteration: undefined }` in `extra` to
 *  exercise the REAL default (`cliStartIterationResolver`) instead — an
 *  explicit `undefined` key in a later spread always wins over this baseline. */
function options(fs: FakeJobFs, exec: FakeJobExec, extra: Partial<PrepareWorkspaceOptions> = {}): PrepareWorkspaceOptions {
  return {
    jobId: 'job-1',
    ref: makeLease().pipeline_ref,
    root: ROOT,
    exec,
    fs,
    resolveStartIteration: defaultResolveStartIteration,
    ...extra,
  };
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

// c4 — 06.4: the DEFAULT verifyContentHash shells `pipelineBin`'s
// `hash --root <abs> --json` (the SAME binary drive uses) and compares
// against the pin. Exercises the TRUE default (no `verifyContentHash`
// override), unlike the direct-injection tests above.
describe('prepareWorkspace — default content-hash verifier (cliContentHashVerifier)', () => {
  const dir = join(ROOT, 'job-1');
  const pipelineRoot = join(dir, '.claude', 'pipeline', 'release');

  test('a match passes, shelling the same pipelineBin drive uses', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'hash' ? { code: 0, stdout: JSON.stringify({ content_hash: 'sha256:abc' }), stderr: '' } : GIT_OK
    );
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha256:abc' };
    const ws = await prepareWorkspace(options(readyFs(dir), exec, { ref, pipelineBin: 'my-pipeline' }));
    expect(ws.pipelineRoot).toBe(pipelineRoot);
    const hashCall = exec.calls.find((c) => c.args[0] === 'hash');
    expect(hashCall?.cmd).toBe('my-pipeline');
    expect(hashCall?.args).toEqual(['hash', '--root', pipelineRoot, '--json']);
  });

  test('a mismatch fails prep closed with the exact F7 reason string', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'hash' ? { code: 0, stdout: JSON.stringify({ content_hash: 'sha256:actual' }), stderr: '' } : GIT_OK
    );
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha256:expected' };
    await expect(prepareWorkspace(options(readyFs(dir), exec, { ref }))).rejects.toThrow(
      'content hash mismatch (expected sha256:expected, got sha256:actual)'
    );
  });

  test('a CLI predating `hash` (unknown command) warns and proceeds — compat', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'hash' ? { code: 2, stdout: '', stderr: "pipeline: unknown command 'hash'\n\nusage: ..." } : GIT_OK
    );
    const logger = new CaptureLogger();
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha256:expected' };
    const ws = await prepareWorkspace(options(readyFs(dir), exec, { ref, logger }));
    expect(ws.pipelineRoot).toBe(pipelineRoot); // prep proceeded, did not throw
    expect(logger.joined()).toContain('content_hash sha256:expected not verified, proceeding');
  });

  test('a missing `pipeline` binary (spawn ENOENT, code 127) is compat too', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'hash' ? { code: 127, stdout: '', stderr: '', error: 'spawn pipeline ENOENT' } : GIT_OK
    );
    const logger = new CaptureLogger();
    const ref = { ...makeLease().pipeline_ref, content_hash: 'sha256:expected' };
    await prepareWorkspace(options(readyFs(dir), exec, { ref, logger }));
    expect(logger.joined()).toContain('not verified, proceeding');
  });
});

// c4 — 06.5: the DEFAULT resolveStartIteration shells `pipelineBin`'s
// `plan --root <abs> --json` and takes the plan's first enumerated step
// (computePlan is the single ordering/graph-entry/target-family authority),
// instead of the flat lexical rule.
describe('prepareWorkspace — default start-iteration resolver (cliStartIterationResolver)', () => {
  const dir = join(ROOT, 'job-1');
  const pipelineRoot = join(dir, '.claude', 'pipeline', 'release');

  /** A pipeline whose top-level `steps/*.md` is a DECOY: the real entry (as
   *  a graph/target-family pipeline might organize its routing steps) lives
   *  nested one level down — invisible to the flat, non-recursive lexical
   *  rule. If resolution fell back to `defaultResolveStartIteration` here it
   *  would (wrongly) pick `01-helper.md`. */
  function graphFs(): FakeJobFs {
    const fs = new FakeJobFs();
    fs.existing.add(pipelineRoot);
    fs.listings.set(join(pipelineRoot, 'steps'), ['01-helper.md']);
    return fs;
  }

  test("resolves the plan's entry step over the lexical rule (graph/target-family fixture)", async () => {
    const planJson = JSON.stringify({
      steps: [{ rel: '00-entry/01-start.md' }, { rel: '01-helper.md' }],
    });
    const exec = new FakeJobExec((_cmd, args) => (args[0] === 'plan' ? { code: 0, stdout: planJson, stderr: '' } : GIT_OK));
    const ws = await prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined, pipelineBin: 'my-pipeline' }));

    expect(ws.startIteration).toBe('steps/00-entry/01-start.md'); // NOT 'steps/01-helper.md'
    const planCall = exec.calls.find((c) => c.args[0] === 'plan');
    expect(planCall?.cmd).toBe('my-pipeline');
    expect(planCall?.args).toEqual(['plan', '--root', pipelineRoot, '--json']);
  });

  test('falls back to the lexical rule when the CLI predates `plan` (unknown command)', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'plan' ? { code: 2, stdout: '', stderr: "pipeline: unknown command 'plan'\n\nusage: ..." } : GIT_OK
    );
    const logger = new CaptureLogger();
    const ws = await prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined, logger }));

    expect(ws.startIteration).toBe('steps/01-helper.md');
    expect(logger.joined()).toContain('falling back to the lexical entry rule');
  });

  test('falls back to the lexical rule on unparseable plan output', async () => {
    const exec = new FakeJobExec((_cmd, args) => (args[0] === 'plan' ? { code: 0, stdout: 'not json', stderr: '' } : GIT_OK));
    const ws = await prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined }));
    expect(ws.startIteration).toBe('steps/01-helper.md');
  });
});
