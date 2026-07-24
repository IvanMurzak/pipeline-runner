/**
 * `ContainerAdapter` tests (department-mesh, task d8). Two halves:
 *
 *   1. The shared `AgentRuntimeAdapter` conformance suite (`./_adapter-
 *      conformance.ts`) run UNCHANGED against `ContainerAdapter` — proves the
 *      JSONL contract and every d1/d2 behavior (kill escalation, cancel,
 *      probe, malformed-line tolerance, …) survive the container wrapping
 *      byte-for-byte, exactly the DoD's "adapter conformance suite passes
 *      against the container adapter unchanged".
 *   2. `container`-specific coverage: spec validation, `docker run` argv
 *      construction (read-only root, explicit mounts, egress allowlist,
 *      per-execution workspace), the R14 availability probe, and the
 *      explicit container-teardown seam. This is the SPEC-LEVEL escape-
 *      attempt coverage the task prompt allows in place of a live Docker
 *      sandbox test in this headless environment — see the `docker run argv
 *      construction` describe block below. A live escape/read-only-root/
 *      egress-allowlist assertion against a REAL container runtime is
 *      explicitly DEFERRED to the `e2`/release-gate verification pass (no
 *      Docker available in this environment) — nothing here fakes that.
 */

import { join, relative, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { FakeJobExec, FakeJobFs, GIT_OK } from '../jobs/_helpers';
import type { InvocationEnvelope, RuntimeConfig } from './adapter';
import { RuntimeAdapterError, type ContainerSpec } from './adapter';
import { runAdapterConformanceSuite, type ConformanceInvocationOverrides } from './_adapter-conformance';
import { FakeJobSpawn, makeTaskSpec } from './_test-helpers';
import {
  buildContainerArgs,
  ContainerAdapter,
  DEFAULT_TMPFS_SIZE_MB,
  DEFAULT_WORKSPACE_CONTAINER_PATH,
  EGRESS_ALLOWLIST_LABEL,
  nodeContainerRuntimeControl,
  probeContainerRuntimeAvailable,
} from './container';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeContainerSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return { image: 'ghcr.io/example/unity-department:1.0', mounts: [], ...overrides };
}

function makeContainerRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    adapterId: 'container',
    command: 'unity-department',
    args: ['--stdio'],
    startupTimeoutSeconds: 5,
    container: makeContainerSpec(),
    ...overrides,
  };
}

/** Deep-merges `overrides.runtime` over the container defaults — see
 *  `./_adapter-conformance.ts`'s doc for why this differs from
 *  `./_test-helpers.ts`'s own (wholesale-replace) `makeInvocation`. */
function makeContainerInvocation(overrides: ConformanceInvocationOverrides = {}): InvocationEnvelope {
  const { runtime: runtimeOverrides, task, ...rest } = overrides;
  return {
    ...rest,
    runtime: makeContainerRuntimeConfig(runtimeOverrides),
    task: task ?? makeTaskSpec(),
  };
}

/** Not a real absolute path on every OS (fine — `FakeJobFs`/`FakeJobSpawn`
 *  never touch a real filesystem) but run through the SAME `node:path.join`
 *  the adapter itself uses, so expectations built via `workspacePathFor`
 *  below match byte-for-byte on both `ubuntu-latest` and `windows-latest` CI
 *  (join()'s separator is platform-dependent — a hardcoded forward-slash
 *  literal would fail on Windows). */
const WORKSPACE_ROOT = join('/data', 'department', 'container-workspaces');

function workspacePathFor(taskId: string): string {
  return join(WORKSPACE_ROOT, taskId);
}

function makeHarness(): { adapter: ContainerAdapter; spawner: FakeJobSpawn; clock: FakeClock; logger: CaptureLogger; fs: FakeJobFs; exec: FakeJobExec } {
  const spawner = new FakeJobSpawn();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const fs = new FakeJobFs();
  const exec = new FakeJobExec(() => GIT_OK);
  const adapter = new ContainerAdapter({
    spawn: spawner,
    clock,
    logger,
    fs,
    control: nodeContainerRuntimeControl(exec),
    workspaceRoot: WORKSPACE_ROOT,
    makeId: (() => {
      let n = 0;
      return () => `id${n++}`;
    })(),
  });
  return { adapter, spawner, clock, logger, fs, exec };
}

