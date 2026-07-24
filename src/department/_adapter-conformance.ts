/**
 * The `AgentRuntimeAdapter` conformance suite (department-mesh, task d1's
 * DoD / 07 §9: "adapter conformance suite runnable against any adapter" —
 * first actually factored out as such by task d8, whose own DoD requires
 * proving it "passes against the `container` adapter unchanged"). Every
 * scenario here drives ONLY the public `AgentRuntimeAdapter` surface
 * (start/send/cancel/dispose/probe) plus the fake process's WRITTEN JSONL
 * lines — never anything adapter-specific — so the exact same assertions are
 * meaningful against `JsonlProcessAdapter` directly (`./jsonl-process.test.ts`)
 * and against `ContainerAdapter` wrapping it (`./container.test.ts`): if
 * `container` is a true wrapping and not a new protocol, this suite is
 * green against both without a single scenario changed.
 *
 * Underscore-prefixed so `bun test` does not pick this up as a suite itself
 * (repo convention, see `./_test-helpers.ts`) — it is imported and invoked by
 * each adapter's own `.test.ts` file.
 */

import { describe, expect, test } from 'bun:test';
import type { CaptureLogger, FakeClock } from '../../tests/_helpers';
import type { AgentRuntimeAdapter, DeptTaskSpec, InvocationEnvelope, RuntimeConfig, RuntimeEvent } from './adapter';
import { RuntimeAdapterError } from './adapter';
import type { FakeJobSpawn } from './_test-helpers';
import { makeMessage } from './_test-helpers';
import { INLINE_ARTIFACT_BYTES_LIMIT, KILL_SETTLE_GRACE_MS } from './jsonl-process';

export interface ConformanceHarness {
  adapter: AgentRuntimeAdapter;
  spawner: FakeJobSpawn;
  clock: FakeClock;
  logger: CaptureLogger;
}

/** Overrides for one `InvocationEnvelope` fixture — `runtime` is a PARTIAL
 *  `RuntimeConfig`, unlike `InvocationEnvelope.runtime` itself (whole-object
 *  required) — see `runAdapterConformanceSuite`'s doc for why. */
export interface ConformanceInvocationOverrides {
  runtime?: Partial<RuntimeConfig>;
  task?: DeptTaskSpec;
  deadlineAt?: string;
}

/** Same bun:test-hang workaround `jsonl-process.test.ts` uses (a still-PENDING
 *  promise's rejection matcher hangs 1.3.14 when constructed before other sync
 *  code runs in between) — plain try/catch sidesteps it. */
