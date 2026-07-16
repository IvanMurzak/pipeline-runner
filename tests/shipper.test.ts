/**
 * EventShipper end-to-end (with fakes): per-run monotonic seq assignment,
 * cursor resume across restart (no re-ship / no skip / contiguous seqs),
 * batching thresholds (size + time), the G2 run_id rule, privacy-tier
 * enforcement on the upload path, and the `.stats` fold.
 */

import { describe, expect, test } from 'bun:test';
import { EventShipper } from '../src/shipper/shipper';
import { QUESTION_PLACEHOLDER } from '../src/shipper/privacy';
import type { StatsSource } from '../src/shipper/stats';
import { CaptureLogger, FakeClock } from './_helpers';
import { FakeUploadTransport, journalLine, MemShipperFs, settle } from './_shipper-helpers';

const JOURNAL = 'C:/proj/.claude/pipeline/.runtime/events.jsonl';
const STATE = 'C:/state/agent/shipper/j1';

interface Rig {
  fs: MemShipperFs;
  transport: FakeUploadTransport;
  clock: FakeClock;
  logger: CaptureLogger;
  shipper: EventShipper;
}

function makeRig(overrides: Partial<ConstructorParameters<typeof EventShipper>[0]> = {}, rig?: Partial<Rig>): Rig {
  const fs = rig?.fs ?? new MemShipperFs();
  const transport = rig?.transport ?? new FakeUploadTransport();
  const clock = rig?.clock ?? new FakeClock();
  const logger = rig?.logger ?? new CaptureLogger();
  const shipper = new EventShipper({
    journalPath: JOURNAL,
    stateDir: STATE,
    transport,
    fs,
    clock,
    logger,
    env: {}, // never the real process env
    rng: () => 0.5, // pins backoff jitter to the raw delay
    ...overrides,
  });
  return { fs, transport, clock, logger, shipper };
}

describe('EventShipper — seq assignment', () => {
  test('assigns a monotonic per-run seq from 1, isolated across interleaved runs', async () => {
    const { fs, transport, shipper } = makeRig();
    fs.appendText(
      JOURNAL,
      journalLine('run.started', 'run-A') +
        journalLine('iteration.started', 'run-A', { iteration_path: 'a.md', index: 0 }) +
        journalLine('run.started', 'run-B') + // interleaved second run
        journalLine('iteration.started', 'run-B', { iteration_path: 'b.md', index: 0 }) +
        journalLine('iteration.completed', 'run-A', { iteration_path: 'a.md', outcome: 'completed' })
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3]);
    expect(transport.confirmedSeqs('run-B')).toEqual([1, 2]);
    // One batch per run per flush (interleaved runs stay isolated).
    expect(transport.confirmed.every((batch) => typeof batch.run_id === 'string')).toBe(true);
  });

  test('G2: session-scoped events (null run_id) are never shipped per-run', async () => {
    const { fs, transport, shipper } = makeRig();
    fs.appendText(
      JOURNAL,
      journalLine('session.opened', null, { claude_pid: 42 }) +
        journalLine('tool.called', null, { tool_name: 'Bash', success: true, agent_spawn: false, tool_use_id: 't1' }) +
        journalLine('run.started', 'run-A')
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmed.length).toBe(1);
    expect(transport.confirmedSeqs('run-A')).toEqual([1]);
  });

  test('a malformed journal line is skipped without derailing later lines', async () => {
    const { fs, transport, shipper, logger } = makeRig();
    fs.appendText(JOURNAL, 'not json at all\n' + '[1,2,3]\n' + journalLine('run.started', 'run-A'));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1]);
    expect(logger.joined()).toContain('malformed journal line');
  });
});

describe('EventShipper — cursor resume across restart', () => {
  test('a restarted shipper never re-ships confirmed events, never skips new ones, and keeps seq contiguous', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();

    const first = makeRig({}, { fs, transport });
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('iteration.started', 'run-A', { iteration_path: 'a.md', index: 0 }));
    first.shipper.pollOnce();
    first.shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2]);

    // Journal grows AFTER the first process dies.
    fs.appendText(JOURNAL, journalLine('iteration.completed', 'run-A', { iteration_path: 'a.md', outcome: 'completed' }));

    // RESTART: a brand-new shipper over the same state dir.
    const second = makeRig({}, { fs, transport });
    second.shipper.pollOnce();
    second.shipper.flushNow();
    await settle();

    // Only the new event shipped; seq CONTINUES (3), no re-ship, no gap.
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3]);
  });

  test('a crash BEFORE the flush re-reads the same lines with the same seqs (dedup-safe overlap, still no gap)', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();

    const first = makeRig({}, { fs, transport });
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('iteration.started', 'run-A', { iteration_path: 'a.md', index: 0 }));
    first.shipper.pollOnce(); // parsed but NEVER flushed — cursor not advanced

    const second = makeRig({}, { fs, transport });
    second.shipper.pollOnce();
    second.shipper.flushNow();
    await settle();

    // The restart re-assigned the SAME seqs 1..2 — the server dedupes on
    // (run_id, seq), so the overlap is a no-op, and no seq was skipped.
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2]);
  });
});

