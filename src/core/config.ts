/**
 * Agent identity/config store.
 *
 * Persists the runner's identity — control-plane base URL, its credentials
 * (SECRETS), the server-assigned runner_id, labels, capacity, and detected
 * environment versions — as JSON in an OS-appropriate user config dir:
 *
 *   - Windows: `%APPDATA%\pipeline-runner\config.json`
 *   - elsewhere: `$XDG_CONFIG_HOME/pipeline-runner/config.json`
 *     (falling back to `~/.config/pipeline-runner/config.json`)
 *
 * Credentials ARE stored in the file (they are the agent's credentials and must
 * survive restarts) but with restrictive permissions where the OS supports
 * them: dir 0o700, file 0o600 (POSIX; on Windows modes are a no-op and the
 * per-user %APPDATA% ACL is the protection). They must NEVER be logged — log
 * only `describeIdentity(...)`, which replaces every field named in
 * `SECRET_IDENTITY_FIELDS` with `<redacted>`.
 *
 * department-mesh d5 (P6, `13-mcp-authorization.md` §10.2): a runner may now
 * hold EITHER credential, or both:
 *
 *   - `runner_token` — the legacy plaintext long-lived registration secret,
 *     the only thing every deployed runner has today;
 *   - `oauth_client_secret` — the DISTINCT OAuth client secret issued by
 *     `POST /api/v1/runners/:id/oauth-credentials`, which (with `runner_id` as
 *     the client id) buys short-lived `runner:register` and `mesh:execution`
 *     tokens from `POST /oauth/token`.
 *
 * A migrated runner therefore no longer needs `runner_token` at all, which is
 * why it is optional below. `load()` still refuses a config carrying NEITHER
 * usable credential — that is an unregisterable identity, and failing at load
 * with an actionable message beats failing on the wire.
 *
 * Import-inert: importing this module touches nothing on disk; the storage
 * path and the filesystem are both injectable so tests never see the real
 * home dir.
 *
 * department-mesh d7 (D17, `07-runtime-contract.md` §2.2): `PIPELINE_RUNNER_HOME`
 * roots an ISOLATED instance's config dir (and, via `../shipper/fs.ts`'s
 * `defaultDataDir`, its data dir too), so N runner instances can coexist on
 * one host without ever sharing a config file, job store, spool, or
 * workspace root. Unset ⇒ the OS-default paths above, byte-for-byte
 * unchanged from before this — a single default-home runner behaves exactly
 * as it always has.
 */

import { join } from 'node:path';
import * as fs from 'node:fs';
import type { RunnerCapabilities } from './capabilities';
import { narrowRunnerCapabilities } from './capabilities';

/** Keep in sync with `package.json` `version`. */
export const AGENT_VERSION = '0.1.0';

export const CONFIG_DIR_NAME = 'pipeline-runner';
export const CONFIG_FILE_NAME = 'config.json';

/** Roots an isolated instance's config dir + data dir (D17). See the module
 *  doc above and `../core/home.ts` (the lock + workspace-root resolvers). */
export const PIPELINE_RUNNER_HOME_ENV = 'PIPELINE_RUNNER_HOME';

/**
 * The isolated HOME root, or `null` when `PIPELINE_RUNNER_HOME` is unset (or
 * blank) — the historical single-home default, where `defaultConfigDir`/
 * `defaultDataDir` keep their pre-d7 OS-default paths untouched.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string | null {
  const home = env[PIPELINE_RUNNER_HOME_ENV];
  return home !== undefined && home.trim().length > 0 ? home : null;
}

/** The placeholder `describeIdentity` substitutes for every secret field. */
export const REDACTED = '<redacted>';

/**
 * EVERY secret an `AgentIdentity` can carry. `describeIdentity` redacts exactly
 * this list, and `tests/config.test.ts` asserts the list is exhaustive against
 * a fully-populated identity — so adding a credential field without redacting
 * it fails the suite rather than leaking on the next `pipeline-runner status`.
 */
export const SECRET_IDENTITY_FIELDS = ['runner_token', 'oauth_client_secret'] as const;

/** Directory mode for the config dir (POSIX; ignored on Windows). */
export const CONFIG_DIR_MODE = 0o700;
/** File mode for the config file (POSIX; ignored on Windows). */
export const CONFIG_FILE_MODE = 0o600;

/**
 * The persisted identity. Field names are snake_case to match the wire
 * protocol 1:1 (`buildRegisterFrame` maps them straight across).
 */
