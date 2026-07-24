/**
 * The resolved service PLAN — the pure input every generator consumes — plus
 * the helpers that build it deterministically from an injectable env/platform.
 *
 * Keeping the plan pure (fully resolved paths, invocation, environment) is what
 * lets the three generators be pure string-in → string-out functions.
 *
 * department-mesh d7 (D17, `07-runtime-contract.md` §2.2): NAMED instances.
 * `PlanInputs.name` pins a service to an instance name — `systemd
 * pipeline-runner@<name>`, a per-label launchd agent, a per-name Windows
 * service (`namedIdentity` below) — and `PlanInputs.home` pins it to an
 * isolated home (`PIPELINE_RUNNER_HOME`), baked into the invocation's argv
 * as `--home <path>` (`resolveInvocation`) so it reaches the daemon on every
 * platform uniformly, including Windows where a service definition cannot
 * carry custom environment variables the way a systemd/launchd unit can.
 * Omitting `name`/`home` reproduces the pre-d7 single default-instance plan
 * byte-for-byte.
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

/** Valid instance names: safe in a systemd unit filename, a launchd
 *  reverse-DNS label segment, an `sc.exe` service name, and a POSIX
 *  filename (launchd's log file names embed it too) — letters, digits,
 *  `-`/`_`, 1-64 chars, must not start with a separator. */
const INSTANCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Thrown by `buildServicePlan` for a `name` that is not safe to embed in a
 *  unit filename / label / service name. */
export class InstanceNameError extends Error {}

/** Validate a `pipeline-runner service --name <name>` instance name. */
export function validateInstanceName(name: string): void {
  if (!INSTANCE_NAME_RE.test(name)) {
    throw new InstanceNameError(
      `invalid instance name '${name}' — use 1-64 letters/digits/hyphens/underscores, starting with a letter or digit`
    );
  }
}

/**
 * Derive a NAMED instance's identity (D17: `systemd pipeline-runner@<name>`,
 * a per-label launchd agent, a per-name Windows service) from the shared
 * default. Validates `name` first (`InstanceNameError`) — a bad name must
 * never reach a unit filename or `sc.exe` argv.
 */
export function namedIdentity(name: string): ServiceIdentity {
  validateInstanceName(name);
  return {
    serviceName: `${DEFAULT_IDENTITY.serviceName}@${name}`,
    launchdLabel: `${DEFAULT_IDENTITY.launchdLabel}.${name}`,
    displayName: `${DEFAULT_IDENTITY.displayName} (${name})`,
    description: `${DEFAULT_IDENTITY.description} [instance: ${name}]`,
  };
}

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
  /** d7 (D17): instance name — derives a NAMED identity (`namedIdentity`)
   *  unless `identity` overrides it explicitly. Omitted ⇒ `DEFAULT_IDENTITY`,
   *  unchanged from before this. */
  name?: string;
  /** d7 (D17): the isolated home (`PIPELINE_RUNNER_HOME`) this named
   *  instance is pinned to — baked into the default invocation's argv
   *  (`resolveInvocation`) and this plan's `configDir`. Ignored when
   *  `invocation`/`configDir` are given explicitly. */
  home?: string;
}

/**
 * Resolve how to invoke the daemon. Defaults to the current runtime
 * (`process.execPath`) running THIS package's `src/cli.ts start`, resolved
 * relative to this module so it is correct regardless of the install location.
 * Everything is injectable so tests never depend on the real runtime path.
 *
 * d7 (D17): `home`, when given, is appended as `--home <path>` — `cli.ts`
 * parses it and sets `PIPELINE_RUNNER_HOME` before anything resolves a
 * config/data/workspace path (see `cli.ts`'s `runStart`). Baking it into
 * argv (rather than relying on environment injection) works uniformly
 * across all three service backends, including Windows, whose `sc.exe`
 * service definitions cannot carry custom environment variables.
 */
export function resolveInvocation(
  params: { execPath?: string; entry?: string; command?: string; home?: string } = {}
): AgentInvocation {
  const program = params.execPath ?? process.execPath;
  const entry = params.entry ?? fileURLToPath(new URL('../cli.ts', import.meta.url));
  const command = params.command ?? 'start';
  const args = [entry, command];
  if (params.home) args.push('--home', params.home);
  return { program, args };
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
  const invocation = inputs.invocation ?? resolveInvocation({ home: inputs.home });
  // d7 (D17): a pinned home roots configDir at `<home>/config` — the exact
  // subpath `defaultConfigDir` (`../core/config.ts`) computes for the same
  // home, kept as a direct join here since the plan already has `home`
  // explicit and this must hold even when the CALLER never sets
  // `PIPELINE_RUNNER_HOME` in `env` (the service definition is what carries
  // the home to the daemon, via `--home` in the invocation above).
  const configDir = inputs.configDir ?? (inputs.home ? join(inputs.home, 'config') : defaultConfigDir(env, platform));
  const entry = invocation.args[0];
  const workingDirectory =
    inputs.workingDirectory ?? (entry && entry.length > 0 ? dirname(entry) : configDir);
  const identity = inputs.name !== undefined ? namedIdentity(inputs.name) : DEFAULT_IDENTITY;
  return {
    identity: { ...identity, ...inputs.identity },
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
