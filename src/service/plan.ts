/**
 * The resolved service PLAN — the pure input every generator consumes — plus
 * the helpers that build it deterministically from an injectable env/platform.
 *
 * Keeping the plan pure (fully resolved paths, invocation, environment) is what
 * lets the three generators be pure string-in → string-out functions.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir } from '../core/config';

/** How to run the long-running daemon (the `start` loop from `core`, T1-11). */
export interface AgentInvocation {
  /**
   * Absolute path to the executable to launch — normally the Bun/Node runtime
   * (`process.execPath`), or an installed `pipeline-runner` native binary.
   */
  program: string;
  /**
   * Arguments to `program`. When running from source this is
   * `['<abs>/src/cli.ts', 'start']`; for an installed binary just `['start']`.
   */
  args: string[];
}

/** Names/labels the service is registered under (per-platform conventions). */
export interface ServiceIdentity {
  /** systemd unit basename + Windows service (short) name. */
  serviceName: string;
  /** launchd reverse-DNS Label + plist basename. */
  launchdLabel: string;
  /** Human-facing name (launchd/Windows display, systemd Description prefix). */
  displayName: string;
  /** One-line description. */
  description: string;
}

export const DEFAULT_IDENTITY: ServiceIdentity = {
  serviceName: 'pipeline-runner',
  launchdLabel: 'com.ivanmurzak.pipeline-runner',
  displayName: 'Pipeline Runner',
  description: 'pipeline-runner daemon (cloud-dispatched pipeline runs).',
};

/** The fully-resolved input to a generator. */
export interface ServicePlan {
  identity: ServiceIdentity;
  invocation: AgentInvocation;
  /** Absolute working directory for the service process. */
  workingDirectory: string;
  /** Extra environment for the daemon. NEVER secrets — the token is on disk. */
  environment: Record<string, string>;
  /** Where the daemon's config (incl. the token) lives — for operator context. */
  configDir: string;
}

/** Inputs that shape a plan; all optional so callers/tests override precisely. */
export interface PlanInputs {
  invocation?: AgentInvocation;
  identity?: Partial<ServiceIdentity>;
  workingDirectory?: string;
  environment?: Record<string, string>;
  configDir?: string;
}

/**
 * Resolve how to invoke the daemon. Defaults to the current runtime
 * (`process.execPath`) running THIS package's `src/cli.ts start`, resolved
 * relative to this module so it is correct regardless of the install location.
 * Everything is injectable so tests never depend on the real runtime path.
 */
export function resolveInvocation(
  params: { execPath?: string; entry?: string; command?: string } = {}
): AgentInvocation {
  const program = params.execPath ?? process.execPath;
  const entry = params.entry ?? fileURLToPath(new URL('../cli.ts', import.meta.url));
  const command = params.command ?? 'start';
  return { program, args: [entry, command] };
}

/**
 * Compute the environment to bake into the definition so the daemon resolves
 * the SAME config dir the user registered under. We only ever propagate
 * non-secret locators (`HOME`, `XDG_CONFIG_HOME`) — never the token.
 */
function computeEnvironment(platform: string, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  if (platform === 'win32') return out; // Windows services inherit the machine/user env
  if (env.HOME) out.HOME = env.HOME;
  if (env.XDG_CONFIG_HOME) out.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  return out;
}

/** Build the resolved plan from inputs + an injectable platform/env. */
export function buildServicePlan(
  inputs: PlanInputs,
  platform: string,
  env: Record<string, string | undefined>
): ServicePlan {
  const invocation = inputs.invocation ?? resolveInvocation();
  const configDir = inputs.configDir ?? defaultConfigDir(env, platform);
  const entry = invocation.args[0];
  const workingDirectory =
    inputs.workingDirectory ?? (entry && entry.length > 0 ? dirname(entry) : configDir);
  return {
    identity: { ...DEFAULT_IDENTITY, ...inputs.identity },
    invocation,
    workingDirectory,
    environment: inputs.environment ?? computeEnvironment(platform, env),
    configDir,
  };
}

// ── Path resolvers (injectable env) ──────────────────────────────────────────

/** `$XDG_CONFIG_HOME/systemd/user` (or `$HOME/.config/systemd/user`). */
export function systemdUserDir(env: Record<string, string | undefined>): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'systemd', 'user');
  if (env.HOME) return join(env.HOME, '.config', 'systemd', 'user');
  throw new PathError('cannot resolve systemd user dir: $XDG_CONFIG_HOME and $HOME are both unset');
}

/** `$HOME/Library/LaunchAgents`. */
export function launchAgentsDir(env: Record<string, string | undefined>): string {
  if (env.HOME) return join(env.HOME, 'Library', 'LaunchAgents');
  throw new PathError('cannot resolve LaunchAgents dir: $HOME is unset');
}

/** `$HOME/Library/Logs` — where the launchd agent writes stdout/stderr. */
export function macLogsDir(env: Record<string, string | undefined>): string {
  if (env.HOME) return join(env.HOME, 'Library', 'Logs');
  throw new PathError('cannot resolve Logs dir: $HOME is unset');
}

/** Thrown when a required environment locator is missing. */
export class PathError extends Error {}

// ── Command-line quoting helpers (one correct implementation per target) ─────

/**
 * systemd `ExecStart`/`Environment` value quoting. systemd splits unquoted
 * values on whitespace and supports `"..."` with C-style escapes.
 */
export function systemdQuote(token: string): string {
  if (token.length > 0 && !/[\s"'\\]/.test(token)) return token;
  return `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Escape a string for a plist `<string>` text node (`&`, `<`, `>`). */
export function xmlEscape(token: string): string {
  return token.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Windows `sc.exe` binPath token quoting: wrap in double quotes only when the
 * token contains whitespace (e.g. `C:\Program Files\...`). Windows paths do not
 * contain literal quotes, so no inner escaping is required.
 */
export function winQuote(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token;
}
