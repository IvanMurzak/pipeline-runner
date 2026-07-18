/**
 * c2 — the shipper-lifecycle composition: `onWorkspaceReady` constructs +
 * starts an `EventShipper` for the job's journal, `onJobFinished` stops it.
 * Exercises the SAME composition `cli.ts` wires onto `attachJobExecution`'s
 * `events` (closing E4 — a cloud-dispatched run previously produced ZERO
 * server-side events because the daemon constructed no `EventShipper` at all).
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { FakeUploadTransport, journalLine, MemShipperFs, settle } from '../../tests/_shipper-helpers';
import { statsDirForJournal } from '../shipper/stats';
import type { JobResult, JobWorkspaceContext } from './executor';
import { createShipperLifecycle, journalPathFor } from './shipper-lifecycle';

const DIR = join('/w', 'job-1');

/** Narrow a captured `upload` frame's passthrough `batch` field (test-only —
 *  `WireFrame` is intentionally untyped beyond `type`/`id`). */
function uploadBatch(frame: WireFrame): { run_id: string; events: Array<{ seq: number }> } {
  return (frame as unknown as { batch: { run_id: string; events: Array<{ seq: number }> } }).batch;
}

function makeContext(overrides: Partial<JobWorkspaceContext> = {}): JobWorkspaceContext {
  return {
    dir: DIR,
    pipelineRoot: join(DIR, '.claude', 'pipeline', 'release'),
    startIteration: 'steps/01-plan.md',
    job_id: 'job-1',
    run_id: 'run-1',
    job_jwt: 'jwt-secret-1',
    secret_slugs: [],
    ...overrides,
  };
}

describe('journalPathFor', () => {
  test('pins <checkout>/.claude/pipeline/.runtime/events.jsonl (06.1)', () => {
    expect(journalPathFor({ dir: 'C:/w/job-1' }).replace(/\\/g, '/')).toBe(
      'C:/w/job-1/.claude/pipeline/.runtime/events.jsonl'
    );
  });
});

describe('createShipperLifecycle — onWorkspaceReady / onJobFinished (fake transport)', () => {
  test('journal lines ship as spooled/uploaded batches with correct (run_id, seq), the stats.run_record fold included, and the shipper stops on job terminal', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const clock = new FakeClock();
    const logger = new CaptureLogger();
    const context = makeContext();
    const journalPath = journalPathFor(context);

    // Seed the `.stats` record the terminal event should fold in through the
    // REAL default `DiskStatsSource` (not stubbed) — proves the production
    // wiring's conventional layout: <checkout>/.claude/pipeline/.stats/**/runs.jsonl.
    const statsDir = statsDirForJournal(journalPath);
    fs.writeFileText(
      join(statsDir, 'runs.jsonl'),
      JSON.stringify({
        schema: 1,
        run_id: 'run-1',
        pipeline: 'release',
        outcome: 'completed',
        ended_at: '2026-07-17T13:00:00.000Z',
        duration_s: 42,
        steps_run: 1,
      }) + '\n'
    );

    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock,
      logger,
      transport,
      stateDirFor: () => 'state/job-1', // avoid touching the real data dir
    });

    lifecycle.onWorkspaceReady(context);

    fs.appendText(
      journalPath,
      journalLine('run.started', 'run-1') + journalLine('run.completed', 'run-1', { outcome: 'completed' })
    );
    clock.advance(500); // poll timer picks up the new lines
    await settle();
    expect(transport.confirmed.length).toBe(0); // below the size threshold; flush timer hasn't fired yet

    clock.advance(2_000); // flush timer fires
    await settle();

    // run.started(1), run.completed(2), stats.run_record(3) — in-band seq,
    // same as the shipper's own contract (shipper.test.ts).
    expect(transport.confirmedSeqs('run-1')).toEqual([1, 2, 3]);
    const statsEvent = transport.confirmed.at(-1)!.events.at(-1)!.payload as Record<string, unknown>;
    expect(statsEvent.type).toBe('stats.run_record');
    expect((statsEvent.data as Record<string, unknown>).outcome).toBe('completed');

    // Terminal: onJobFinished stops the shipper (final flush/drain + timers cleared).
    lifecycle.onJobFinished({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
    await settle();

    // A stray late journal write AFTER stop is never picked up — the poll
    // timer was cancelled outright (stop(), not merely idle).
    fs.appendText(journalPath, journalLine('run.started', 'run-2'));
    clock.advance(10_000);
    await settle();
    expect(transport.confirmedSeqs('run-2')).toEqual([]);

    // onJobFinished for a job that never reached onWorkspaceReady (e.g. a
    // workspace-prep failure) is a safe no-op — nothing to stop.
    expect(() =>
      lifecycle.onJobFinished({ job_id: 'never-readied', run_id: 'run-x', ok: false, reason: 'prep failed' })
    ).not.toThrow();
  });

  test('two concurrent jobs get two independent shippers, keyed by job_id', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const clock = new FakeClock();
    const contextA = makeContext({ dir: join('/w', 'job-A'), job_id: 'job-A', run_id: 'run-A' });
    const contextB = makeContext({ dir: join('/w', 'job-B'), job_id: 'job-B', run_id: 'run-B' });

    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock,
      transport,
      stateDirFor: (journalPath) => `state/${journalPath}`,
    });

    lifecycle.onWorkspaceReady(contextA);
    lifecycle.onWorkspaceReady(contextB);
    fs.appendText(journalPathFor(contextA), journalLine('run.started', 'run-A'));
    fs.appendText(journalPathFor(contextB), journalLine('run.started', 'run-B'));
    clock.advance(2_500);
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1]);
    expect(transport.confirmedSeqs('run-B')).toEqual([1]);

    // Stopping job A must not disturb job B's still-running shipper.
    lifecycle.onJobFinished({ job_id: 'job-A', run_id: 'run-A', ok: true, outcome: 'completed' });
    await settle();
    fs.appendText(journalPathFor(contextA), journalLine('run.started', 'run-A2'));
    fs.appendText(journalPathFor(contextB), journalLine('iteration.started', 'run-B', { iteration_path: 'a.md', index: 0 }));
    clock.advance(2_500);
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1]); // A: unchanged, stopped
    expect(transport.confirmedSeqs('run-B')).toEqual([1, 2]); // B: still shipping
  });
});

