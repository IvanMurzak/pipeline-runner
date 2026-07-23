/**
 * Unified stats watcher (design 08 D13+D18+D16, task obs-d1):
 *
 *   - LOCAL-run shipping: a journal-unknown finished record ships once with
 *     `origin:"local"` when `sync_local_stats` is on (default), never when
 *     off; the flag resolver fails toward privacy.
 *   - Enrichment RE-ship: a shipped record whose `tokens` went null→non-null
 *     re-ships exactly once with `revision`+1.
 *   - The dispatched-terminal path keeps its trigger/seq behavior and now
 *     stamps `revision:1` + `origin:"dispatched"`.
 *   - 14-day window + per-file mtime gate on the rescan.
 *   - Protocol schema validation: a malformed record is NEVER spooled.
 *   - D16/G-sec-2: `RunFailureDetail.error` excerpt text never ships, at ANY
 *     tier (tool name + step + counts survive).
 */

import { describe, expect, test } from 'bun:test';
import { EventShipper } from '../src/shipper/shipper';
import { emptyCursor, pruneCursor, pruneStatsMarkers } from '../src/shipper/cursor';
import {
  DiskStatsSource,
  resolveSyncLocalStats,
  STATS_RESCAN_WINDOW_MS,
} from '../src/shipper/stats';
import { CaptureLogger, FakeClock } from './_helpers';
import { FakeUploadTransport, journalLine, MemShipperFs, settle, validRunRecord } from './_shipper-helpers';

const JOURNAL = 'C:/proj/.claude/pipeline/.runtime/events.jsonl';
const STATE = 'C:/state/agent/shipper/j1';
const STATS_DIR = 'C:/proj/.claude/pipeline/.stats';
const RUNS_FILE = `${STATS_DIR}/workflows/release/runs.jsonl`;

/** Fixture records end at 2026-07-11T13:00Z; "now" is the following day, so
 *  they sit comfortably inside the 14-day rescan window. */
const NOW = Date.parse('2026-07-12T13:00:00.000Z');

interface Rig {
  fs: MemShipperFs;
  transport: FakeUploadTransport;
  clock: FakeClock;
  logger: CaptureLogger;
  source: DiskStatsSource;
  shipper: EventShipper;
}

function makeRig(overrides: Partial<ConstructorParameters<typeof EventShipper>[0]> = {}, rig?: Partial<Rig>): Rig {
  const fs = rig?.fs ?? new MemShipperFs();
  const transport = rig?.transport ?? new FakeUploadTransport();
  const clock = rig?.clock ?? new FakeClock();
  if (clock.now() === 0) clock.advance(NOW);
  const logger = rig?.logger ?? new CaptureLogger();
  const source = new DiskStatsSource(fs, STATS_DIR);
  const shipper = new EventShipper({
    journalPath: JOURNAL,
    stateDir: STATE,
    transport,
    fs,
    clock,
    logger,
    env: {}, // never the real process env
    rng: () => 0.5,
    statsSource: source,
    projectRoot: 'C:/proj',
    ...overrides,
  });
  return { fs, transport, clock, logger, source, shipper };
}

function appendRecord(fs: MemShipperFs, record: Record<string, unknown>): void {
  fs.appendText(RUNS_FILE, JSON.stringify(record) + '\n');
}

function shippedStatsData(transport: FakeUploadTransport, runId: string): Array<Record<string, unknown>> {
  return transport.confirmed
    .filter((batch) => batch.run_id === runId)
    .flatMap((batch) => batch.events.map((event) => event.payload as Record<string, unknown>))
    .filter((payload) => payload.type === 'stats.run_record')
    .map((payload) => payload.data as Record<string, unknown>);
}

