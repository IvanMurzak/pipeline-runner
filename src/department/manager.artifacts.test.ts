/**
 * `DepartmentManager` × artifact upload wiring (department-mesh task d3, 08
 * §6 / 09 §3.1). Uses the SAME `FakeAdapter`/`makeMessage`/`makeOffer` shape
 * as `./manager.test.ts` but is its own file — mirrors the split
 * `./manager-mesh-oauth.test.ts` already uses for the same reason: this
 * task's wiring is additive and orthogonal to that suite's existing coverage.
 *
 * Covers the manager-level half of the DoD that `./artifact-upload.test.ts`
 * cannot: an `artifact` `RuntimeEvent` reaching `shipDepartmentEvent` actually
 * produces `department.artifact` frames on the real connection seam; the
 * per-task running cap is tracked ACROSS separate artifact events for the
 * same task (not just within one call); and `department.artifact_ack` is
 * handled through a real `Dispatcher`, surfacing a rejection rather than
 * swallowing it.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import type { RuntimeConfig } from './adapter';
import type { ArtifactFileSystem } from './artifact-upload';
import { MAX_ARTIFACT_BYTES, MAX_TASK_ARTIFACT_BYTES } from './artifact-upload';
import { FakeAdapter, makeMessage } from './_test-helpers';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DepartmentManager } from './manager';

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
  ok = true;
  send = (frame: WireFrame): boolean => {
    if (!this.ok) return false;
    this.frames.push(frame);
    return true;
  };
  artifactFrames(): WireFrame[] {
    return this.frames.filter((f) => f.type === 'department.artifact');
  }
}

class FakeArtifactFs implements ArtifactFileSystem {
  files = new Map<string, Uint8Array>();
  put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }
  statSize(path: string): number | null {
    return this.files.get(path)?.byteLength ?? null;
  }
  readFile(path: string): Uint8Array | null {
    return this.files.get(path) ?? null;
  }
}

function content(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

function makeManager(
  overrides: Partial<{
    adapters: FakeAdapter[];
    logger: CaptureLogger;
    artifactFs: ArtifactFileSystem;
    dispatcher: Dispatcher;
    onArtifactAck: (ack: unknown) => void;
  }> = {},
) {
  const clock = new FakeClock();
  const logger = overrides.logger ?? new CaptureLogger();
  const journal = new MemJournal();
  const sink = new FrameSink();
  const adapters = overrides.adapters ?? [new FakeAdapter()];
  const runtimes = new Map<string, RuntimeConfig>();
  const dispatcher = overrides.dispatcher ?? new Dispatcher();
  const manager = new DepartmentManager({
    adapters,
    resolveRuntimeConfig: (departmentId) => runtimes.get(departmentId) ?? null,
    send: sink.send,
    dispatcher,
    journal,
    journalRoot: join('/data', 'department'),
    clock,
    logger,
    ...(overrides.artifactFs !== undefined ? { artifactFs: overrides.artifactFs } : {}),
    ...(overrides.onArtifactAck !== undefined ? { onArtifactAck: overrides.onArtifactAck as never } : {}),
  });
  return { manager, clock, logger, journal, sink, runtimes, dispatcher, adapter: adapters[0]! };
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

describe('DepartmentManager — artifact upload (d3)', () => {
  test('an artifact RuntimeEvent with inline bytes is uploaded as department.artifact frame(s) on the real send seam', async () => {
    const { manager, adapter, runtimes, sink } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    const bytes = content(2048);
    adapter.emitLatest({ type: 'artifact', name: 'summary.txt', mediaType: 'text/plain', bytes });

    const artifactFrames = sink.artifactFrames();
    expect(artifactFrames).toHaveLength(1);
    expect(artifactFrames[0]).toMatchObject({
      type: 'department.artifact',
      execution_id: 'dexec-1',
      task_id: 'dtask-1',
      name: 'summary.txt',
      media_type: 'text/plain',
      size: 2048,
      chunk_index: 0,
      chunk_total: 1,
    });
  });

  test('a path-referenced artifact is read from the injected ArtifactFileSystem and uploaded', async () => {
    const fs = new FakeArtifactFs();
    fs.put('/work/report.md', content(300 * 1024)); // 300 KiB -> 2 chunks
    const { manager, adapter, runtimes, sink } = makeManager({ artifactFs: fs });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'artifact', name: 'report.md', mediaType: 'text/markdown', path: '/work/report.md' });

    const artifactFrames = sink.artifactFrames();
    expect(artifactFrames).toHaveLength(2);
    expect(artifactFrames[0]!.chunk_total).toBe(2);
  });

  test('the per-task 8 MiB cap accumulates ACROSS separate artifact events for the same task, and the artifact that tips it over is rejected on the runner — nothing sent for it', async () => {
    // Each artifact is at most 1 MiB (the per-ARTIFACT cap) — the per-TASK
    // budget only becomes the binding constraint after several of them.
    // Eight 1 MiB artifacts exactly fill the 8 MiB per-task budget; the
    // ninth (even a small one) must be rejected on the runner-tracked total.
    const fs = new FakeArtifactFs();
    for (let i = 0; i < 8; i++) fs.put(`/artifact-${i}.bin`, content(MAX_ARTIFACT_BYTES));
    fs.put('/tips-it-over.bin', content(2048));
    const { manager, adapter, runtimes, sink, logger } = makeManager({ artifactFs: fs });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    for (let i = 0; i < 8; i++) {
      adapter.emitLatest({ type: 'artifact', name: `artifact-${i}.bin`, mediaType: 'application/octet-stream', path: `/artifact-${i}.bin` });
    }
    expect(sink.artifactFrames().length).toBeGreaterThan(0);
    const framesAfterEight = sink.frames.length;

    adapter.emitLatest({ type: 'artifact', name: 'tips-it-over.bin', mediaType: 'application/octet-stream', path: '/tips-it-over.bin' });

    // No NEW frames were sent for the rejected, budget-tipping artifact.
    expect(sink.frames.length).toBe(framesAfterEight);
    expect(
      logger.lines.some((l) => l.startsWith('warn:') && l.includes('tips-it-over.bin') && l.includes('per-task limit')),
    ).toBe(true);
  });

  test('an over-per-artifact-cap artifact (on disk) is rejected on the runner before any wire transfer, with a stated reason logged', async () => {
    const fs = new FakeArtifactFs();
    fs.put('/huge.bin', content(MAX_ARTIFACT_BYTES + 1));
    const { manager, adapter, runtimes, sink, logger } = makeManager({ artifactFs: fs });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({
      type: 'artifact',
      name: 'huge.bin',
      mediaType: 'application/octet-stream',
      path: '/huge.bin',
    });

    expect(sink.artifactFrames()).toHaveLength(0);
    expect(
      logger.lines.some(
        (l) => l.startsWith('warn:') && l.includes('huge.bin') && l.includes('per-artifact limit') && l.includes('not truncated'),
      ),
    ).toBe(true);
  });

  test('a successfully uploaded artifact logs an info line naming size/chunks/checksum (observable proof of a completed upload)', async () => {
    const { manager, adapter, runtimes, logger } = makeManager();
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'artifact', name: 'ok.txt', mediaType: 'text/plain', bytes: content(10) });

    expect(logger.lines.some((l) => l.startsWith('info:') && l.includes('ok.txt') && l.includes('uploaded'))).toBe(true);
  });
});

describe('DepartmentManager — department.artifact_ack handling (d3, 08 §6)', () => {
  test('a well-formed accepted ack is logged at info and handed to onArtifactAck', () => {
    const acks: unknown[] = [];
    const { manager, dispatcher } = makeManager({ onArtifactAck: (ack) => acks.push(ack) });
    manager.attach(dispatcher);

    dispatcher.dispatch({ type: 'department.artifact_ack', artifact_id: 'art-1', accepted: true });

    expect(acks).toEqual([{ type: 'department.artifact_ack', artifact_id: 'art-1', accepted: true }]);
  });

  test('a rejected ack is surfaced — logged at WARN with the reason, never swallowed — and handed to onArtifactAck', () => {
    const acks: unknown[] = [];
    const { manager, dispatcher, logger } = makeManager({ onArtifactAck: (ack) => acks.push(ack) });
    manager.attach(dispatcher);

    dispatcher.dispatch({
      type: 'department.artifact_ack',
      artifact_id: 'art-2',
      accepted: false,
      reason: 'task_quota_exceeded: over the 8 MiB per-task limit',
    });

    expect(logger.lines.some((l) => l.startsWith('warn:') && l.includes('art-2') && l.includes('REJECTED') && l.includes('task_quota_exceeded'))).toBe(
      true,
    );
    expect(acks).toEqual([
      { type: 'department.artifact_ack', artifact_id: 'art-2', accepted: false, reason: 'task_quota_exceeded: over the 8 MiB per-task limit' },
    ]);
  });

  test('a malformed department.artifact_ack (missing required fields) is logged and dropped, not thrown', () => {
    const { manager, dispatcher, logger } = makeManager();
    manager.attach(dispatcher);

    expect(() => dispatcher.dispatch({ type: 'department.artifact_ack', accepted: true })).not.toThrow();
    expect(logger.lines.some((l) => l.startsWith('warn:') && l.includes('malformed department.artifact_ack'))).toBe(true);
  });
});
