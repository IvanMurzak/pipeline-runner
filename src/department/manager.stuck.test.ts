/**
 * `DepartmentManager` × stuck detection (simplified-onboarding b4; D25,
 * `06-engine-modules.md` §5, `05-department-project.md` §6/§7.5). Its own file
 * for the same reason `./manager.artifacts.test.ts` is one: the wiring is
 * additive and orthogonal to `./manager.test.ts`'s existing coverage, which
 * stays the regression proof that crash, deadline, park expiry, lease
 * revocation and idle eviction are untouched.
 *
 * The two shapes covered here are NOT the same failure:
 *
 *   1. The session goes quiet — nothing arrives for longer than the threshold,
 *      the process still alive. A watchdog catches this.
 *   2. The session ENDS having reported nothing. b3 observed this for real
 *      (a denied receiver-tool call does not block, it just fails, and the
 *      session runs to its own end silently), and no watchdog can ever catch
 *      it — the terminal always arrives first. `judgeTerminalEvent` does.
 *
 * Everything is gated on the engine's own `supportsStreaming: 'yes'`
 * declaration (`./engine.ts`), so `FakeAdapter`'s id is load-bearing in this
 * file: `'claude-code'`/`'jsonl-process'` are watched, `'pipeline-drive'` and
 * the default `'fake'` are not.
 */

import { describe, expect, test } from 'bun:test';
import { DeptEventMessageSchema } from '@baizor/pipeline-protocol';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import type { RuntimeConfig } from './adapter';
import { FakeAdapter, makeMessage } from './_test-helpers';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DEFAULT_STUCK_AFTER_S, deriveStuckAfterSeconds, DepartmentManager, STUCK_FAILURE_REASON } from './manager';

const MINUTE = 60_000;
const DEFAULT_STUCK_MS = DEFAULT_STUCK_AFTER_S * 1000;

class MemJournal implements JournalWriter {
  lines = new Map<string, string[]>();
  ensureDir(): void {}
  appendLine(path: string, line: string): void {
    const list = this.lines.get(path) ?? [];
    list.push(line);
    this.lines.set(path, list);
  }
  /** Every line written anywhere, parsed — this suite asserts on WHAT was
   *  journalled, never on which file it landed in (that is `./events.test.ts`'s
   *  subject). */
  allParsed(): Array<Record<string, unknown>> {
    return [...this.lines.values()].flat().map((line) => JSON.parse(line));
  }
}

class FrameSink {
  frames: WireFrame[] = [];
  send = (frame: WireFrame): boolean => {
    this.frames.push(frame);
    return true;
  };
  events(): Array<Record<string, unknown>> {
    return this.frames.filter((f) => f.type === 'department.event') as Array<Record<string, unknown>>;
  }
}

const NULL_DISPATCHER: Pick<Dispatcher, 'on'> = { on: () => () => {} };

