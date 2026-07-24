/**
 * `PipelineDriveAdapter` tests (department-mesh, task d4). Exercises the
 * `AgentRuntimeAdapter` surface (probe/start/send/cancel/dispose) against the
 * SAME `buildDriveArgs`/`classifyDriveOutcome` fixtures `../jobs/drive.test.ts`
 * uses for the untouched pipeline-dispatch path — proving the adapter wraps
 * the exact same contract, not a reimplementation of it. `narrowPipelineDriveSpec`
 * (the `./config.ts` parsing counterpart to `narrowContainerSpec`) is also
 * covered here.
 *
 * This is a DEDICATED suite, not a run of `./_adapter-conformance.ts`: that
 * suite drives the JSONL wire contract (ready/task.start/task.message frames
 * over a live pipe) which `pipeline-drive` structurally does not speak — no
 * handshake, no stdin, a single buffered exec per `start()` (see
 * `./pipeline-drive.ts`'s module doc). The applicable conformance claim for
 * this adapter is `../jobs/drive.test.ts` staying green — the P5 gate.
 */

import { describe, expect, test } from 'bun:test';
import { DRIVE_COMPLETED, DRIVE_HALTED, FakeJobExec, driveAwaiting } from '../jobs/_helpers';
import type { JobExec, JobExecResult } from '../jobs/types';
import type { InvocationEnvelope, PipelineDriveSpec, RuntimeEvent } from './adapter';
import { RuntimeAdapterError } from './adapter';
import { makeTaskSpec } from './_test-helpers';
import { PIPELINE_DRIVE_CAPABILITIES, PipelineDriveAdapter, narrowPipelineDriveSpec } from './pipeline-drive';

function makeDriveSpec(overrides: Partial<PipelineDriveSpec> = {}): PipelineDriveSpec {
  return {
    pipelineRoot: '/ws/.claude/pipeline/release',
    startIteration: 'steps/01-plan.md',
    ...overrides,
  };
}

function makeInvocation(overrides: { pipelineDrive?: Partial<PipelineDriveSpec> | null; taskId?: string } = {}): InvocationEnvelope {
  const pipelineDrive =
    overrides.pipelineDrive === null ? undefined : makeDriveSpec(overrides.pipelineDrive);
  return {
    runtime: {
      adapterId: 'pipeline-drive',
      command: 'pipeline',
      cwd: '/ws',
      ...(pipelineDrive !== undefined ? { pipelineDrive } : {}),
    },
    task: makeTaskSpec({ taskId: overrides.taskId ?? 'dtask-1', contextId: 'dctx-1' }),
  };
}

