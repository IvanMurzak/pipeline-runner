import { describe, expect, test } from 'bun:test';
import { RegisterMessageSchema } from '@baizor/pipeline-protocol';
import type { RunnerCapabilities } from '../src/core/capabilities';
import { ConfigStore, type AgentIdentity } from '../src/core/config';
import { applyRegisterAck, buildRegisterFrame, classifyReject, describeReject } from '../src/core/register';
import { PROTOCOL_VERSION, type RegisterRejectMessage } from '../src/core/wire';
import { MemFs } from './_helpers';

const TOKEN = 'rt_secret-abc';

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    base_url: 'https://cp.example.com',
    runner_token: TOKEN,
    labels: ['os:linux'],
    os: 'linux',
    agent_version: '0.1.0',
    cli_version: '2.0.0',
    ...overrides,
  };
}

describe('buildRegisterFrame', () => {
  test('maps the identity onto the wire shape with the correlation id', () => {
    const frame = buildRegisterFrame(identity({ capacity: 3, plugin_version: '0.9.0' }), 'corr-1');
    expect(frame).toEqual({
      type: 'register',
      id: 'corr-1',
      runner_token: TOKEN,
      labels: ['os:linux'],
      os: 'linux',
      agent_version: '0.1.0',
      cli_version: '2.0.0',
      plugin_version: '0.9.0',
      protocol_version: PROTOCOL_VERSION,
      capacity: 3,
    });
  });

  test('advertises this agent protocol major', () => {
    expect(buildRegisterFrame(identity(), 'x').protocol_version).toBe(1);
  });

  // c4 (P2.5 chat): the a3 `chat_capable` handshake flag. Declared per
  // CONNECTION, never inferred from a version — the cloud (d6) uses it as a
  // hard gate, so a build that ships the code but wires no relay must not
  // claim it.
  describe('chat_capable (c4)', () => {
    test('is omitted entirely when the caller does not declare it', () => {
      expect(buildRegisterFrame(identity(), 'x')).not.toHaveProperty('chat_capable');
      expect(buildRegisterFrame(identity(), 'x', TOKEN, {})).not.toHaveProperty('chat_capable');
    });

    test('is omitted — not sent as false — when the connection is not chat-capable', () => {
      expect(buildRegisterFrame(identity(), 'x', TOKEN, { chatCapable: false })).not.toHaveProperty('chat_capable');
    });

    test('is sent as true when the connection wires the chat relay', () => {
      expect(buildRegisterFrame(identity(), 'x', TOKEN, { chatCapable: true }).chat_capable).toBe(true);
    });

    test('is validated by the protocol schema alongside the rest of the frame', () => {
      const frame = buildRegisterFrame(identity(), 'x', TOKEN, { chatCapable: true });
      expect(RegisterMessageSchema.safeParse(frame).success).toBe(true);
    });
  });

  // department-mesh d5 (P6, 13 §10.2): the SAME wire field carries either
  // credential class — no protocol change, the cloud classifies what arrived.
  describe('P6 credential (d5)', () => {
    test('an explicit credential replaces the legacy token on the frame', () => {
      const frame = buildRegisterFrame(identity(), 'x', 'hdr.pld.sig');
      expect(frame.runner_token).toBe('hdr.pld.sig');
    });

    test('a migrated identity with no legacy token registers with the supplied credential', () => {
      const frame = buildRegisterFrame(identity({ runner_token: undefined }), 'x', 'hdr.pld.sig');
      expect(frame.runner_token).toBe('hdr.pld.sig');
    });

    test('omitting the credential keeps the pre-P6 behaviour exactly', () => {
      expect(buildRegisterFrame(identity(), 'x').runner_token).toBe(TOKEN);
    });

    test('throws when there is nothing at all to present (ConfigStore.load refuses this upstream)', () => {
      expect(() => buildRegisterFrame(identity({ runner_token: undefined }), 'x')).toThrow('no register credential');
    });
  });

  test('omits capacity when unset; plugin_version defaults to null', () => {
    const frame = buildRegisterFrame(identity(), 'x');
    expect('capacity' in frame).toBe(false);
    expect(frame.plugin_version).toBeNull();
  });

  // department-mesh d7 (D17): capability advertisement rides the frame's
  // additive .passthrough() (no typed schema field in protocol 0.4.0 yet —
  // see core/capabilities.ts's PROTOCOL FOLLOW-UP note).
  describe('D17 capability advertisement', () => {
    const caps: RunnerCapabilities = {
      isolation: ['process'],
      gpu: true,
      os: 'linux',
      resources: { cpu_count: 8, total_memory_mb: 16384 },
    };

    test('attaches capabilities when the identity has them', () => {
      const frame = buildRegisterFrame(identity({ capabilities: caps }), 'x');
      expect((frame as unknown as { capabilities?: RunnerCapabilities }).capabilities).toEqual(caps);
    });

    test('omits the key entirely (not null) when the identity predates d7', () => {
      const frame = buildRegisterFrame(identity(), 'x');
      expect('capabilities' in frame).toBe(false);
    });

    test('survives a JSON round-trip untouched (what actually crosses the wire)', () => {
      const frame = buildRegisterFrame(identity({ capabilities: caps }), 'x');
      const roundTripped = JSON.parse(JSON.stringify(frame));
      expect(roundTripped.capabilities).toEqual(caps);
    });
  });
});