function makeManager(options: { adapterId?: string; perContextIdleMs?: number } = {}) {
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const journal = new MemJournal();
  const sink = new FrameSink();
  const adapter = new FakeAdapter(options.adapterId ?? 'claude-code');
  const runtimes = new Map<string, RuntimeConfig>();
  const dispatcher = new Dispatcher();
  const manager = new DepartmentManager({
    adapters: [adapter],
    resolveRuntimeConfig: (departmentId) => runtimes.get(departmentId) ?? null,
    send: sink.send,
    dispatcher,
    journal,
    journalRoot: '/data/department',
    clock,
    logger,
    perContextIdleMs: options.perContextIdleMs,
  });
  manager.attach(dispatcher);
  return { manager, clock, logger, journal, sink, runtimes, adapter, dispatcher };
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

/** The terminal `failed` reason the manager actually reported, or null. */
function reportedFailure(sink: FrameSink): { reason: string; retry_safe: boolean } | null {
  for (const frame of sink.events()) {
    const event = frame.event as { type: string; reason?: string; retry_safe?: boolean };
    if (event.type === 'failed') return { reason: event.reason!, retry_safe: event.retry_safe! };
  }
  return null;
}

function journalledTypes(journal: MemJournal): string[] {
  return journal.allParsed().map((line) => String(line.type));
}

describe('stuck detection — shape 1: the session goes quiet (D25)', () => {
  test('past the threshold the execution is reported `stuck`, and the sender is notified through the existing channel', async () => {
    const { manager, adapter, runtimes, clock, sink, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'progress', note: 'using Read' });

    clock.advance(DEFAULT_STUCK_MS);
    await tick(); // checkStuck's terminateExecution() is fire-and-forget

    expect(manager.activeCount).toBe(0);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(1);
    expect(adapter.calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);
    // Notified through the SAME `department.event` channel every other
    // terminal uses — no new frame type, no second path.
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
    expect(journalledTypes(journal)).toContain('department.failed');
  });

  test('the reason is the bare coded value `stuck`, and the frame still parses as an ordinary department.event (p1)', async () => {
    const { manager, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    clock.advance(DEFAULT_STUCK_MS);
    await tick();

    const frame = sink.events()[0];
    expect(frame).toBeDefined();
    // p1's whole point: `stuck` rides the EXISTING `failed` event as a reason
    // value, so the real schema — a discriminated union that hard-fails on an
    // unknown `type` — parses it with no change at all.
    const parsed = DeptEventMessageSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    expect(STUCK_FAILURE_REASON).toBe('stuck');
    expect((frame!.event as { reason: string }).reason).toBe('stuck');
  });

  test('a busy long-running task is NOT flagged: signals keep the window open for hours (false-positive guard)', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    // A slow-but-live session: one signal every 29 minutes for 10 hours —
    // always inside the 30-minute window, never twice inside it.
    for (let i = 0; i < 20; i += 1) {
      clock.advance(29 * MINUTE);
      await tick();
      expect(reportedFailure(sink)).toBeNull();
      adapter.emitLatest({ type: 'progress', note: `step ${i}` });
    }
    expect(manager.activeCount).toBe(1);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);

    // Same session, same manager: 30 minutes after its LAST word it is stuck.
    // Silence is measured from the last signal, not from admission.
    clock.advance(DEFAULT_STUCK_MS);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });

  test('a task that finishes normally after a long quiet-ish run is never touched by the watchdog', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    clock.advance(20 * MINUTE);
    adapter.emitLatest({ type: 'progress', note: 'still going' });
    clock.advance(20 * MINUTE);
    await tick();
    adapter.emitLatest({ type: 'completed', summary: 'done' });

    expect(reportedFailure(sink)).toBeNull();
    expect(manager.activeCount).toBe(0);

    // Well past the threshold with the execution already terminal — the timer
    // was cleared, not merely ignored.
    clock.advance(10 * DEFAULT_STUCK_MS);
    await tick();
    expect(reportedFailure(sink)).toBeNull();
    expect(clock.pendingCount).toBe(0);
  });
});

describe('stuck detection — shape 2: the session ends having reported nothing (b3\'s observation)', () => {
  test('a `completed` from a watched engine that emitted NOTHING is reported `stuck`, not a hollow success', async () => {
    const { manager, adapter, runtimes, sink, journal, logger } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    // The observed failure: every receiver-tool call was DENIED (not blocked),
    // so the session ran to its own end and reported precisely nothing.
    adapter.emitLatest({ type: 'completed', summary: 'I could not report anything' });

    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
    expect(journalledTypes(journal)).toContain('department.failed');
    expect(journalledTypes(journal)).not.toContain('department.completed');
    expect(logger.joined()).toContain('without reporting anything at all');
  });

  test('ONE signal of any kind is enough for the completion to stand', async () => {
    const { manager, adapter, runtimes, sink, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'progress', note: 'using Read' });
    adapter.emitLatest({ type: 'completed', summary: 'reviewed the save system' });

    expect(reportedFailure(sink)).toBeNull();
    expect(journalledTypes(journal)).toContain('department.completed');
  });

  test('a `failed` is NEVER rewritten — the runtime\'s own stated reason is more specific than `stuck`', async () => {
    const { manager, adapter, runtimes, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'failed', reason: 'claude-code: the session ended with an error', retrySafe: true });

    expect(reportedFailure(sink)).toEqual({
      reason: 'claude-code: the session ended with an error',
      retry_safe: true,
    });
  });

  test('x16\'s shape passes straight through: a cut-off session\'s `unreported` is NOT relabelled `stuck`', async () => {
    // The third shape (`./claude-code.ts`'s `UNREPORTED_FAILURE_REASON`): a
    // session that reported for a while and then lost its receiver tools. It
    // has plenty of signals, so nothing in this file can see it — the engine
    // module judged it from the tool-call outcomes only it can read, and the
    // supervisor's job is to carry that verdict, not to second-guess it.
    const { manager, adapter, runtimes, sink, journal } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'progress', note: 'using mcp__pipeline-department__task_update_progress' });
    adapter.emitLatest({ type: 'progress', note: 'using mcp__pipeline-department__task_check_cancelled' });
    adapter.emitLatest({ type: 'failed', reason: 'unreported', retrySafe: true });

    expect(reportedFailure(sink)).toEqual({ reason: 'unreported', retry_safe: true });
    expect(journalledTypes(journal)).not.toContain('department.completed');
    // Same frame shape as `stuck`: a reason value on the existing `failed`
    // event, so no consumer needs a schema change to receive it (p1).
    expect(DeptEventMessageSchema.safeParse(sink.events()[sink.events().length - 1]).success).toBe(true);
  });

  test('a silent `completed` from an engine that does not claim to stream (pipeline) stands untouched', async () => {
    const { manager, adapter, runtimes, sink, journal } = makeManager({ adapterId: 'pipeline-drive' });
    runtimes.set('review-department', { adapterId: 'pipeline-drive', command: 'pipeline' });
    await manager.admitTask(makeOffer({ departmentId: 'review-department' }));

    // `pipeline` declares `supportsStreaming: 'partial'`: nothing is reported
    // WHILE a buffered exec runs, so silence proves nothing about it.
    adapter.emitLatest({ type: 'completed', summary: 'drive finished' });

    expect(reportedFailure(sink)).toBeNull();
    expect(journalledTypes(journal)).toContain('department.completed');
  });
});