// ── 1. Shared adapter conformance suite (d1, unchanged) ────────────────────

runAdapterConformanceSuite('ContainerAdapter', () => makeHarness(), makeContainerInvocation);

// ── 2. container-specific coverage ─────────────────────────────────────────

describe('ContainerAdapter — refuses to run unsandboxed', () => {
  test('start() rejects when RuntimeConfig.container is missing', async () => {
    const { adapter } = makeHarness();
    const invocation = makeContainerInvocation({ runtime: { container: undefined } });
    await expect(adapter.start(invocation, () => {})).rejects.toBeInstanceOf(RuntimeAdapterError);
    await expect(adapter.start(invocation, () => {})).rejects.toThrow(/missing 'container'/);
  });

  test('probe() returns ok:false (not a throw) when RuntimeConfig.container is missing', async () => {
    const { adapter } = makeHarness();
    const config = makeContainerRuntimeConfig({ container: undefined });
    const result = await adapter.probe(config);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("missing 'container'") as unknown as string });
  });
});

describe('ContainerAdapter — delegates to a real docker run invocation', () => {
  test("start() spawns 'docker' (not the department's own command) with --read-only, explicit mounts, and the workspace mounted", async () => {
    const { adapter, spawner, fs } = makeHarness();
    const invocation = makeContainerInvocation({
      runtime: {
        container: makeContainerSpec({ mounts: [{ hostPath: '/host/creds', containerPath: '/creds', readOnly: true }] }),
      },
      task: makeTaskSpec({ taskId: 'dtask-container-1' }),
    });
    const startPromise = adapter.start(invocation, () => {});
    const call = spawner.calls[0];
    expect(call.cmd).toBe('docker');
    expect(call.args).toContain('run');
    expect(call.args).toContain('--read-only');
    expect(call.args).toContain('--network');
    expect(call.args[call.args.indexOf('--network') + 1]).toBe('none'); // no allowlist declared
    expect(call.args).toContain('--cap-drop');
    expect(call.args).toContain('--security-opt');
    // Explicit mount + auto workspace mount — nothing else.
    const vIndices = call.args.reduce<number[]>((acc, a, i) => (a === '-v' ? [...acc, i] : acc), []);
    expect(vIndices.length).toBe(2);
    expect(call.args).toContain('/host/creds:/creds:ro');
    expect(call.args).toContain(`${workspacePathFor('dtask-container-1')}:${DEFAULT_WORKSPACE_CONTAINER_PATH}`);
    // The department's OWN command/args land AFTER the image, unchanged.
    const imageIdx = call.args.indexOf('ghcr.io/example/unity-department:1.0');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(call.args.slice(imageIdx + 1)).toEqual(['unity-department', '--stdio']);
    // The per-execution workspace directory was actually created.
    expect(fs.made).toContain(workspacePathFor('dtask-container-1'));

    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;
  });

  test('every -v flag traces to an explicit mount or the workspace — never an implicit whole-filesystem mount', async () => {
    const { adapter, spawner } = makeHarness();
    const invocation = makeContainerInvocation({
      runtime: {
        container: makeContainerSpec({
          mounts: [
            { hostPath: '/host/a', containerPath: '/a' },
            { hostPath: '/host/b', containerPath: '/b', readOnly: true },
          ],
        }),
      },
    });
    const startPromise = adapter.start(invocation, () => {});
    const call = spawner.calls[0];
    const mountValues = call.args.filter((_, i) => call.args[i - 1] === '-v');
    expect(mountValues.length).toBe(3); // 2 explicit + 1 workspace
    expect(mountValues.some((v) => v.startsWith('/host/a:/a'))).toBe(true);
    expect(mountValues.some((v) => v === '/host/b:/b:ro')).toBe(true);
    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;
  });

  test('config.env becomes -e flags; the daemon host env is never forwarded into the container', async () => {
    const { adapter, spawner } = makeHarness();
    const originalHostVar = process.env.PIPELINE_RUNNER_CONTAINER_TEST_LEAK;
    process.env.PIPELINE_RUNNER_CONTAINER_TEST_LEAK = 'should-not-appear';
    try {
      const invocation = makeContainerInvocation({ runtime: { env: { UNITY_LICENSE: 'abc123' } } });
      const startPromise = adapter.start(invocation, () => {});
      const call = spawner.calls[0];
      expect(call.args).toContain('-e');
      expect(call.args[call.args.indexOf('-e') + 1]).toBe('UNITY_LICENSE=abc123');
      expect(call.args.join(' ')).not.toContain('PIPELINE_RUNNER_CONTAINER_TEST_LEAK');
      expect(call.args.join(' ')).not.toContain('should-not-appear');
      spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      await startPromise;
    } finally {
      if (originalHostVar === undefined) delete process.env.PIPELINE_RUNNER_CONTAINER_TEST_LEAK;
      else process.env.PIPELINE_RUNNER_CONTAINER_TEST_LEAK = originalHostVar;
    }
  });

  test('two starts for the same taskId reuse the workspace directory but mint distinct container names', async () => {
    const { adapter, spawner, fs } = makeHarness();
    const invocation = makeContainerInvocation({ task: makeTaskSpec({ taskId: 'dtask-respawn' }) });

    const startPromise1 = adapter.start(invocation, () => {});
    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise1;
    const firstName = spawner.calls[0].args[spawner.calls[0].args.indexOf('--name') + 1];

    const startPromise2 = adapter.start(invocation, () => {});
    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise2;
    const secondName = spawner.calls[1].args[spawner.calls[1].args.indexOf('--name') + 1];

    expect(firstName).not.toBe(secondName);
    // mkdirp is idempotent and was called for the SAME workspace path both
    // times (never wiped/removed between respawns — see the module doc).
    expect(fs.made.filter((p) => p === workspacePathFor('dtask-respawn')).length).toBe(2);
    expect(fs.removed).toEqual([]);
  });

  test("a taskId of '..' (or any id that sanitizes to nothing but dots/dashes) never escapes the workspace root — path-traversal guard", async () => {
    const { adapter, spawner, fs } = makeHarness();
    for (const dangerousTaskId of ['..', '.', '...', '--', '../../etc']) {
      const invocation = makeContainerInvocation({ task: makeTaskSpec({ taskId: dangerousTaskId }) });
      const startPromise = adapter.start(invocation, () => {});
      spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      await startPromise;
    }
    // Every mkdirp call stayed strictly AT OR UNDER the configured workspace
    // root — never resolved to its parent or above (a relative path that
    // starts with '..' means it escaped upward).
    expect(fs.made.length).toBeGreaterThan(0);
    for (const made of fs.made) {
      // A genuine escape shows up as a relative path of EXACTLY '..' or one
      // that starts with '..' + the path separator (e.g. '../x') — NOT as a
      // naive string prefix, which would misfire on an harmless single
      // SEGMENT name like '..-..-etc' (no separator in it at all, so it can
      // never navigate anywhere — just an odd folder name directly under root).
      const rel = relative(WORKSPACE_ROOT, made);
      expect(rel === '..' || rel.startsWith(`..${sep}`)).toBe(false);
    }
    // The pure dot/dash ids collapse to the SAME safe fallback directory
    // (harmless collision — a random container-name suffix still keeps
    // concurrent containers distinct) rather than 4 different escaped paths.
    expect(fs.made.filter((p) => p === join(WORKSPACE_ROOT, 'x')).length).toBe(4);
  });

  test('dispose() removes the container via the control seam, independent of the docker CLI process handling', async () => {
    const { adapter, spawner, exec } = makeHarness();
    const invocation = makeContainerInvocation();
    const startPromise = adapter.start(invocation, () => {});
    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;

    const disposePromise = adapter.dispose(handle);
    spawner.last.emitExit({ code: 0 });
    await disposePromise;

    const rmCalls = exec.of('docker').filter((c) => c.args[0] === 'rm');
    expect(rmCalls.length).toBe(1);
    expect(rmCalls[0].args).toEqual(['rm', '-f', expect.stringContaining('pipeline-dept-') as unknown as string]);
  });

  test('probe() also removes the container as a cleanup net', async () => {
    const { adapter, spawner, exec } = makeHarness();
    const probePromise = adapter.probe(makeContainerRuntimeConfig());
    spawner.last.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await probePromise;
    const rmCalls = exec.of('docker').filter((c) => c.args[0] === 'rm');
    expect(rmCalls.length).toBe(1);
  });
});