describe('createShipperLifecycle — default transport (WireUploadTransport over send()+dispatcher)', () => {
  test('round-trips a real upload_ack correlated by id — the exact composition cli.ts wires by default', async () => {
    const fs = new MemShipperFs();
    const clock = new FakeClock();
    const dispatcher = new Dispatcher();
    const sent: WireFrame[] = [];
    const send = (frame: WireFrame): boolean => {
      sent.push(frame);
      if (frame.type === 'upload') {
        const batch = uploadBatch(frame);
        dispatcher.dispatch({
          type: 'upload_ack',
          id: frame.id,
          ack: { run_id: batch.run_id, inserted: batch.events.length, skipped: 0 },
        });
      }
      return true;
    };
    const context = makeContext();
    const journalPath = journalPathFor(context);

    const lifecycle = createShipperLifecycle({
      send,
      dispatcher,
      fs,
      clock,
      stateDirFor: () => 'state/job-1',
    });
    lifecycle.onWorkspaceReady(context);
    fs.appendText(journalPath, journalLine('run.started', 'run-1'));
    clock.advance(2_500); // poll + flush
    await settle();

    const uploads = sent.filter((f) => f.type === 'upload');
    expect(uploads).toHaveLength(1);
    expect(uploadBatch(uploads[0]!).run_id).toBe('run-1');
    expect(sent.some((f) => f.type === 'upload_ack')).toBe(false); // that direction is inbound-only, never sent

    lifecycle.onJobFinished({ job_id: context.job_id, run_id: context.run_id, ok: true, outcome: 'completed' });
    await settle();
  });

  test('send() returning false (offline) is retried, never dropped — the shipper is the durable buffer', async () => {
    const fs = new MemShipperFs();
    const clock = new FakeClock();
    const dispatcher = new Dispatcher();
    let online = false;
    const sent: WireFrame[] = [];
    const send = (frame: WireFrame): boolean => {
      if (!online) return false;
      sent.push(frame);
      if (frame.type === 'upload') {
        const batch = uploadBatch(frame);
        dispatcher.dispatch({
          type: 'upload_ack',
          id: frame.id,
          ack: { run_id: batch.run_id, inserted: batch.events.length, skipped: 0 },
        });
      }
      return true;
    };
    const context = makeContext();
    const journalPath = journalPathFor(context);

    const lifecycle = createShipperLifecycle({
      send,
      dispatcher,
      fs,
      clock,
      stateDirFor: () => 'state/job-1',
      // rng pinned via the shipper's default backoff — not overridden here;
      // we only need to observe eventual delivery, not exact delay values.
    });
    lifecycle.onWorkspaceReady(context);
    fs.appendText(journalPath, journalLine('run.started', 'run-1'));
    clock.advance(2_500); // poll + flush -> first upload attempt fails ("not connected")
    await settle();
    expect(sent).toHaveLength(0);

    online = true;
    clock.advance(60_000); // well past the retry backoff ceiling
    await settle();
    expect(sent.filter((f) => f.type === 'upload')).toHaveLength(1);

    lifecycle.onJobFinished({ job_id: context.job_id, run_id: context.run_id, ok: true, outcome: 'completed' });
    await settle();
  });
});