/** Wait for the adapter's fire-and-forget background exec to settle and call
 *  the sink — `FakeJobExec.run()` resolves on the same microtask queue, so a
 *  couple of drained ticks are enough (same idiom other adapter tests use for
 *  a promise `void`d rather than awaited by the code under test). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PipelineDriveAdapter — argv is byte-identical to pipeline-dispatch (P5 DoD)', () => {
  test('start() execs the SAME argv buildDriveArgs would produce for this target/mode', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation({ taskId: 'run-1' }), (e) => events.push(e));
    await flush();

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]).toMatchObject({
      cmd: 'pipeline',
      args: ['drive', '--root', '/ws/.claude/pipeline/release', '--run-id', 'run-1', '--start', 'steps/01-plan.md', '--json'],
    });
    expect(exec.calls[0]!.opts.cwd).toBe('/ws');
  });

  test('defaultModel/defaultEffort/variables ride through unchanged (same DriveTarget fields)', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    await adapter.start(
      makeInvocation({
        taskId: 'run-2',
        pipelineDrive: { defaultModel: 'opus', defaultEffort: 'high', variables: { PP_SERVICE: 'payments' } },
      }),
      () => {}
    );
    await flush();

    expect(exec.calls[0]!.args).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-2',
      '--default-model',
      'opus',
      '--default-effort',
      'high',
      '--start',
      'steps/01-plan.md',
      '--var',
      'PP_SERVICE=payments',
      '--json',
    ]);
  });

  test('the department taskId becomes drive\'s --run-id', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    await adapter.start(makeInvocation({ taskId: 'dtask-xyz' }), () => {});
    await flush();
    expect(exec.calls[0]!.args).toContain('--run-id');
    expect(exec.calls[0]!.args[exec.calls[0]!.args.indexOf('--run-id') + 1]).toBe('dtask-xyz');
  });
});

describe('PipelineDriveAdapter — outcome mapping (classifyDriveOutcome, unchanged)', () => {
  test('exit 0 (completed) → RuntimeEvent completed', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'completed', summary: 'completed' }]);
  });

  test('exit 1 (halted) → RuntimeEvent failed, retrySafe:false', async () => {
    const exec = new FakeJobExec(() => DRIVE_HALTED);
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'failed', reason: 'step 02 halted: tests failed', retrySafe: false }]);
  });

  test('exit 2 (usage error) → RuntimeEvent failed', async () => {
    const exec = new FakeJobExec(() => ({ code: 2, stdout: '', stderr: 'pipeline drive: --start is required' }));
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([
      { type: 'failed', reason: 'pipeline drive usage error (exit 2): pipeline drive: --start is required', retrySafe: false },
    ]);
  });

  test('a spawn failure (code null) → RuntimeEvent failed with the spawn detail', async () => {
    const exec = new FakeJobExec(() => ({ code: null, stdout: '', stderr: '', error: 'spawn pipeline ENOENT' }));
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'failed', reason: 'pipeline drive did not run: spawn pipeline ENOENT', retrySafe: false }]);
  });

  test('exit 4 (awaiting_input) → RuntimeEvent input_required, question_id passed through verbatim', async () => {
    const exec = new FakeJobExec(() => driveAwaiting('steps/02-deploy.md', 'Which host?', 'drive-q-42'));
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([
      {
        type: 'input_required',
        questionId: 'drive-q-42',
        question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] },
      },
    ]);
  });

  test('exit 4 with no question_id (older-CLI shape) mints a fallback id', async () => {
    const exec = new FakeJobExec(() => driveAwaiting('steps/02-deploy.md', 'Which host?'));
    const adapter = new PipelineDriveAdapter({ exec, makeId: () => 'minted-1' });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([
      { type: 'input_required', questionId: 'minted-1', question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] } },
    ]);
  });
});

describe('PipelineDriveAdapter — declared capabilities (07 §2.1, fixed)', () => {
  test('the minted handle always declares midTaskInput:false, artifacts:false', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const handle = await adapter.start(makeInvocation(), () => {});
    expect(handle.capabilities).toEqual(PIPELINE_DRIVE_CAPABILITIES);
    expect(handle.adapterId).toBe('pipeline-drive');
  });

  test('send() with kind:"message" always throws (acceptsMidTaskInput:false)', async () => {
    const exec = new FakeJobExec(() => new Promise(() => {})); // never resolves — handle stays live
    const adapter = new PipelineDriveAdapter({ exec });
    const handle = await adapter.start(makeInvocation(), () => {});
    await expect(
      adapter.send(handle, { kind: 'message', message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } })
    ).rejects.toBeInstanceOf(RuntimeAdapterError);
  });

  test('send() with kind:"task.start" always throws (lifecycle: per-task only, no daemon reuse)', async () => {
    const exec = new FakeJobExec(() => new Promise(() => {}));
    const adapter = new PipelineDriveAdapter({ exec });
    const handle = await adapter.start(makeInvocation(), () => {});
    await expect(adapter.send(handle, { kind: 'task.start', task: makeTaskSpec({ taskId: 'dtask-2' }) })).rejects.toBeInstanceOf(
      RuntimeAdapterError
    );
  });

  test('send() on a handle not minted by this adapter throws', async () => {
    const adapter = new PipelineDriveAdapter({ exec: new FakeJobExec(() => DRIVE_COMPLETED) });
    const foreignHandle = { adapterId: 'pipeline-drive', taskId: 't', contextId: 'c', capabilities: PIPELINE_DRIVE_CAPABILITIES };
    await expect(adapter.send(foreignHandle, { kind: 'task.start', task: makeTaskSpec() })).rejects.toBeInstanceOf(RuntimeAdapterError);
  });
});

describe('PipelineDriveAdapter — start() validation', () => {
  test('missing RuntimeConfig.pipelineDrive rejects start()', async () => {
    const adapter = new PipelineDriveAdapter({ exec: new FakeJobExec(() => DRIVE_COMPLETED) });
    await expect(adapter.start(makeInvocation({ pipelineDrive: null }), () => {})).rejects.toBeInstanceOf(RuntimeAdapterError);
  });

  test('a blank pipelineRoot rejects start()', async () => {
    const adapter = new PipelineDriveAdapter({ exec: new FakeJobExec(() => DRIVE_COMPLETED) });
    await expect(adapter.start(makeInvocation({ pipelineDrive: { pipelineRoot: '  ' } }), () => {})).rejects.toBeInstanceOf(
      RuntimeAdapterError
    );
  });

  test('a blank startIteration rejects start()', async () => {
    const adapter = new PipelineDriveAdapter({ exec: new FakeJobExec(() => DRIVE_COMPLETED) });
    await expect(adapter.start(makeInvocation({ pipelineDrive: { startIteration: '' } }), () => {})).rejects.toBeInstanceOf(
      RuntimeAdapterError
    );
  });
});

describe('PipelineDriveAdapter — cancel() / dispose() (07 §7)', () => {
  test("cancel() aborts the in-flight exec's signal", async () => {
    let capturedSignal: AbortSignal | undefined;
    const exec: JobExec = {
      run: async (_cmd, _args, opts) => {
        capturedSignal = opts?.signal;
        return new Promise(() => {}); // never resolves — the assertion happens before/after abort
      },
    };
    const adapter = new PipelineDriveAdapter({ exec });
    const handle = await adapter.start(makeInvocation(), () => {});
    expect(capturedSignal?.aborted).toBe(false);
    await adapter.cancel(handle);
    expect(capturedSignal?.aborted).toBe(true);
  });

  test('dispose() aborts and is idempotent', async () => {
    const exec = new FakeJobExec(() => new Promise(() => {}));
    const adapter = new PipelineDriveAdapter({ exec });
    const handle = await adapter.start(makeInvocation(), () => {});
    await adapter.dispose(handle);
    await adapter.dispose(handle); // second call must not throw
    expect(handle).toBeTruthy();
  });

  test('an exec that settles AFTER dispose() does not report anything to the sink', async () => {
    let resolveExec: (result: JobExecResult) => void;
    const exec = new FakeJobExec(
      () =>
        new Promise<JobExecResult>((resolve) => {
          resolveExec = resolve;
        })
    );
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    const handle = await adapter.start(makeInvocation(), (e) => events.push(e));

    await adapter.dispose(handle);
    resolveExec!(DRIVE_COMPLETED);
    await flush();

    expect(events).toEqual([]);
  });

  test('cancel() then dispose() (the DepartmentManager terminateExecution sequence) suppresses the eventual event', async () => {
    let resolveExec: (result: JobExecResult) => void;
    const exec = new FakeJobExec(
      () =>
        new Promise<JobExecResult>((resolve) => {
          resolveExec = resolve;
        })
    );
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    const handle = await adapter.start(makeInvocation(), (e) => events.push(e));

    await adapter.cancel(handle, 'canceled');
    await adapter.dispose(handle);
    // The aborted exec eventually settles the way nodeJobExec's abort path does.
    resolveExec!({ code: null, stdout: '', stderr: '', error: 'aborted before spawn' });
    await flush();

    expect(events).toEqual([]);
  });
});

describe('PipelineDriveAdapter — probe()', () => {
  test('ok:true with fixed capabilities and the reported version', async () => {
    const exec = new FakeJobExec(() => ({ code: 0, stdout: '1.2.3\n', stderr: '' }));
    const adapter = new PipelineDriveAdapter({ exec });
    const result = await adapter.probe({ adapterId: 'pipeline-drive', command: 'pipeline' });
    expect(result).toEqual({ ok: true, runtime: 'pipeline-drive', capabilities: PIPELINE_DRIVE_CAPABILITIES, version: '1.2.3' });
    expect(exec.calls[0]).toMatchObject({ cmd: 'pipeline', args: ['--version'] });
  });

  test('ok:false with a reason on a non-zero exit', async () => {
    const exec = new FakeJobExec(() => ({ code: 127, stdout: '', stderr: '', error: 'ENOENT' }));
    const adapter = new PipelineDriveAdapter({ exec });
    const result = await adapter.probe({ adapterId: 'pipeline-drive', command: 'pipeline' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exited 127/);
  });
});

describe('narrowPipelineDriveSpec (./config.ts parsing counterpart)', () => {
  test('a well-formed spec parses through, optional fields included', () => {
    expect(
      narrowPipelineDriveSpec({
        pipelineRoot: '/ws/.claude/pipeline/release',
        startIteration: 'steps/01-plan.md',
        defaultModel: 'opus',
        defaultEffort: 'high',
        variables: { PP_SERVICE: 'payments', PP_BAD: 5 },
      })
    ).toEqual({
      pipelineRoot: '/ws/.claude/pipeline/release',
      startIteration: 'steps/01-plan.md',
      defaultModel: 'opus',
      defaultEffort: 'high',
      variables: { PP_SERVICE: 'payments' },
    });
  });

  test('the minimal required-only shape parses with no optional fields', () => {
    expect(narrowPipelineDriveSpec({ pipelineRoot: '/root', startIteration: 'steps/01.md' })).toEqual({
      pipelineRoot: '/root',
      startIteration: 'steps/01.md',
    });
  });

  test.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['missing pipelineRoot', { startIteration: 'steps/01.md' }],
    ['blank pipelineRoot', { pipelineRoot: '', startIteration: 'steps/01.md' }],
    ['missing startIteration', { pipelineRoot: '/root' }],
  ])('%s → undefined', (_label, raw) => {
    expect(narrowPipelineDriveSpec(raw)).toBeUndefined();
  });
});
