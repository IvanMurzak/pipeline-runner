/**
 * f1 — hosted `standalone`: executor selection, the ORG provider key, and the
 * tenant-isolation guarantee.
 *
 * THE TEST THAT MATTERS MOST is "the ambient key is not used". Its failure
 * mode has no symptom: the run succeeds, the records are well-formed, and one
 * tenant's steps are billed to whatever balance this machine's environment
 * happened to point at. It is asserted twice on purpose — once at the overlay
 * the executor builds, and once through the REAL spawn seam against a REAL
 * child process, because the guarantee rests on how `{...process.env,
 * ...overlay}` treats an `undefined` value and that is a runtime behaviour,
 * not a type.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import {
  DRIVE_COMPLETED,
  driveAwaiting,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
} from './_helpers';
import { nodeJobExec, type JobExecResult } from './types';
import { JobExecutor, type JobExecutorOptions } from './executor';
import { defaultResolveStartIteration } from './workspace';
import { buildDriveArgs } from './drive';
import {
  describeHostedProviderKey,
  hostedDriveEnv,
  HOSTED_EXECUTOR,
  HostedCredentialError,
  HostedProviderCredential,
  PROVIDER_KEY_ENV,
  PROVIDER_KEY_HELPER_ENV,
  REDACTED,
  redactingLogger,
  resolveHostedCredential,
  revealHostedProviderKey,
  type ProviderCredentialSource,
} from './standalone';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.pipeline', 'release');

/** SYNTHETIC placeholders. Never a real credential — not in a fixture, not in
 *  a snapshot, not in a commit message (this task's standing rule). */
const ORG_KEY = 'sk-ant-ORG-synthetic-0000000000';
const AMBIENT_KEY = 'sk-ant-AMBIENT-synthetic-1111';

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

/** A source that hands back the org's key, as the secrets-delivery path would. */
const orgSource: ProviderCredentialSource = () => new HostedProviderCredential('ANTHROPIC_API_KEY', ORG_KEY);

function makeWorld(queue: JobExecResult[], overrides: Partial<JobExecutorOptions> = {}) {
  const exec = overrides.exec !== undefined ? (overrides.exec as FakeJobExec) : driveExec(queue);
  const sink = new FrameSink();
  const logger = new CaptureLogger();
  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    fs: readyFs(),
    clock: new FakeClock(),
    logger,
    makeId: () => 'q-1',
    resolveStartIteration: defaultResolveStartIteration,
    ...overrides,
    exec,
  });
  return { executor, exec, sink, logger };
}

// ---------------------------------------------------------------------------
// THE TENANT-ISOLATION GUARANTEE
// ---------------------------------------------------------------------------

describe('f1 — an ambient ANTHROPIC_API_KEY on the machine is never used', () => {
  test('the drive child is given the ORG key, not the machine one', async () => {
    // The machine carries a key (an operator leftover, a baked base image, a
    // pooled shell). It must lose to the org's, not race it.
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], {
      env: { [PROVIDER_KEY_ENV]: AMBIENT_KEY },
      hostedStandalone: { credential: orgSource },
    });
    await executor.start();

    const drive = exec.of('pipeline');
    expect(drive).toHaveLength(1);
    const env = drive[0]!.opts.env!;
    expect(env[PROVIDER_KEY_ENV]).toBe(ORG_KEY);
    expect(env[PROVIDER_KEY_ENV]).not.toBe(AMBIENT_KEY);
  });

  test('rung 2 is closed — a machine-configured key HELPER would outrank us', async () => {
    // The non-obvious half. `PIPELINE_API_KEY_HELPER` sits ABOVE the env var
    // in c1's ladder, so a helper configured on this machine would hand the
    // run somebody else's credential even though we supplied the org's.
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], {
      env: { [PROVIDER_KEY_HELPER_ENV]: 'op read op://vault/someone-elses/key' },
      hostedStandalone: { credential: orgSource },
    });
    await executor.start();

    const env = exec.of('pipeline')[0]!.opts.env!;
    expect(env[PROVIDER_KEY_HELPER_ENV]).toBeUndefined();
    expect(Object.hasOwn(env, PROVIDER_KEY_HELPER_ENV)).toBe(true); // present-but-undefined ⇒ omitted by spawn
    expect(env[PROVIDER_KEY_ENV]).toBe(ORG_KEY);
  });

  test('THROUGH THE REAL SPAWN SEAM: the child sees the org key and no ambient one', async () => {
    // The guarantee rests on `{...process.env, ...overlay}` plus spawn's
    // treatment of an `undefined` value. Asserted against a real child so a
    // future runtime change cannot silently un-do it.
    const credential = new HostedProviderCredential('deliver', ORG_KEY);
    const overlay = hostedDriveEnv(credential, {
      // Stand in for the machine's own environment.
      [PROVIDER_KEY_ENV]: AMBIENT_KEY,
      [PROVIDER_KEY_HELPER_ENV]: 'op read op://vault/someone-elses/key',
      UNRELATED_VAR: 'kept',
    });

    const probe =
      'console.log(JSON.stringify({' +
      `key: process.env.${PROVIDER_KEY_ENV} ?? '<<ABSENT>>',` +
      `helper: process.env.${PROVIDER_KEY_HELPER_ENV} ?? '<<ABSENT>>',` +
      "unrelated: process.env.UNRELATED_VAR ?? '<<ABSENT>>'}))";
    const result = await nodeJobExec().run(process.execPath, ['-e', probe], { env: overlay });

    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout.trim()) as Record<string, string>;
    expect(seen.key).toBe(ORG_KEY);
    expect(seen.helper).toBe('<<ABSENT>>'); // the higher rung really is closed
    expect(seen.unrelated).toBe('kept'); // and nothing else was disturbed
  });
});

// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------

describe('f1 — a hosted run without an org credential does not start', () => {
  test('no credential ⇒ the job fails and NO drive process is spawned', async () => {
    const { executor, exec } = makeWorld([], {
      env: { [PROVIDER_KEY_ENV]: AMBIENT_KEY },
      hostedStandalone: { credential: () => null },
    });
    const result = await executor.start();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('no org provider key is configured');
    // The whole point: it did not spawn and quietly use the machine's key.
    expect(exec.of('pipeline')).toHaveLength(0);
  });

  test('a delivery failure is fatal, and its message is never quoted back', async () => {
    // A secrets-delivery error is a plausible place for a secret (or a URL
    // carrying one) to appear. c1 discards helper output for the same reason.
    const leaky = () => {
      throw new Error(`vault said: ${ORG_KEY} is not readable`);
    };
    const { executor, logger } = makeWorld([], { hostedStandalone: { credential: leaky } });
    const result = await executor.start();

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).not.toContain(ORG_KEY);
    expect(logger.joined()).not.toContain(ORG_KEY);
  });

  test('an empty value is refused rather than passed on as a key', () => {
    expect(() => new HostedProviderCredential('deliver', '   ')).toThrow(HostedCredentialError);
  });
});

// ---------------------------------------------------------------------------
// EXECUTOR SELECTION
// ---------------------------------------------------------------------------

describe('f1 — the hosted runner selects --executor=claude-sdk', () => {
  test('the start invocation carries the flag', async () => {
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], { hostedStandalone: { credential: orgSource } });
    await executor.start();

    const args = exec.of('pipeline')[0]!.args;
    expect(args).toContain('--executor');
    expect(args[args.indexOf('--executor') + 1]).toBe('claude-sdk');
  });

  test('EVERY re-entry carries it too — a resume must not decay to claude-cli', async () => {
    // The failure this guards: a parked run resumes, the flag is gone, and a
    // mode whose premise is "no claude binary here" silently requires one.
    const { executor, exec } = makeWorld([driveAwaiting(), DRIVE_COMPLETED], {
      hostedStandalone: { credential: orgSource },
      needsInput: { onQuestion: () => 'use host-a' },
    });
    await executor.start();

    const drives = exec.of('pipeline');
    expect(drives).toHaveLength(2);
    for (const call of drives) {
      expect(call.args).toContain('--executor');
      expect(call.args[call.args.indexOf('--executor') + 1]).toBe('claude-sdk');
      // …and the key rides every invocation, not just the first.
      expect(call.opts.env![PROVIDER_KEY_ENV]).toBe(ORG_KEY);
    }
    // The answer invocation is the resume shape, so this really is a re-entry.
    expect(drives[1]!.args).toContain('--resume');
    expect(drives[1]!.args).toContain('--answer');
  });

  test('buildDriveArgs: absent executor ⇒ argv byte-identical to before f1', () => {
    const target = { pipelineRoot: '/w/p', runId: 'run-1' };
    expect(buildDriveArgs(target, { kind: 'start', startIteration: 'steps/01.md' })).toEqual([
      'drive',
      '--root',
      '/w/p',
      '--run-id',
      'run-1',
      '--start',
      'steps/01.md',
      '--json',
    ]);
    expect(buildDriveArgs({ ...target, executor: '  ' }, { kind: 'resume' })).not.toContain('--executor');
  });
});