describe('createShipperLifecycle — c6 ordered completion + shutdown drain', () => {
  test('onTerminalFlush ships the terminal journal events BEFORE resolving (the c5 race closer)', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const clock = new FakeClock();
    const context = makeContext();
    const journalPath = journalPathFor(context);
    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock,
      transport,
      stateDirFor: () => 'state/job-1',
    });
    lifecycle.onWorkspaceReady(context);

    // Terminal events land in the journal; NO timers have fired yet.
    fs.appendText(
      journalPath,
      journalLine('run.started', 'run-1') + journalLine('run.completed', 'run-1', { outcome: 'completed' })
    );
    await lifecycle.onTerminalFlush('job-1');
    // The flush await alone (no clock advance) got the terminal events out.
    // No .stats record was seeded, so there is no stats fold — just the two
    // journal events, both shipped before onTerminalFlush resolved.
    expect(transport.confirmedSeqs('run-1')).toEqual([1, 2]);
  });

  test('onTerminalFlush for a job with no shipper resolves immediately (prep failure path)', async () => {
    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs: new MemShipperFs(),
      clock: new FakeClock(),
      transport: new FakeUploadTransport(),
      stateDirFor: () => 'state/x',
    });
    await lifecycle.onTerminalFlush('never-readied'); // no throw, no hang
  });

  test('onJobFinished after onTerminalFlush is a no-op (already flushed + removed)', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock: new FakeClock(),
      transport,
      stateDirFor: () => 'state/job-1',
    });
    lifecycle.onWorkspaceReady(makeContext());
    await lifecycle.onTerminalFlush('job-1');
    const uploads = transport.attempts.length;
    lifecycle.onJobFinished({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
    await settle();
    expect(transport.attempts.length).toBe(uploads); // nothing re-shipped
  });

  test('stopAll drains every active shipper (graceful shutdown)', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const clock = new FakeClock();
    const contextA = makeContext({ dir: join('/w', 'job-A'), job_id: 'job-A', run_id: 'run-A' });
    const contextB = makeContext({ dir: join('/w', 'job-B'), job_id: 'job-B', run_id: 'run-B' });
    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock,
      transport,
      stateDirFor: (journal) => `state/${journal.includes('job-A') ? 'a' : 'b'}`,
    });
    lifecycle.onWorkspaceReady(contextA);
    lifecycle.onWorkspaceReady(contextB);
    fs.appendText(journalPathFor(contextA), journalLine('run.started', 'run-A'));
    fs.appendText(journalPathFor(contextB), journalLine('run.started', 'run-B'));

    await lifecycle.stopAll();
    expect(transport.confirmedSeqs('run-A')).toEqual([1]);
    expect(transport.confirmedSeqs('run-B')).toEqual([1]);
  });

  test('a context-carried event_seq_base fences the shipper seqs (06.8.2)', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const context = makeContext({ event_seq_base: 3_000_000 });
    const lifecycle = createShipperLifecycle({
      send: () => true,
      dispatcher: new Dispatcher(),
      fs,
      clock: new FakeClock(),
      transport,
      stateDirFor: () => 'state/job-1',
    });
    lifecycle.onWorkspaceReady(context);
    fs.appendText(journalPathFor(context), journalLine('run.started', 'run-1'));
    await lifecycle.onTerminalFlush('job-1');
    expect(transport.confirmedSeqs('run-1')).toEqual([3_000_001]);
  });
});