describe('unified stats watcher — local-run shipping (D18)', () => {
  test('a journal-unknown finished record ships ONCE with origin local + revision 1 (flag default ON)', async () => {
    const { fs, transport, shipper } = makeRig();
    expect(shipper.syncLocalStats).toBe(true); // D18 default
    appendRecord(fs, validRunRecord('run-L'));

    expect(shipper.rescanStats()).toBe(1);
    shipper.flushNow();
    await settle();

    expect(transport.confirmedSeqs('run-L')).toEqual([1]);
    const [data] = shippedStatsData(transport, 'run-L');
    expect(data.origin).toBe('local');
    expect(data.revision).toBe(1);

    // Unchanged file: the mtime gate skips it. Changed file: the cursor's
    // local shipped-set still prevents a re-ship.
    expect(shipper.rescanStats()).toBe(0);
    appendRecord(fs, validRunRecord('run-other', { ended_at: '2026-07-11T14:00:00.000Z' }));
    shipper.rescanStats();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-L')).toEqual([1]); // still exactly one
  });

  test('flag OFF (env sync_local_stats=0): a local record never ships — and ships after a later opt back in', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const off = makeRig({ env: { PIPELINE_SYNC_LOCAL_STATS: '0' } }, { fs, transport });
    expect(off.shipper.syncLocalStats).toBe(false);
    appendRecord(fs, validRunRecord('run-L'));

    expect(off.shipper.rescanStats()).toBe(0);
    off.shipper.flushNow();
    await settle();
    expect(transport.confirmed.length).toBe(0);
    expect(off.shipper.spooledCount).toBe(0);

    // The skip left no cursor mark, so flipping the flag back on ships it.
    const on = makeRig({}, { fs, transport });
    expect(on.shipper.rescanStats()).toBe(1);
    on.shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-L')).toEqual([1]);
  });

  test('the boolean config option wins over env', () => {
    const { shipper } = makeRig({ syncLocalStats: false, env: { PIPELINE_SYNC_LOCAL_STATS: '1' } });
    expect(shipper.syncLocalStats).toBe(false);
  });

  test('resolveSyncLocalStats: default ON; falsey/truthy strings recognized; garbage fails toward privacy (off)', () => {
    expect(resolveSyncLocalStats(undefined, {})).toEqual({ enabled: true, warning: null });
    for (const value of ['0', 'false', 'off', 'no']) {
      expect(resolveSyncLocalStats(undefined, { PIPELINE_SYNC_LOCAL_STATS: value }).enabled).toBe(false);
    }
    for (const value of ['1', 'true', 'on', 'yes']) {
      expect(resolveSyncLocalStats(undefined, { PIPELINE_SYNC_LOCAL_STATS: value }).enabled).toBe(true);
    }
    const garbage = resolveSyncLocalStats(undefined, { PIPELINE_SYNC_LOCAL_STATS: 'nope' });
    expect(garbage.enabled).toBe(false);
    expect(garbage.warning).toContain('failing toward privacy');
  });

  test('local ships survive a restart: the saved cursor prevents a rescan-everything re-ship', async () => {
    const fs = new MemShipperFs();
    const transport = new FakeUploadTransport();
    const first = makeRig({}, { fs, transport });
    appendRecord(fs, validRunRecord('run-L'));
    first.shipper.rescanStats();
    first.shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-L')).toEqual([1]);

    // Restart: fresh shipper + fresh DiskStatsSource (empty mtime gate) over
    // the same state dir — the full rescan finds the record but the cursor
    // remembers it shipped.
    const second = makeRig({}, { fs, transport });
    expect(second.shipper.rescanStats()).toBe(0);
  });
});

