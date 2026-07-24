/**
 * `jsonl-process` adapter tests — the JSONL-contract half of task d1's DoD:
 * happy path (ready → status → progress → message → input_required → answer
 * → artifact → completed), malformed-line tolerance, missing-`ready` timeout,
 * capability-mismatch refusal, oversize inline-artifact rejection, and an
 * unexpected-exit → synthetic `failed`. Every scenario drives a
 * `FakeProcessHandle` directly (no real OS process — see `_test-helpers.ts`).
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import type { RuntimeEvent } from './adapter';
import { RuntimeAdapterError } from './adapter';
import { FakeJobSpawn, makeInvocation, makeMessage } from './_test-helpers';
import { INLINE_ARTIFACT_BYTES_LIMIT, KILL_SETTLE_GRACE_MS, JsonlProcessAdapter, narrowRuntimeEvent } from './jsonl-process';

function makeAdapter(): { adapter: JsonlProcessAdapter; spawner: FakeJobSpawn; clock: FakeClock; logger: CaptureLogger } {
  const spawner = new FakeJobSpawn();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  return { adapter: new JsonlProcessAdapter({ spawn: spawner, clock, logger }), spawner, clock, logger };
}

/**
 * Plain try/catch instead of `expect(promise).rejects.toThrow()`: bun:test
 * (1.3.14) hangs when that matcher is constructed against a still-PENDING
 * promise and only awaited after other synchronous code runs in between
 * (e.g. `clock.advance()`) — confirmed by isolating a minimal repro outside
 * this suite. Awaiting the rejection directly sidesteps it entirely.
 */
