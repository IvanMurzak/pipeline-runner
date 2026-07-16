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
 * `renderWindowsCreateCommand` is PURE (plan → sc.exe create descriptor) and
 * unit-tested directly, including binPath quoting.
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
    return renderWindowsCreateCommand(plan).commandLine;
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
        `check it: sc.exe query ${name}`,
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