describe('stuck detection — who is watched at all (the engine\'s own declaration, b2)', () => {
  test('`pipeline` (supportsStreaming: partial) is never watched — a long buffered exec is not silence', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager({ adapterId: 'pipeline-drive' });
    runtimes.set('review-department', { adapterId: 'pipeline-drive', command: 'pipeline' });
    await manager.admitTask(makeOffer({ departmentId: 'review-department' }));

    clock.advance(100 * DEFAULT_STUCK_MS);
    await tick();

    expect(manager.activeCount).toBe(1);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
    expect(reportedFailure(sink)).toBeNull();
  });

  test('an adapter with no registry row declared nothing and is held to nothing', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager({ adapterId: 'fake' });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    clock.advance(100 * DEFAULT_STUCK_MS);
    await tick();

    expect(manager.activeCount).toBe(1);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
    expect(reportedFailure(sink)).toBeNull();
  });

  test('`stuckAfterSeconds: 0` disables the watchdog for that department', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', stuckAfterSeconds: 0 });
    await manager.admitTask(makeOffer());

    clock.advance(100 * DEFAULT_STUCK_MS);
    await tick();

    expect(manager.activeCount).toBe(1);
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);
    expect(reportedFailure(sink)).toBeNull();
  });

  test('an explicit `stuckAfterSeconds` is taken literally, default or not', async () => {
    const { manager, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', stuckAfterSeconds: 120 });
    await manager.admitTask(makeOffer());

    clock.advance(119_000);
    await tick();
    expect(reportedFailure(sink)).toBeNull();

    clock.advance(1_000);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });
});

describe('stuck detection — the shipped timers keep their own jobs (regression)', () => {
  test('a parked question is not silence: the watchdog suspends and park expiry owns the wait', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' }); // park expiry: 7d default
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'input_required', questionId: 'q1', question: { text: 'Which Unity version?' } });

    // Four hours parked — eight stuck windows — and nothing happens, because
    // the sender is the one being waited on.
    clock.advance(8 * DEFAULT_STUCK_MS);
    await tick();
    expect(manager.activeCount).toBe(1);
    expect(reportedFailure(sink)).toBeNull();

    // The answer restarts the work AND the window.
    await manager.deliverMessage('dexec-1', makeMessage({ messageId: 'answer-1' }));
    clock.advance(DEFAULT_STUCK_MS - 1_000);
    await tick();
    expect(reportedFailure(sink)).toBeNull();

    clock.advance(1_000);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });

  test('park expiry still fires at its OWN value, with its own reason, while the watchdog is suspended', async () => {
    const { manager, adapter, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', parkExpirySeconds: 60 });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'input_required', questionId: 'q1', question: { text: 'Android or iOS?' } });

    clock.advance(60_000);
    await tick();

    expect(reportedFailure(sink)).toEqual({
      reason: 'parked question expired without an answer',
      retry_safe: false,
    });
  });

  test('the wall-clock deadline still wins when it lands first, with its own reason', async () => {
    const { manager, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    const deadlineAt = new Date(clock.now() + 10 * MINUTE).toISOString();
    await manager.admitTask(makeOffer({ deadlineAt }));

    clock.advance(10 * MINUTE);
    await tick();

    expect(reportedFailure(sink)).toEqual({ reason: 'wall-clock deadline exceeded', retry_safe: false });
    // And exactly one terminal — the watchdog does not report a second one.
    expect(sink.events().filter((f) => (f.event as { type: string }).type === 'failed')).toHaveLength(1);
  });

  test('a crash is still a crash: the runtime\'s own retry-safe failure is not relabelled', async () => {
    const { manager, adapter, runtimes, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'progress', note: 'using Bash' });

    adapter.emitLatest({ type: 'failed', reason: 'the session exited without reporting a result (code 137)', retrySafe: true });

    expect(reportedFailure(sink)).toEqual({
      reason: 'the session exited without reporting a result (code 137)',
      retry_safe: true,
    });
  });

  test('a revoked lease reports NOTHING further — the watchdog does not resurrect the execution', async () => {
    const { manager, dispatcher, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer());

    dispatcher.dispatch({ type: 'department.lease_revoked', execution_id: 'dexec-1', reason: 'reassigned' });
    await tick();

    clock.advance(100 * DEFAULT_STUCK_MS);
    await tick();
    expect(sink.events()).toHaveLength(0);
    expect(clock.pendingCount).toBe(0);
  });

  test('per-context idle eviction still evicts, and is NOT conflated with stuck reporting', async () => {
    const { manager, adapter, runtimes, clock, sink, logger } = makeManager({
      adapterId: 'jsonl-process',
      perContextIdleMs: 60_000,
    });
    runtimes.set('unity-department', {
      adapterId: 'jsonl-process',
      command: 'unity-department',
      lifecycle: 'per-context',
      stuckAfterSeconds: 300,
    });
    await manager.admitTask(makeOffer());

    // 1 minute idle: the HANDLE is reclaimed. Nothing is reported, nothing
    // fails, the execution is still live — eviction's job, unchanged.
    clock.advance(60_000);
    await tick();
    expect(adapter.calls.filter((c) => c.kind === 'dispose')).toHaveLength(1);
    expect(manager.activeCount).toBe(1);
    expect(reportedFailure(sink)).toBeNull();
    expect(logger.joined()).toContain('evicting (per-context)');

    // 5 minutes of total silence: the TASK is reported. Two mechanisms, two
    // jobs, one silence.
    clock.advance(4 * 60_000);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });
});