export interface AgentIdentity {
  /** Control-plane base URL, e.g. `https://pipeline.example.com`. */
  base_url: string;
  /**
   * The LEGACY plaintext long-lived runner token — SECRET. Never log; redact
   * via `describeIdentity`.
   *
   * d5 (P6): optional. A migrated runner holding `oauth_client_secret` +
   * `runner_id` does not need it, and once the operator retires the legacy
   * credential server-side it should be removed from the file. Every runner
   * deployed before P6 still has one, and keeps using it — the cloud
   * dual-accepts (c15) — so it is optional, never deprecated-and-ignored.
   */
  runner_token?: string;
  /**
   * The DISTINCT OAuth client secret (d5 / c15) — SECRET. Issued once by
   * `POST /api/v1/runners/:id/oauth-credentials` (or at mint) and stored by
   * `pipeline-runner register --client-secret` / `set-credentials`. Paired with
   * `runner_id` as the OAuth `client_id`.
   */
  oauth_client_secret?: string;
  /** Server-assigned stable id, persisted from `register_ack`. ALSO the OAuth
   *  `client_id` for `oauth_client_secret` above (the cloud uses the runner row
   *  id for both). */
  runner_id?: string;
  /** Matchable labels advertised on register. */
  labels: string[];
  /** Max parallel runs this runner will accept. */
  capacity?: number;
  /** Detected OS: "windows" | "linux" | "darwin" (or the raw platform). */
  os: string;
  /** This agent's version. */
  agent_version: string;
  /** Detected `pipeline` CLI version ("unknown" when not detectable). */
  cli_version: string;
  /** Detected Claude-Pipeline plugin version, or null if not installed. */
  plugin_version?: string | null;
  /** Heartbeat cadence adopted from `register_ack`. */
  heartbeat_interval_s?: number;
  /** D17 capability advertisement (`./capabilities.ts`), captured at
   *  `register` time. Optional/omitted for an identity that predates d7 or
   *  was never re-registered — `buildRegisterFrame` simply leaves the
   *  frame's `capabilities` key off in that case, exactly like `capacity`. */
  capabilities?: RunnerCapabilities;
}

export class ConfigError extends Error {}

/** A present, non-empty string, or undefined — the shape every optional
 *  credential/id field is narrowed to on load. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Minimal injectable filesystem — tests use an in-memory implementation. */
export interface ConfigFileSystem {
  /** Returns the file's text, or null if it does not exist. */
  readFileText(path: string): string | null;
  writeFileText(path: string, data: string, mode: number): void;
  mkdirp(path: string, mode: number): void;
  /** Tighten permissions on an existing file (best-effort; no-op on Windows). */
  chmod(path: string, mode: number): void;
}

/** The real filesystem (node:fs sync API — config I/O is rare and tiny). */
export function nodeConfigFs(): ConfigFileSystem {
  return {
    readFileText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    writeFileText: (path, data, mode) => {
      fs.writeFileSync(path, data, { mode });
    },
    mkdirp: (path, mode) => {
      fs.mkdirSync(path, { recursive: true, mode });
    },
    chmod: (path, mode) => {
      try {
        fs.chmodSync(path, mode);
      } catch {
        // Best-effort: Windows has no POSIX modes; %APPDATA% ACLs apply.
      }
    },
  };
}

/**
 * Resolve the OS-appropriate config DIRECTORY from an injectable env +
 * platform (no `os.homedir()` — fully deterministic in tests).
 */
export function defaultConfigDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  // d7 (D17): an isolated home roots this instance's config dir at
  // `<home>/config`, checked BEFORE the OS-default branches below so an
  // unset PIPELINE_RUNNER_HOME leaves every existing path untouched.
  const home = resolveHome(env);
  if (home !== null) return join(home, 'config');
  if (platform === 'win32') {
    const appData = env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);
    if (!appData) throw new ConfigError('cannot determine config directory: %APPDATA% and %USERPROFILE% are both unset');
    return join(appData, CONFIG_DIR_NAME);
  }
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, CONFIG_DIR_NAME);
  if (env.HOME) return join(env.HOME, '.config', CONFIG_DIR_NAME);
  throw new ConfigError('cannot determine config directory: $XDG_CONFIG_HOME and $HOME are both unset');
}

