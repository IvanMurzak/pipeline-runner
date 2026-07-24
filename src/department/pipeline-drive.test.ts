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
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { DRIVE_COMPLETED, DRIVE_HALTED, DRIVE_PROVIDER_LIMIT, FakeJobExec, driveAwaiting } from '../jobs/_helpers';
import type { JobExec, JobExecResult } from '../jobs/types';
import type { DeptMessage, InvocationEnvelope, PipelineDriveSpec, RuntimeEvent } from './adapter';
import { RuntimeAdapterError } from './adapter';
import { makeMessage, makeTaskSpec } from './_test-helpers';
import { PIPELINE_DRIVE_CAPABILITIES, PipelineDriveAdapter, narrowPipelineDriveSpec } from './pipeline-drive';

function makeDriveSpec(overrides: Partial<PipelineDriveSpec> = {}): PipelineDriveSpec {
  return {
    pipelineRoot: '/ws/.claude/pipeline/release',
    startIteration: 'steps/01-plan.md',
    ...overrides,
  };
}

function makeInvocation(
  overrides: { pipelineDrive?: Partial<PipelineDriveSpec> | null; taskId?: string; messages?: DeptMessage[] } = {}
): InvocationEnvelope {
  const pipelineDrive =
    overrides.pipelineDrive === null ? undefined : makeDriveSpec(overrides.pipelineDrive);
  return {
    runtime: {
      adapterId: 'pipeline-drive',
      command: 'pipeline',
      cwd: '/ws',
      ...(pipelineDrive !== undefined ? { pipelineDrive } : {}),
    },
    task: makeTaskSpec({
      taskId: overrides.taskId ?? 'dtask-1',
      contextId: 'dctx-1',
      ...(overrides.messages !== undefined ? { messages: overrides.messages } : {}),
    }),
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

describe('PipelineDriveAdapter — resuming a parked question (07 §5 respawn-on-answer contract)', () => {
  test('park → answer → resumes with --resume/--answer at the parked iteration, and does NOT restart from startIteration', async () => {
    let call = 0;
    const exec = new FakeJobExec(() => {
      call += 1;
      return call === 1 ? driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-1') : DRIVE_COMPLETED;
    });
    const adapter = new PipelineDriveAdapter({ exec });

    // First admission: a fresh start.
    const events1: RuntimeEvent[] = [];
    await adapter.start(makeInvocation({ taskId: 'dtask-park-1' }), (e) => events1.push(e));
    await flush();
    expect(events1).toEqual([
      { type: 'input_required', questionId: 'q-1', question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] } },
    ]);
    expect(exec.calls[0]!.args).toContain('steps/01-plan.md');

    // DepartmentManager's respawn (./manager.ts's spawnAndStart): the SAME
    // taskId, task.messages now the FULL retained history with the answer
    // appended last — exactly what deliverMessage produces.
    const answerMessage = makeMessage({ messageId: 'answer-1', parts: [{ text: 'host-a' }] });
    const events2: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-1', messages: [makeMessage(), answerMessage] }),
      (e) => events2.push(e)
    );
    await flush();

    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[1]!.args).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'dtask-park-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
    expect(exec.calls[1]!.args).not.toContain('steps/01-plan.md');
    expect(events2).toEqual([{ type: 'completed', summary: 'completed' }]);
  });

  test('a SECOND park mid-resume overwrites the remembered iteration for the NEXT answer', async () => {
    let call = 0;
    const exec = new FakeJobExec(() => {
      call += 1;
      if (call === 1) return driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-1');
      if (call === 2) return driveAwaiting('steps/03-verify.md', 'Which region?', 'q-2');
      return DRIVE_COMPLETED;
    });
    const adapter = new PipelineDriveAdapter({ exec });

    await adapter.start(makeInvocation({ taskId: 'dtask-park-2' }), () => {});
    await flush();

    const answer1 = makeMessage({ messageId: 'answer-1', parts: [{ text: 'host-a' }] });
    const events2: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-2', messages: [makeMessage(), answer1] }),
      (e) => events2.push(e)
    );
    await flush();
    expect(events2).toEqual([
      { type: 'input_required', questionId: 'q-2', question: { text: 'Which region?', context: 'ctx', options: ['a', 'b'] } },
    ]);
    expect(exec.calls[1]!.args).toContain('steps/02-deploy.md'); // resumed at the FIRST park

    const answer2 = makeMessage({ messageId: 'answer-2', parts: [{ text: 'eu-west' }] });
    const events3: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-2', messages: [makeMessage(), answer1, answer2] }),
      (e) => events3.push(e)
    );
    await flush();
    expect(exec.calls[2]!.args).toContain('steps/03-verify.md'); // the SECOND park's iteration, not the first
    expect(exec.calls[2]!.args).toContain('eu-west');
    expect(events3).toEqual([{ type: 'completed', summary: 'completed' }]);
  });

  test('a respawn whose replayed history has no usable answer text fails cleanly instead of resuming with a blank --answer', async () => {
    let call = 0;
    const exec = new FakeJobExec(() => {
      call += 1;
      return call === 1 ? driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-1') : DRIVE_COMPLETED;
    });
    const adapter = new PipelineDriveAdapter({ exec });

    await adapter.start(makeInvocation({ taskId: 'dtask-park-3' }), () => {});
    await flush();

    const textlessAnswer: DeptMessage = { messageId: 'answer-1', role: 'ROLE_USER', parts: [{ mediaType: 'text/plain' }] };
    const events2: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-3', messages: [makeMessage(), textlessAnswer] }),
      (e) => events2.push(e)
    );
    await flush();

    expect(exec.calls).toHaveLength(1); // no second exec was even attempted
    expect(events2).toEqual([
      {
        type: 'failed',
        reason: 'pipeline-drive: task was parked awaiting an answer, but the replayed message history carries no usable answer text',
        retrySafe: false,
      },
    ]);
  });

  test('a provider limit hit while resuming an answer preserves the parked state (adapter-level bookkeeping; DepartmentManager does not auto-retry per-task lifecycle today)', async () => {
    let call = 0;
    const exec = new FakeJobExec(() => {
      call += 1;
      if (call === 1) return driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-1');
      if (call === 2) return DRIVE_PROVIDER_LIMIT;
      return DRIVE_COMPLETED;
    });
    const adapter = new PipelineDriveAdapter({ exec });

    await adapter.start(makeInvocation({ taskId: 'dtask-park-4' }), () => {});
    await flush();

    const answerMessage = makeMessage({ messageId: 'answer-1', parts: [{ text: 'host-a' }] });
    const events2: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-4', messages: [makeMessage(), answerMessage] }),
      (e) => events2.push(e)
    );
    await flush();
    expect(events2).toEqual([{ type: 'failed', reason: 'pipeline drive provider limit: usage limit', retrySafe: true }]);
    expect(exec.calls[1]!.args).toContain('--answer');

    // A later start() for the SAME taskId (whatever triggers it) still
    // resumes from the SAME parked iteration — never restarted from scratch.
    const events3: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-park-4', messages: [makeMessage(), answerMessage] }),
      (e) => events3.push(e)
    );
    await flush();
    expect(exec.calls[2]!.args).toContain('steps/02-deploy.md');
    expect(exec.calls[2]!.args).not.toContain('steps/01-plan.md');
    expect(events3).toEqual([{ type: 'completed', summary: 'completed' }]);
  });
});

