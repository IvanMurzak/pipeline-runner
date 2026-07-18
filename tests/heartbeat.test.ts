import { describe, expect, test } from 'bun:test';
import { DEFAULT_HEARTBEAT_INTERVAL_S, HeartbeatLoop, type HeartbeatOptions } from '../src/core/heartbeat';
import type { HeartbeatDirective, HeartbeatMessage, RunnerStatus } from '../src/core/wire';
import { CaptureLogger, FakeClock } from './_helpers';

function makeLoop(overrides: Partial<HeartbeatOptions> = {}) {
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const sent: HeartbeatMessage[] = [];
  let ids = 0;
  const directives: Array<Exclude<HeartbeatDirective, 'none'>> = [];
  const missed: number[] = [];
  const loop = new HeartbeatLoop({
    runnerId: 'r-1',
    send: (frame) => sent.push(frame),
    intervalS: 10,
    makeId: () => `hb-${++ids}`,
    onDirective: (directive) => directives.push(directive),
    onMissedAcks: (misses) => missed.push(misses),
    clock,
    logger,
    ...overrides,
  });
  return { loop, clock, logger, sent, directives, missed };
}

describe('HeartbeatLoop cadence', () => {
  test('fires on the configured interval, not before', () => {
    const { loop, clock, sent } = makeLoop();
    loop.start();
    clock.advance(9_999);
    expect(sent).toHaveLength(0);
    clock.advance(1);
    expect(sent).toHaveLength(1);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1' });
    clock.advance(10_000);
    expect(sent).toHaveLength(2);
    loop.stop();
  });

  test('defaults to DEFAULT_HEARTBEAT_INTERVAL_S when the ack stated none', () => {
    const { loop, clock, sent } = makeLoop({ intervalS: undefined });
    loop.start();
    clock.advance(DEFAULT_HEARTBEAT_INTERVAL_S * 1000 - 1);
    expect(sent).toHaveLength(0);
    clock.advance(1);
    expect(sent).toHaveLength(1);
    loop.stop();
  });

  test('frames carry runner_id, active_run_ids (empty absent an accessor), status, paused_until, runs_authoritative, and a fresh correlation id', () => {
    const { loop, clock, sent } = makeLoop();
    loop.start();
    clock.advance(10_000);
    expect(sent[0]).toEqual({
      type: 'heartbeat',
      id: 'hb-1',
      runner_id: 'r-1',
      active_run_ids: [],
      status: 'online',
      paused_until: null,
      runs_authoritative: true,
    });
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1' });
    clock.advance(10_000);
    expect(sent[1]!.id).toBe('hb-2'); // fresh id per beat
    loop.stop();
  });

  test('activeRunIds/pausedUntil accessors compose real run state onto the frame (c2)', () => {
    let runIds: string[] = [];
    let paused: string | null = null;
    const { loop, clock, sent } = makeLoop({
      activeRunIds: () => runIds,
      pausedUntil: () => paused,
    });
    loop.start();
    clock.advance(10_000);
    expect(sent[0]!.active_run_ids).toEqual([]);
    expect(sent[0]!.paused_until).toBeNull();
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1' });

    runIds = ['run-1', 'run-2'];
    paused = '2026-07-17T13:00:00.000Z';
    clock.advance(10_000);
    expect(sent[1]!.active_run_ids).toEqual(['run-1', 'run-2']);
    expect(sent[1]!.paused_until).toBe('2026-07-17T13:00:00.000Z');
    expect(sent[1]!.runs_authoritative).toBe(true);
    loop.stop();
  });

  test('status callback drives the reported status (drain support)', () => {
    let draining = false;
    const { loop, clock, sent } = makeLoop({ status: (): RunnerStatus => (draining ? 'draining' : 'online') });
    loop.start();
    clock.advance(10_000);
    expect(sent[0]!.status).toBe('online');
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1', directive: 'drain' });
    draining = true;
    clock.advance(10_000);
    expect(sent[1]!.status).toBe('draining');
    loop.stop();
  });

  test('stop cancels the timer', () => {
    const { loop, clock, sent } = makeLoop();
    loop.start();
    loop.stop();
    clock.advance(100_000);
    expect(sent).toHaveLength(0);
    expect(clock.pendingCount).toBe(0);
  });
});

