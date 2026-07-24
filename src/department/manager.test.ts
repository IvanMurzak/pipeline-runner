/**
 * `DepartmentManager` tests — the supervisor POLICY layer, independent of
 * any wire format (uses `FakeAdapter`/`FakeNoMidTaskInputAdapter`, not
 * `jsonl-process` — the same separation the interface itself draws). Covers:
 * admission (capacity/draining/unknown-department), capability-aware message
 * routing (queue vs. live send), idle eviction, and the DoD's headline
 * scenario — `per-context` restart mid-task: process gone, message history
 * replayed, task continues.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import { FakeAdapter, FakeNoMidTaskInputAdapter, makeMessage } from './_test-helpers';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DepartmentManager } from './manager';
import type { RuntimeConfig } from './adapter';

/** In-memory journal: appendLine records lines per path — no real fs. */
class MemJournal implements JournalWriter {
  dirsEnsured: string[] = [];
  lines = new Map<string, string[]>();

  ensureDir(path: string): void {
    this.dirsEnsured.push(path);
  }

  appendLine(path: string, line: string): void {
    const list = this.lines.get(path) ?? [];
    list.push(line);
    this.lines.set(path, list);
  }

  parsedLines(path: string): Array<Record<string, unknown>> {
    return (this.lines.get(path) ?? []).map((l) => JSON.parse(l));
  }
}

/** No-op dispatcher (tests drive the manager directly, not through frames). */
const NULL_DISPATCHER: Pick<Dispatcher, 'on'> = { on: () => () => {} };

class FrameSink {
  frames: WireFrame[] = [];
  send = (frame: WireFrame): boolean => {
    this.frames.push(frame);
    return true;
  };
}

function makeManager(overrides: Partial<{ adapters: FakeAdapter[]; capacity: number; draining: boolean; perContextIdleMs: number }> = {}) {
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const journal = new MemJournal();
  const sink = new FrameSink();
  const adapters = overrides.adapters ?? [new FakeAdapter()];
  const runtimes = new Map<string, RuntimeConfig>();
  const manager = new DepartmentManager({
    adapters,
    resolveRuntimeConfig: (departmentId) => runtimes.get(departmentId) ?? null,
    send: sink.send,
    dispatcher: NULL_DISPATCHER,
    journal,
    journalRoot: '/data/department',
    fs: new MemShipperFs(),
    transport: { name: 'fake', upload: async () => ({ ok: true, ack: { run_id: 'x', inserted: 0, skipped: 0 } }) },
    clock,
    logger,
    perContextIdleMs: overrides.perContextIdleMs,
    capacity: overrides.capacity !== undefined ? () => overrides.capacity! : undefined,
    draining: overrides.draining !== undefined ? () => overrides.draining! : undefined,
  });
  return { manager, clock, logger, journal, sink, runtimes, adapter: adapters[0]! };
}

/** Matches manager.ts's `join(journalRoot, sanitizeForPath(executionId), 'events.jsonl')`
 *  — built with the SAME `node:path` join so the test's expected key matches
 *  the platform-native separator manager.ts actually writes with (Windows
 *  join produces backslashes; a hardcoded forward-slash literal would not
 *  match `MemJournal`'s exact-string keys). */
function journalPathFor(executionId: string): string {
  return join('/data/department', executionId, 'events.jsonl');
}

function makeOffer(overrides: Partial<DepartmentOfferInput> = {}): DepartmentOfferInput {
  return {
    executionId: 'dexec-1',
    taskId: 'dtask-1',
    contextId: 'dctx-1',
    departmentId: 'unity-department',
    messages: [makeMessage()],
    ...overrides,
  };
}

describe('DepartmentManager — admission', () => {
  test('accepts a well-formed offer for a known department and starts the adapter', async () => {
    const { manager, adapter, runtimes } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department' });
    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);
    expect(adapter.startCalls()[0]!.task).toMatchObject({ taskId: 'dtask-1', contextId: 'dctx-1' });
  });

  test('rejects with capability when the department is unknown', async () => {
    const { manager } = makeManager();
    const result = await manager.admitTask(makeOffer({ departmentId: 'no-such-department' }));
    expect(result).toEqual({ accepted: false, reason: 'capability' });
  });

  test('rejects with capability when the resolved adapterId has no registered adapter', async () => {
    const { manager, runtimes } = makeManager();
    runtimes.set('unity-department', { adapterId: 'not-registered', command: 'x' });
    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: false, reason: 'capability' });
  });

  test('rejects with busy at capacity', async () => {
    const { manager, runtimes } = makeManager({ capacity: 1 });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    const first = await manager.admitTask(makeOffer({ executionId: 'e1' }));
    expect(first).toEqual({ accepted: true });
    const second = await manager.admitTask(makeOffer({ executionId: 'e2' }));
    expect(second).toEqual({ accepted: false, reason: 'busy' });
  });

  test('rejects with policy while draining', async () => {
    const { manager, runtimes } = makeManager({ draining: true });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: false, reason: 'policy' });
  });

  test('a redelivered offer for an already-admitted execution is idempotently accepted (no second start)', async () => {
    const { manager, adapter, runtimes } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    const again = await manager.admitTask(makeOffer());
    expect(again).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);
  });

  test('a terminal RuntimeEvent journals and clears activeCount', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    expect(manager.activeCount).toBe(1);

    adapter.emitLatest({ type: 'completed', summary: 'all done' });
    expect(manager.activeCount).toBe(0);
    const lines = journal.parsedLines(journalPathFor('dexec-1'));
    expect(lines.map((l) => l.type)).toContain('department.completed');
  });
});