describe('PipelineDriveAdapter — bounding parked-resume state (leak fix: cancel() is never reached for a parked-then-terminated execution)', () => {
  test('a park that is NEVER cancelled (park-expiry / deadline / lease-revoke style abandonment — cancel() never called) is reclaimed by the TTL sweep, triggered by another task parking', async () => {
    let call = 0;
    const exec = new FakeJobExec(() => {
      call += 1;
      // Task A parks on call 1; Task B parks on call 2; Task A's (too-late)
      // answer attempt on call 3 should look like a FRESH start, not a resume.
      if (call === 1) return driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-a');
      if (call === 2) return driveAwaiting('steps/02-deploy.md', 'Which host?', 'q-b');
      return DRIVE_COMPLETED;
    });
    const clock = new FakeClock();
    const adapter = new PipelineDriveAdapter({ exec, clock, parkedStateTtlMs: 1000 });

    // Task A parks. NOTHING ever calls adapter.cancel() for it — exactly
    // what happens today when `./manager.ts`'s park expiry / wall-clock
    // deadline / explicit cancel / lease-revoked fire while a midTaskInput:
    // false handle is null (the bug this test guards against).
    await adapter.start(makeInvocation({ taskId: 'dtask-leak-a' }), () => {});
    await flush();

    // Time passes well beyond the TTL — Task A's execution is abandoned,
    // but this adapter is never told so directly.
    clock.advance(5000);

    // An UNRELATED task (Task B) parks. Its own runOnce() call `prune()`s
    // FIRST, before touching its own state — sweeping Task A's stale entry
    // as a side effect of ordinary, unrelated activity.
    await adapter.start(makeInvocation({ taskId: 'dtask-leak-b' }), () => {});
    await flush();

    // If Task A's answer somehow still arrives (a very late, stale answer),
    // the adapter must NOT resume from the remembered — now evicted —
    // iteration: it degrades safely to a fresh {kind:'start'}.
    const staleAnswer = makeMessage({ messageId: 'answer-a', parts: [{ text: 'host-a' }] });
    const eventsA: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-leak-a', messages: [makeMessage(), staleAnswer] }),
      (e) => eventsA.push(e)
    );
    await flush();

    expect(exec.calls).toHaveLength(3);
    expect(exec.calls[2]!.args).toContain('steps/01-plan.md'); // the ORIGINAL configured start, not a resume
    expect(exec.calls[2]!.args).not.toContain('--answer');
    expect(exec.calls[2]!.args).not.toContain('--resume');
    expect(eventsA).toEqual([{ type: 'completed', summary: 'completed' }]);
  });

  test('a hard ceiling bounds the map even without any TTL elapsing — oldest-parked entry is evicted first', async () => {
    const exec = new FakeJobExec(() => driveAwaiting('steps/02-deploy.md', 'Which host?', 'q'));
    const adapter = new PipelineDriveAdapter({ exec, maxParkedEntries: 2 });

    // Three DIFFERENT tasks park in sequence, none ever answered/cancelled.
    await adapter.start(makeInvocation({ taskId: 'dtask-cap-1' }), () => {});
    await flush();
    await adapter.start(makeInvocation({ taskId: 'dtask-cap-2' }), () => {});
    await flush();
    await adapter.start(makeInvocation({ taskId: 'dtask-cap-3' }), () => {}); // pushes the map over the ceiling
    await flush();

    // Task 1 (the oldest) should have been evicted by the hard ceiling —
    // its late answer looks like a fresh start, not a resume.
    const staleAnswer = makeMessage({ messageId: 'answer-1', parts: [{ text: 'host-a' }] });
    const events1: RuntimeEvent[] = [];
    await adapter.start(
      makeInvocation({ taskId: 'dtask-cap-1', messages: [makeMessage(), staleAnswer] }),
      (e) => events1.push(e)
    );
    await flush();
    expect(exec.calls[3]!.args).toContain('steps/01-plan.md');
    expect(exec.calls[3]!.args).not.toContain('--answer');
  });
});