describe('ContainerAdapter — process-tier work is never forced into a container', () => {
  test('a jsonl-process RuntimeConfig (no container field) is simply not this adapter\'s concern — the manager routes by adapterId', async () => {
    // ContainerAdapter never sees a process-tier config at all in practice
    // (`DepartmentManager` looks the adapter up by `RuntimeConfig.adapterId`
    // — `./manager.ts`); this test documents that even if it somehow did, it
    // still refuses rather than silently running the department unsandboxed.
    const { adapter } = makeHarness();
    const processConfig: RuntimeConfig = { adapterId: 'jsonl-process', command: 'unity-department', args: ['--stdio'] };
    const result = await adapter.probe(processConfig);
    expect(result.ok).toBe(false);
  });
});

// ── buildContainerArgs — pure argv construction (spec-level escape-attempt
//    coverage; live Docker verification deferred — see the module doc) ─────

describe('buildContainerArgs — read-only root, explicit mounts, egress allowlist (spec-level)', () => {
  const base = { command: 'dept-bin', args: ['--flag'], containerName: 'pipeline-dept-x-id0', workspaceHostPath: '/ws/x' };

  test('always includes --read-only, --cap-drop=ALL, --security-opt=no-new-privileges', () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec() });
    expect(args).toContain('--read-only');
    expect(args.join(' ')).toContain('--cap-drop ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
  });

  test('gives a bounded tmpfs /tmp so --read-only stays usable, sized from the spec', () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec({ tmpfsSizeMb: 128 }) });
    expect(args.join(' ')).toContain('--tmpfs /tmp:rw,noexec,nosuid,size=128m');
  });

  test(`defaults the tmpfs size to ${DEFAULT_TMPFS_SIZE_MB}m`, () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec() });
    expect(args.join(' ')).toContain(`size=${DEFAULT_TMPFS_SIZE_MB}m`);
  });

  test('no egressAllowlist ⇒ --network none, and no allowlist label', () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec() });
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).not.toContain('--label');
  });

  test('a non-empty egressAllowlist without egressNetwork fails CLOSED (refuses to build, never attaches to an unenforced default network)', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ egressAllowlist: [{ host: 'api.example.com' }] }) })
    ).toThrow(RuntimeAdapterError);
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ egressAllowlist: [{ host: 'api.example.com' }] }) })
    ).toThrow(/egressNetwork/);
  });

  test('a non-empty egressAllowlist WITH egressNetwork attaches to that network and carries the allowlist as a label', () => {
    const { args } = buildContainerArgs({
      ...base,
      spec: makeContainerSpec({ egressAllowlist: [{ host: 'api.example.com', port: 443 }], egressNetwork: 'dept-egress-net' }),
    });
    expect(args[args.indexOf('--network') + 1]).toBe('dept-egress-net');
    const labelIdx = args.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    expect(args[labelIdx + 1]).toBe(`${EGRESS_ALLOWLIST_LABEL}=${JSON.stringify([{ host: 'api.example.com', port: 443 }])}`);
  });

  test('an egressAllowlist entry with an empty host is rejected', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ egressAllowlist: [{ host: '' }], egressNetwork: 'net' }) })
    ).toThrow(RuntimeAdapterError);
  });

  test('a missing image is rejected', () => {
    expect(() => buildContainerArgs({ ...base, spec: makeContainerSpec({ image: '' }) })).toThrow(/image is required/);
  });

  test('a mount missing hostPath is rejected', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ mounts: [{ hostPath: '', containerPath: '/x' }] }) })
    ).toThrow(RuntimeAdapterError);
  });

  test('a mount with a relative containerPath is rejected', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ mounts: [{ hostPath: '/h', containerPath: 'relative/path' }] }) })
    ).toThrow(/absolute container path/);
  });

  test('a mount targeting the container root (/) is rejected', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ mounts: [{ hostPath: '/h', containerPath: '/' }] }) })
    ).toThrow(/container root/);
  });

  test('a mount colliding with the auto-provisioned workspace containerPath is rejected as a duplicate', () => {
    expect(() =>
      buildContainerArgs({ ...base, spec: makeContainerSpec({ mounts: [{ hostPath: '/h', containerPath: DEFAULT_WORKSPACE_CONTAINER_PATH }] }) })
    ).toThrow(/duplicate mount/);
  });

  test('two mounts targeting the same containerPath are rejected as a duplicate', () => {
    expect(() =>
      buildContainerArgs({
        ...base,
        spec: makeContainerSpec({
          mounts: [
            { hostPath: '/h1', containerPath: '/shared' },
            { hostPath: '/h2', containerPath: '/shared' },
          ],
        }),
      })
    ).toThrow(/duplicate mount/);
  });

  test('workdir defaults to the workspace container path, overridable via spec.workdir', () => {
    const noOverride = buildContainerArgs({ ...base, spec: makeContainerSpec() });
    expect(noOverride.args[noOverride.args.indexOf('-w') + 1]).toBe(DEFAULT_WORKSPACE_CONTAINER_PATH);

    const withOverride = buildContainerArgs({ ...base, spec: makeContainerSpec({ workdir: '/app' }) });
    expect(withOverride.args[withOverride.args.indexOf('-w') + 1]).toBe('/app');
  });

  test('runtimeBinary defaults to docker, overridable to podman (same flag surface)', () => {
    expect(buildContainerArgs({ ...base, spec: makeContainerSpec() }).runtimeBinary).toBe('docker');
    expect(buildContainerArgs({ ...base, spec: makeContainerSpec({ runtimeBinary: 'podman' }) }).runtimeBinary).toBe('podman');
  });

  test("the department's own command/args always land last, after the image — the wrapped process never sees container flags", () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec() });
    const imageIdx = args.indexOf('ghcr.io/example/unity-department:1.0');
    expect(args.slice(imageIdx)).toEqual(['ghcr.io/example/unity-department:1.0', 'dept-bin', '--flag']);
  });

  test('extraArgs are appended before the image, never able to relax --read-only or the mount list', () => {
    const { args } = buildContainerArgs({ ...base, spec: makeContainerSpec({ extraArgs: ['--pids-limit', '128'] }) });
    const imageIdx = args.indexOf('ghcr.io/example/unity-department:1.0');
    expect(args.slice(imageIdx - 2, imageIdx)).toEqual(['--pids-limit', '128']);
    expect(args).toContain('--read-only'); // untouched
  });
});

