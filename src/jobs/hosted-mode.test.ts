/**
 * f2 — reject any EXPLICITLY non-`standalone` `runner:` on a hosted run.
 *
 * Two layers, matching `hosted-mode.ts`'s own split:
 *   1. the PURE reader/guard (`readDeclaredRunner` / `assertHostedRunnerAllowed`)
 *      against a `FakeJobFs`, covering v2/v1, quoting, comments, indentation,
 *      and the declared-vs-defaulted distinction directly;
 *   2. the INTEGRATION story through `JobExecutor`, proving the rejection
 *      actually happens before any resource is provisioned (no credential
 *      resolution, no drive spawn), that a non-hosted run is untouched, and
 *      that nothing — no flag, no environment variable — bypasses it.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { DRIVE_COMPLETED, FakeJobExec, FakeJobFs, FrameSink, GIT_OK, makeLease } from './_helpers';
import { JobExecutor, type JobExecutorOptions } from './executor';
import {
  assertHostedRunnerAllowed,
  HOSTED_ONLY_RUNNER,
  LEGACY_MANIFEST_FILENAME,
  MANIFEST_FILENAME,
  readDeclaredRunner,
  RunnerModeRejectedError,
} from './hosted-mode';
import { HostedProviderCredential, type ProviderCredentialSource } from './standalone';
import { defaultResolveStartIteration } from './workspace';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.pipeline', 'release');
const V2_MANIFEST = join(PIPELINE_ROOT, MANIFEST_FILENAME);
const V1_MANIFEST = join(PIPELINE_ROOT, LEGACY_MANIFEST_FILENAME);

/** SYNTHETIC placeholder — never a real credential. */
const ORG_KEY = 'sk-ant-ORG-synthetic-0000000000';

// ---------------------------------------------------------------------------
// PURE: readDeclaredRunner / assertHostedRunnerAllowed against a FakeJobFs
// ---------------------------------------------------------------------------

function fsWith(path: string, content: string): FakeJobFs {
  const fs = new FakeJobFs();
  fs.files.set(path, content);
  return fs;
}

describe('f2 — readDeclaredRunner: the declared value, never the CLI-resolved default', () => {
  test('v2 pipeline.yml: a top-level runner: key is read verbatim', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nname: release\nrunner: manager\nsteps: []\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBe('manager');
  });

  test('v2 pipeline.yml: NO runner: key ⇒ null (not the CLI default "manager")', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nname: release\nsteps: []\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBeNull();
  });

  test('v2 pipeline.yml: declared standalone reads back exactly', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nrunner: standalone\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBe('standalone');
  });

  test('an indented runner: (nested under something else) is NOT a top-level declaration', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nsome_map:\n  runner: manager\nsteps: []\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBeNull();
  });

  test('a line merely mentioning "runner:" mid-value does not false-match', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\ndescription: "set runner: manager for prod"\nsteps: []\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBeNull();
  });

  test('quotes and a trailing comment are stripped', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nrunner: "manager"   # explicit choice\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBe('manager');
  });

  test('v1 PIPELINE.md: frontmatter runner: is read (v2 file absent)', () => {
    const fs = fsWith(V1_MANIFEST, '---\nexecution: sequential\nrunner: headless\n---\n\n# Body\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBe('headless');
  });

  test('v1 PIPELINE.md: no runner: frontmatter key ⇒ null', () => {
    const fs = fsWith(V1_MANIFEST, '---\nexecution: sequential\n---\n\n# Body\nrunner: manager\n');
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBeNull();
  });

  test('v2 takes priority when BOTH files exist', () => {
    const fs = new FakeJobFs();
    fs.files.set(V2_MANIFEST, 'schema: 2\n'); // no runner: key
    fs.files.set(V1_MANIFEST, '---\nrunner: manager\n---\n'); // would say manager
    expect(readDeclaredRunner(PIPELINE_ROOT, fs)).toBeNull();
  });

  test('neither manifest file exists ⇒ null, same as "absent"', () => {
    expect(readDeclaredRunner(PIPELINE_ROOT, new FakeJobFs())).toBeNull();
  });
});

