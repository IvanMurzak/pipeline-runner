import { describe, expect, test } from 'bun:test';
import { ConfigStore, type AgentIdentity } from '../src/core/config';
import { AgentClient, type AgentClientOptions } from '../src/core/connection';
import type { Transport } from '../src/core/transport';
import { CaptureLogger, FakeClock, MemFs, MockTransport, tick } from './_helpers';

const TOKEN = 'rt_hyper-secret-token-31337';

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    base_url: 'https://cp.example.com',
    runner_token: TOKEN,
    labels: ['os:windows'],
    os: 'windows',
    agent_version: '0.1.0',
    cli_version: 'unknown',
    ...overrides,
  };
}

function makeWorld(options: {
  transports?: Transport[];
  wssBehaviors?: Array<'establish' | 'fail'>;
  seedIdentity?: AgentIdentity | null;
  clientOverrides?: Partial<AgentClientOptions>;
} = {}) {
  const fs = new MemFs();
  const store = new ConfigStore({ dir: 'cfg', fs });
  if (options.seedIdentity !== null) store.save(options.seedIdentity ?? identity());
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const wss = new MockTransport('wss', options.wssBehaviors ?? ['establish']);
  const transports = options.transports ?? [wss];
  let ids = 0;
  const online: string[] = [];
  const fatal: string[] = [];
  const client = new AgentClient({
    store,
    transports,
    clock,
    logger,
    rng: () => 0.5, // jitter midpoint ⇒ deterministic raw delays
    makeId: () => `id-${++ids}`,
    events: {
      onOnline: (runnerId) => online.push(runnerId),
      onFatal: (reason) => fatal.push(reason),
    },
    ...options.clientOverrides,
  });
  return { client, store, clock, logger, wss, online, fatal };
}

/** Drive a fresh client to `online` (register sent → ack'd). */
async function goOnline(world: ReturnType<typeof makeWorld>, heartbeatIntervalS = 5) {
  world.client.start();
  await tick();
  const register = world.wss.last.sent[0]!;
  world.wss.last.serverSend({
    type: 'register_ack',
    id: register.id,
    protocol_version: 1,
    runner_id: 'r-1',
    heartbeat_interval_s: heartbeatIntervalS,
  });
  expect(world.client.state).toBe('online');
}

describe('register handshake over the connection', () => {
  test('register is the FIRST frame sent after the transport opens', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    expect(world.client.state).toBe('registering');
    expect(world.wss.last.sent).toHaveLength(1);
    const frame = world.wss.last.sent[0]!;
    expect(frame.type).toBe('register');
    expect(frame.runner_token).toBe(TOKEN);
    expect(frame.protocol_version).toBe(1);
    expect(frame.id).toBeDefined();
  });

  test('register_ack → online, runner_id + cadence persisted, backoff reset, onOnline fired', async () => {
    const world = makeWorld();
    await goOnline(world, 15);
    expect(world.store.load()?.runner_id).toBe('r-1');
    expect(world.store.load()?.heartbeat_interval_s).toBe(15);
    expect(world.online).toEqual(['r-1']);
  });

  test('a fatal reject (invalid_token) stops the client — NO reconnect is ever scheduled', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'invalid_token' });
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.client.fatalReason).toContain('pipeline-runner register');
    expect(world.fatal).toHaveLength(1);
    await tick();
    world.clock.advance(3_600_000); // an hour of fake time: nothing may fire
    await tick();
    expect(world.wss.connections).toHaveLength(1);
    expect(world.client.state).toBe('stopped_fatal');
  });

  test('upgrade_required surfaces the precise version message', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'upgrade_required', min_protocol_version: 2 });
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.client.fatalReason).toContain('update the agent');
    expect(world.client.fatalReason).toContain('v2');
    expect(world.client.fatalReason).toContain('v1');
  });

  test('a capacity reject is transient: reconnects with backoff and re-registers', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'capacity' });
    await tick(); // local close → onClose
    expect(world.client.state).toBe('backoff');
    world.clock.advance(1_000); // first retry delay (rng midpoint ⇒ base)
    await tick();
    expect(world.wss.connections).toHaveLength(2);
    expect(world.wss.last.sent[0]!.type).toBe('register');
    expect(world.client.state).toBe('registering');
  });

  test('an incompatible ack protocol major is fatal', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_ack', id: 'id-1', protocol_version: 99, runner_id: 'r-1' });
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.client.fatalReason).toContain('v99');
  });

  test('register timeout drops the connection and retries', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    expect(world.client.state).toBe('registering');
    world.clock.advance(10_000); // DEFAULT_REGISTER_TIMEOUT_MS — no reply arrived
    await tick(); // local close → onClose → backoff
    expect(world.client.state).toBe('backoff');
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.connections).toHaveLength(2);
  });

  test('starting with no stored identity is fatal with an actionable message', async () => {
    const world = makeWorld({ seedIdentity: null });
    world.client.start();
    await tick();
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.client.fatalReason).toContain('pipeline-runner register');
  });
});

