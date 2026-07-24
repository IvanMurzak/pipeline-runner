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

describe('DepartmentManager — lease renewal (d2, 07 §6)', () => {
  test('renewLeases() sends department.lease_renew at TTL/3, repeatedly, for a long-running execution', async () => {
    const { manager, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 })); // TTL/3 = 30s

    clock.advance(29_000);
    manager.renewLeases();
    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(0);

    clock.advance(1_000); // 30s total — due
    manager.renewLeases();
    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toEqual([
      { type: 'department.lease_renew', execution_id: 'dexec-1', lease_token: 'lease-abc' },
    ]);

    // A LONG task: renewal keeps firing every 30s, well past the original
    // 90s TTL — the DoD's "lease renewal keeps a long task alive" (the cloud
    // is what actually expires an unrenewed lease; this proves the runner
    // side keeps feeding it).
    clock.advance(30_000);
    manager.renewLeases();
    clock.advance(30_000);
    manager.renewLeases();
    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(3);
  });

  test('an execution admitted without lease info is silently skipped, never renewed', async () => {
    const { manager, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer()); // no leaseToken/leaseTtlS
    clock.advance(1_000_000);
    manager.renewLeases();
    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(0);
  });

  test('a terminal execution is never renewed', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 }));
    adapter.emitLatest({ type: 'completed', summary: 'done' });
    clock.advance(1_000_000);
    manager.renewLeases();
    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(0);
  });

  test('a failed send (runner offline) is retried on the next call, never marked renewed', async () => {
    const clock = new FakeClock();
    const adapter = new FakeAdapter();
    const runtimes = new Map<string, RuntimeConfig>([['unity-department', { adapterId: 'fake', command: 'x' }]]);
    let sendOk = true;
    const sent: WireFrame[] = [];
    const manager = new DepartmentManager({
      adapters: [adapter],
      resolveRuntimeConfig: (id) => runtimes.get(id) ?? null,
      send: (frame) => {
        if (frame.type === 'department.lease_renew' && !sendOk) return false;
        sent.push(frame);
        return true;
      },
      dispatcher: NULL_DISPATCHER,
      journal: new MemJournal(),
      journalRoot: '/data/department',
      clock,
      logger: new CaptureLogger(),
    });
    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 }));

    sendOk = false;
    clock.advance(30_000);
    manager.renewLeases();
    expect(sent.filter((f) => f.type === 'department.lease_renew')).toHaveLength(0);

    sendOk = true;
    manager.renewLeases(); // retried right away — the miss was never marked renewed
    expect(sent.filter((f) => f.type === 'department.lease_renew')).toHaveLength(1);
  });
});

describe('DepartmentManager — lease revocation (d2, 07 §6)', () => {
  function makeWiredForRevoke() {
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
      clock,
      logger: new CaptureLogger(),
    });
    manager.attach(dispatcher);
    return { manager, dispatcher, adapter, sink };
  }

  test('department.lease_revoked stops the execution and ships NOTHING further', async () => {
    const { manager, dispatcher, adapter, sink } = makeWiredForRevoke();
    await manager.admitTask(makeOffer());
    expect(manager.activeCount).toBe(1);

    dispatcher.dispatch({ type: 'department.lease_revoked', execution_id: 'dexec-1', reason: 'reassigned to another runner' });
    await tick();

    expect(manager.activeCount).toBe(0);
    expect(sink.frames.filter((f) => f.type === 'department.event')).toHaveLength(0);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(1);
    expect(adapter.calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);

    // A late runtime event after revocation must also ship nothing.
    adapter.emitLatest({ type: 'completed', summary: 'too late' });
    expect(sink.frames.filter((f) => f.type === 'department.event')).toHaveLength(0);
  });

  test('a malformed department.lease_revoked (missing execution_id) is ignored', async () => {
    const { manager, dispatcher } = makeWiredForRevoke();
    await manager.admitTask(makeOffer());
    dispatcher.dispatch({ type: 'department.lease_revoked', reason: 'x' });
    await tick();
    expect(manager.activeCount).toBe(1); // untouched
  });
});

