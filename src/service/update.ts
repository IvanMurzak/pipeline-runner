/**
 * `pipeline-runner update` — install a newer package, then bring the running
 * runner onto it.
 *
 * THE PROBLEM THIS SOLVES. `bun add -g @baizor/pipeline-runner` rewrites files
 * on disk; it does not touch a process that is already running. Bun reads the
 * TypeScript at startup, so a live runner keeps executing the OLD code with the
 * NEW files underneath it — indistinguishable from being up to date, right up
 * until you wonder why a fix you shipped is not behaving. That is precisely
 * how the 2026-08-01 `ROLE_AGENT` fix reached a machine and did nothing.
 *
 * WHY THE DYING PROCESS DOES NOT RESTART ITSELF. The restart is delegated to
 * whatever supervises the runner — the scheduler, systemd, launchd. A process
 * that re-execs itself has to outlive its own replacement long enough to spawn
 * it, and on Windows a service host would see that exit as a crash and race its
 * own recovery action against the new process. Asking the supervisor is both
 * simpler and the only version that is correct under a supervisor.
 *
 * NOT RUN AS A SERVICE. Then there is nothing to ask, and this command says so
 * and stops rather than killing a foreground process the operator is watching.
 * The files are updated either way; only the restart is skipped.
 *
 * SELF-UPDATE HAZARD, stated because it is real: the package this command
 * lives in is the package it replaces. The install step therefore runs FIRST
 * and completely, and the restart is a separate delegated call — this module
 * never holds a file handle into its own install tree across the swap.
 */

import { consoleLogger, type Logger } from '../core/log';
import { restartService, serviceStatus } from './index';
import { ServiceError, nodeServiceExec, type ServiceExec } from './types';

/** The npm package this runner ships as. */
export const PACKAGE_NAME = '@baizor/pipeline-runner';

export interface UpdateOptions {
  /** Version or dist-tag to install. Default `latest`. */
  target?: string;
  /** Print what would happen; install and restart nothing. */
  dryRun?: boolean;
  /** Update the files but leave the running process alone. */
  noRestart?: boolean;
  /** Injected seams (tests). */
  exec?: ServiceExec;
  logger?: Logger;
  platform?: string;
  env?: Record<string, string | undefined>;
  /** The version this process is running, for the before/after report. */
  currentVersion?: string;
}

export interface UpdateOutcome {
  installed: boolean;
  restarted: boolean;
  /** Why the restart did not happen, when it did not. */
  restartSkippedReason?: string;
  from?: string;
  to?: string;
  messages: string[];
}

/** PURE: the install command line for a target. Exported for the dry-run text
 *  and for a test that does not want to guess at argv. */
export function installCommand(target: string): { cmd: string; args: string[] } {
  return { cmd: 'bun', args: ['add', '-g', `${PACKAGE_NAME}@${target}`] };
}

/**
 * Read the version npm would install, without installing it. Used only for the
 * before/after line — a failure here is cosmetic and never blocks the update.
 */
function resolveTargetVersion(exec: ServiceExec, target: string): string | undefined {
  const r = exec.run('npm', ['view', `${PACKAGE_NAME}@${target}`, 'version']);
  if (r.code !== 0) return undefined;
  const v = r.stdout.trim().split(/\s+/).pop();
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
}

export function runUpdate(opts: UpdateOptions = {}): UpdateOutcome {
  const exec = opts.exec ?? nodeServiceExec();
  const logger = opts.logger ?? consoleLogger;
  const target = opts.target ?? 'latest';
  const messages: string[] = [];

  const to = resolveTargetVersion(exec, target);
  const from = opts.currentVersion;
  if (from !== undefined && to !== undefined && from === to) {
    messages.push(`already on ${from} — nothing to install`);
    // Still fall through to the restart: the files can be current while the
    // RUNNING process is not, which is the whole failure mode this command
    // exists for. Skipping here would leave exactly that state unfixable.
  }

  const install = installCommand(target);
  if (opts.dryRun) {
    messages.push(`would run: ${install.cmd} ${install.args.join(' ')}`);
    messages.push('would then ask the service supervisor to restart the runner');
    return { installed: false, restarted: false, from, to, messages };
  }

  let installed = false;
  if (from === undefined || to === undefined || from !== to) {
    const ran = exec.run(install.cmd, install.args);
    if (ran.code !== 0) {
      const detail = (ran.stderr || ran.stdout || '').trim().split(/\r?\n/)[0] ?? '';
      throw new ServiceError(
        `installing ${PACKAGE_NAME}@${target} failed (exit ${ran.code})${detail ? `: ${detail}` : ''}`,
      );
    }
    installed = true;
    messages.push(to ? `installed ${PACKAGE_NAME}@${to}` : `installed ${PACKAGE_NAME}@${target}`);
  }

  if (opts.noRestart) {
    return {
      installed,
      restarted: false,
      restartSkippedReason: '--no-restart was given',
      from,
      to,
      messages: [
        ...messages,
        'the running process still holds the OLD code — restart it to pick this up',
      ],
    };
  }

  // Is anything supervising this runner? `status` answers without mutating.
  const serviceOpts = {
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    logger,
  };
  let installedAsService: boolean;
  try {
    installedAsService = serviceStatus(serviceOpts).state !== 'not-installed';
  } catch (err) {
    // "I could not find out" is NOT "there is no service". Reporting the
    // latter would send the operator to `service install` for a service that
    // may already exist, and hide whatever actually went wrong (an
    // unsupported platform, an unreadable config dir, a broken query).
    const detail = err instanceof Error ? err.message : String(err);
    return {
      installed,
      restarted: false,
      restartSkippedReason: `could not determine whether a service is installed: ${detail}`,
      from,
      to,
      messages: [
        ...messages,
        `could not check for a service supervisor: ${detail}`,
        'the files are updated; restart the runner yourself so it picks up the new code',
      ],
    };
  }

  if (!installedAsService) {
    return {
      installed,
      restarted: false,
      restartSkippedReason: 'the runner is not installed as a service',
      from,
      to,
      messages: [
        ...messages,
        'not running as a service — restart the runner yourself so it picks up the new code',
        '(`pipeline-runner service install` registers it, and then this command can restart it for you)',
      ],
    };
  }

  const restarted = restartService(serviceOpts);
  return {
    installed,
    restarted: true,
    from,
    to,
    messages: [...messages, ...restarted.messages],
  };
}
