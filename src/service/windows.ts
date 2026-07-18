/**
 * Windows Service backend (SCM via `sc.exe`).
 *
 * WRAPPER CAVEAT: a native Windows service must be a real service executable
 * that talks to the Service Control Manager (responds to START/STOP control
 * messages). A Bun/Node SCRIPT is NOT one — so `sc.exe create` here registers
 * the RUNTIME wrapping our script (`"<bun>" "<cli.ts>" start`). The SCM will
 * launch it and `stop`/`delete` work, but because the process does not
 * acknowledge SCM control codes the "start pending → running" transition can be
 * reported imprecisely and a stop may fall back to a forced terminate. For a
 * production-grade service use a proper wrapper (WinSW / NSSM) or a compiled
 * service host pointed at the same `"<bun>" "<cli.ts>" start` command; this
 * backend generates exactly that invocation so swapping the host is trivial.
 *
 * `sc.exe create ... start= auto` alone configures NO recovery action — the SCM
 * never restarts a crashed service (review B P0: "daemon restarts
 * automatically" was false as shipped). `install` additionally runs
 * `sc.exe failure <name> reset= 86400 actions= restart/5000` right after
 * `create` succeeds, so a crash restarts the process 5s later.
 *
 * `renderWindowsCreateCommand`/`renderWindowsFailureCommand` are PURE (plan →
 * sc.exe descriptor) and unit-tested directly, including binPath quoting.
 */

import {
  type RanCommand,
  type ServiceBackend,
  type ServiceContext,
  ServiceError,
  type ServiceResult,
  type ServiceState,
} from './types';
import { type ServicePlan, winQuote } from './plan';

const SC = 'sc.exe';
/** `sc query`/`qc` exit code when the service does not exist. */
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
/** `sc failure` reset window (seconds): failure count resets after this much uptime. */
const FAILURE_RESET_SECONDS = '86400';
/** `sc failure` action: restart, 5000ms after the crash. */
const FAILURE_ACTIONS = 'restart/5000';

/** The `sc.exe create` invocation, fully resolved (pure). */
export interface WindowsCreateCommand {
  /** The `binPath=` value: the runtime + script + args, each quoted as needed. */
  binPath: string;
  /** Args for the exec seam: `sc.exe <these>`. */
  createArgs: string[];
  /** Args for `sc.exe description <name> <desc>`. */
  descriptionArgs: string[];
  /** A copy-pasteable command line (for display / docs / --dry-run). */
  commandLine: string;
}

/** PURE: build the `sc.exe create` command for the plan (binPath quoting incl.). */
export function renderWindowsCreateCommand(plan: ServicePlan): WindowsCreateCommand {
  const name = plan.identity.serviceName;
  const binPath = [plan.invocation.program, ...plan.invocation.args].map(winQuote).join(' ');
  // sc.exe's quirk: each option is `key=` as its OWN token, value as the NEXT
  // token (the space after `=` is significant). Passed as an argv array the
  // spawn layer keeps them separate, which is exactly what sc.exe wants.
  const createArgs = [
    'create',
    name,
    'binPath=',
    binPath,
    'start=',
    'auto',
    'DisplayName=',
    plan.identity.displayName,
  ];
  const descriptionArgs = ['description', name, plan.identity.description];
  // Copy-pasteable cmd.exe line: the whole binPath value is one quoted argument,
  // so inner quotes are escaped as \" (what sc.exe/CommandLineToArgvW expect).
  const displayBinPath = `"${binPath.replace(/"/g, '\\"')}"`;
  const commandLine =
    `sc.exe create ${name} binPath= ${displayBinPath} start= auto ` +
    `DisplayName= "${plan.identity.displayName}"`;
  return { binPath, createArgs, descriptionArgs, commandLine };
}

/** The `sc.exe failure` invocation, fully resolved (pure). */
export interface WindowsFailureCommand {
  /** Args for the exec seam: `sc.exe <these>`. */
  args: string[];
  /** A copy-pasteable command line (for display / docs / --dry-run). */
  commandLine: string;
}

/**
 * PURE: build the `sc.exe failure` command that configures SCM crash recovery
 * — `reset= 86400` (failure counter resets after a day of uptime) and
 * `actions= restart/5000` (restart 5s after each crash, up to that reset
 * window). Without this the SCM registers NO recovery action for a service
 * created via `sc.exe create ... start= auto` — it starts at boot but never
 * comes back after a crash (review B P0).
 */
export function renderWindowsFailureCommand(name: string): WindowsFailureCommand {
  const args = ['failure', name, 'reset=', FAILURE_RESET_SECONDS, 'actions=', FAILURE_ACTIONS];
  const commandLine = `sc.exe failure ${name} reset= ${FAILURE_RESET_SECONDS} actions= ${FAILURE_ACTIONS}`;
  return { args, commandLine };
}

