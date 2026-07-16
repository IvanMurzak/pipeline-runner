/**
 * Offline buffer (spool) tests: durable persist → retry with backoff → drain,
 * survival across a simulated process restart, the bounded cap with loud
 * drop logging, and non-retryable rejection handling.
 */

import { describe, expect, test } from 'bun:test';
import { Spool } from '../src/shipper/spool';
import { EventShipper } from '../src/shipper/shipper';
import { CaptureLogger, FakeClock } from './_helpers';
import { FakeUploadTransport, journalLine, MemShipperFs, settle } from './_shipper-helpers';

const JOURNAL = 'C:/proj/.claude/pipeline/.runtime/events.jsonl';
const STATE = 'C:/state/agent/shipper/j1';
const SPOOL_DIR = `${STATE}/spool`;

function makeShipper(
  fs: MemShipperFs,
  transport: FakeUploadTransport,
  overrides: Partial<ConstructorParameters<typeof EventShipper>[0]> = {}
): { shipper: EventShipper; clock: FakeClock; logger: CaptureLogger } {
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const shipper = new EventShipper({
    journalPath: JOURNAL,
    stateDir: STATE,
    transport,
    fs,
    clock,
    logger,
    env: {},
    rng: () => 0.5, // jitter pinned: delay(attempt) = base * 2^attempt (≤ cap)
    ...overrides,
  });
  return { shipper, clock, logger };
}

describe('offline buffer — persist, retry, drain', () => {
  test('failed uploads stay durably spooled and drain with backoff once the transport recovers', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    transport.mode = 'offline';
    const { shipper, clock, logger } = makeShipper(fs, transport);

    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    // Nothing confirmed; the batch is ON DISK, not just in memory.
    expect(transport.confirmed.length).toBe(0);
    expect(transport.attempts.length).toBe(1);
    expect(shipper.spooledCount).toBe(2);
    expect(fs.listDir(SPOOL_DIR)?.some((e) => e.name.endsWith('.json'))).toBe(true);
    expect(logger.joined()).toContain('retrying in 1000ms'); // backoff attempt 0

    // Still failing: the next attempt backs off exponentially.
    clock.advance(1000);
    await settle();
    expect(transport.attempts.length).toBe(2);
    expect(logger.joined()).toContain('retrying in 2000ms');

    // Transport recovers: the retry drains the spool and deletes the chunk.
    transport.mode = 'ok';
    clock.advance(2000);
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2]);
    expect(shipper.spooledCount).toBe(0);
    expect(fs.listDir(SPOOL_DIR)?.some((e) => e.name.endsWith('.json'))).toBe(false);
  });

  test('spooled batches survive a process restart and upload exactly once confirmed', async () => {
    const fs = new MemShipperFs();
    const offline = new FakeUploadTransport();
    offline.mode = 'offline';

    // Life 1: events spooled, upload never confirmed, process "dies".
    const first = makeShipper(fs, offline);
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('iteration.started', 'run-A', { iteration_path: 'a.md', index: 0 }));
    first.shipper.pollOnce();
    first.shipper.flushNow();
    await settle();
    expect(offline.confirmed.length).toBe(0);
    expect(first.shipper.spooledCount).toBe(2);

    // Life 2: a fresh shipper + healthy transport over the same state dir.
    const online = new FakeUploadTransport();
    const second = makeShipper(fs, online);
    expect(second.shipper.spooledCount).toBe(2); // recovered from disk
    second.shipper.start(); // start() drains leftover spool
    await settle();
    expect(online.confirmedSeqs('run-A')).toEqual([1, 2]);
    expect(second.shipper.spooledCount).toBe(0);
    await second.shipper.stop();

    // And new journal growth continues seq 3 — nothing was lost or re-read.
    const third = makeShipper(fs, online);
    fs.appendText(JOURNAL, journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    third.shipper.pollOnce();
    third.shipper.flushNow();
    await settle();
    expect(online.confirmedSeqs('run-A')).toEqual([1, 2, 3]);
  });

  test('a non-retryable rejection sets the chunk aside as .rejected — loudly, never silently — and the drain continues', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    transport.script.push({ ok: false, retryable: false, error: 'unknown context.project_id' });
    const { shipper, logger } = makeShipper(fs, transport);

    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('run.started', 'run-B'));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    // run-A's chunk was rejected and preserved for forensics; run-B shipped.
    expect(logger.joined()).toContain('rejected');
    expect(logger.joined()).toContain('.rejected');
    expect(fs.listDir(SPOOL_DIR)?.some((e) => e.name.endsWith('.json.rejected'))).toBe(true);
    expect(transport.confirmedSeqs('run-B')).toEqual([1]);
    expect(shipper.spooledCount).toBe(0);
  });
});

describe('offline buffer — bounded cap', () => {
  test('exceeding the cap drops the OLDEST chunks and logs every drop at error level with the seq range', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    transport.mode = 'offline';
    // Cap of 4 events, chunks of 2 → the third chunk evicts the first.
    const { shipper, logger } = makeShipper(fs, transport, { spoolMaxEvents: 4, batchMaxEvents: 2 });

    for (let i = 0; i < 6; i++) {
      fs.appendText(JOURNAL, journalLine('turn.usage', 'run-A', { assistant_turns: i, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }));
    }
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    expect(shipper.spooledCount).toBe(4); // bounded
    const log = logger.joined();
    expect(log).toContain('OFFLINE BUFFER CAP HIT');
    expect(log).toContain('seq 1..2'); // the oldest chunk, named precisely
    expect(log).toContain('permanently lost');

    // Recovery ships only the surviving chunks — the server sees a seq gap.
    transport.mode = 'ok';
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([3, 4, 5, 6]);
  });
});

describe('Spool (unit)', () => {
  test('restart recovery resumes the name counter and event count from disk', () => {
    const fs = new MemShipperFs();
    const spool = new Spool(fs, SPOOL_DIR);
    spool.append({ run_id: 'r1', events: [{ seq: 1, payload: {} }, { seq: 2, payload: {} }] });
    spool.append({ run_id: 'r1', events: [{ seq: 3, payload: {} }] });

    const recovered = new Spool(fs, SPOOL_DIR);
    expect(recovered.eventCount).toBe(3);
    expect(recovered.chunkCount).toBe(2);
    expect(recovered.oldest()?.batch.events[0]?.seq).toBe(1); // oldest first
    // New appends continue the counter (no name collisions).
    const { name } = recovered.append({ run_id: 'r1', events: [{ seq: 4, payload: {} }] });
    expect(name).toBe('00000003.json');
  });

  test('remove and reject update the accounting', () => {
    const fs = new MemShipperFs();
    const spool = new Spool(fs, SPOOL_DIR);
    const first = spool.append({ run_id: 'r1', events: [{ seq: 1, payload: {} }] });
    const second = spool.append({ run_id: 'r1', events: [{ seq: 2, payload: {} }] });
    spool.remove(first.name);
    expect(spool.eventCount).toBe(1);
    spool.reject(second.name);
    expect(spool.eventCount).toBe(0);
    expect(spool.oldest()).toBeNull();
    expect(fs.readFileText(`${SPOOL_DIR}/${second.name}.rejected`)).not.toBeNull();
  });
});