async function expectRejection(promise: Promise<unknown>, check: (err: unknown) => void): Promise<void> {
  try {
    await promise;
  } catch (err) {
    check(err);
    return;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/**
 * Run the full JSONL-contract conformance suite against one adapter. `label`
 * names the `describe` blocks; `makeHarness()` constructs a fresh adapter +
 * fake spawner per test; `makeInvocation(overrides)` builds a valid
 * `InvocationEnvelope` for THIS adapter (e.g. `container`'s needs a
 * `runtime.container` spec `jsonl-process`'s does not). Unlike
 * `./_test-helpers.ts`'s own `makeInvocation` (which REPLACES `runtime`
 * wholesale on any override, per its call sites in `./jsonl-process.test.ts`
 * always restating `adapterId`/`command`), the function passed in here MUST
 * deep-merge `overrides.runtime` over its own adapter-specific defaults — this
 * suite's `runtime` overrides below (`startupTimeoutSeconds`, `command`,
 * `gracefulShutdownSeconds`) are partial and rely on that merge to keep
 * every other required field (`adapterId`, and for `container`, the
 * `container` spec itself) intact.
 */
export function runAdapterConformanceSuite(
  label: string,
  makeHarness: () => ConformanceHarness,
  makeInvocation: (overrides?: ConformanceInvocationOverrides) => InvocationEnvelope
): void {
  describe(`${label} — adapter conformance (d1 suite, 07 §9)`, () => {
    test('start → progress → message → input_required → answer → artifact → complete, in order', async () => {
      const { adapter, spawner } = makeHarness();
      const events: RuntimeEvent[] = [];
      const invocation = makeInvocation();

      const startPromise = adapter.start(invocation, (event) => events.push(event));
      const proc = spawner.last;

      expect(proc.lastWrittenJson()).toEqual({
        type: 'initialize',
        protocolVersion: '1.0',
        capabilities: { midTaskInput: true, artifacts: true },
      });

      proc.emitJson({ type: 'ready', runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
      const handle = await startPromise;
      expect(handle.capabilities).toEqual({ midTaskInput: true, artifacts: true });

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
        { type: 'input_required', questionId: 'q_1', question: { text: 'Android or iOS?', context: null, options: ['Android', 'iOS'] } },
        { type: 'artifact', name: 'review.md', mediaType: 'text/markdown', path: './out/review.md' },
        { type: 'completed', summary: 'Review complete' },
      ]);
    });

    test('every failure branch: task.failed carries reason + retrySafe through verbatim', async () => {
      const { adapter, spawner } = makeHarness();
      const events: RuntimeEvent[] = [];
      const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      await startPromise;

      proc.emitJson({ type: 'task.failed', reason: 'unity not installed', retrySafe: false });
      expect(events).toEqual([{ type: 'failed', reason: 'unity not installed', retrySafe: false }]);
    });

    test('unparseable and unrecognized lines are logged and dropped, never fatal', async () => {
      const { adapter, spawner, logger } = makeHarness();
      const events: RuntimeEvent[] = [];
      const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      const handle = await startPromise;
      expect(handle).toBeTruthy();

      proc.emitLine('not json at all {{{');
      proc.emitLine('42');
      proc.emitJson({ type: 'some.future.event', whatever: true });
      proc.emitJson({ type: 'task.progress', note: 'still going' });

      expect(events).toEqual([{ type: 'progress', note: 'still going' }]);
      expect(logger.lines.some((l) => l.includes('warn:') && l.includes('unparseable'))).toBe(true);
      expect(logger.lines.some((l) => l.includes('warn:') && l.includes('unrecognized up-message'))).toBe(true);
    });

    test('an unparseable line before ready does not fail the handshake', async () => {
      const { adapter, spawner } = makeHarness();
      const startPromise = adapter.start(makeInvocation(), () => {});
      const proc = spawner.last;
      proc.emitLine('garbage');
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: false } });
      await expect(startPromise).resolves.toBeTruthy();
    });

    test('start() rejects and kills the process when ready never arrives', async () => {
      const { adapter, spawner, clock } = makeHarness();
      const startPromise = adapter.start(makeInvocation({ runtime: { startupTimeoutSeconds: 5, command: 'slow-department' } }), () => {});
      clock.advance(5_000);
      await expectRejection(startPromise, (err) => {
        expect(err).toBeInstanceOf(RuntimeAdapterError);
        expect((err as Error).message).toMatch(/did not emit 'ready'/);
      });
      expect(spawner.last.killedWith.length).toBeGreaterThan(0);
    });

    test('an early process exit before ready also fails start()', async () => {
      const { adapter, spawner } = makeHarness();
      const startPromise = adapter.start(makeInvocation(), () => {});
      const proc = spawner.last;
      proc.emitExit({ code: 127, error: 'ENOENT' });
      await expectRejection(startPromise, (err) => {
        expect((err as Error).message).toMatch(/exited before 'ready'/);
      });
    });

    test('a midTaskInput:false handle refuses task.message', async () => {
      const { adapter, spawner } = makeHarness();
      const startPromise = adapter.start(makeInvocation(), () => {});
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', runtime: 'batch-department', capabilities: { midTaskInput: false, artifacts: false } });
      const handle = await startPromise;
      expect(handle.capabilities.midTaskInput).toBe(false);

      await expectRejection(adapter.send(handle, { kind: 'message', message: makeMessage() }), (err) => {
        expect((err as Error).message).toMatch(/midTaskInput:false/);
      });
      expect(proc.written.filter((l) => JSON.parse(l).type === 'task.message')).toEqual([]);
    });

    test('task.start reuse (daemon-lifecycle) is always allowed regardless of capability', async () => {
      const { adapter, spawner } = makeHarness();
      const startPromise = adapter.start(makeInvocation(), () => {});
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: false } });
      const handle = await startPromise;
      await adapter.send(handle, { kind: 'task.start', task: { taskId: 'dtask-2', contextId: 'dctx-1', messages: [makeMessage()] } });
      expect(proc.lastWrittenJson()).toMatchObject({ type: 'task.start', task: { taskId: 'dtask-2' } });
    });

    test('an inline-bytes artifact at/over the cap is dropped, not forwarded', async () => {
      const { adapter, spawner, logger } = makeHarness();
      const events: RuntimeEvent[] = [];
      const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      await startPromise;

      const oversize = Buffer.alloc(INLINE_ARTIFACT_BYTES_LIMIT).toString('base64');
      proc.emitJson({ type: 'task.artifact', name: 'huge.bin', mediaType: 'application/octet-stream', bytes: oversize });
      proc.emitJson({ type: 'task.progress', note: 'after the oversize artifact' });

      expect(events).toEqual([{ type: 'progress', note: 'after the oversize artifact' }]);
      expect(logger.lines.some((l) => l.includes('inline bytes') && l.includes('cap'))).toBe(true);
    });

    test('an inline-bytes artifact comfortably under the cap ships', async () => {
      const { adapter, spawner } = makeHarness();
      const events: RuntimeEvent[] = [];
      const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      await startPromise;

      const small = Buffer.from('hello artifact').toString('base64');
      proc.emitJson({ type: 'task.artifact', name: 'note.txt', mediaType: 'text/plain', bytes: small });

      expect(events).toEqual([{ type: 'artifact', name: 'note.txt', mediaType: 'text/plain', bytes: new Uint8Array(Buffer.from('hello artifact')) }]);
    });

    test('a process that dies mid-task without a terminal event surfaces a synthetic failed(retrySafe:true)', async () => {
      const { adapter, spawner } = makeHarness();
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
      const { adapter, spawner } = makeHarness();
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
      const { adapter, spawner } = makeHarness();
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

    test("dispose() SIGTERMs the process GROUP immediately, then SIGKILLs the group after the grace window if it never exits (d2 — inherited unchanged)", async () => {
      const { adapter, spawner, clock } = makeHarness();
      const startPromise = adapter.start(makeInvocation({ runtime: { command: 'stuck-department', gracefulShutdownSeconds: 3 } }), () => {});
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      const handle = await startPromise;

      const disposePromise = adapter.dispose(handle);
      expect(proc.killedGroupWith).toEqual(['SIGTERM']);
      expect(proc.killedWith).toEqual([]);

      clock.advance(3_000);
      expect(proc.killedGroupWith).toEqual(['SIGTERM', 'SIGKILL']);

      clock.advance(KILL_SETTLE_GRACE_MS);
      await disposePromise;
    });

    test('dispose() resolves as soon as the process actually exits, without waiting out the full grace window', async () => {
      const { adapter, spawner, clock } = makeHarness();
      const startPromise = adapter.start(makeInvocation({ runtime: { command: 'x', gracefulShutdownSeconds: 15 } }), () => {});
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      const handle = await startPromise;

      const disposePromise = adapter.dispose(handle);
      clock.advance(500);
      proc.emitExit({ code: 0, signal: 'SIGTERM' });
      await disposePromise;
      expect(proc.killedGroupWith).toEqual(['SIGTERM']);
    });

    test('cancel() writes task.cancel with the given reason and never touches the OS process directly', async () => {
      const { adapter, spawner } = makeHarness();
      const startPromise = adapter.start(makeInvocation(), () => {});
      const proc = spawner.last;
      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      const handle = await startPromise;
      await adapter.cancel(handle, 'caller canceled');
      expect(proc.lastWrittenJson()).toEqual({ type: 'task.cancel', reason: 'caller canceled' });
      expect(proc.killedGroupWith).toEqual([]);
      expect(proc.killedWith).toEqual([]);
    });

    test('probe(): ok:true with capabilities when the process answers ready promptly', async () => {
      const { adapter, spawner } = makeHarness();
      const probePromise = adapter.probe(makeInvocation().runtime);
      spawner.last.emitJson({ type: 'ready', runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
      const result = await probePromise;
      expect(result).toEqual({ ok: true, runtime: 'unity-department', version: '1.2.0', capabilities: { midTaskInput: true, artifacts: true } });
    });

    test('probe(): ok:false with a reason when ready never arrives, and the process is killed', async () => {
      const { adapter, spawner, clock } = makeHarness();
      const probePromise = adapter.probe(makeInvocation({ runtime: { command: 'broken-department', startupTimeoutSeconds: 2 } }).runtime);
      clock.advance(2_000);
      const result = await probePromise;
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/did not emit 'ready'/);
      expect(spawner.last.killedWith.length).toBeGreaterThan(0);
    });

    test('a task.status emitted synchronously right after ready (same stdout chunk) is not dropped', async () => {
      const { adapter, spawner } = makeHarness();
      const events: RuntimeEvent[] = [];
      const startPromise = adapter.start(makeInvocation(), (event) => events.push(event));
      const proc = spawner.last;

      proc.emitJson({ type: 'ready', capabilities: { midTaskInput: true } });
      proc.emitJson({ type: 'task.status', state: 'WORKING', message: 'no gap at all' });

      await startPromise;
      expect(events).toEqual([{ type: 'status', state: 'WORKING', message: 'no gap at all' }]);
    });
  });
}