/** True when an `sc.exe` result indicates the service is not installed. */
function isMissing(r: { code: number; stdout: string; stderr: string }): boolean {
  return (
    r.code === ERROR_SERVICE_DOES_NOT_EXIST ||
    /1060|does not exist|specified service does not exist/i.test(`${r.stdout}\n${r.stderr}`)
  );
}

class WindowsBackend implements ServiceBackend {
  readonly id = 'windows';

  definitionPath(): null {
    return null; // SCM-registered — no on-disk definition file
  }

  generate(plan: ServicePlan): string {
    const create = renderWindowsCreateCommand(plan);
    const failure = renderWindowsFailureCommand(plan.identity.serviceName);
    return `${create.commandLine}\n${failure.commandLine}`;
  }

  install(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SC, args });
      return ctx.exec.run(SC, args);
    };
    const name = plan.identity.serviceName;
    const create = renderWindowsCreateCommand(plan);

    // Idempotent re-install: best-effort stop + delete so `create` overwrites.
    run(['stop', name]);
    run(['delete', name]);

    const created = run(create.createArgs);
    if (created.code !== 0) {
      throw new ServiceError(
        `\`${SC} create ${name}\` failed (exit ${created.code})` +
          `${created.stderr ? `: ${created.stderr.trim()}` : ''}` +
          '\nhint: creating a service requires an elevated (Administrator) shell.'
      );
    }

    // Configure crash recovery — without this the SCM never restarts a
    // crashed service (review B P0: "daemon restarts automatically" was false
    // as shipped). Same SERVICE_CHANGE_CONFIG privilege as `create` above,
    // which just succeeded, so a failure here is treated as hard (not
    // best-effort like description/start below) — it should not happen if
    // `create` did, and if it somehow does we want the operator to know the
    // recovery guarantee is NOT in place rather than silently proceeding.
    const failureCmd = renderWindowsFailureCommand(name);
    const failure = run(failureCmd.args);
    if (failure.code !== 0) {
      throw new ServiceError(
        `\`${failureCmd.commandLine}\` failed (exit ${failure.code})` +
          `${failure.stderr ? `: ${failure.stderr.trim()}` : ''}` +
          '\nhint: configuring failure actions requires an elevated (Administrator) shell.'
      );
    }

    run(create.descriptionArgs); // best-effort — cosmetic
    run(['start', name]); // best-effort — see the wrapper caveat above

    return {
      action: 'install',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: null,
      commands,
      messages: [
        `created Windows service '${name}' (start= auto)`,
        `binPath: ${create.binPath}`,
        `configured crash recovery: restart 5s after failure (counter resets after ${FAILURE_RESET_SECONDS}s uptime)`,
        `check it: sc.exe query ${name}`,
        `check recovery config: sc.exe qfailure ${name}`,
        'note: script-backed service — see the WinSW/NSSM wrapper caveat for production.',
      ],
    };
  }

  uninstall(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SC, args });
      return ctx.exec.run(SC, args);
    };
    const name = plan.identity.serviceName;

    run(['stop', name]); // best-effort — may already be stopped
    const deleted = run(['delete', name]);
    if (deleted.code !== 0 && !isMissing(deleted)) {
      throw new ServiceError(
        `\`${SC} delete ${name}\` failed (exit ${deleted.code})` +
          `${deleted.stderr ? `: ${deleted.stderr.trim()}` : ''}` +
          '\nhint: deleting a service requires an elevated (Administrator) shell.'
      );
    }

    return {
      action: 'uninstall',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: null,
      commands,
      messages: [`deleted Windows service '${name}'`],
    };
  }

  status(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SC, args });
      return ctx.exec.run(SC, args);
    };
    const name = plan.identity.serviceName;

    const query = run(['query', name]);
    if (isMissing(query)) {
      return {
        action: 'status',
        backend: this.id,
        platform: ctx.platform,
        definitionPath: null,
        state: 'not-installed',
        enabled: false,
        commands,
        messages: [`service '${name}' is not installed`],
      };
    }

    let state: ServiceState = 'unknown';
    if (/\bRUNNING\b/.test(query.stdout)) state = 'running';
    else if (/\bSTOPPED\b/.test(query.stdout)) state = 'stopped';

    // START_TYPE lives in `sc qc`; AUTO_START ⇒ starts at boot.
    const config = run(['qc', name]);
    const enabled = /AUTO_START/.test(config.stdout);

    return {
      action: 'status',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: null,
      state,
      enabled,
      commands,
      messages: [`service '${name}': ${state} (${enabled ? 'auto-start' : 'manual/disabled'})`],
    };
  }
}

export function createWindowsBackend(): ServiceBackend {
  return new WindowsBackend();
}
