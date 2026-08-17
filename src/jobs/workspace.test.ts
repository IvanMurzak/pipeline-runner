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
function readyFs(dir: string, pipelineRel = '.pipeline/release'): FakeJobFs {
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
  test('a bare name resolves under .pipeline/', () => {
    expect(pipelineRootRel('release')).toBe('.pipeline/release');
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
    expect(ws.pipelineRoot).toBe(join(dir, '.pipeline', 'release'));
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
    expect(seen).toEqual([[join(dir, '.pipeline', 'release'), 'sha-abc']]);
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
  const pipelineRoot = join(dir, '.pipeline', 'release');

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
  const pipelineRoot = join(dir, '.pipeline', 'release');

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
      steps: [
        { rel: '00-entry/01-start.md', path: join(pipelineRoot, 'steps', '00-entry', '01-start.md') },
        { rel: '01-helper.md', path: join(pipelineRoot, 'steps', '01-helper.md') },
      ],
    });
    const exec = new FakeJobExec((_cmd, args) => (args[0] === 'plan' ? { code: 0, stdout: planJson, stderr: '' } : GIT_OK));
    const ws = await prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined, pipelineBin: 'my-pipeline' }));

    expect(ws.startIteration).toBe('steps/00-entry/01-start.md'); // NOT 'steps/01-helper.md'
    const planCall = exec.calls.find((c) => c.args[0] === 'plan');
    expect(planCall?.cmd).toBe('my-pipeline');
    expect(planCall?.args).toEqual(['plan', '--root', pipelineRoot, '--json']);
  });

  // CONTRACT CHANGE (g1/B1) — these two used to assert the lexical FALLBACK.
  // They now assert a refusal, because the fallback is the D4-1 approval
  // bypass: it cannot see a body-less gate, so it silently enters at the next
  // step. See the `cliStartIterationResolver fails closed` block below for the
  // gate-shaped repros; these keep the original fixtures so the change of
  // posture on the ORIGINAL inputs is visible rather than implied.
  test('a CLI that predates `plan` (unknown command) is refused, not degraded', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'plan' ? { code: 2, stdout: '', stderr: "pipeline: unknown command 'plan'\n\nusage: ..." } : GIT_OK
    );
    const logger = new CaptureLogger();
    await expect(prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined, logger }))).rejects.toBeInstanceOf(
      JobError,
    );
    expect(logger.joined()).toContain('start-iteration resolution refused the job');
  });

  test('unparseable plan output is refused, not degraded', async () => {
    const exec = new FakeJobExec((_cmd, args) => (args[0] === 'plan' ? { code: 0, stdout: 'not json', stderr: '' } : GIT_OK));
    await expect(prepareWorkspace(options(graphFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(JobError);
  });
});

// ============================================================================
// g1 / B1 — entry resolution is a SECURITY boundary when step 1 is a gate.
//
// The lexical fallback picks the lexically-first `steps/*.md`. A body-less
// `type: gate` step has NO file under `steps/` at all — its plan path is the
// SYNTHETIC `steps/<name>.md` (pipeline-cli `manifest-plan.ts` dispatchPath) —
// so the lexical rule cannot see it and returns the NEXT step's body instead.
//
// The CLI then resolves that path perfectly well and dispatches that step. The
// gate is never dispatched, no `approval` marker reaches the wire, and the
// CLI-side g1 backstop cannot fire, because nothing was synthesized:
// resolution succeeded — on the wrong step. That is D4-1's outcome (an
// unapproved step executes) reached through the entry resolver rather than
// through path synthesis.
//
// So this resolver must FAIL CLOSED. `prepareWorkspace` refusing the job is a
// visible, recoverable failure; silently entering the pipeline one step past
// its approval gate is not.
// ============================================================================
describe('cliStartIterationResolver fails closed (g1/B1)', () => {
  const dir = join(ROOT, 'job-1');
  const pipelineRoot = join(dir, '.pipeline', 'release');

  /** D4-1's production shape: a manifest whose FIRST step is a body-less gate,
   *  followed by a normal agent step. Only the agent step has a file under
   *  `steps/` — which is exactly what makes the lexical rule skip the gate. */
  function gateFirstFs(): FakeJobFs {
    const fs = new FakeJobFs();
    fs.existing.add(pipelineRoot);
    fs.listings.set(join(pipelineRoot, 'steps'), ['02-ship.md']);
    return fs;
  }

  /** The plan the CLI reports for that pipeline — the gate first, carrying its
   *  synthetic path. */
  const gateFirstPlan = JSON.stringify({
    steps: [
      { step_id: 'approve-deploy', type: 'gate', rel: 'approve-deploy.md', path: join(pipelineRoot, 'steps', 'approve-deploy.md') },
      { step_id: 'ship', type: 'agent', rel: '02-ship.md', path: join(pipelineRoot, 'steps', '02-ship.md') },
    ],
  });

  const planFails = (result: { code: number | null; stdout: string; stderr: string }) =>
    new FakeJobExec((_cmd, args) => (args[0] === 'plan' ? result : GIT_OK));

  test('a NON-ZERO plan exit never silently selects a different entry step', async () => {
    // The exact bypass: pre-fix this resolved to 'steps/02-ship.md' and the run
    // began one step past its approval gate.
    const exec = planFails({ code: 1, stdout: gateFirstPlan, stderr: 'plan errors: ...' });
    await expect(prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
  });

  test('a plan carrying hard ERRORS is refused even though its JSON parses', async () => {
    // `pipeline plan` exits 1 on plan errors but still prints a usable-looking
    // plan. The exit code was never consulted, so the entry was taken anyway.
    const exec = planFails({ code: 1, stdout: gateFirstPlan, stderr: '' });
    await expect(
      prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined })),
    ).rejects.toThrow(/plan/i);
  });

  test('unparseable plan output is refused, not degraded to the lexical rule', async () => {
    const exec = planFails({ code: 0, stdout: 'not json', stderr: '' });
    await expect(prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
  });

  test('a CLI that predates `plan` is refused too — it also predates the g1 gate fix', async () => {
    // The old rationale kept a compat fallback here. It cannot be salvaged: a
    // CLI too old to have `plan --json` is also too old to have g1's gate
    // resolution, so a gate pipeline is unsafe on it either way. Degrading
    // preserved a silently-wrong configuration, not a working one.
    const exec = planFails({ code: 2, stdout: '', stderr: "pipeline: unknown command 'plan'\n\nusage: ..." });
    await expect(prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
  });

  test('a missing `pipeline` binary is refused', async () => {
    const exec = planFails({ code: 127, stdout: '', stderr: '' });
    await expect(prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
  });

  test('an empty plan is refused', async () => {
    const exec = planFails({ code: 0, stdout: JSON.stringify({ steps: [] }), stderr: '' });
    await expect(prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(
      JobError,
    );
  });

  test('the HAPPY path still resolves the gate itself as the entry', async () => {
    // Fail-closed must not mean fail-always: a healthy plan whose first step is
    // a body-less gate still enters AT the gate, on its synthetic path.
    const exec = planFails({ code: 0, stdout: gateFirstPlan, stderr: '' });
    const ws = await prepareWorkspace(options(gateFirstFs(), exec, { resolveStartIteration: undefined }));
    expect(ws.startIteration).toBe('steps/approve-deploy.md');
  });
});

// ============================================================================
// g1 / A6(a) — the entry is derived from the plan's own `path`, not from
// `steps/${rel}`.
//
// `rel` is only steps/-relative when the body lives under `steps/`
// (pipeline-cli `manifest-plan.ts` relLabel strips the prefix only then), so
// prefixing it unconditionally named a path that exists in NEITHER tree for a
// body declared anywhere else. `path` is absolute and unambiguous.
// ============================================================================
describe('entry resolution derives from the plan step path (g1/A6a)', () => {
  const dir = join(ROOT, 'job-1');
  const pipelineRoot = join(dir, '.pipeline', 'release');

  function fsFor(): FakeJobFs {
    const fs = new FakeJobFs();
    fs.existing.add(pipelineRoot);
    fs.listings.set(join(pipelineRoot, 'steps'), ['01-helper.md']);
    return fs;
  }

  async function entryFor(first: Record<string, unknown>): Promise<string> {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'plan' ? { code: 0, stdout: JSON.stringify({ steps: [first] }), stderr: '' } : GIT_OK,
    );
    const ws = await prepareWorkspace(options(fsFor(), exec, { resolveStartIteration: undefined }));
    return ws.startIteration;
  }

  // The three shapes where the OLD rule was already correct must stay
  // byte-identical — this change may only differ where the old rule was wrong.
  test('a body under steps/ is unchanged', async () => {
    expect(await entryFor({ rel: '01-plan.md', path: join(pipelineRoot, 'steps', '01-plan.md') })).toBe('steps/01-plan.md');
  });

  test('a nested body under steps/ is unchanged', async () => {
    expect(await entryFor({ rel: '00-entry/01-start.md', path: join(pipelineRoot, 'steps', '00-entry', '01-start.md') })).toBe(
      'steps/00-entry/01-start.md',
    );
  });

  test('a synthetic (body-less / multi-body) step path is unchanged', async () => {
    expect(await entryFor({ rel: 'compose.md', path: join(pipelineRoot, 'steps', 'compose.md') })).toBe('steps/compose.md');
  });

  // The shape the old rule got wrong.
  test('a body OUTSIDE steps/ resolves to its real path, not steps/<root-relative>', async () => {
    expect(await entryFor({ rel: 'prompts/foo.md', path: join(pipelineRoot, 'prompts', 'foo.md') })).toBe('prompts/foo.md');
  });

  test('a step path outside the pipeline root is refused rather than guessed at', async () => {
    const exec = new FakeJobExec((_cmd, args) =>
      args[0] === 'plan'
        ? { code: 0, stdout: JSON.stringify({ steps: [{ rel: 'x.md', path: join(dir, 'elsewhere', 'x.md') }] }), stderr: '' }
        : GIT_OK,
    );
    await expect(prepareWorkspace(options(fsFor(), exec, { resolveStartIteration: undefined }))).rejects.toBeInstanceOf(JobError);
  });
});
