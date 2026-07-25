import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { RunnerCapabilities } from '../src/core/capabilities';
import {
  AGENT_VERSION,
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  ConfigError,
  ConfigStore,
  defaultConfigDir,
  describeIdentity,
  detectOs,
  PIPELINE_RUNNER_HOME_ENV,
  REDACTED,
  resolveHome,
  SECRET_IDENTITY_FIELDS,
  type AgentIdentity,
} from '../src/core/config';
import { MemFs } from './_helpers';

const TOKEN = 'rt_super-secret-token-9f8e7d';
/** d5 (P6): the DISTINCT OAuth client secret (c15) — a second credential the
 *  identity may carry, and a second thing that must never be logged. */
const CLIENT_SECRET = 'rcs_distinct-client-secret-1a2b3c';
const RUNNER_ID = 'run_9c1f';

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

  // ── department-mesh d5 (P6, 13 §10.2): a runner may hold EITHER credential ──

  test('save → load round-trips the OAuth client secret alongside the legacy token', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity({ oauth_client_secret: CLIENT_SECRET, runner_id: RUNNER_ID }));
    const loaded = store.load();
    expect(loaded?.oauth_client_secret).toBe(CLIENT_SECRET);
    expect(loaded?.runner_id).toBe(RUNNER_ID);
    expect(loaded?.runner_token).toBe(TOKEN);
  });

  test('a MIGRATED identity loads with no runner_token at all (DoD: no longer required)', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    fs.writeFileText(
      store.path,
      JSON.stringify({ base_url: 'https://x', oauth_client_secret: CLIENT_SECRET, runner_id: RUNNER_ID }),
      0o600
    );
    const loaded = store.load();
    expect(loaded?.runner_token).toBeUndefined();
    expect(loaded?.oauth_client_secret).toBe(CLIENT_SECRET);
  });

  test('a client secret WITHOUT a runner_id is not a usable credential — it has no client_id', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    fs.writeFileText(store.path, JSON.stringify({ base_url: 'https://x', oauth_client_secret: CLIENT_SECRET }), 0o600);
    expect(() => store.load()).toThrow(ConfigError);
  });

  test('an EMPTY-string credential counts as absent, not as a credential', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    fs.writeFileText(store.path, JSON.stringify({ base_url: 'https://x', runner_token: '', oauth_client_secret: '' }), 0o600);
    expect(() => store.load()).toThrow(ConfigError);
  });

  test('a pre-P6 config (legacy token only) still loads unchanged', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity());
    const loaded = store.load();
    expect(loaded?.runner_token).toBe(TOKEN);
    expect(loaded?.oauth_client_secret).toBeUndefined();
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

  // department-mesh d7 (D17): capability advertisement round-trips through
  // save/load like every other field; absent when never set (a pre-d7
  // identity, or one saved before this field existed).
  test('save → load round-trips the D17 capabilities object', () => {
    const caps: RunnerCapabilities = {
      isolation: ['process'],
      gpu: true,
      os: 'linux',
      resources: { cpu_count: 8, total_memory_mb: 16384 },
    };
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity({ capabilities: caps }));
    expect(store.load()?.capabilities).toEqual(caps);
  });

  test('capabilities is undefined for an identity that never set it (pre-d7)', () => {
    const fs = new MemFs();
    const store = new ConfigStore({ dir: 'cfg', fs });
    store.save(identity());
    expect(store.load()?.capabilities).toBeUndefined();
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

  // d5 (P6): the second credential gets the same treatment. Iterating
  // SECRET_IDENTITY_FIELDS alone would NOT be a guarantee — a new credential
  // field added without touching the list keeps every such assertion green
  // while `status` prints it in the clear. So the fixture below is typed
  // `Required<AgentIdentity>` (adding any field to the interface fails `tsc`
  // until it is named here) and the test then insists every key of that
  // fixture is classified as either a secret or explicitly non-secret.
  const NON_SECRET_IDENTITY_FIELDS = [
    'base_url',
    'runner_id',
    'labels',
    'capacity',
    'os',
    'agent_version',
    'cli_version',
    'plugin_version',
    'heartbeat_interval_s',
    'capabilities',
  ] as const;

  const fullyPopulated: Required<AgentIdentity> = {
    base_url: 'https://cp.example.com',
    runner_token: TOKEN,
    oauth_client_secret: CLIENT_SECRET,
    runner_id: RUNNER_ID,
    labels: ['os:windows'],
    capacity: 2,
    os: 'windows',
    agent_version: AGENT_VERSION,
    cli_version: '1.2.3',
    plugin_version: null,
    heartbeat_interval_s: 30,
    capabilities: { isolation: ['process'], gpu: false, os: 'windows', resources: { cpu_count: 8, total_memory_mb: 16384 } },
  };

  test('every field of a fully-populated identity is classified secret or non-secret', () => {
    const classified = new Set<string>([...SECRET_IDENTITY_FIELDS, ...NON_SECRET_IDENTITY_FIELDS]);
    const unclassified = Object.keys(fullyPopulated).filter((key) => !classified.has(key));
    // A new AgentIdentity field lands here. If it holds a credential it must be
    // added to SECRET_IDENTITY_FIELDS; if not, to the allowlist above — but it
    // cannot be silently forgotten and then printed by `status`.
    expect(unclassified).toEqual([]);
    // …and the allowlist cannot be used to smuggle a known secret out.
    for (const field of SECRET_IDENTITY_FIELDS) {
      expect(NON_SECRET_IDENTITY_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  test('redacts every field named in SECRET_IDENTITY_FIELDS, and nothing else', () => {
    const safe = describeIdentity(fullyPopulated);
    for (const field of SECRET_IDENTITY_FIELDS) {
      expect(safe[field]).toBe(REDACTED);
    }
    for (const field of NON_SECRET_IDENTITY_FIELDS) {
      expect(safe[field]).toEqual(fullyPopulated[field]); // untouched
    }
  });

  test('no value of any secret field survives serialization of the full identity', () => {
    const serialized = JSON.stringify(describeIdentity(fullyPopulated));
    for (const field of SECRET_IDENTITY_FIELDS) {
      const secret = fullyPopulated[field];
      expect(typeof secret).toBe('string');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secret.slice(0, 8));
    }
  });

  test('no secret value (or prefix) survives serialization', () => {
    const serialized = JSON.stringify(describeIdentity(identity({ oauth_client_secret: CLIENT_SECRET })));
    for (const secret of [TOKEN, CLIENT_SECRET]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secret.slice(0, 8));
    }
  });

  test('an ABSENT secret stays absent rather than being reported as redacted', () => {
    // `status` on a migrated runner must show truthfully that it holds no
    // legacy token, not imply it is hiding one.
    const safe = describeIdentity(identity({ runner_token: undefined, oauth_client_secret: CLIENT_SECRET, runner_id: RUNNER_ID }));
    expect(safe.runner_token).toBeUndefined();
    expect(safe.oauth_client_secret).toBe(REDACTED);
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

  // department-mesh d7 (D17): PIPELINE_RUNNER_HOME roots an isolated
  // instance's config dir at <home>/config, checked BEFORE every OS-default
  // branch above — those existing tests (unchanged) prove the unset case is
  // byte-identical to before this.
  test('PIPELINE_RUNNER_HOME roots config dir at <home>/config, on every platform', () => {
    expect(defaultConfigDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux')).toBe(join('/srv/runner-a', 'config'));
    expect(defaultConfigDir({ PIPELINE_RUNNER_HOME: 'C:\\homes\\a' }, 'win32')).toBe(join('C:\\homes\\a', 'config'));
  });

  test('PIPELINE_RUNNER_HOME wins even when the OS-default env vars are ALSO set', () => {
    const dir = defaultConfigDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a', XDG_CONFIG_HOME: '/home/u/.cfg', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/srv/runner-a', 'config'));
  });

  test('a blank PIPELINE_RUNNER_HOME is treated as unset', () => {
    const dir = defaultConfigDir({ PIPELINE_RUNNER_HOME: '   ', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u', '.config', 'pipeline-runner'));
  });

  test('two different homes never collide', () => {
    const a = defaultConfigDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux');
    const b = defaultConfigDir({ PIPELINE_RUNNER_HOME: '/srv/runner-b' }, 'linux');
    expect(a).not.toBe(b);
  });
});

describe('resolveHome', () => {
  test('null when unset/blank; the configured path otherwise', () => {
    expect(resolveHome({})).toBeNull();
    expect(resolveHome({ [PIPELINE_RUNNER_HOME_ENV]: '' })).toBeNull();
    expect(resolveHome({ [PIPELINE_RUNNER_HOME_ENV]: '/srv/runner-a' })).toBe('/srv/runner-a');
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