describe('unified stats watcher — enrichment re-ship (D13)', () => {
  test('tokens null→non-null re-ships EXACTLY once with revision 2 (dispatched origin preserved)', async () => {
    const { fs, transport, shipper } = makeRig();
    // Dispatched run: journal terminal event triggers the first ship (tokens null).
    appendRecord(fs, validRunRecord('run-A'));
    fs.appendText(JOURNAL, journalLine('run.started', 'run-A') + journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3]);
    expect(shippedStatsData(transport, 'run-A')).toMatchObject([{ revision: 1, origin: 'dispatched', tokens: null }]);

    // Enrichment rewrites the record line with folded tokens.
    fs.setText(
      RUNS_FILE,
      JSON.stringify(validRunRecord('run-A', { tokens: { input: 10, output: 20, cache_read: 0, cache_creation: 0 } })) + '\n'
    );
    expect(shipper.rescanStats()).toBe(1);
    shipper.flushNow();
    await settle();
    expect(transport.confirmedSeqs('run-A')).toEqual([1, 2, 3, 4]);
    const reshipped = shippedStatsData(transport, 'run-A').at(-1)!;
    expect(reshipped.revision).toBe(2);
    expect(reshipped.origin).toBe('dispatched');
    expect((reshipped.tokens as Record<string, unknown>).input).toBe(10);

    // The transition is one-way — a further file touch never ships a third time.
    fs.appendText(RUNS_FILE, 'garbage-line\n');
    expect(shipper.rescanStats()).toBe(0);
  });

  test('a record already enriched at first ship is never re-shipped', async () => {
    const { fs, transport, shipper } = makeRig();
    appendRecord(fs, validRunRecord('run-A', { tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 } }));
    fs.appendText(JOURNAL, journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(shippedStatsData(transport, 'run-A')).toMatchObject([{ revision: 1 }]);

    fs.appendText(RUNS_FILE, 'garbage-line\n'); // mtime bump, same record
    expect(shipper.rescanStats()).toBe(0);
  });

  test('a local run re-ships as origin local', async () => {
    const { fs, transport, shipper } = makeRig();
    appendRecord(fs, validRunRecord('run-L'));
    shipper.rescanStats();
    fs.setText(
      RUNS_FILE,
      JSON.stringify(validRunRecord('run-L', { tokens: { input: 5, output: 6, cache_read: 0, cache_creation: 0 } })) + '\n'
    );
    shipper.rescanStats();
    shipper.flushNow();
    await settle();
    expect(shippedStatsData(transport, 'run-L')).toMatchObject([
      { revision: 1, origin: 'local' },
      { revision: 2, origin: 'local' },
    ]);
  });
});

describe('unified stats watcher — dispatched path + rescan classification', () => {
  test('a dispatched run whose record lands AFTER its terminal event ships as dispatched via the rescan', async () => {
    const { fs, transport, shipper } = makeRig();
    fs.appendText(JOURNAL, journalLine('run.completed', 'run-B', { outcome: 'completed' }));
    shipper.pollOnce(); // terminal fold finds NO record yet
    shipper.flushNow();
    await settle();
    expect(shippedStatsData(transport, 'run-B')).toEqual([]);

    appendRecord(fs, validRunRecord('run-B'));
    expect(shipper.rescanStats()).toBe(1);
    shipper.flushNow();
    await settle();
    // Journal-known run ⇒ dispatched, NOT local — even with the flag on.
    expect(shippedStatsData(transport, 'run-B')).toMatchObject([{ revision: 1, origin: 'dispatched' }]);
  });

  test('records older than the 14-day window are ignored by the rescan', () => {
    const clock = new FakeClock();
    clock.advance(Date.parse('2026-07-11T13:00:00.000Z') + STATS_RESCAN_WINDOW_MS + 60_000);
    const { fs, shipper } = makeRig({}, { clock });
    appendRecord(fs, validRunRecord('run-old')); // ended_at 2026-07-11T13:00Z — just outside
    expect(shipper.rescanStats()).toBe(0);
  });
});

describe('unified stats watcher — schema validation (malformed never spooled)', () => {
  test('a malformed local record is rejected before the spool and left unmarked', async () => {
    const { fs, transport, shipper, logger } = makeRig();
    const broken = validRunRecord('run-X');
    delete (broken as Record<string, unknown>).pipeline; // required field gone
    appendRecord(fs, broken);

    expect(shipper.rescanStats()).toBe(0);
    shipper.flushNow();
    await settle();
    expect(shipper.spooledCount).toBe(0);
    expect(transport.attempts.length).toBe(0); // nothing ever left the machine
    expect(logger.joined()).toContain('failed schema validation');
    expect(logger.joined()).toContain('pipeline'); // names the field path only

    // A corrected rewrite ships (the rejection did not mark it shipped).
    fs.setText(RUNS_FILE, JSON.stringify(validRunRecord('run-X')) + '\n');
    expect(shipper.rescanStats()).toBe(1);
  });

  test('a malformed record on the dispatched-terminal path ships the journal events but never the stats record', async () => {
    const { fs, transport, shipper, logger } = makeRig();
    appendRecord(fs, { schema: 1, run_id: 'run-A', outcome: 'completed', ended_at: '2026-07-11T13:00:00.000Z' });
    fs.appendText(JOURNAL, journalLine('run.completed', 'run-A', { outcome: 'completed' }));
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    expect(transport.confirmedSeqs('run-A')).toEqual([1]); // the terminal event only
    expect(shippedStatsData(transport, 'run-A')).toEqual([]);
    expect(logger.joined()).toContain('failed schema validation');
  });
});

