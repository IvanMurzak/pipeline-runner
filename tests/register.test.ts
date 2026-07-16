import { describe, expect, test } from 'bun:test';
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

  test('omits capacity when unset; plugin_version defaults to null', () => {
    const frame = buildRegisterFrame(identity(), 'x');
    expect('capacity' in frame).toBe(false);
    expect(frame.plugin_version).toBeNull();
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