describe('reconnect / backoff', () => {
  test('repeated establish failures back off exponentially (deterministic at rng midpoint)', async () => {
    const world = makeWorld({ wssBehaviors: ['fail'] });
    world.client.start();
    const observedDelays: number[] = [];
    for (const expected of [1_000, 2_000, 4_000, 8_000]) {
      await tick(); // the open attempt fails
      expect(world.client.state).toBe('backoff');
      const before = world.wss.connections.length;
      world.clock.advance(expected - 1);
      await tick();
      expect(world.wss.connections.length).toBe(before); // not yet
      world.clock.advance(1);
      await tick();
      expect(world.wss.connections.length).toBe(before + 1); // fired exactly at the delay
      observedDelays.push(expected);
    }
    expect(observedDelays).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  test('a drop AFTER online reconnects (backoff restarted from base) and re-registers', async () => {
    const world = makeWorld();
    await goOnline(world);
    world.wss.last.serverClose('network reset');
    expect(world.client.state).toBe('backoff');
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.connections).toHaveLength(2);
    expect(world.wss.last.sent[0]!.type).toBe('register'); // full re-handshake
  });

  test('stop() halts everything cleanly', async () => {
    const world = makeWorld();
    await goOnline(world);
    world.client.stop();
    await tick();
    world.clock.advance(600_000);
    await tick();
    expect(world.client.state).toBe('stopped');
    expect(world.wss.connections).toHaveLength(1);
  });
});

describe('long-poll fallback seam', () => {
  test('when WSS fails to establish, the fallback transport is tried in the SAME attempt', async () => {
    const wss = new MockTransport('wss', ['fail']);
    const longPoll = new MockTransport('long-poll', ['establish']);
    const world = makeWorld({ transports: [wss, longPoll] });
    world.client.start();
    await tick();
    expect(wss.connections).toHaveLength(1);
    expect(longPoll.connections).toHaveLength(1);
    expect(world.client.state).toBe('registering');
    expect(longPoll.last.sent[0]!.type).toBe('register'); // register rides the fallback
    expect(world.logger.joined()).toContain('falling back to long-poll');
  });

  test('after a successful session, the NEXT reconnect tries the primary (WSS) first again', async () => {
    const wss = new MockTransport('wss', ['fail', 'establish']);
    const longPoll = new MockTransport('long-poll', ['establish']);
    const world = makeWorld({ transports: [wss, longPoll] });
    world.client.start();
    await tick(); // wss fails → long-poll established
    const register = longPoll.last.sent[0]!;
    longPoll.last.serverSend({ type: 'register_ack', id: register.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.state).toBe('online');
    longPoll.last.serverClose('poll died');
    world.clock.advance(1_000);
    await tick();
    expect(wss.connections).toHaveLength(2); // primary retried first
    expect(world.client.state).toBe('registering');
  });

  test('when every transport fails to establish, the attempt ends in backoff', async () => {
    const wss = new MockTransport('wss', ['fail']);
    const longPoll = new MockTransport('long-poll', ['fail']);
    const world = makeWorld({ transports: [wss, longPoll] });
    world.client.start();
    await tick();
    expect(world.client.state).toBe('backoff');
    expect(wss.connections).toHaveLength(1);
    expect(longPoll.connections).toHaveLength(1);
  });
});

describe('heartbeat over the connection', () => {
  test('after online, heartbeats flow on the server cadence and pair their acks', async () => {
    const world = makeWorld();
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    expect(hb.type).toBe('heartbeat');
    expect(hb.runner_id).toBe('r-1');
    expect(hb.active_run_ids).toEqual([]);
    expect(hb.status).toBe('online');
    world.wss.last.serverSend({ type: 'heartbeat_ack', id: hb.id });
    world.clock.advance(5_000);
    expect(world.wss.last.sent).toHaveLength(3); // second beat, no misses
    expect(world.client.state).toBe('online');
  });

  test('a drain directive sets draining and later beats report it', async () => {
    const world = makeWorld();
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    world.wss.last.serverSend({ type: 'heartbeat_ack', id: hb.id, directive: 'drain' });
    expect(world.client.draining).toBe(true);
    world.clock.advance(5_000);
    expect(world.wss.last.sent[2]!.status).toBe('draining');
    expect(world.client.state).toBe('online'); // draining ≠ disconnected
  });

  test('a reregister directive re-handshakes on a fresh connection', async () => {
    const world = makeWorld();
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    world.wss.last.serverSend({ type: 'heartbeat_ack', id: hb.id, directive: 'reregister' });
    await tick(); // local close → onClose → backoff
    expect(world.client.state).toBe('backoff');
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.connections).toHaveLength(2);
    expect(world.wss.last.sent[0]!.type).toBe('register');
  });

  test('missed heartbeat acks mark the connection dead and reconnect', async () => {
    const world = makeWorld();
    await goOnline(world, 5);
    world.clock.advance(5_000); // hb 1 — never acked
    world.clock.advance(5_000); // miss 1, hb 2
    world.clock.advance(5_000); // miss 2 ⇒ dead
    await tick();
    expect(world.client.state).toBe('backoff');
    expect(world.logger.joined()).toContain('presuming connection dead');
  });
});

describe('secrets discipline', () => {
  test('the runner token NEVER appears in any log line across the full lifecycle', async () => {
    // Exercise every logging path: connect, register, transient reject,
    // backoff, reconnect, ack, heartbeats, drop, and a final fatal reject.
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'capacity' });
    await tick();
    world.clock.advance(1_000);
    await tick();
    const register = world.wss.last.sent[0]!;
    world.wss.last.serverSend({
      type: 'register_ack',
      id: register.id,
      protocol_version: 1,
      runner_id: 'r-1',
      heartbeat_interval_s: 5,
    });
    world.clock.advance(5_000);
    world.wss.last.serverClose('flap');
    world.clock.advance(1_000);
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'revoked' });
    expect(world.client.state).toBe('stopped_fatal');

    expect(world.logger.lines.length).toBeGreaterThan(5); // plenty was logged...
    expect(world.logger.joined()).not.toContain(TOKEN); // ...none of it the token
    expect(world.fatal.join('\n')).not.toContain(TOKEN);
  });
});