describe('unified stats watcher — excerpt strip (D16 / G-sec-2)', () => {
  const failingRecord = (runId: string): Record<string, unknown> =>
    validRunRecord(runId, {
      outcome: 'halted',
      tokens: {
        input: 10,
        output: 20,
        cache_read: 0,
        cache_creation: 0,
        tools_failed: 2,
        failed_tools: { Bash: 2 },
      },
      failures: [
        { ts: '2026-07-11T12:59:30.000Z', tool: 'Bash', step: 'step-1', error: 'SECRET_stack: /Users/ivan/code.ts:12 rm -rf failed' },
        { ts: '2026-07-11T12:59:40.000Z', tool: 'Bash', step: null, error: 'SECRET_other excerpt' },
      ],
    });

  test('metadata tier: shipped payload has NO excerpt text; tool + step + counts survive', async () => {
    const { fs, transport, shipper } = makeRig();
    appendRecord(fs, failingRecord('run-F'));
    shipper.rescanStats();
    shipper.flushNow();
    await settle();

    const wire = JSON.stringify(transport.confirmed);
    expect(wire).not.toContain('SECRET_');
    const [data] = shippedStatsData(transport, 'run-F');
    expect(data.failures).toEqual([
      { ts: '2026-07-11T12:59:30.000Z', tool: 'Bash', step: 'step-1' },
      { ts: '2026-07-11T12:59:40.000Z', tool: 'Bash', step: null },
    ]);
    expect((data.tokens as Record<string, unknown>).failed_tools).toEqual({ Bash: 2 }); // counts survive
  });

  test('events tier (verbatim tier): excerpts are STILL stripped on the stats path', async () => {
    const { fs, transport, shipper } = makeRig({ env: { PIPELINE_PRIVACY_TIER: 'events' } });
    expect(shipper.tier).toBe('events');
    appendRecord(fs, failingRecord('run-F'));
    shipper.rescanStats();
    shipper.flushNow();
    await settle();

    const wire = JSON.stringify(transport.confirmed);
    expect(wire).not.toContain('SECRET_');
    const [data] = shippedStatsData(transport, 'run-F');
    expect((data.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-07-11T12:59:30.000Z',
      tool: 'Bash',
      step: 'step-1',
    });
  });
});

/**
 * Marker retention is DELIBERATELY not tied to the seq bound. Evicting a stats
 * marker while its record is still inside the rescan window is what makes an
 * already-shipped dispatched run look brand new — the rescan then re-ships it
 * as `origin:"local"`, because its perRunSeq/endedRuns evidence was pruned in
 * the same pass.
 */
/**
 * The regression this retention split exists for. Note how little it takes to
 * reach: appending the NEXT run's record to the same runs.jsonl changes that
 * file's mtime, so every earlier record in it becomes a rescan candidate
 * again — no enrichment rewrite needed.
 */
describe('unified stats watcher — eviction must not resurrect a shipped run', () => {
  test('a dispatched run whose SEQ counter was pruned is never re-shipped as local', async () => {
    const { fs, transport, shipper } = makeRig({ maxTrackedRuns: 1 });

    // A dispatched run ships through the terminal-event path.
    appendRecord(fs, validRunRecord('run-D'));
    fs.appendText(
      JOURNAL,
      journalLine('run.started', 'run-D') + journalLine('run.completed', 'run-D', { outcome: 'completed' }),
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(shippedStatsData(transport, 'run-D')).toHaveLength(1);
    expect(shippedStatsData(transport, 'run-D')[0]!.origin).toBe('dispatched');

    // Enough other ended runs to push run-D past the seq bound.
    for (const id of ['run-x', 'run-y']) {
      fs.appendText(JOURNAL, journalLine('run.started', id) + journalLine('run.completed', id, { outcome: 'completed' }));
    }
    shipper.pollOnce();
    shipper.flushNow();
    await settle();
    expect(shipper.cursorSnapshot.perRunSeq['run-D']).toBeUndefined(); // evicted

    // The next run lands in the SAME runs.jsonl — its mtime changes, so run-D's
    // record is a rescan candidate again.
    appendRecord(fs, validRunRecord('run-N', { ended_at: '2026-07-11T14:00:00.000Z' }));
    shipper.rescanStats();
    shipper.flushNow();
    await settle();

    // run-D must NOT ship a second time, and certainly not as "local".
    const dispatched = shippedStatsData(transport, 'run-D');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.origin).toBe('dispatched');
    // The new local run still ships normally.
    expect(shippedStatsData(transport, 'run-N')).toHaveLength(1);
  });
});