describe('DepartmentManager — capability-aware message routing', () => {
  test('midTaskInput:true — a message is delivered live via adapter.send()', async () => {
    const { manager, adapter, runtimes } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    const result = await manager.deliverMessage('dexec-1', makeMessage({ messageId: 'answer-1' }));
    expect(result.delivered).toBe(true);
    const sendCalls = adapter.calls.filter((c) => c.kind === 'send');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.input).toEqual({ kind: 'message', message: expect.objectContaining({ messageId: 'answer-1' }) });
  });

  test("midTaskInput:false — a message is NEVER sent live; it is queued and triggers no adapter.send() call", async () => {
    const noMid = new FakeNoMidTaskInputAdapter();
    const { manager, runtimes } = makeManager({ adapters: [noMid] });
    runtimes.set('batch-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer({ departmentId: 'batch-department' }));

    const result = await manager.deliverMessage('dexec-1', makeMessage({ messageId: 'answer-1' }));
    expect(result.delivered).toBe(false);
    expect(noMid.calls.filter((c) => c.kind === 'send')).toHaveLength(0);
  });
});

describe('DepartmentManager — per-context restart mid-task (DoD headline scenario)', () => {
  test('process gone, message history replayed, task continues', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department', lifecycle: 'per-context' });

    await manager.admitTask(makeOffer({ messages: [makeMessage({ messageId: 'm1', parts: [{ text: 'first message' }] })] }));
    expect(adapter.startCalls()).toHaveLength(1);

    // The runtime says something before it dies (must be replayed too).
    adapter.emitLatest({ type: 'message', parts: [{ text: 'partial progress noted' }] });
    // Simulate the process crashing mid-task: an unexpected exit.
    adapter.emitLatest({ type: 'failed', reason: 'process exited unexpectedly (code 137)', retrySafe: true });

    // A silent respawn happened — start() was called a SECOND time, for the
    // SAME task/context, with the FULL history (original + the agent's
    // partial message) replayed.
    expect(adapter.startCalls()).toHaveLength(2);
    const secondInvocation = adapter.startCalls()[1]!;
    expect(secondInvocation.task.taskId).toBe('dtask-1');
    expect(secondInvocation.task.contextId).toBe('dctx-1');
    expect(secondInvocation.task.messages.map((m) => m.parts[0]?.text)).toEqual(['first message', 'partial progress noted']);

    // The task CONTINUES: the second (respawned) process completes normally.
    adapter.emitLatest({ type: 'completed', summary: 'done after respawn' });
    expect(manager.activeCount).toBe(0);

    // The crash itself was NOT journaled as a department.failed — it was
    // absorbed as an internal respawn, not surfaced as the task's outcome.
    const journalPath = journalPathFor('dexec-1');
    const types = journal.parsedLines(journalPath).map((l) => l.type);
    expect(types).not.toContain('department.failed');
    expect(types).toContain('department.completed');
    expect(types).toContain('department.message'); // the pre-crash message IS journaled
  });

  test('a second unexpected exit after the one auto-respawn is a real terminal failure (no crash loop)', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'failed', reason: 'crash 1', retrySafe: true });
    expect(adapter.startCalls()).toHaveLength(2);

    adapter.emitLatest({ type: 'failed', reason: 'crash 2', retrySafe: true });
    // No third respawn — bounded to exactly one.
    expect(adapter.startCalls()).toHaveLength(2);
    expect(manager.activeCount).toBe(0);
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types).toContain('department.failed');
  });

  test('per-task lifecycle does NOT auto-respawn on an unexpected exit — it fails outright', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' }); // default lifecycle: per-task
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'failed', reason: 'process exited unexpectedly', retrySafe: true });
    expect(adapter.startCalls()).toHaveLength(1); // no respawn
    expect(manager.activeCount).toBe(0);
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types).toContain('department.failed');
  });
});