describe('HeartbeatLoop ack pairing', () => {
  test('a matched ack clears the pending beat (no miss accrues)', () => {
    const { loop, clock, missed } = makeLoop();
    loop.start();
    for (let i = 1; i <= 5; i++) {
      clock.advance(10_000);
      loop.handleAck({ type: 'heartbeat_ack', id: `hb-${i}` });
    }
    expect(missed).toHaveLength(0);
    loop.stop();
  });

  test('an unmatched ack id is ignored', () => {
    const { loop, clock, missed } = makeLoop({ maxMissedAcks: 1 });
    loop.start();
    clock.advance(10_000); // hb-1 pending
    loop.handleAck({ type: 'heartbeat_ack', id: 'not-a-real-id' });
    clock.advance(10_000); // hb-1 still unacked ⇒ miss
    expect(missed).toEqual([1]);
    loop.stop();
  });

  test('a malformed ack (bogus directive) is ignored with a warning', () => {
    const { loop, clock, logger, missed } = makeLoop({ maxMissedAcks: 1 });
    loop.start();
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1', directive: 'self_destruct' });
    expect(logger.joined()).toContain('malformed heartbeat_ack ignored');
    clock.advance(10_000);
    expect(missed).toEqual([1]); // the malformed ack did NOT clear the pending beat
    loop.stop();
  });

  test('directives on the ack reach onDirective (reregister, drain); none does not', () => {
    const { loop, clock, directives } = makeLoop();
    loop.start();
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1', directive: 'none' });
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-2', directive: 'reregister' });
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-3', directive: 'drain' });
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-4' }); // absent ⇒ none
    expect(directives).toEqual(['reregister', 'drain']);
    loop.stop();
  });
});

describe('HeartbeatLoop liveness', () => {
  test('onMissedAcks fires after maxMissedAcks consecutive unacked beats', () => {
    const { loop, clock, missed } = makeLoop({ maxMissedAcks: 2 });
    loop.start();
    clock.advance(10_000); // hb-1 (never acked)
    clock.advance(10_000); // miss 1, hb-2
    expect(missed).toHaveLength(0);
    clock.advance(10_000); // miss 2 ⇒ fire
    expect(missed).toEqual([2]);
    loop.stop();
  });

  test('an ack resets the miss counter', () => {
    const { loop, clock, missed } = makeLoop({ maxMissedAcks: 2 });
    loop.start();
    clock.advance(10_000); // hb-1
    clock.advance(10_000); // miss 1, hb-2
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1' });
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-2' });
    clock.advance(10_000); // hb-3, nothing pending before it
    clock.advance(10_000); // miss 1 again (hb-3), hb-4
    expect(missed).toHaveLength(0);
    loop.stop();
  });
});

describe('HeartbeatLoop onBeat hook (c6 record-touch writer)', () => {
  test('fires once per beat, before the frame is composed', () => {
    const beats: number[] = [];
    const { loop, clock, sent } = makeLoop({
      onBeat: () => beats.push(sent.length), // captured length BEFORE the frame is pushed
    });
    loop.start();
    clock.advance(10_000);
    loop.handleAck({ type: 'heartbeat_ack', id: 'hb-1' });
    clock.advance(10_000);
    expect(sent).toHaveLength(2);
    expect(beats).toEqual([0, 1]); // one hook call per beat, each before its send
    loop.stop();
  });

  test('a throwing onBeat never blocks the beat itself', () => {
    const { loop, clock, sent, logger } = makeLoop({
      onBeat: () => {
        throw new Error('store on fire');
      },
    });
    loop.start();
    clock.advance(10_000);
    expect(sent).toHaveLength(1); // beat went out regardless
    expect(logger.joined()).toContain('onBeat hook failed');
    loop.stop();
  });
});
