import { describe, expect, test } from 'bun:test';
import { ConfigStore, type AgentIdentity } from '../src/core/config';
import { AgentClient, type AgentClientOptions } from '../src/core/connection';
import type { ClientCredentialsResult } from '../src/core/department-oauth';
import { RegisterCredentialProvider } from '../src/core/register-credential';
import type { Transport } from '../src/core/transport';
import { CaptureLogger, FakeClock, MemFs, MockTransport, tick } from './_helpers';

const TOKEN = 'rt_hyper-secret-token-31337';
/** d5 (P6): the DISTINCT OAuth client secret and the short-lived
 *  `runner:register` token it buys. Both are secrets; neither may be logged. */
const CLIENT_SECRET = 'rcs_distinct-client-secret-77';
const REGISTER_JWT = 'hdr.pld.sig-registration-token';
const RUNNER_ID = 'run_r-1';

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

describe('heartbeat composition (c2 — job manager truth)', () => {
  test('activeRunIds/runnerStatus/pausedUntil accessors thread onto every beat, and runs_authoritative is always set', async () => {
    let runIds: string[] = ['run-1'];
    let status: 'online' | 'paused' = 'paused';
    let pausedUntil: string | null = '2026-07-17T13:00:00.000Z';
    const world = makeWorld({
      clientOverrides: {
        activeRunIds: () => runIds,
        runnerStatus: () => status,
        pausedUntil: () => pausedUntil,
      },
    });
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    expect(hb.active_run_ids).toEqual(['run-1']);
    expect(hb.status).toBe('paused');
    expect(hb.paused_until).toBe('2026-07-17T13:00:00.000Z');
    expect(hb.runs_authoritative).toBe(true);

    // The invariant: a paused (or awaiting-input) run stays reported in
    // active_run_ids — asserted here at the composition boundary (the
    // manager's own map semantics are asserted in jobs/manager.test.ts).
    world.wss.last.serverSend({ type: 'heartbeat_ack', id: hb.id });
    runIds = [];
    status = 'online';
    pausedUntil = null;
    world.clock.advance(5_000);
    const hb2 = world.wss.last.sent[2]!;
    expect(hb2.active_run_ids).toEqual([]);
    expect(hb2.status).toBe('online');
    expect(hb2.paused_until).toBeNull();
    expect(hb2.runs_authoritative).toBe(true);
  });

  test('a drain directive still overrides runnerStatus (server directive wins)', async () => {
    const world = makeWorld({ clientOverrides: { runnerStatus: () => 'paused' } });
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    expect(hb.status).toBe('paused'); // no drain yet — the manager's status wins
    world.wss.last.serverSend({ type: 'heartbeat_ack', id: hb.id, directive: 'drain' });
    world.clock.advance(5_000);
    expect(world.wss.last.sent[2]!.status).toBe('draining'); // drain wins over 'paused'
  });

  test('without accessors wired, heartbeats fall back to the pre-wiring stub ([], "online")', async () => {
    const world = makeWorld();
    await goOnline(world, 5);
    world.clock.advance(5_000);
    const hb = world.wss.last.sent[1]!;
    expect(hb.active_run_ids).toEqual([]);
    expect(hb.status).toBe('online');
    expect(hb.paused_until).toBeNull();
    expect(hb.runs_authoritative).toBe(true);
  });
});

// ── department-mesh d5 (P6): which credential the register frame carries ─────

/** A migrated runner: distinct client secret + the runner id that is its
 *  OAuth `client_id`. */
function migratedIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return identity({ oauth_client_secret: CLIENT_SECRET, runner_id: RUNNER_ID, ...overrides });
}

function providerReturning(result: ClientCredentialsResult, clock?: FakeClock, logger?: CaptureLogger): RegisterCredentialProvider {
  return new RegisterCredentialProvider({
    requestToken: async () => result,
    ...(clock !== undefined ? { clock } : {}),
    ...(logger !== undefined ? { logger } : {}),
  });
}