describe('DepartmentManager — cancellation finalizes promptly, not on the runtime\'s cooperation (d2, 07 §7)', () => {
  test('cancelExecution() finalizes immediately — no waiting on the runtime to self-report', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    expect(manager.activeCount).toBe(1);

    await manager.cancelExecution('dexec-1', 'caller canceled');

    expect(manager.activeCount).toBe(0); // finalized synchronously
    const cancelCalls = adapter.calls.filter((c) => c.kind === 'cancel');
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.reason).toBe('caller canceled');
    expect(adapter.calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types).toContain('department.failed');
  });

  test('a late task.failed AFTER cancel is a no-op — no double-report, no respawn', async () => {
    const { manager, adapter, runtimes, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });
    await manager.admitTask(makeOffer());
    const handle = adapter.lastHandle;

    await manager.cancelExecution('dexec-1');
    expect(manager.activeCount).toBe(0);

    // The runtime's own (stale) response arrives after the fact.
    adapter.emit(handle, { type: 'failed', reason: 'late response', retrySafe: true });
    expect(adapter.startCalls()).toHaveLength(1); // no respawn triggered
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types.filter((t) => t === 'department.failed')).toHaveLength(1); // exactly one, from the cancel
  });
});

describe('DepartmentManager — wall-clock deadline (d2, 07 §7)', () => {
  test('a deadline fires on a runtime that never exits', async () => {
    const { manager, adapter, runtimes, clock, journal, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    const deadlineAt = new Date(clock.now() + 3_600_000).toISOString(); // 1h out
    await manager.admitTask(makeOffer({ deadlineAt }));
    expect(manager.activeCount).toBe(1);

    clock.advance(3_600_000);
    await tick(); // onDeadlineExceeded's terminateExecution() is fire-and-forget

    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(1);
    expect(manager.activeCount).toBe(0);
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types).toContain('department.failed');
    const shipped = sink.frames.find((f) => f.type === 'department.event');
    expect(shipped).toMatchObject({ event: { type: 'failed', reason: 'wall-clock deadline exceeded' } });
  });

  test('completing before the deadline clears the timer — no spurious cancel afterward', async () => {
    const { manager, adapter, runtimes, clock } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    const deadlineAt = new Date(clock.now() + 3_600_000).toISOString();
    await manager.admitTask(makeOffer({ deadlineAt }));
    adapter.emitLatest({ type: 'completed', summary: 'done early' });
    expect(manager.activeCount).toBe(0);

    clock.advance(3_600_000); // deadline would have fired — must be a no-op now
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
  });

  test('an execution admitted without a deadline never gets cancelled by one', async () => {
    const { manager, adapter, runtimes, clock } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer()); // no deadlineAt
    clock.advance(100 * 3_600_000);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
    expect(manager.activeCount).toBe(1);
  });
});

describe('DepartmentManager — park expiry (d2, 07 §7 — "a parked question inherits the department\'s park expiry")', () => {
  test('a parked question expires at the department park expiry, not never', async () => {
    const { manager, adapter, runtimes, clock, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', parkExpirySeconds: 60 });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'input_required', questionId: 'q1', question: { text: 'Android or iOS?' } });

    clock.advance(60_000);
    await tick(); // onParkExpired's terminateExecution() is fire-and-forget

    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(1);
    expect(manager.activeCount).toBe(0);
    const types = journal.parsedLines(journalPathFor('dexec-1')).map((l) => l.type);
    expect(types).toContain('department.failed');
  });

  test('an answer delivered before the park expiry clears the timer — no spurious expiry', async () => {
    const { manager, adapter, runtimes, clock } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', parkExpirySeconds: 60 });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'input_required', questionId: 'q1', question: { text: 'Android or iOS?' } });

    await manager.deliverMessage('dexec-1', makeMessage({ messageId: 'answer-1' }));
    clock.advance(60_000); // would have expired — must be a no-op now
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
    expect(manager.activeCount).toBe(1);
  });

  test('with no parkExpirySeconds configured, the default (7 days) applies — not never', async () => {
    const { manager, adapter, runtimes, clock } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' }); // no parkExpirySeconds
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'input_required', questionId: 'q1', question: { text: 'Android or iOS?' } });

    clock.advance(7 * 24 * 60 * 60 * 1000);
    await tick();
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(1);
  });
});

describe('DepartmentManager — wire attachment (attach(), real protocol 0.4.0 frame shapes)', () => {
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
    attempt: 1,
    lease_token: 'lease-w1',
    lease_ttl_s: 900,
    adapter: 'fake',
    accepted_output_modes: ['text/markdown'],
    deadline_at: '2026-07-23T18:00:00.000Z',
    event_seq_base: 0,
    messages: [
      { message_id: 'm1', role: 'ROLE_USER', parts: [{ text: 'hello' }], created_at: '2026-07-23T12:00:00.000Z' },
    ],
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
      message: {
        message_id: 'answer-1',
        role: 'ROLE_USER',
        parts: [{ text: 'the answer' }],
        created_at: '2026-07-23T12:05:00.000Z',
      },
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