async function expectRejection(promise: Promise<unknown>, check: (err: unknown) => void): Promise<void> {
  try {
    await promise;
  } catch (err) {
    check(err);
    return;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describe('JsonlProcessAdapter — happy path', () => {
  test('start → progress → message → input_required → answer → artifact → complete, in order', async () => {
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const invocation = makeInvocation();

    const startPromise = adapter.start(invocation, (event) => events.push(event));
    const proc = spawner.last;

    // The initialize down-message went out before ready.
    expect(proc.lastWrittenJson()).toEqual({
      type: 'initialize',
      protocolVersion: '1.0',
      capabilities: { midTaskInput: true, artifacts: true },
    });

    proc.emitJson({ type: 'ready', runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
    const handle = await startPromise;
    expect(handle.capabilities).toEqual({ midTaskInput: true, artifacts: true });

    // task.start went out right after ready.
    expect(proc.lastWrittenJson()).toMatchObject({ type: 'task.start', task: { taskId: 'dtask-1', contextId: 'dctx-1' } });

    proc.emitJson({ type: 'task.status', state: 'WORKING', message: 'Inspecting project' });
    proc.emitJson({ type: 'task.progress', note: '12/40 scripts analysed' });
    proc.emitJson({ type: 'task.message', parts: [{ text: 'Findings so far', mediaType: 'text/markdown' }] });
    proc.emitJson({ type: 'task.input_required', questionId: 'q_1', question: { text: 'Android or iOS?', options: ['Android', 'iOS'] } });

    await adapter.send(handle, { kind: 'message', message: makeMessage({ messageId: 'answer-1', parts: [{ text: 'Android' }] }) });
    expect(proc.lastWrittenJson()).toEqual({
      type: 'task.message',
      message: { messageId: 'answer-1', role: 'ROLE_USER', parts: [{ text: 'Android' }] },
    });

    proc.emitJson({ type: 'task.artifact', name: 'review.md', mediaType: 'text/markdown', path: './out/review.md' });
    proc.emitJson({ type: 'task.completed', summary: 'Review complete' });

    expect(events).toEqual([
      { type: 'status', state: 'WORKING', message: 'Inspecting project' },
      { type: 'progress', note: '12/40 scripts analysed' },
      { type: 'message', parts: [{ text: 'Findings so far', mediaType: 'text/markdown' }] },
      {
        type: 'input_required',
        questionId: 'q_1',
        question: { text: 'Android or iOS?', context: null, options: ['Android', 'iOS'] },
      },
      { type: 'artifact', name: 'review.md', mediaType: 'text/markdown', path: './out/review.md' },
      { type: 'completed', summary: 'Review complete' },
    ]);
  });

  test('every failure branch: task.failed carries reason + retrySafe through verbatim', async () => {
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;

    proc.emitJson({ type: 'task.failed', reason: 'unity not installed', retrySafe: false });
    expect(events).toEqual([{ type: 'failed', reason: 'unity not installed', retrySafe: false }]);
  });
});

describe('JsonlProcessAdapter — malformed-line tolerance (07 §3)', () => {
  test('unparseable and unrecognized lines are logged and dropped, never fatal', async () => {
    const { adapter, spawner, logger } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;
    expect(handle).toBeTruthy();

    proc.emitLine('not json at all {{{');
    proc.emitLine('42'); // valid JSON, not an object
    proc.emitJson({ type: 'some.future.event', whatever: true }); // well-formed, unrecognized type
    proc.emitJson({ type: 'task.progress', note: 'still going' });

    expect(events).toEqual([{ type: 'progress', note: 'still going' }]);
    expect(logger.lines.some((l) => l.includes('warn:') && l.includes('unparseable'))).toBe(true);
    expect(logger.lines.some((l) => l.includes('warn:') && l.includes('unrecognized up-message'))).toBe(true);
  });

  test('an unparseable line before ready does not fail the handshake', async () => {
    const { adapter, spawner } = makeAdapter();
    const startPromise = adapter.start(makeInvocation(), () => {});
    const proc = spawner.last;
    proc.emitLine('garbage');
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: false } });
    await expect(startPromise).resolves.toBeTruthy();
  });
});

describe('JsonlProcessAdapter — missing-ready timeout (07 §3)', () => {
  test('start() rejects and kills the process when ready never arrives', async () => {
    const { adapter, spawner, clock } = makeAdapter();
    const startPromise = adapter.start(makeInvocation({ runtime: { adapterId: 'jsonl-process', command: 'slow-department', startupTimeoutSeconds: 5 } }), () => {});
    clock.advance(5_000);
    await expectRejection(startPromise, (err) => {
      expect(err).toBeInstanceOf(RuntimeAdapterError);
      expect((err as Error).message).toMatch(/did not emit 'ready'/);
    });
    expect(spawner.last.killedWith.length).toBeGreaterThan(0);
  });

  test('an early process exit before ready also fails start()', async () => {
    const { adapter, spawner } = makeAdapter();
    const startPromise = adapter.start(makeInvocation(), () => {});
    const proc = spawner.last;
    proc.emitExit({ code: 127, error: 'ENOENT' });
    await expectRejection(startPromise, (err) => {
      expect((err as Error).message).toMatch(/exited before 'ready'/);
    });
  });
});

describe('JsonlProcessAdapter — capability mismatch (07 §3)', () => {
  test('a midTaskInput:false handle refuses task.message', async () => {
    const { adapter, spawner } = makeAdapter();
    const startPromise = adapter.start(makeInvocation(), () => {});
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', runtime: 'batch-department', capabilities: { midTaskInput: false, artifacts: false } });
    const handle = await startPromise;
    expect(handle.capabilities.midTaskInput).toBe(false);

    await expectRejection(adapter.send(handle, { kind: 'message', message: makeMessage() }), (err) => {
      expect((err as Error).message).toMatch(/midTaskInput:false/);
    });
    // Nothing beyond task.start was ever written to the process.
    expect(proc.written.filter((l) => JSON.parse(l).type === 'task.message')).toEqual([]);
  });

  test('task.start reuse (daemon-lifecycle) is always allowed regardless of capability', async () => {
    const { adapter, spawner } = makeAdapter();
    const startPromise = adapter.start(makeInvocation(), () => {});
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: false } });
    const handle = await startPromise;
    await adapter.send(handle, { kind: 'task.start', task: { taskId: 'dtask-2', contextId: 'dctx-1', messages: [makeMessage()] } });
    expect(proc.lastWrittenJson()).toMatchObject({ type: 'task.start', task: { taskId: 'dtask-2' } });
  });
});