describe('outbound send (T2-03 seam)', () => {
  test('send() delivers a frame only while online', async () => {
    const world = makeWorld();
    expect(world.client.send({ type: 'accept', runner_id: 'r-1' })).toBe(false); // idle
    world.client.start();
    await tick();
    expect(world.client.state).toBe('registering');
    expect(world.client.send({ type: 'accept', runner_id: 'r-1' })).toBe(false); // not online yet
    const register = world.wss.last.sent[0]!;
    world.wss.last.serverSend({ type: 'register_ack', id: register.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.send({ type: 'accept', runner_id: 'r-1', job_id: 'j1', run_id: 'run1' })).toBe(true);
    expect(world.wss.last.sent[1]).toEqual({ type: 'accept', runner_id: 'r-1', job_id: 'j1', run_id: 'run1' });
  });

  test('send() after a drop is refused (no queueing), and logs at debug only', async () => {
    const world = makeWorld();
    await goOnline(world);
    world.wss.last.serverClose('network reset');
    expect(world.client.state).toBe('backoff');
    expect(world.client.send({ type: 'run_status', run_id: 'run1', phase: 'started' })).toBe(false);
    expect(world.logger.joined()).toContain("frame 'run_status' not sent");
  });
});

describe('inbound routing while online', () => {
  test('protocol frames this core does not handle yet are ignored gracefully; the dispatcher hook works', async () => {
    const world = makeWorld();
    await goOnline(world);
    // Unknown + reserved types must not disturb the connection.
    world.wss.last.serverSend({ type: 'lease', job_id: 'j1', run_id: 'run1' });
    world.wss.last.serverSend({ type: 'shiny_future_frame', payload: 1 });
    expect(world.client.state).toBe('online');
    expect(world.logger.joined()).toContain("frame 'lease' not handled yet (ignored)");
    // The T1-12 hook: attach a lease handler on the SAME dispatcher.
    const leases: unknown[] = [];
    world.client.dispatcher.on('lease', (frame) => leases.push(frame.job_id));
    world.wss.last.serverSend({ type: 'lease', job_id: 'j2', run_id: 'run2' });
    expect(leases).toEqual(['j2']);
  });
});
