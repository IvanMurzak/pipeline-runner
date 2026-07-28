/**
 * Shared types + injectable seams for `pipeline-runner service ...`.
 *
 * The whole point of this module is TESTABILITY: every system-mutating action
 * (spawning `systemctl`/`launchctl`/`sc.exe`, writing unit/plist files) sits
 * behind one of two seams — `ServiceExec` and `ServiceFs` — so tests can inject
 * a fake exec that records the exact command sequence and a mem-fs that records
 * file paths + contents, and assert on both WITHOUT touching the real machine.
 *
 * The generated service DEFINITIONS never contain secrets: the runner token is
 * loaded by the daemon itself from the config file (see `core/config.ts`) at
 * runtime. A unit/plist only references how to RUN the daemon.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { Logger } from '../core/log';
import type { ServicePlan } from './plan';

/** Actionable, non-crashing failure surfaced by any service action. */
export class ServiceError extends Error {}

/** Result of running one external command through the exec seam. */
export interface ServiceExecResult {
  /** Process exit code (127 when the binary is missing; 1 on spawn error). */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable process-spawn seam. `run` is SYNCHRONOUS — service actions are
 * rare, one-shot, and easier to reason about (and to fake) sequentially.
 */
export interface ServiceExec {
  run(cmd: string, args: string[]): ServiceExecResult;
}

/**
 * Injectable filesystem seam for unit/plist files. Deliberately smaller than
 * core's `ConfigFileSystem`: no POSIX modes (definitions are not secrets) but
 * with `removeFile`/`exists` which install/uninstall/status need.
 */
export interface ServiceFs {
  writeFileText(path: string, data: string): void;
  /** Returns the file's text, or null if it does not exist. */
  readFileText(path: string): string | null;
  /** Idempotent: removing a missing file is a no-op (never throws ENOENT). */
  removeFile(path: string): void;
  mkdirp(path: string): void;
  exists(path: string): boolean;
}

/** A command that a backend ran (or would run), in order — handy for tests. */
export interface RanCommand {
  cmd: string;
  args: string[];
}

/**
 * Coarse service state parsed from a backend's status query.
 *
 * DELIBERATELY UNCHANGED by x24, which added the `start`/`stop`/`restart`
 * verbs: a `status` message's shape is a cross-package contract the `pipeline`
 * CLI parses (`department-serve.ts`'s `parseRunnerServiceState`, matching
 * `/:\s*(running|stopped|unknown)\s*\(/`), so a fifth word here would break a
 * shipped consumer to describe a transient. The SCM's `START_PENDING` /
 * `STOP_PENDING` therefore stay `'unknown'` — which is what they already
 * were — and the new verbs say what they saw in their own message lines
 * instead of inventing a state for it.
 */
export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export type ServiceAction = 'install' | 'uninstall' | 'status' | 'start' | 'stop' | 'restart';

/** Structured outcome of a service action. */
export interface ServiceResult {
  action: ServiceAction;
  /** Backend id: 'systemd' | 'launchd' | 'windows'. */
  backend: string;
  /** The raw platform the backend was selected for. */
  platform: string;
  /** Path of the definition written/removed (null for Windows/SCM). */
  definitionPath?: string | null;
  /** Populated by `status`. */
  state?: ServiceState;
  /** Whether the service is enabled to start at boot/login (best-effort). */
  enabled?: boolean;
  /** External commands run, in order — assertable without the fake exec. */
  commands: RanCommand[];
  /** Human-readable summary lines (the CLI prints these). */
  messages: string[];
}

/** Everything a backend needs at runtime, all injectable. */
export interface ServiceContext {
  fs: ServiceFs;
  exec: ServiceExec;
  logger: Logger;
  env: Record<string, string | undefined>;
  platform: string;
}

/**
 * A per-platform backend. Generators are pure and exposed as standalone
 * functions in each backend module (unit-tested directly); this interface is
 * the imperative install/uninstall/status surface the orchestrator drives.
 */
export interface ServiceBackend {
  /** 'systemd' | 'launchd' | 'windows'. */
  readonly id: string;
  /** Absolute path of the definition file, or null when there is none (SCM). */
  definitionPath(plan: ServicePlan, ctx: ServiceContext): string | null;
  /** The exact definition text (unit/plist), or the create command line (win). */
  generate(plan: ServicePlan, ctx: ServiceContext): string;
  install(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
  uninstall(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
  status(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
  /**
   * x24 — the three verbs that were missing, and the rules all three backends
   * keep. Before this, the ONLY path from `stopped` back to `running` was
   * `service install`, which stop+deletes+recreates the service and needs
   * elevation on Windows; `x13` had meanwhile taught `pipeline department
   * serve` to correctly REPORT a stopped supervisor, so the product could name
   * the problem and had no clean command to name as the fix.
   *
   * The awkward states, and what each verb owes them:
   *
   *  - **Not installed.** `start`/`restart` THROW `ServiceError` — the desired
   *    end state (running) was not reached, so exiting 0 would be a success
   *    line with nothing behind it — and the message names `service install`.
   *    `stop` returns SUCCESS with `state: 'not-installed'`: its desired end
   *    state (not running) is already true, and `cli.ts`'s `unbind` sets the
   *    precedent ("was not bound — nothing to do").
   *  - **Already in the target state.** Success, `state` set, and the message
   *    says "already", never "started"/"stopped". Idempotent, and honest about
   *    having done nothing.
   *  - **Insufficient privilege.** Detected from the backend's own exit
   *    code/stderr and re-thrown with the remedy named (an elevated shell on
   *    Windows; the logind/lingering hint on systemd).
   *  - **Command succeeded, service did not.** Every verb RE-QUERIES the state
   *    afterwards and throws when the observation contradicts the exit code.
   *    Where the observation is legitimately inconclusive — the SCM's
   *    `START_PENDING`, launchd not having reported a pid yet — it says that
   *    in words and claims nothing more.
   */
  start(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
  stop(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
  restart(plan: ServicePlan, ctx: ServiceContext): ServiceResult;
}

// ── Real seam implementations (node/bun stdlib only) ─────────────────────────

/** The real process spawner. Errors are mapped to a non-zero `code`. */
export function nodeServiceExec(): ServiceExec {
  return {
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
      if (r.error) {
        const code = (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1;
        return { code, stdout: '', stderr: r.error.message };
      }
      return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

/** The real filesystem (node:fs sync API — service I/O is rare and tiny). */
export function nodeServiceFs(): ServiceFs {
  return {
    writeFileText: (path, data) => {
      fs.writeFileSync(path, data);
    },
    readFileText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    removeFile: (path) => {
      fs.rmSync(path, { force: true });
    },
    mkdirp: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    exists: (path) => fs.existsSync(path),
  };
}