describe('cursor — stats marker retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-22T12:00:00.000Z');
  const WINDOW = 14 * DAY;

  function seeded(): ReturnType<typeof emptyCursor> {
    const cursor = emptyCursor();
    cursor.perRunSeq = { 'run-1': 3, 'run-2': 5 };
    cursor.endedRuns = ['run-1'];
    cursor.statsShipped = ['run-1'];
    cursor.localStatsShipped = ['run-2'];
    cursor.statsTokensShipped = ['run-1'];
    cursor.statsRevisionShipped = { 'run-1': 2, 'run-2': 1 };
    cursor.statsShippedAt = { 'run-1': NOW - 3 * DAY, 'run-2': NOW - 20 * DAY };
    return cursor;
  }

  test('pruneCursor evicts the SEQ counter and leaves the stats markers alone', () => {
    const cursor = seeded();
    expect(pruneCursor(cursor, 1)).toEqual(['run-1']);
    expect(cursor.perRunSeq).toEqual({ 'run-2': 5 });
    // The markers survive: run-1's record is 3 days old, still rescannable.
    expect(cursor.statsShipped).toEqual(['run-1']);
    expect(cursor.statsTokensShipped).toEqual(['run-1']);
    expect(cursor.statsRevisionShipped['run-1']).toBe(2);
    expect(cursor.statsShippedAt['run-1']).toBe(NOW - 3 * DAY);
  });

  test('pruneStatsMarkers drops only records that aged OUT of the rescan window', () => {
    const cursor = seeded();
    expect(pruneStatsMarkers(cursor, NOW, WINDOW)).toEqual(['run-2']); // 20 days old
    expect(cursor.localStatsShipped).toEqual([]);
    expect(cursor.statsRevisionShipped).toEqual({ 'run-1': 2 });
    expect(cursor.statsShippedAt).toEqual({ 'run-1': NOW - 3 * DAY });
    // The in-window run keeps every marker.
    expect(cursor.statsShipped).toEqual(['run-1']);
  });

  test('a record exactly at the window edge is kept (it is still scannable)', () => {
    const cursor = emptyCursor();
    cursor.statsShipped = ['edge'];
    cursor.statsShippedAt = { edge: NOW - WINDOW };
    expect(pruneStatsMarkers(cursor, NOW, WINDOW)).toEqual([]);
    expect(cursor.statsShipped).toEqual(['edge']);
  });

  test('the hard cap evicts OLDEST-first as a backstop', () => {
    const cursor = emptyCursor();
    for (let i = 0; i < 5; i++) {
      const id = `run-${i}`;
      cursor.statsShipped.push(id);
      cursor.statsShippedAt[id] = NOW - i * 60_000; // run-4 is the oldest
    }
    const dropped = pruneStatsMarkers(cursor, NOW, WINDOW, 3);
    expect(dropped.sort()).toEqual(['run-3', 'run-4']);
    expect(cursor.statsShipped.sort()).toEqual(['run-0', 'run-1', 'run-2']);
  });

  test('an older cursor without statsShippedAt loads and prunes without throwing', () => {
    const cursor = emptyCursor();
    cursor.statsShipped = ['legacy'];
    // No statsShippedAt entry: nothing to age out, so the marker is kept
    // rather than dropped on a guess.
    expect(pruneStatsMarkers(cursor, NOW, WINDOW)).toEqual([]);
    expect(cursor.statsShipped).toEqual(['legacy']);
  });
});