describe('EventShipper — batching thresholds', () => {
  test('size threshold: reaching batchMaxEvents flushes without waiting for the timer', async () => {
    const { fs, transport, shipper } = makeRig({ batchMaxEvents: 2 });
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('iteration.started', 'run-A', { iteration_path: 'a.md', index: 0 }));
    shipper.pollOnce(); // 2 pending ≥ 2 → auto-flush
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2]);
    // …and chunks never exceed the batch size.
    expect(transport.confirmed.every((batch) => batch.events.length <= 2)).toBe(true);
  });

  test('time threshold: a below-size batch still flushes when batchMaxMs elapses (events are never held hostage)', async () => {
    const { fs, transport, clock, shipper } = makeRig({ batchMaxEvents: 100, batchMaxMs: 2000, pollMs: 500 });
    shipper.start();
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A'));
    clock.advance(500); // poll timer: reads the line (1 pending < 100)
    await settle();
    expect(transport.confirmed.length).toBe(0); // size threshold not reached
    clock.advance(2000); // flush timer fires
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1]);
    await shipper.stop();
  });

  test('a large backlog is chunked at batchMaxEvents per upload', async () => {
    const { fs, transport, shipper } = makeRig({ batchMaxEvents: 3 });
    let text = '';
    for (let i = 0; i < 8; i++) text += journalLine('turn.usage', 'run-A', { assistant_turns: i, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 });
    fs.appendText(JOURNAL, text);
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(transport.confirmed.map((batch) => batch.events.length)).toEqual([3, 3, 2]);
  });
});

describe('EventShipper — privacy tier on the upload path', () => {
  test('at the default (metadata) tier the uploaded batch carries no question content', async () => {
    const { fs, transport, shipper } = makeRig();
    expect(shipper.tier).toBe('metadata');
    fs.appendText(
      JOURNAL,
      journalLine('awaiting_input', 'run-A', {
        run_id: 'run-A',
        iteration: 1,
        question_id: 'q1',
        question: { text: 'SECRET_should we deploy?', context: 'SECRET_ctx', options: ['SECRET_yes'] },
      })
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    const wire = JSON.stringify(transport.confirmed);
    expect(wire).not.toContain('SECRET_');
    expect(wire).toContain(QUESTION_PLACEHOLDER);
    expect(wire).toContain('q1');
  });

  test('the tier comes from config/env and fails closed on garbage', () => {
    const viaEnv = makeRig({ env: { PIPELINE_PRIVACY_TIER: 'events' } });
    expect(viaEnv.shipper.tier).toBe('events');
    const garbage = makeRig({ env: { PIPELINE_PRIVACY_TIER: 'everything' } });
    expect(garbage.shipper.tier).toBe('metadata');
    expect(garbage.logger.joined()).toContain('failing closed');
  });
});

describe('EventShipper — .stats fold', () => {
  const statsSource: StatsSource = {
    findRunRecord: (runId) =>
      runId === 'run-A'
        ? { schema: 1, run_id: 'run-A', pipeline: 'release', outcome: 'completed', ended_at: '2026-07-11T13:00:00.000Z', duration_s: 60, steps_run: 1, transcript: 'SECRET_transcript' }
        : null,
  };

  test('a terminal event triggers ONE stats.run_record through the same seq/privacy path', async () => {
    const { fs, transport, shipper } = makeRig({ statsSource, projectRoot: 'C:/proj' });
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    // run.started(1), run.completed(2), stats.run_record(3) — in-band seq.
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3]);
    const last = transport.confirmed.at(-1)!.events.at(-1)!.payload as Record<string, unknown>;
    expect(last.type).toBe('stats.run_record');
    expect((last.data as Record<string, unknown>).outcome).toBe('completed');
    expect(JSON.stringify(last)).not.toContain('SECRET_transcript'); // metadata tier

    // A second terminal event for the same run does NOT re-fold.
    fs.appendText(JOURNAL, journalLine('pipeline.completed', 'run-A', { pipeline_name: 'release' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3, 4]); // just the event
  });

  test('a run with no stats record ships its events unaffected', async () => {
    const { fs, transport, shipper } = makeRig({ statsSource });
    fs.appendText(JOURNAL, journalLine('run.completed', 'run-B', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-B')).toEqual([1]);
  });
});
