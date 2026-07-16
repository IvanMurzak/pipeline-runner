import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  AGENT_VERSION,
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  ConfigError,
  ConfigStore,
  defaultConfigDir,
  describeIdentity,
  detectOs,
  REDACTED,
  type AgentIdentity,
} from '../src/core/config';
import { MemFs } from './_helpers';

const TOKEN = 'rt_super-secret-token-9f8e7d';

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    base_url: 'https://cp.example.com',
    runner_token: TOKEN,
    labels: ['os:windows', 'gpu'],
    os: 'windows',
    agent_version: AGENT_VERSION,
    cli_version: '1.2.3',
    plugin_version: null,
    capacity: 2,
    ...overrides,
  };
}

describe('ConfigStore', () => {
  test('save → load roundtrips the identity', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity());
    expect(store.load()).toEqual(identity());
  });

  test('load returns null when no config exists', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    expect(store.load()).toBeNull();
  });

  test('update persists a patch (runner_id from register_ack)', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity());
    store.update({ runner_id: 'r-42', heartbeat_interval_s: 15 });
    const loaded = store.load();
    expect(loaded?.runner_id).toBe('r-42');
    expect(loaded?.heartbeat_interval_s).toBe(15);
    expect(loaded?.runner_token).toBe(TOKEN); // untouched
  });

  test('update without an existing config throws ConfigError', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    expect(() => store.update({ runner_id: 'r-1' })).toThrow(ConfigError);
  });

  test('corrupt JSON throws ConfigError', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    fs.writeFileText(store.path, '{not json', 0o600);
    expect(() => store.load()).toThrow(ConfigError);
  });

  test('missing runner_token throws ConfigError', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    fs.writeFileText(store.path, JSON.stringify({ base_url: 'https://x' }), 0o600);
    expect(() => store.load()).toThrow(ConfigError);
  });

  test('writes with restrictive modes: dir 0o700, file 0o600', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity());
    expect(fs.dirs.get('cfg')).toBe(CONFIG_DIR_MODE);
    expect(fs.files.get(store.path)?.mode).toBe(CONFIG_FILE_MODE);
    expect(CONFIG_DIR_MODE).toBe(0o700);
    expect(CONFIG_FILE_MODE).toBe(0o600);
  });

  test('the file persists the token (it is the credential) — but only the file', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity());
    expect(fs.files.get(store.path)?.data).toContain(TOKEN);
  });
});

describe('describeIdentity (log-safe view)', () => {
  test('replaces the whole token — no prefix leaks', () => {
    const safe = describeIdentity(identity());
    expect(safe.runner_token).toBe(REDACTED);
    expect(JSON.stringify(safe)).not.toContain(TOKEN);
    expect(JSON.stringify(safe)).not.toContain(TOKEN.slice(0, 8));
    expect(safe.base_url).toBe('https://cp.example.com'); // everything else intact
  });
});

describe('defaultConfigDir', () => {
  test('win32 uses %APPDATA%', () => {
    const dir = defaultConfigDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32');
    expect(dir).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'pipeline-runner'));
  });

  test('win32 falls back to %USERPROFILE%\\AppData\\Roaming', () => {
    const dir = defaultConfigDir({ USERPROFILE: 'C:\\Users\\u' }, 'win32');
    expect(dir).toBe(join('C:\\Users\\u', 'AppData', 'Roaming', 'pipeline-runner'));
  });

  test('POSIX prefers $XDG_CONFIG_HOME', () => {
    const dir = defaultConfigDir({ XDG_CONFIG_HOME: '/home/u/.cfg', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u/.cfg', 'pipeline-runner'));
  });

  test('POSIX falls back to ~/.config', () => {
    const dir = defaultConfigDir({ HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u', '.config', 'pipeline-runner'));
  });

  test('throws ConfigError when nothing is resolvable', () => {
    expect(() => defaultConfigDir({}, 'linux')).toThrow(ConfigError);
    expect(() => defaultConfigDir({}, 'win32')).toThrow(ConfigError);
  });
});

describe('detectOs', () => {
  test('maps platforms to wire os values', () => {
    expect(detectOs('win32')).toBe('windows');
    expect(detectOs('darwin')).toBe('darwin');
    expect(detectOs('linux')).toBe('linux');
    expect(detectOs('freebsd')).toBe('freebsd'); // raw passthrough
  });
});