const issuedToken: ClientCredentialsResult = {
  ok: true,
  token: { accessToken: REGISTER_JWT, tokenType: 'Bearer', expiresAt: 900_000, scope: 'runner:register' },
};

describe('d5 — register credential selection over the connection', () => {
  test('a MIGRATED runner registers with the runner:register token, not the plaintext one', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    world.client.start();
    await tick();
    const frame = world.wss.last.sent[0]!;
    expect(frame.type).toBe('register');
    expect(frame.runner_token).toBe(REGISTER_JWT);
    expect(frame.runner_token).not.toBe(TOKEN);
  });

  test('a MIGRATED runner with NO plaintext token in its config still registers (DoD 1)', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity({ runner_token: undefined }),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    await goOnline(world);
    expect(world.wss.last.sent[0]!.runner_token).toBe(REGISTER_JWT);
    expect(world.store.load()?.runner_token).toBeUndefined();
  });

  test('an UN-UPGRADED runner registers with its legacy token, with no token-endpoint call (DoD 2)', async () => {
    let calls = 0;
    const world = makeWorld({
      clientOverrides: {
        registerCredentials: new RegisterCredentialProvider({
          requestToken: async () => {
            calls += 1;
            return issuedToken;
          },
        }),
      },
    });
    await goOnline(world);
    expect(world.wss.last.sent[0]!.runner_token).toBe(TOKEN);
    expect(calls).toBe(0);
  });

  test('an un-migrated runner sends register in the SAME turn the socket opened — a hung token endpoint cannot delay it', async () => {
    // A never-settling exchange: the migrated client is still waiting for its
    // credential while the un-migrated one has already registered.
    const pending = new RegisterCredentialProvider({ requestToken: () => new Promise<ClientCredentialsResult>(() => {}) });
    const blocked = makeWorld({ seedIdentity: migratedIdentity(), clientOverrides: { registerCredentials: pending } });
    const plain = makeWorld();

    blocked.client.start();
    plain.client.start();
    await tick();

    expect(plain.wss.last.sent).toHaveLength(1);
    expect(blocked.wss.last.sent).toHaveLength(0);
    expect(blocked.client.state).toBe('registering');
  });

  test('a hung token exchange drops the connection on the register timeout and backs off — it never wedges', async () => {
    const pending = new RegisterCredentialProvider({ requestToken: () => new Promise<ClientCredentialsResult>(() => {}) });
    const world = makeWorld({ seedIdentity: migratedIdentity(), clientOverrides: { registerCredentials: pending } });
    world.client.start();
    await tick();
    world.clock.advance(10_000); // DEFAULT_REGISTER_TIMEOUT_MS
    await tick();
    expect(world.logger.joined()).toContain('register timed out');
    expect(world.client.state).toBe('backoff');
  });

  test('R11: when the token endpoint refuses, the runner falls back to its legacy token and stays online', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: {
        registerCredentials: providerReturning({ ok: false, error: { error: 'invalid_client', status: 401 } }),
      },
    });
    await goOnline(world);
    expect(world.wss.last.sent[0]!.runner_token).toBe(TOKEN);
    expect(world.client.state).toBe('online');
  });

  test('R11 safety net: a FATAL reject of an OAuth credential retries with legacy instead of stopping', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    world.client.start();
    await tick();
    expect(world.wss.last.sent[0]!.runner_token).toBe(REGISTER_JWT);

    // The cloud refuses the JWT fatally (rotated OAUTH_TOKEN_SECRET, stale
    // client secret, clock skew). Pre-d5 this runner would have presented its
    // still-valid legacy token; it must not be worse off for having migrated.
    world.wss.last.serverSend({ type: 'register_reject', reason: 'invalid_token' });
    expect(world.client.state).not.toBe('stopped_fatal');
    expect(world.fatal).toHaveLength(0);
    await tick();
    world.clock.advance(1_000);
    await tick();

    expect(world.wss.connections).toHaveLength(2);
    expect(world.wss.last.sent[0]!.runner_token).toBe(TOKEN);
    world.wss.last.serverSend({ type: 'register_ack', id: world.wss.last.sent[0]!.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.state).toBe('online');
    expect(world.logger.joined()).toContain('retrying with this runner');
  });

  test('…and if the legacy token is refused too, the fatal stop is honoured (no reject loop)', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'invalid_token' });
    await tick();
    world.clock.advance(1_000);
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'invalid_token' });
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.fatal).toHaveLength(1);
  });

  test('a migrated runner with no legacy fallback RETRIES with backoff — it never stops fatally on its own', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity({ runner_token: undefined }),
      clientOverrides: {
        registerCredentials: providerReturning({ ok: false, error: { error: 'network_error' } }),
      },
    });
    world.client.start();
    await tick();
    expect(world.wss.last.sent).toHaveLength(0);
    expect(world.client.state).toBe('backoff');
    expect(world.fatal).toHaveLength(0);
    expect(world.logger.joined()).toContain('no register credential available');
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.connections).toHaveLength(2); // it keeps trying
  });

  // ── A1: the reject that must NOT be fatal ──────────────────────────────────
  // A migrated runner whose token exchange blipped presents its legacy token as
  // a STAND-IN. If the window is closed (`oauth_only`) the cloud answers
  // `upgrade_required` — fatal by the protocol's vocabulary. Honouring it here
  // would turn a recoverable failure on `/oauth/token` into a permanent outage
  // over a WSS channel that was healthy the whole time. That is a NEW R11 path
  // this migration must not create.
  test('R11: a fatal reject of a DEGRADED legacy stand-in is retried, not honoured', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: {
        registerCredentials: providerReturning({ ok: false, error: { error: 'network_error' } }),
      },
    });
    world.client.start();
    await tick();
    expect(world.wss.last.sent[0]!.runner_token).toBe(TOKEN); // the stand-in

    world.wss.last.serverSend({
      type: 'register_reject',
      reason: 'upgrade_required',
      message: 'legacy runner token retired for this runner',
    });
    expect(world.client.state).not.toBe('stopped_fatal');
    expect(world.fatal).toHaveLength(0);
    expect(world.logger.joined()).toContain('STAND-IN');

    await tick();
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.connections).toHaveLength(2); // it keeps trying
  });

  test('…and once the exchange recovers, the very next attempt registers with OAuth', async () => {
    let failing = true;
    const provider = new RegisterCredentialProvider({
      requestToken: async () => (failing ? { ok: false, error: { error: 'network_error' } } : issuedToken),
    });
    const world = makeWorld({ seedIdentity: migratedIdentity(), clientOverrides: { registerCredentials: provider } });
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'upgrade_required' });
    await tick();
    failing = false; // /oauth/token comes back
    world.clock.advance(1_000);
    await tick();
    expect(world.wss.last.sent[0]!.runner_token).toBe(REGISTER_JWT);
    world.wss.last.serverSend({ type: 'register_ack', id: world.wss.last.sent[0]!.id, protocol_version: 1, runner_id: 'r-1' });
    expect(world.client.state).toBe('online');
  });

  test('a genuinely UN-MIGRATED runner is NOT rescued by that branch — it still stops on the first reject', async () => {
    // The un-migrated identity can never mint, so its legacy token is never a
    // "stand-in" and `upgrade_required` means what it has always meant.
    const world = makeWorld();
    world.client.start();
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'upgrade_required', min_protocol_version: 2 });
    expect(world.client.state).toBe('stopped_fatal');
    expect(world.fatal).toHaveLength(1);
    expect(world.wss.connections).toHaveLength(1);
  });

  test('the stand-in branch does not fire once the client secret is gone from the config', async () => {
    // Reject arrives; by then the operator has removed the client secret, so
    // this runner can no longer mint and the fatal answer is the true one.
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: {
        registerCredentials: providerReturning({ ok: false, error: { error: 'network_error' } }),
      },
    });
    world.client.start();
    await tick();
    world.store.save({ ...world.store.load()!, oauth_client_secret: undefined });
    world.wss.last.serverSend({ type: 'register_reject', reason: 'upgrade_required' });
    expect(world.client.state).toBe('stopped_fatal');
  });

  // ── A3: the register deadline is re-armed when the frame actually leaves ────
  test('a slow exchange does not eat the gateway’s answer budget — the timer restarts at send', async () => {
    let release: (result: ClientCredentialsResult) => void = () => {};
    const provider = new RegisterCredentialProvider({
      requestToken: () => new Promise<ClientCredentialsResult>((resolve) => (release = resolve)),
    });
    const world = makeWorld({ seedIdentity: migratedIdentity(), clientOverrides: { registerCredentials: provider } });
    world.client.start();
    await tick();
    world.clock.advance(7_000); // the exchange took 7 of the 10 seconds
    release(issuedToken);
    await tick();
    expect(world.wss.last.sent).toHaveLength(1);
    // Pre-fix this would have fired 3s later; the gateway now gets a full 10s.
    world.clock.advance(9_000);
    await tick();
    expect(world.logger.joined()).not.toContain('register timed out');
    expect(world.client.state).toBe('registering');
    world.clock.advance(2_000);
    await tick();
    expect(world.logger.joined()).toContain('register timed out');
  });

  test('a credential resolved after the connection dropped is discarded, never sent late', async () => {
    let release: (result: ClientCredentialsResult) => void = () => {};
    const provider = new RegisterCredentialProvider({
      requestToken: () => new Promise<ClientCredentialsResult>((resolve) => (release = resolve)),
    });
    const world = makeWorld({ seedIdentity: migratedIdentity(), clientOverrides: { registerCredentials: provider } });
    world.client.start();
    await tick();
    world.wss.last.serverClose('network reset');
    await tick();
    release(issuedToken);
    await tick();
    expect(world.wss.connections[0]!.sent).toHaveLength(0);
    expect(world.logger.joined()).toContain('resolved after the connection moved on');
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

  // d5 (P6): the same guarantee now has to cover TWO more secrets — the
  // distinct OAuth client secret and the short-lived `runner:register` token it
  // buys. Both cross the same code paths as the legacy token, so both are
  // exercised over the full lifecycle rather than asserted in isolation.
  test('NEITHER the OAuth client secret NOR the issued registration token appears in any log line', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    world.client.start();
    await tick();
    expect(world.wss.last.sent[0]!.runner_token).toBe(REGISTER_JWT); // it WAS used
    world.wss.last.serverSend({ type: 'register_reject', reason: 'capacity' });
    await tick();
    world.clock.advance(1_000);
    await tick();
    const register = world.wss.last.sent[0]!;
    world.wss.last.serverSend({ type: 'register_ack', id: register.id, protocol_version: 1, runner_id: 'r-1', heartbeat_interval_s: 5 });
    world.clock.advance(5_000);
    world.wss.last.serverClose('flap');
    world.clock.advance(1_000);
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'revoked' });
    await tick();
    world.clock.advance(1_000);
    await tick();
    world.wss.last.serverSend({ type: 'register_reject', reason: 'revoked' });

    const everything = [world.logger.joined(), world.fatal.join('\n')].join('\n');
    expect(world.logger.lines.length).toBeGreaterThan(5);
    for (const secret of [TOKEN, CLIENT_SECRET, REGISTER_JWT]) {
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(secret.slice(0, 12)); // no prefix leaks
    }
  });

  test('the register FRAME still carries the credential — redaction is a logging rule, not a wire one', async () => {
    const world = makeWorld({
      seedIdentity: migratedIdentity(),
      clientOverrides: { registerCredentials: providerReturning(issuedToken) },
    });
    await goOnline(world);
    expect(world.wss.last.sent[0]!.runner_token).toBe(REGISTER_JWT);
    expect(world.logger.joined()).not.toContain(REGISTER_JWT);
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