describe('JsonlProcessAdapter — oversize inline artifact (07 §3, 64 KiB cap)', () => {
  test('an inline-bytes artifact at/over the cap is dropped, not forwarded', async () => {
    const { adapter, spawner, logger } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;

    const oversize = Buffer.alloc(INLINE_ARTIFACT_BYTES_LIMIT).toString('base64'); // exactly at the cap
    proc.emitJson({ type: 'task.artifact', name: 'huge.bin', mediaType: 'application/octet-stream', bytes: oversize });
    proc.emitJson({ type: 'task.progress', note: 'after the oversize artifact' });

    expect(events).toEqual([{ type: 'progress', note: 'after the oversize artifact' }]);
    expect(logger.lines.some((l) => l.includes('inline bytes') && l.includes('cap'))).toBe(true);
  });

  test('an inline-bytes artifact comfortably under the cap ships', async () => {
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;

    const small = Buffer.from('hello artifact').toString('base64');
    proc.emitJson({ type: 'task.artifact', name: 'note.txt', mediaType: 'text/plain', bytes: small });

    expect(events).toEqual([{ type: 'artifact', name: 'note.txt', mediaType: 'text/plain', bytes: new Uint8Array(Buffer.from('hello artifact')) }]);
  });
});

describe('JsonlProcessAdapter — unexpected process exit', () => {
  test('a process that dies mid-task without a terminal event surfaces a synthetic failed(retrySafe:true)', async () => {
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;

    proc.emitJson({ type: 'task.status', state: 'WORKING' });
    proc.emitExit({ code: 137, signal: 'SIGKILL' });

    expect(events).toEqual([
      { type: 'status', state: 'WORKING' },
      { type: 'failed', reason: expect.stringContaining('unexpectedly') as unknown as string, retrySafe: true },
    ]);
  });

  test('a clean exit AFTER task.completed does not emit a second, spurious failed', async () => {
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    await startPromise;
    proc.emitJson({ type: 'task.completed', summary: 'done' });
    proc.emitExit({ code: 0 });

    expect(events).toEqual([{ type: 'completed', summary: 'done' }]);
  });

  test('an exit during dispose() is not reported as a failure', async () => {
    const { adapter, spawner, clock } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;

    const disposePromise = adapter.dispose(handle);
    proc.emitExit({ code: 0 });
    await disposePromise;

    expect(events).toEqual([]);
    expect(proc.ended).toBe(true);
    expect(proc.written.some((l) => JSON.parse(l).type === 'shutdown')).toBe(true);
  });

  test('dispose() SIGTERMs the process GROUP immediately, then SIGKILLs the group after the grace window if it never exits (d2)', async () => {
    const { adapter, spawner, clock } = makeAdapter();
    const startPromise = adapter.start(
      makeInvocation({ runtime: { adapterId: 'jsonl-process', command: 'stuck-department', gracefulShutdownSeconds: 3 } }),
      () => {}
    );
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;

    const disposePromise = adapter.dispose(handle);
    // SIGTERM is sent to the GROUP right away — not deferred until the grace
    // window elapses (the pre-d2 behavior), and not the direct-child-only
    // `kill()`.
    expect(proc.killedGroupWith).toEqual(['SIGTERM']);
    expect(proc.killedWith).toEqual([]);

    clock.advance(3_000); // the grace window elapses — still no exit
    expect(proc.killedGroupWith).toEqual(['SIGTERM', 'SIGKILL']);

    clock.advance(KILL_SETTLE_GRACE_MS); // post-SIGKILL settle grace — dispose() gives up waiting
    await disposePromise;
  });

  test('dispose() resolves as soon as the process actually exits, without waiting out the full grace window', async () => {
    const { adapter, spawner, clock } = makeAdapter();
    const startPromise = adapter.start(
      makeInvocation({ runtime: { adapterId: 'jsonl-process', command: 'x', gracefulShutdownSeconds: 15 } }),
      () => {}
    );
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;

    const disposePromise = adapter.dispose(handle);
    clock.advance(500); // well short of the 15s grace window
    proc.emitExit({ code: 0, signal: 'SIGTERM' });
    await disposePromise; // resolves without the grace timer ever firing
    expect(proc.killedGroupWith).toEqual(['SIGTERM']); // no SIGKILL — it exited first
  });
});

