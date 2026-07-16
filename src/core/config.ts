/**
 * Agent identity/config store.
 *
 * Persists the runner's identity — control-plane base URL, the runner_token
 * (a SECRET), the server-assigned runner_id, labels, capacity, and detected
 * environment versions — as JSON in an OS-appropriate user config dir:
 *
 *   - Windows: `%APPDATA%\pipeline-runner\config.json`
 *   - elsewhere: `$XDG_CONFIG_HOME/pipeline-runner/config.json`
 *     (falling back to `~/.config/pipeline-runner/config.json`)
 *
 * The token IS stored in the file (it is the agent's credential and must
 * survive restarts) but with restrictive permissions where the OS supports
 * them: dir 0o700, file 0o600 (POSIX; on Windows modes are a no-op and the
 * per-user %APPDATA% ACL is the protection). It must NEVER be logged — log
 * only `describeIdentity(...)`, which replaces it with `<redacted>`.
 *
 * Import-inert: importing this module touches nothing on disk; the storage
 * path and the filesystem are both injectable so tests never see the real
 * home dir.
 */

import { join } from 'node:path';
import * as fs from 'node:fs';

/** Keep in sync with `package.json` `version`. */
export const AGENT_VERSION = '0.1.0';

export const CONFIG_DIR_NAME = 'pipeline-runner';
export const CONFIG_FILE_NAME = 'config.json';

/** The placeholder `describeIdentity` substitutes for the runner token. */
export const REDACTED = '<redacted>';

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
  /** Scoped runner token — SECRET. Never log; redact via `describeIdentity`. */
  runner_token: string;
  /** Server-assigned stable id, persisted from `register_ack`. */
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
}

export class ConfigError extends Error {}

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
 * A log-safe view of the identity: the runner token replaced with
 * `<redacted>` (whole-token — no prefix leaks). THIS is what may be logged
 * or printed; the raw identity never is.
 */
export function describeIdentity(identity: AgentIdentity): Record<string, unknown> {
  return { ...identity, runner_token: REDACTED };
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
    if (typeof record.runner_token !== 'string' || record.runner_token.length === 0) {
      throw new ConfigError(`config file is missing runner_token: ${this.path}`);
    }
    return {
      // Tolerant load: unknown extra fields are dropped on the next save, but
      // the fields we own are defaulted so an older file still loads.
      base_url: record.base_url,
      runner_token: record.runner_token,
      runner_id: typeof record.runner_id === 'string' ? record.runner_id : undefined,
      labels: Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [],
      capacity: typeof record.capacity === 'number' ? record.capacity : undefined,
      os: typeof record.os === 'string' ? record.os : detectOs(),
      agent_version: typeof record.agent_version === 'string' ? record.agent_version : AGENT_VERSION,
      cli_version: typeof record.cli_version === 'string' ? record.cli_version : 'unknown',
      plugin_version:
        typeof record.plugin_version === 'string' ? record.plugin_version : record.plugin_version === null ? null : undefined,
      heartbeat_interval_s: typeof record.heartbeat_interval_s === 'number' ? record.heartbeat_interval_s : undefined,
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
