/**
 * `DepartmentManager` × the isolation/engine agreement check (simplified-
 * onboarding x20; D17/R14, `07-runtime-contract.md` §2.2). Its own file for
 * the same reason `./manager.stuck.test.ts` and `./manager.artifacts.test.ts`
 * are: the wiring is additive and orthogonal to `./manager.test.ts`'s
 * existing coverage.
 *
 * ## What was actually wrong
 *
 * Adapter selection is a FLAT lookup on `RuntimeConfig.adapterId`. There is
 * no `engine × isolation` composition anywhere — an execution is either
 * `claude-code` or `container`, never both. `RuntimeConfig.container` is the
 * only way a binding says "sandbox this", and exactly one adapter reads it;
 * every other adapter ignores the field by design.
 *
 * So `{ adapterId: 'claude-code', container: { image: … } }` was accepted,
 * stored, and RUN — on the host, unsandboxed, with nothing anywhere saying
 * the sandbox had been dropped. This suite is the proof that it now fails
 * loudly instead, with a coded reason and ZERO spawns.
 *
 * ## What this file does NOT claim
 *
 * It does not claim the composition works. It cannot: `claude-code` builds
 * its own argv (`buildClaudeArgs`) and `container` rewrites `command`/`args`
 * BEFORE handing them to its inner adapter, so the two compose in the wrong
 * order — see the PR body / `resolveIsolationRefusal`'s doc. Refusing is the
 * honest outcome; the tests below assert exactly that and nothing more.
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import type { ContainerSpec, RuntimeConfig } from './adapter';
import { FakeAdapter, makeMessage } from './_test-helpers';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DepartmentManager, ISOLATION_UNSUPPORTED_FAILURE_REASON } from './manager';

class MemJournal implements JournalWriter {
  lines = new Map<string, string[]>();
  ensureDir(): void {}
  appendLine(path: string, line: string): void {
    const list = this.lines.get(path) ?? [];
    list.push(line);
    this.lines.set(path, list);
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
  /** The terminal `failed` the manager reported, or null. */
  failure(): { reason: string; retry_safe: boolean } | null {
    for (const frame of this.events()) {
      const event = frame.event as { type: string; reason?: string; retry_safe?: boolean };
      if (event.type === 'failed') return { reason: event.reason!, retry_safe: event.retry_safe! };
    }
    return null;
  }
}

function makeManager(adapterId: string) {
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const sink = new FrameSink();
  const adapter = new FakeAdapter(adapterId);
  const runtimes = new Map<string, RuntimeConfig>();
  const dispatcher = new Dispatcher();
  const manager = new DepartmentManager({
    adapters: [adapter],
    resolveRuntimeConfig: (departmentId) => runtimes.get(departmentId) ?? null,
    send: sink.send,
    dispatcher,
    journal: new MemJournal(),
    journalRoot: '/data/department',
    clock,
    logger,
  });
  manager.attach(dispatcher);
  return { manager, logger, sink, runtimes, adapter };
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

const SPEC: ContainerSpec = { image: 'ghcr.io/example/dept:1.0', mounts: [] };

describe('x20 — a sandbox request the selected engine cannot build is refused, never ignored', () => {
  test('`claude-code` + a container spec: ZERO spawns, terminal failed, coded reason', async () => {
    const { manager, sink, runtimes, adapter } = makeManager('claude-code');
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', container: SPEC });

    const result = await manager.admitTask(makeOffer());

    // The DoD's own words: a stated reason and zero spawns.
    expect(adapter.startCalls()).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0); // not probed either — nothing ran at all
    expect(sink.failure()).toEqual({ reason: ISOLATION_UNSUPPORTED_FAILURE_REASON, retry_safe: false });
    expect(result.accepted).toBe(false);
  });

  test('the refusal names the engine, the image, and what to do — an operator should not have to read the source', async () => {
    const { manager, logger, runtimes } = makeManager('claude-code');
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', container: SPEC });

    await manager.admitTask(makeOffer());

    const warning = logger.lines.find((l) => l.startsWith('warn:') && l.includes('refusing to start'));
    expect(warning).toBeDefined();
    expect(warning).toContain('claude-code');
    expect(warning).toContain('ghcr.io/example/dept:1.0');
    expect(warning).toContain('unsandboxed');
    // The two ways out, both stated.
    expect(warning).toContain("engine 'container'");
    expect(warning).toContain("remove the 'container' spec");
  });

  test('the coded reason is a bare, equality-checkable word — the human detail stays in the log', async () => {
    const { manager, sink, runtimes } = makeManager('claude-code');
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude', container: SPEC });

    await manager.admitTask(makeOffer());

    // Same discipline as b4's `stuck` and x16's `unreported`: the wire value
    // is one token a consumer compares by equality, never a sentence.
    expect(sink.failure()?.reason).toBe('isolation_unsupported');
    expect(sink.failure()?.reason).not.toContain(' ');
  });

  test('`pipeline-drive` + a container spec is refused for the same reason — this is not claude-code-specific', async () => {
    const { manager, sink, runtimes, adapter } = makeManager('pipeline-drive');
    runtimes.set('unity-department', { adapterId: 'pipeline-drive', command: 'pipeline', container: SPEC });

    await manager.admitTask(makeOffer());

    expect(adapter.startCalls()).toHaveLength(0);
    expect(sink.failure()?.reason).toBe(ISOLATION_UNSUPPORTED_FAILURE_REASON);
  });

  test('`jsonl-process` + a container spec is refused — the plain host process tier never sandboxes either', async () => {
    const { manager, sink, runtimes, adapter } = makeManager('jsonl-process');
    runtimes.set('unity-department', { adapterId: 'jsonl-process', command: 'dept', container: SPEC });

    await manager.admitTask(makeOffer());

    expect(adapter.startCalls()).toHaveLength(0);
    expect(sink.failure()?.reason).toBe(ISOLATION_UNSUPPORTED_FAILURE_REASON);
  });
});

describe('x20 — everything that legitimately runs still runs', () => {
  test('the `container` engine WITH a container spec is exactly what the spec is for — admitted and spawned', async () => {
    const { manager, sink, runtimes, adapter } = makeManager('container');
    runtimes.set('unity-department', { adapterId: 'container', command: 'dept', container: SPEC });

    const result = await manager.admitTask(makeOffer());

    expect(result).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);
    expect(sink.failure()).toBeNull();
  });

  test('no container spec ⇒ no isolation was requested ⇒ nothing to refuse (every existing department)', async () => {
    const { manager, sink, runtimes, adapter } = makeManager('claude-code');
    runtimes.set('unity-department', { adapterId: 'claude-code', command: 'claude' });

    const result = await manager.admitTask(makeOffer());

    expect(result).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);
    expect(sink.failure()).toBeNull();
  });

  test('an adapterId OUTSIDE the engine registry is not judged — a third-party adapter may sandbox in ways this table cannot know', async () => {
    // Also the reason `./manager.artifacts.test.ts`'s container-tier test —
    // which pairs `adapterId: 'fake'` with a container spec on purpose —
    // keeps passing untouched.
    const { manager, sink, runtimes, adapter } = makeManager('fake');
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', container: SPEC });

    const result = await manager.admitTask(makeOffer());

    expect(result).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);
    expect(sink.failure()).toBeNull();
  });
});
