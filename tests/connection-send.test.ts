import { describe, expect, test } from 'bun:test';
import { ConfigStore, type AgentIdentity } from '../src/core/config';
import { AgentClient } from '../src/core/connection';
import { FakeClock, MemFs, MockTransport, tick } from './_helpers';

/**
 * Focused coverage for the ONE flagged additive core method: `AgentClient.send`
 * (the T1-13 relay seam). It must accept a frame ONLY while `online`, and report
 * false otherwise so the relay knows the live channel could not deliver.
 */

function identity(): AgentIdentity {
  return {
    base_url: 'https://cp.example.com',
    runner_token: 'rt_secret',
    labels: ['os:windows'],
    os: 'windows',
    agent_version: '0.1.0',
    cli_version: 'unknown',
  };
}

function makeWorld() {
  const fs = new MemFs();
  const store = new ConfigStore({ dir: 'cfg', fs });
  store.save(identity());
  const clock = new FakeClock();
  const wss = new MockTransport('wss', ['establish']);
  let ids = 0;
  const client = new AgentClient({
    store,
    transports: [wss],
    clock,
    rng: () => 0.5,
    makeId: () => `id-${++ids}`,
  });
  return { client, clock, wss };
}

describe('AgentClient.send() — the additive relay seam', () => {
  test('false before register, true after register_ack (online), false after the connection closes', async () => {
    const world = makeWorld();

    // idle: no connection at all.
    expect(world.client.send({ type: 'needs_input' })).toBe(false);

    world.client.start();
    await tick();
    // registering: transport open but NOT yet online — must refuse.
    expect(world.client.state).toBe('registering');
    expect(world.client.send({ type: 'needs_input' })).toBe(false);

    const register = world.wss.last.sent[0]!;
    world.wss.last.serverSend({ type: 'register_ack', id: register.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.state).toBe('online');

    // online: the frame is accepted and actually rides the live connection.
    const sentBefore = world.wss.last.sent.length;
    expect(world.client.send({ type: 'needs_input', run_id: 'run-1', question_id: 'q-1' })).toBe(true);
    expect(world.wss.last.sent).toHaveLength(sentBefore + 1);
    expect(world.wss.last.sent[sentBefore]!.type).toBe('needs_input');

    // dropped: the connection is gone → back to false.
    world.wss.last.serverClose('network reset');
    expect(world.client.state).toBe('backoff');
    expect(world.client.send({ type: 'needs_input' })).toBe(false);
  });

  test('false after stop()', async () => {
    const world = makeWorld();
    world.client.start();
    await tick();
    const register = world.wss.last.sent[0]!;
    world.wss.last.serverSend({ type: 'register_ack', id: register.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.send({ type: 'needs_input' })).toBe(true);
    world.client.stop();
    expect(world.client.state).toBe('stopped');
    expect(world.client.send({ type: 'needs_input' })).toBe(false);
  });
});