describe('classifyReject', () => {
  test('upgrade_required / invalid_token / revoked are fatal — no reconnect loop', () => {
    expect(classifyReject('upgrade_required')).toBe('fatal');
    expect(classifyReject('invalid_token')).toBe('fatal');
    expect(classifyReject('revoked')).toBe('fatal');
  });

  test('capacity is transient (retry with backoff)', () => {
    expect(classifyReject('capacity')).toBe('retryable');
  });

  test('an unknown reason from a newer server is treated as transient', () => {
    expect(classifyReject('maintenance_window')).toBe('retryable');
  });
});

describe('describeReject', () => {
  const reject = (fields: Partial<RegisterRejectMessage>): RegisterRejectMessage =>
    ({ type: 'register_reject', reason: 'capacity', ...fields }) as RegisterRejectMessage;

  test('upgrade_required names the required and spoken protocol versions', () => {
    const message = describeReject(reject({ reason: 'upgrade_required', min_protocol_version: 2 }));
    expect(message).toContain('update the agent');
    expect(message).toContain('v2');
    expect(message).toContain(`v${PROTOCOL_VERSION}`);
  });

  test('invalid_token and revoked point at re-registration', () => {
    expect(describeReject(reject({ reason: 'invalid_token' }))).toContain('pipeline-runner register');
    expect(describeReject(reject({ reason: 'revoked' }))).toContain('revoked');
  });

  test('capacity says it will retry', () => {
    expect(describeReject(reject({ reason: 'capacity' }))).toContain('backoff');
  });

  test('appends the server detail message when present', () => {
    expect(describeReject(reject({ reason: 'capacity', message: 'try later' }))).toContain('try later');
  });
});

describe('applyRegisterAck', () => {
  test('persists runner_id and the heartbeat cadence', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity());
    applyRegisterAck(store, { type: 'register_ack', protocol_version: 1, runner_id: 'r-7', heartbeat_interval_s: 20 });
    const loaded = store.load();
    expect(loaded?.runner_id).toBe('r-7');
    expect(loaded?.heartbeat_interval_s).toBe(20);
  });

  test('leaves the stored cadence alone when the ack does not state one', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity({ heartbeat_interval_s: 45 }));
    applyRegisterAck(store, { type: 'register_ack', protocol_version: 1, runner_id: 'r-7' });
    expect(store.load()?.heartbeat_interval_s).toBe(45);
  });
});