describe('PipelineDriveAdapter — lifecycle validation (07 §2.1: per-task only)', () => {
  test('an explicit lifecycle:"per-task" is accepted', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const invocation = makeInvocation();
    invocation.runtime.lifecycle = 'per-task';
    await expect(adapter.start(invocation, () => {})).resolves.toBeTruthy();
  });

  test('lifecycle:"per-context" is rejected — this adapter never keeps a live process across a respawn', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const invocation = makeInvocation();
    invocation.runtime.lifecycle = 'per-context';
    await expect(adapter.start(invocation, () => {})).rejects.toBeInstanceOf(RuntimeAdapterError);
  });

  test('lifecycle:"daemon" is rejected', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const adapter = new PipelineDriveAdapter({ exec });
    const invocation = makeInvocation();
    invocation.runtime.lifecycle = 'daemon';
    await expect(adapter.start(invocation, () => {})).rejects.toBeInstanceOf(RuntimeAdapterError);
  });
});

describe('PipelineDriveAdapter — provider limits (06.7, precedence over exit-code classification)', () => {
  test('a fresh-start provider limit reports failed with retrySafe:true, not a hard classified failure', async () => {
    const exec = new FakeJobExec(() => DRIVE_PROVIDER_LIMIT);
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'failed', reason: 'pipeline drive provider limit: usage limit', retrySafe: true }]);
  });

  test('a custom detectProviderLimit is honored', async () => {
    const exec = new FakeJobExec(() => ({ code: 1, stdout: '', stderr: 'custom throttle' }));
    const adapter = new PipelineDriveAdapter({ exec, detectProviderLimit: () => ({ reason: 'custom throttle hit' }) });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'failed', reason: 'pipeline drive provider limit: custom throttle hit', retrySafe: true }]);
  });

  test('a completed run is never limit-paused even if the detector would otherwise fire on stray text', async () => {
    const exec = new FakeJobExec(() => ({ code: 0, stdout: JSON.stringify({ status: 'completed' }), stderr: 'discussed a rate limit' }));
    const adapter = new PipelineDriveAdapter({ exec });
    const events: RuntimeEvent[] = [];
    await adapter.start(makeInvocation(), (e) => events.push(e));
    await flush();
    expect(events).toEqual([{ type: 'completed', summary: 'completed' }]);
  });
});

describe('PipelineDriveAdapter — fire-and-forget safety (unhandled rejection guard)', () => {
  test('a throwing sink is caught and logged instead of producing an unhandled rejection', async () => {
    const exec = new FakeJobExec(() => DRIVE_COMPLETED);
    const logger = new CaptureLogger();
    const adapter = new PipelineDriveAdapter({ exec, logger });
    let sinkCalls = 0;
    await adapter.start(makeInvocation(), () => {
      sinkCalls += 1;
      throw new Error('sink boom');
    });
    await flush();
    expect(sinkCalls).toBe(1);
    expect(
      logger.lines.some((l) => l.includes('warn:') && l.includes('runOnce failed unexpectedly') && l.includes('sink boom'))
    ).toBe(true);
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

  test('cancel() ALONE (no dispose() call following) also suppresses a late result — its own doc comment promises this', async () => {
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

    await adapter.cancel(handle, 'canceled'); // deliberately no dispose() afterwards
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