// ── probeContainerRuntimeAvailable — R14 (never advertise what you can't
//    actually isolate) ──────────────────────────────────────────────────────

describe('probeContainerRuntimeAvailable', () => {
  test('available:true with the server version when docker version exits 0', async () => {
    const exec = new FakeJobExec(() => ({ code: 0, stdout: '24.0.7\n', stderr: '' }));
    const result = await probeContainerRuntimeAvailable(exec);
    expect(result).toEqual({ available: true, version: '24.0.7' });
    expect(exec.calls[0]).toMatchObject({ cmd: 'docker', args: ['version', '--format', '{{.Server.Version}}'] });
  });

  test('available:false with a reason when docker is not installed (spawn ENOENT ⇒ code 127)', async () => {
    const exec = new FakeJobExec(() => ({ code: 127, stdout: '', stderr: '', error: 'ENOENT' }));
    const result = await probeContainerRuntimeAvailable(exec);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('127');
  });

  test('available:false when the docker daemon is unreachable (non-zero exit with stderr)', async () => {
    const exec = new FakeJobExec(() => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\n' }));
    const result = await probeContainerRuntimeAvailable(exec);
    expect(result.available).toBe(false);
    expect(result.reason).toContain('Cannot connect to the Docker daemon');
  });

  test('honours a podman override', async () => {
    const exec = new FakeJobExec(() => ({ code: 0, stdout: '4.9.0', stderr: '' }));
    await probeContainerRuntimeAvailable(exec, 'podman');
    expect(exec.calls[0].cmd).toBe('podman');
  });
});

// ── nodeContainerRuntimeControl ──────────────────────────────────────────

describe('nodeContainerRuntimeControl', () => {
  test('removeContainer shells "<runtimeBinary> rm -f <name>"', async () => {
    const exec = new FakeJobExec(() => GIT_OK);
    const control = nodeContainerRuntimeControl(exec);
    await control.removeContainer('pipeline-dept-abc-id0', 'docker');
    expect(exec.calls).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'pipeline-dept-abc-id0'], opts: {} }]);
  });

  test('is best-effort — a non-zero exit (container already gone) does not throw', async () => {
    const exec = new FakeJobExec(() => ({ code: 1, stdout: '', stderr: 'No such container' }));
    const control = nodeContainerRuntimeControl(exec);
    await expect(control.removeContainer('gone', 'docker')).resolves.toBeUndefined();
  });
});