describe('JsonlProcessAdapter — cancel()', () => {
  test('writes task.cancel with the given reason', async () => {
    const { adapter, spawner } = makeAdapter();
    const startPromise = adapter.start(makeInvocation(), () => {});
    const proc = spawner.last;
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    const handle = await startPromise;
    await adapter.cancel(handle, 'caller canceled');
    expect(proc.lastWrittenJson()).toEqual({ type: 'task.cancel', reason: 'caller canceled' });
    // cancel() alone never touches the OS process — that escalation is
    // dispose()'s job (d2), always invoked right after by the supervisor
    // (`../manager.ts`'s `terminateExecution`).
    expect(proc.killedGroupWith).toEqual([]);
    expect(proc.killedWith).toEqual([]);
  });
});

describe('JsonlProcessAdapter — probe()', () => {
  test('ok:true with capabilities when the process answers ready promptly', async () => {
    const { adapter, spawner } = makeAdapter();
    const probePromise = adapter.probe(makeInvocation().runtime);
    spawner.last.emitJson({ type: 'ready', runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
    const result = await probePromise;
    expect(result).toEqual({ ok: true, runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
  });

  test('ok:false with a reason when ready never arrives, and the process is killed', async () => {
    const { adapter, spawner, clock } = makeAdapter();
    const probePromise = adapter.probe({ adapterId: 'jsonl-process', command: 'broken-department', startupTimeoutSeconds: 2 });
    clock.advance(2_000);
    const result = await probePromise;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not emit 'ready'/);
    expect(spawner.last.killedWith.length).toBeGreaterThan(0);
  });
});

describe('regression: ready + first task line arriving in the same stdout chunk', () => {
  test('a task.status emitted synchronously right after ready is not dropped', async () => {
    // Guards the fix in `runHandshakeThenStart`'s module doc: a two-step
    // "await ready, THEN register the active handler" design would drop this
    // line, because re-registering only takes effect for lines processed
    // after the `await` continuation (a microtask) runs — and a real child's
    // stdout chunk can carry both lines before that continuation ever fires.
    const { adapter, spawner } = makeAdapter();
    const events: RuntimeEvent[] = [];
    const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
    const proc = spawner.last;

    // Both lines emitted synchronously, back-to-back, BEFORE `startPromise`
    // is ever awaited — simulating one chunk containing both.
    proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
    proc.emitJson({ type: 'task.status', state: 'WORKING', message: 'no gap at all' });

    await startPromise;
    expect(events).toEqual([{ type: 'status', state: 'WORKING', message: 'no gap at all' }]);
  });
});

describe('narrowRuntimeEvent — pure parsing, every drop branch', () => {
  test('task.status with a non-WORKING state is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.status', state: 'SUBMITTED' })).toEqual({
      drop: "task.status with unrecognized state 'SUBMITTED'",
    });
  });

  test('task.progress missing note is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.progress' })).toEqual({ drop: 'task.progress missing note' });
  });

  test('task.message with empty parts is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.message', parts: [] })).toEqual({ drop: 'task.message missing/empty parts' });
  });

  test('task.input_required missing questionId is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.input_required', question: { text: 'x' } })).toEqual({
      drop: 'task.input_required missing questionId',
    });
  });

  test('task.artifact with neither bytes nor path is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.artifact', name: 'a', mediaType: 'text/plain' })).toEqual({
      drop: "task.artifact 'a' has neither bytes nor path",
    });
  });

  test('task.artifact with malformed base64 bytes is dropped', () => {
    const result = narrowRuntimeEvent({ type: 'task.artifact', name: 'a', mediaType: 'text/plain', bytes: 123 });
    expect(result).toEqual({ drop: "task.artifact 'a' has malformed base64 bytes" });
  });

  test('task.failed missing reason is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'task.failed' })).toEqual({ drop: 'task.failed missing reason' });
  });

  test('an entirely unrecognized type is dropped', () => {
    expect(narrowRuntimeEvent({ type: 'wat' })).toEqual({ drop: "unrecognized up-message type 'wat'" });
  });
});