/** Map a Node/Bun platform string to the wire `os` value. */
export function detectOs(platform: string = process.platform): string {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return platform;
}

/**
 * A log-safe view of the identity: every field in `SECRET_IDENTITY_FIELDS`
 * replaced with `<redacted>` (whole value — no prefix leaks). THIS is what may
 * be logged or printed; the raw identity never is.
 *
 * A secret that is ABSENT stays absent rather than becoming `<redacted>` — so
 * `pipeline-runner status` on a migrated runner truthfully shows it holds no
 * legacy token, instead of implying it is hiding one.
 */
export function describeIdentity(identity: AgentIdentity): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...identity };
  for (const field of SECRET_IDENTITY_FIELDS) {
    if (safe[field] !== undefined) safe[field] = REDACTED;
  }
  return safe;
}

export interface ConfigStoreOptions {
  /** Override the config directory (tests, or a --config-dir flag later). */
  dir?: string;
  fs?: ConfigFileSystem;
  env?: Record<string, string | undefined>;
  platform?: string;
}

/**
 * Load/save the agent identity. Construction computes the path only — no I/O
 * until `load`/`save` (import-inert stays true for module consumers).
 */
export class ConfigStore {
  private readonly dir: string;
  private readonly fs: ConfigFileSystem;

  constructor(options: ConfigStoreOptions = {}) {
    this.dir = options.dir ?? defaultConfigDir(options.env, options.platform);
    this.fs = options.fs ?? nodeConfigFs();
  }

  get path(): string {
    return join(this.dir, CONFIG_FILE_NAME);
  }

  /**
   * Load the persisted identity: null when no config exists yet; throws
   * `ConfigError` on a corrupt/invalid file (actionable — re-register).
   */
  load(): AgentIdentity | null {
    const text = this.fs.readFileText(this.path);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ConfigError(`config file is not valid JSON: ${this.path}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`config file is not a JSON object: ${this.path}`);
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.base_url !== 'string' || record.base_url.length === 0) {
      throw new ConfigError(`config file is missing base_url: ${this.path}`);
    }
    const runnerToken = nonEmptyString(record.runner_token);
    const clientSecret = nonEmptyString(record.oauth_client_secret);
    const runnerId = nonEmptyString(record.runner_id);
    // d5 (P6): EITHER credential is enough. The OAuth pair needs `runner_id`
    // too — it is the `client_id` half — so a client secret without one cannot
    // register and does not count. Refusing here (rather than on the wire)
    // keeps the message actionable.
    if (runnerToken === undefined && (clientSecret === undefined || runnerId === undefined)) {
      throw new ConfigError(
        `config file has no usable credential: needs runner_token, or oauth_client_secret + runner_id: ${this.path}`
      );
    }
    return {
      // Tolerant load: unknown extra fields are dropped on the next save, but
      // the fields we own are defaulted so an older file still loads.
      base_url: record.base_url,
      runner_token: runnerToken,
      oauth_client_secret: clientSecret,
      runner_id: runnerId,
      labels: Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [],
      capacity: typeof record.capacity === 'number' ? record.capacity : undefined,
      os: typeof record.os === 'string' ? record.os : detectOs(),
      agent_version: typeof record.agent_version === 'string' ? record.agent_version : AGENT_VERSION,
      cli_version: typeof record.cli_version === 'string' ? record.cli_version : 'unknown',
      plugin_version:
        typeof record.plugin_version === 'string' ? record.plugin_version : record.plugin_version === null ? null : undefined,
      heartbeat_interval_s: typeof record.heartbeat_interval_s === 'number' ? record.heartbeat_interval_s : undefined,
      capabilities: narrowRunnerCapabilities(record.capabilities),
    };
  }

  save(identity: AgentIdentity): void {
    this.fs.mkdirp(this.dir, CONFIG_DIR_MODE);
    this.fs.writeFileText(this.path, JSON.stringify(identity, null, 2) + '\n', CONFIG_FILE_MODE);
    // writeFile's mode only applies on creation — re-tighten existing files.
    this.fs.chmod(this.path, CONFIG_FILE_MODE);
  }

  /** Merge a patch into the stored identity (e.g. persist `runner_id`). */
  update(patch: Partial<AgentIdentity>): AgentIdentity {
    const current = this.load();
    if (current === null) throw new ConfigError('no agent identity configured — run `pipeline-runner register` first');
    const next = { ...current, ...patch };
    this.save(next);
    return next;
  }
}