describe('f1 — a NON-hosted runner is completely unchanged', () => {
  test('no --executor flag and no env overlay', async () => {
    const { executor, exec } = makeWorld([DRIVE_COMPLETED]); // no hostedStandalone
    await executor.start();

    const call = exec.of('pipeline')[0]!;
    expect(call.args).not.toContain('--executor');
    expect(call.opts.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NO KEY REACHES A LOG
// ---------------------------------------------------------------------------

describe('f1 — the key value reaches no log', () => {
  test('the holder redacts every stringification path', () => {
    const cred = new HostedProviderCredential('deliver', ORG_KEY);

    expect(JSON.stringify({ nested: { cred } })).not.toContain(ORG_KEY);
    expect(JSON.stringify({ nested: { cred } })).toContain(REDACTED);
    expect(`${cred}`).toBe(REDACTED);
    expect(String(cred)).toBe(REDACTED);
    expect(Bun.inspect(cred)).not.toContain(ORG_KEY);
    // The secret is not an own property, so no spread or entries walk finds it.
    expect(JSON.stringify({ ...cred })).not.toContain(ORG_KEY);
    expect(Object.values(cred).join()).not.toContain(ORG_KEY);
    // …and the one boundary still works.
    expect(revealHostedProviderKey(cred)).toBe(ORG_KEY);
  });

  test('describe prints the LENGTH, never the content', () => {
    const cred = new HostedProviderCredential('deliver', ORG_KEY);
    const described = describeHostedProviderKey(cred);
    expect(described).not.toContain(ORG_KEY);
    expect(described).toContain(`${Buffer.byteLength(ORG_KEY, 'utf-8')} bytes`);
  });

  test('the hosted run logs the selection without the key', async () => {
    const { executor, logger } = makeWorld([DRIVE_COMPLETED], { hostedStandalone: { credential: orgSource } });
    await executor.start();

    expect(logger.joined()).not.toContain(ORG_KEY);
    expect(logger.joined()).toContain('hosted standalone');
    expect(logger.joined()).toContain(`--executor=${HOSTED_EXECUTOR}`);
  });

  test('text DERIVED from drive output is redacted before it is logged', async () => {
    // `classifyDriveOutcome` quotes drive's first stderr line into a usage
    // error reason, which then reaches `logger.warn`. If a key ever survives
    // the child's own scrubber, the runner's second layer catches it here.
    const leakingUsageError: JobExecResult = {
      code: 2,
      stdout: '',
      stderr: `pipeline drive: bad flag near ${ORG_KEY}`,
    };
    const { executor, logger } = makeWorld([leakingUsageError], { hostedStandalone: { credential: orgSource } });
    await executor.start();

    expect(logger.joined()).not.toContain(ORG_KEY);
    expect(logger.joined()).toContain(REDACTED);
  });

  test('redactingLogger scrubs every level', () => {
    const cred = new HostedProviderCredential('deliver', ORG_KEY);
    const inner = new CaptureLogger();
    const log = redactingLogger(inner, cred);
    log.debug(`d ${ORG_KEY}`);
    log.info(`i ${ORG_KEY}`);
    log.warn(`w ${ORG_KEY}`);
    log.error(`e ${ORG_KEY}`);
    expect(inner.joined()).not.toContain(ORG_KEY);
    expect(inner.lines).toHaveLength(4);
    for (const line of inner.lines) expect(line).toContain(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// THE OVERLAY ITSELF
// ---------------------------------------------------------------------------

describe('f1 — hostedDriveEnv', () => {
  test('a caller base rides along but cannot re-open either rung', async () => {
    const cred = new HostedProviderCredential('deliver', ORG_KEY);
    const env = hostedDriveEnv(cred, {
      PP_THING: 'kept',
      [PROVIDER_KEY_ENV]: AMBIENT_KEY,
      [PROVIDER_KEY_HELPER_ENV]: 'op read op://vault/x',
    });
    expect(env.PP_THING).toBe('kept');
    expect(env[PROVIDER_KEY_ENV]).toBe(ORG_KEY);
    expect(env[PROVIDER_KEY_HELPER_ENV]).toBeUndefined();
  });

  test('resolveHostedCredential rejects null without a fallback rung', async () => {
    await expect(
      resolveHostedCredential(() => null, { jobId: 'job-1', runId: 'run-1', jobJwt: 'j', secretSlugs: [] }),
    ).rejects.toThrow(HostedCredentialError);
  });
});

// ---------------------------------------------------------------------------
// CROSS-REPOSITORY DRIFT TRIPWIRES
// ---------------------------------------------------------------------------

describe('f1 — constants that must match the CLI', () => {
  test('the ladder variable names are pinned', () => {
    // These mirror `pipeline`'s src/lib/provider-key.ts. This package does not
    // depend on that one, so a rename there is silent here — and the failure
    // is that we stop closing rung 2 while still believing we do. A real
    // cross-repo assertion belongs in the superproject's tests/cross-repo/.
    expect(PROVIDER_KEY_ENV).toBe('ANTHROPIC_API_KEY');
    expect(PROVIDER_KEY_HELPER_ENV).toBe('PIPELINE_API_KEY_HELPER');
    expect(HOSTED_EXECUTOR).toBe('claude-sdk');
  });

  test('TRIPWIRE: settingSources cannot be pinned from this repository yet', async () => {
    // DoD item 3 (`settingSources: ["project"]`, E9) is NOT satisfied by this
    // task and cannot be: the runner reaches the SDK only by spawning
    // `pipeline drive`, and the CLI exposes no flag or environment variable
    // that maps onto the SDK option — `commands/drive.ts` builds its SDK
    // seams without it, though `sdkDriveSeams` accepts it.
    //
    // WHEN THE CLI GAINS THAT SURFACE, this test must be REPLACED by the real
    // assertion the DoD asks for: plant a `user`-scope agent and prove the
    // hosted run does not load it. Until then it fails loudly if someone
    // believes the flag is already being sent. See docs/hosted-standalone.md.
    const { executor, exec } = makeWorld([DRIVE_COMPLETED], { hostedStandalone: { credential: orgSource } });
    await executor.start();

    const args = exec.of('pipeline')[0]!.args.join(' ');
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--settingSources');
  });
});