describe('stuck detection — the threshold comes from the department\'s own limits (D25)', () => {
  test('deriveStuckAfterSeconds: a quarter of taskTimeout, clamped to [5m, 60m]', () => {
    expect(deriveStuckAfterSeconds(2 * 3600)).toBe(30 * 60); // 05 §2's reference manifest ⇒ 05 §6's "30m"
    expect(deriveStuckAfterSeconds(40 * 60)).toBe(10 * 60);
    expect(deriveStuckAfterSeconds(10 * 60)).toBe(5 * 60); // floor
    expect(deriveStuckAfterSeconds(24 * 3600)).toBe(60 * 60); // ceiling
  });

  function configUpdate(taskTimeout: string, departmentId = 'unity-department'): WireFrame {
    return {
      type: 'department.config_update',
      department_id: departmentId,
      manifest_digest: 'digest-abc',
      runtime_profile: {},
      limits: { taskTimeout },
    };
  }

  test('a config_update\'s limits.taskTimeout sets the threshold for the next admission', async () => {
    const { manager, dispatcher, runtimes, clock, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });

    dispatcher.dispatch(configUpdate('40m')); // ⇒ 10m, far short of the 30m default
    await tick();
    await manager.admitTask(makeOffer());

    clock.advance(10 * MINUTE - 1_000);
    await tick();
    expect(reportedFailure(sink)).toBeNull();

    clock.advance(1_000);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });

  test('a config_update re-arms an ALREADY-RUNNING execution to the new threshold', async () => {
    const { manager, dispatcher, runtimes, clock, sink, logger } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });
    await manager.admitTask(makeOffer()); // armed at the 30m default

    dispatcher.dispatch(configUpdate('40m')); // ⇒ 10m
    await tick();
    expect(logger.joined()).toContain('stuck threshold re-armed to 600s');

    clock.advance(10 * MINUTE);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });

  test('a malformed taskTimeout is logged and ignored — the default still applies, nothing crashes', async () => {
    const { manager, dispatcher, runtimes, clock, sink, logger } = makeManager();
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });

    dispatcher.dispatch(configUpdate('not-a-duration'));
    await tick();
    expect(logger.joined()).toContain('taskTimeout');
    expect(logger.joined()).toContain('not-a-duration');
    expect(logger.lines.some((l) => l.includes('threw'))).toBe(false);

    await manager.admitTask(makeOffer());
    clock.advance(DEFAULT_STUCK_MS - 1_000);
    await tick();
    expect(reportedFailure(sink)).toBeNull();
    clock.advance(1_000);
    await tick();
    expect(reportedFailure(sink)).toEqual({ reason: STUCK_FAILURE_REASON, retry_safe: false });
  });
});