describe('f2 — assertHostedRunnerAllowed', () => {
  test('absent runner: ⇒ allowed (defaults to standalone on hosted, not the CLI\'s manager)', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nname: release\nsteps: []\n');
    expect(() => assertHostedRunnerAllowed(PIPELINE_ROOT, fs)).not.toThrow();
  });

  test('declared standalone ⇒ allowed', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nrunner: standalone\n');
    expect(() => assertHostedRunnerAllowed(PIPELINE_ROOT, fs)).not.toThrow();
  });

  test('declared STANDALONE (any case) ⇒ allowed', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nrunner: STANDALONE\n');
    expect(() => assertHostedRunnerAllowed(PIPELINE_ROOT, fs)).not.toThrow();
  });

  for (const mode of ['session', 'manager', 'driver']) {
    test(`declared ${mode} ⇒ rejected, naming the mode and the alternative`, () => {
      const fs = fsWith(V2_MANIFEST, `schema: 2\nrunner: ${mode}\n`);
      let caught: unknown;
      try {
        assertHostedRunnerAllowed(PIPELINE_ROOT, fs);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RunnerModeRejectedError);
      const err = caught as RunnerModeRejectedError;
      expect(err.requested).toBe(mode);
      expect(err.message).toContain(mode); // names the requested mode
      expect(err.message).toContain(HOSTED_ONLY_RUNNER); // says only standalone runs hosted
      expect(err.message.toLowerCase()).toContain('locally'); // points at what the user can do
    });
  }

  test('v1 headless ⇒ rejected too (same mode as driver, different spelling)', () => {
    const fs = fsWith(V1_MANIFEST, '---\nrunner: headless\n---\n');
    expect(() => assertHostedRunnerAllowed(PIPELINE_ROOT, fs)).toThrow(RunnerModeRejectedError);
  });

  test('an unrecognized value is refused, not guessed at', () => {
    const fs = fsWith(V2_MANIFEST, 'schema: 2\nrunner: bogus\n');
    expect(() => assertHostedRunnerAllowed(PIPELINE_ROOT, fs)).toThrow(RunnerModeRejectedError);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: through JobExecutor — before any resource is provisioned
// ---------------------------------------------------------------------------

function readyFs(manifest?: { path: string; content: string }): FakeJobFs {
  const fs = new FakeJobFs();
  fs.existing.add(PIPELINE_ROOT);
  fs.listings.set(join(PIPELINE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);
  if (manifest) fs.files.set(manifest.path, manifest.content);
  return fs;
}

function driveExec(queue: (typeof DRIVE_COMPLETED)[]): FakeJobExec {
  return new FakeJobExec((cmd) => {
    if (cmd === 'git') return GIT_OK;
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
}

function makeWorld(fs: FakeJobFs, overrides: Partial<JobExecutorOptions> = {}) {
  const exec = overrides.exec !== undefined ? (overrides.exec as FakeJobExec) : driveExec([DRIVE_COMPLETED]);
  const sink = new FrameSink();
  const logger = new CaptureLogger();
  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    fs,
    clock: new FakeClock(),
    logger,
    makeId: () => 'q-1',
    resolveStartIteration: defaultResolveStartIteration,
    ...overrides,
    exec,
  });
  return { executor, exec, sink, logger };
}

describe('f2 — a hosted run is refused at the door, before any resource is provisioned', () => {
  test('explicit runner: manager ⇒ no credential resolved, no drive spawned', async () => {
    let credentialCalls = 0;
    const orgSource: ProviderCredentialSource = () => {
      credentialCalls += 1;
      return new HostedProviderCredential('deliver', ORG_KEY);
    };
    const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nrunner: manager\nsteps: []\n' });
    const { executor, exec } = makeWorld(fs, { hostedStandalone: { credential: orgSource }, exec: driveExec([]) });

    const result = await executor.start();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain("runner: manager");
    expect(result.ok ? '' : result.reason).toContain(HOSTED_ONLY_RUNNER);
    // THE RESOURCES: neither was touched.
    expect(credentialCalls).toBe(0);
    expect(exec.of('pipeline')).toHaveLength(0);
  });

  test('explicit runner: session and runner: driver are refused the same way', async () => {
    for (const mode of ['session', 'driver']) {
      const fs = readyFs({ path: V2_MANIFEST, content: `schema: 2\nrunner: ${mode}\nsteps: []\n` });
      const { executor, exec } = makeWorld(fs, {
        hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
        exec: driveExec([]),
      });
      const result = await executor.start();
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toContain(mode);
      expect(exec.of('pipeline')).toHaveLength(0);
    }
  });

  test('the halted run_status frame carries the same actionable reason', async () => {
    const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nrunner: manager\nsteps: []\n' });
    const { executor, sink } = makeWorld(fs, {
      hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
      exec: driveExec([]),
    });
    await executor.start();

    const halted = sink.ofType('run_status').find((f) => (f as { phase?: string }).phase === 'halted');
    expect(halted).toBeDefined();
    expect((halted as { halt_reason?: string }).halt_reason).toContain('manager');
  });
});

describe('f2 — a manifest that declares nothing is not a rejection', () => {
  test('no runner: key at all ⇒ runs hosted, as standalone', async () => {
    const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nname: release\nsteps: []\n' });
    const { executor, exec } = makeWorld(fs, {
      hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
    });

    const result = await executor.start();

    expect(result.ok).toBe(true);
    const drive = exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toContain('--executor');
    expect(drive[0]!.args[drive[0]!.args.indexOf('--executor') + 1]).toBe('claude-sdk');
  });

  test('explicit runner: standalone ⇒ runs hosted exactly the same way', async () => {
    const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nrunner: standalone\nsteps: []\n' });
    const { executor, exec } = makeWorld(fs, {
      hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
    });

    const result = await executor.start();

    expect(result.ok).toBe(true);
    expect(exec.of('pipeline')).toHaveLength(1);
  });

  test('no manifest file at all (defensive default) ⇒ still allowed through', async () => {
    const fs = readyFs(); // no pipeline.yml / PIPELINE.md seeded
    const { executor, exec } = makeWorld(fs, {
      hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
    });

    const result = await executor.start();

    expect(result.ok).toBe(true);
    expect(exec.of('pipeline')).toHaveLength(1);
  });
});

describe('f2 — a NON-hosted run is never subject to this check at all', () => {
  test('runner: manager on a local (non-hosted) run is untouched', async () => {
    const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nrunner: manager\nsteps: []\n' });
    const { executor, exec } = makeWorld(fs); // no hostedStandalone

    const result = await executor.start();

    expect(result.ok).toBe(true);
    const drive = exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).not.toContain('--executor');
  });
});

describe('f2 — no flag or environment variable bypasses the check', () => {
  test('plausible bypass-shaped environment variables change nothing', async () => {
    const bypassNames = [
      'PIPELINE_RUNNER_ALLOW_NONSTANDALONE',
      'PIPELINE_RUNNER_SKIP_MODE_CHECK',
      'PIPELINE_ALLOW_ALL_RUNNERS',
      'PIPELINE_RUNNER_FORCE_STANDALONE',
    ];
    const previous = new Map<string, string | undefined>();
    for (const name of bypassNames) {
      previous.set(name, process.env[name]);
      process.env[name] = '1';
    }
    try {
      const fs = readyFs({ path: V2_MANIFEST, content: 'schema: 2\nrunner: manager\nsteps: []\n' });
      const { executor, exec } = makeWorld(fs, {
        hostedStandalone: { credential: () => new HostedProviderCredential('d', ORG_KEY) },
        exec: driveExec([]),
      });

      const result = await executor.start();

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toContain('manager');
      expect(exec.of('pipeline')).toHaveLength(0);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('assertHostedRunnerAllowed takes no override parameter — the guard is pure', () => {
    // Structural proof, not just a runtime one: the function's arity is
    // exactly (pipelineRootAbs, fs) — there is nowhere for a bypass flag to
    // be threaded through even if a future edit tried to add one silently.
    expect(assertHostedRunnerAllowed.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// CROSS-REPOSITORY DRIFT TRIPWIRE
// ---------------------------------------------------------------------------

describe('f2 — constants that must match the CLI', () => {
  test('the manifest filenames are pinned', () => {
    // Mirrors `pipeline`'s `MANIFEST_FILENAME` (lib/manifest.ts) and its
    // hardcoded v1 fallback (lib/plan.ts). This package does not depend on
    // that one, so a rename there is silent here.
    expect(MANIFEST_FILENAME).toBe('pipeline.yml');
    expect(LEGACY_MANIFEST_FILENAME).toBe('PIPELINE.md');
    expect(HOSTED_ONLY_RUNNER).toBe('standalone');
  });
});