describe('DepartmentManager — idle eviction (per-context)', () => {
  test('an idle per-context handle is disposed after perContextIdleMs; the next message respawns it', async () => {
    const { manager, adapter, runtimes, clock } = makeManager({ perContextIdleMs: 60_000 });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });
    await manager.admitTask(makeOffer());
    expect(adapter.startCalls()).toHaveLength(1);

    clock.advance(60_000);
    expect(adapter.calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);

    await manager.deliverMessage('dexec-1', makeMessage({ messageId: 'nudge' }));
    expect(adapter.startCalls()).toHaveLength(2);
    expect(adapter.startCalls()[1]!.task.messages.map((m) => m.messageId)).toContain('nudge');
  });
});

describe('DepartmentManager — wire attachment (attach(), provisional frame shapes)', () => {
  function makeWiredManager() {
    const dispatcher = new Dispatcher();
    const clock = new FakeClock();
    const journal = new MemJournal();
    const sink = new FrameSink();
    const adapter = new FakeAdapter();
    const runtimes = new Map<string, RuntimeConfig>([['unity-department', { adapterId: 'fake', command: 'x' }]]);
    const manager = new DepartmentManager({
      adapters: [adapter],
      resolveRuntimeConfig: (id) => runtimes.get(id) ?? null,
      send: sink.send,
      dispatcher,
      journal,
      journalRoot: '/data/department',
      fs: new MemShipperFs(),
      transport: { name: 'fake', upload: async () => ({ ok: true, ack: { run_id: 'x', inserted: 0, skipped: 0 } }) },
      clock,
      logger: new CaptureLogger(),
    });
    manager.attach(dispatcher);
    return { manager, dispatcher, adapter, sink, runtimes };
  }

  const OFFER_FRAME: WireFrame = {
    type: 'department.offer',
    execution_id: 'dexec-w1',
    task_id: 'dtask-w1',
    context_id: 'dctx-w1',
    department_id: 'unity-department',
    messages: [{ message_id: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }] }],
  };

  test('a well-formed department.offer admits the task and replies department.accept', async () => {
    const { dispatcher, adapter, sink } = makeWiredManager();
    dispatcher.dispatch(OFFER_FRAME);
    await tick(); // let the async offer/admission chain settle
    expect(adapter.startCalls()).toHaveLength(1);
    expect(sink.frames).toEqual([{ type: 'department.accept', execution_id: 'dexec-w1', task_id: 'dtask-w1' }]);
  });

  test('an offer for an unknown department replies department.reject with reason capability', async () => {
    const { dispatcher, sink } = makeWiredManager();
    dispatcher.dispatch({ ...OFFER_FRAME, execution_id: 'dexec-w2', department_id: 'no-such-department' });
    await tick();
    expect(sink.frames).toEqual([{ type: 'department.reject', execution_id: 'dexec-w2', reason: 'capability' }]);
  });

  test('a malformed offer (missing messages) is ignored — no accept/reject sent', async () => {
    const { dispatcher, sink } = makeWiredManager();
    const malformed: WireFrame = {
      type: 'department.offer',
      execution_id: 'dexec-w3',
      task_id: 'dtask-w3',
      context_id: 'dctx-w3',
      department_id: 'unity-department',
      // messages omitted — narrowOfferFrame requires at least one.
    };
    dispatcher.dispatch(malformed);
    await tick();
    expect(sink.frames).toEqual([]);
  });

  test('a department.message frame delivers to the running execution', async () => {
    const { dispatcher, adapter } = makeWiredManager();
    dispatcher.dispatch(OFFER_FRAME);
    await tick();
    dispatcher.dispatch({
      type: 'department.message',
      execution_id: 'dexec-w1',
      message: { message_id: 'answer-1', role: 'ROLE_USER', parts: [{ text: 'the answer' }] },
    });
    await tick();
    const sendCalls = adapter.calls.filter((c) => c.kind === 'send');
    expect(sendCalls).toHaveLength(1);
  });

  test('a department.cancel frame cancels the running execution', async () => {
    const { dispatcher, adapter } = makeWiredManager();
    dispatcher.dispatch(OFFER_FRAME);
    await tick();
    dispatcher.dispatch({ type: 'department.cancel', execution_id: 'dexec-w1', reason: 'caller canceled' });
    await tick();
    const cancelCalls = adapter.calls.filter((c) => c.kind === 'cancel');
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.reason).toBe('caller canceled');
  });
});