// ── End-to-end through the REAL DepartmentManager (not just the adapter in
//    isolation) — the DoD's "a department with requiredIsolation: container
//    runs under the container adapter with a read-only root, explicit
//    mounts, and egress restricted to the allowlist" scenario. `requiredIsolation`
//    MATCHING is task c3 (cloud scheduler, not yet built) — what this proves
//    is that once a department's resolved `RuntimeConfig` says `adapterId:
//    'container'`, `DepartmentManager` runs it through `ContainerAdapter`
//    with those controls, exactly like any other adapter, and a `docker run`
//    invocation (never the bare department command) is what is actually
//    spawned. ────────────────────────────────────────────────────────────

describe('DepartmentManager + ContainerAdapter — end to end', () => {
  test('a requiredIsolation:container department is admitted and driven through a real docker run invocation', async () => {
    const { DepartmentManager } = await import('./manager');
    const { adapter, spawner, logger, fs, exec } = makeHarness();

    const sink: { frames: Array<Record<string, unknown>> } = { frames: [] };
    // A fake journal — the DEFAULT `nodeJournalWriter()` touches the real
    // filesystem (`fs.mkdirSync`), which this test must never do.
    const journal = { ensureDir: () => {}, appendLine: () => {} };
    const manager = new DepartmentManager({
      adapters: [adapter],
      resolveRuntimeConfig: (departmentId) =>
        departmentId === 'unity-department'
          ? makeContainerRuntimeConfig({
              container: makeContainerSpec({ mounts: [{ hostPath: '/host/project', containerPath: '/project', readOnly: true }] }),
            })
          : null,
      send: (frame) => {
        sink.frames.push(frame as unknown as Record<string, unknown>);
        return true;
      },
      dispatcher: { on: () => () => {} },
      journal,
      journalRoot: '/data/department',
      logger,
    });

    // Do NOT await yet — `admitTask()` awaits `adapter.start()`, which in
    // turn awaits the fake process's `ready` line (same reason every
    // adapter-level test in this file grabs `spawner.calls`/`spawner.last`
    // BEFORE awaiting `start()`'s promise).
    const resultPromise = manager.admitTask({
      executionId: 'dexec-container-1',
      taskId: 'dtask-container-1',
      contextId: 'dctx-container-1',
      departmentId: 'unity-department',
      messages: [{ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'review the project' }] }],
    });

    // The container adapter actually ran — `docker`, not the bare department
    // command — with the sandbox controls in place.
    const call = spawner.calls[0];
    expect(call.cmd).toBe('docker');
    expect(call.args).toContain('--read-only');
    expect(call.args).toContain('/host/project:/project:ro');
    expect(call.args[call.args.indexOf('--network') + 1]).toBe('none');
    expect(fs.made).toContain(workspacePathFor('dtask-container-1'));

    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });

    const result = await resultPromise;
    // `admitTask()` is called directly here (bypassing the wire layer, same
    // as `./manager.test.ts` does) — accept/reject FRAME sending is
    // `handleOfferFrame`'s job, already covered elsewhere; this test's own
    // concern is admission + the actual sandboxed spawn.
    expect(result).toEqual({ accepted: true });

    proc.emitJson({ type: 'task.completed', summary: 'done' });
    // `reportTerminal` -> `ContainerAdapter.dispose()` -> the inner adapter's
    // `terminateProcessGroup()` is now awaiting the docker CLI process's own
    // exit — simulate it (the FakeProcessHandle is "the docker run process",
    // not the containerized one) so dispose()'s promise chain — including
    // the explicit `docker rm -f` teardown — actually settles.
    proc.emitExit({ code: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(exec.of('docker').some((c) => c.args[0] === 'rm')).toBe(true);
  });
});
