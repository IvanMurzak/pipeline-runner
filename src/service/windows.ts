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

// ── x24 helpers: reading `sc.exe` honestly ──────────────────────────────────

/** `sc.exe` exit code when the caller lacks SERVICE_START/SERVICE_STOP rights. */
const ERROR_ACCESS_DENIED = 5;
/** `sc stop` on a service that is not running. */
const ERROR_SERVICE_NOT_ACTIVE = 1062;
/** `sc start` on a service that is already running. */
const ERROR_SERVICE_ALREADY_RUNNING = 1056;

/** What `sc query` says right now. `'missing'` is distinct from `'unknown'`:
 *  one means the service does not exist, the other that it exists in a state
 *  this parse does not name (both PENDING states land here). */
function queryState(r: { code: number; stdout: string; stderr: string }): 'missing' | 'running' | 'stopped' | 'unknown' {
  if (isMissing(r)) return 'missing';
  if (/\bRUNNING\b/.test(r.stdout)) return 'running';
  if (/\bSTOPPED\b/.test(r.stdout)) return 'stopped';
  return 'unknown';
}

/** START_PENDING / STOP_PENDING — the SCM accepted the request and the
 *  transition is in flight. Genuinely inconclusive, and said as such rather
 *  than rounded to the outcome we were hoping for. */
function isPending(stdout: string): boolean {
  return /\b(START_PENDING|STOP_PENDING)\b/.test(stdout);
}

function isAlreadyRunning(r: { code: number; stdout: string; stderr: string }): boolean {
  return r.code === ERROR_SERVICE_ALREADY_RUNNING || /1056|already running/i.test(`${r.stdout}\n${r.stderr}`);
}

function isNotActive(r: { code: number; stdout: string; stderr: string }): boolean {
  return r.code === ERROR_SERVICE_NOT_ACTIVE || /1062|has not been started/i.test(`${r.stdout}\n${r.stderr}`);
}

/** `sc start` when the launched program never answered the SCM. */
const ERROR_SERVICE_REQUEST_TIMEOUT = 1053;

/**
 * PURE: turn an `sc.exe` exit code into something an operator can act on.
 *
 * A bare `failed (exit 29)` is a dead end: the number is a Win32 error the
 * caller has to go and look up, and the two that actually happen here have
 * very different remedies. This is the layer that says which.
 *
 * `1053` is the important one, and it is not a transient fault: it means the
 * program the SCM launched never announced itself as a service, which a Bun
 * script structurally cannot do. The remedy is not "retry" or "run as
 * Administrator" — it is to stop using the SCM for this, which is why the
 * Windows default is now Task Scheduler (`./windows-task.ts`).
 */
export function describeScExitCode(code: number): string | null {
  switch (code) {
    case ERROR_ACCESS_DENIED:
      return 'access denied — this needs an elevated (Administrator) shell';
    case ERROR_SERVICE_REQUEST_TIMEOUT:
      return (
        'the program did not report itself to the Service Control Manager within 30s. ' +
        'A Bun/Node script cannot: only a real service executable can. ' +
        'Use the Task Scheduler backend instead — `pipeline-runner service install` now defaults to it ' +
        '(re-run it to migrate), or keep the SCM behind a wrapper like WinSW/NSSM'
      );
    case ERROR_SERVICE_ALREADY_RUNNING:
      return 'the service is already running';
    case ERROR_SERVICE_NOT_ACTIVE:
      return 'the service is not running';
    case ERROR_SERVICE_DOES_NOT_EXIST:
      return 'no such service — install it first';
    default:
      return null;
  }
}

/** x24: name elevation when — and only when — it is what actually went wrong.
 *  A blanket "try Administrator" on every failure trains people to ignore it.
 *  Now also names the OTHER codes that actually occur — see
 *  {@link describeScExitCode}; before this, `sc.exe` failures surfaced as a
 *  bare exit number and 1053 in particular sent people looking for a
 *  permissions problem that was not there. */
function elevationHint(r: { code: number; stdout: string; stderr: string }, what: string): string {
  const denied = r.code === ERROR_ACCESS_DENIED || /access is denied|\b5\b\s*:\s*access/i.test(`${r.stdout}\n${r.stderr}`);
  if (denied) return `\nhint: ${what} requires an elevated (Administrator) shell.`;
  const described = describeScExitCode(r.code);
  return described === null ? '' : `\nhint: ${described}.`;
}

/** x24: `start`/`restart` against a service the SCM has never heard of. */
function notInstalled(name: string, verb: string): ServiceError {
  return new ServiceError(
    `service '${name}' is not installed — there is nothing to ${verb}.\n` +
      'hint: install it first (`pipeline-runner service install`, which needs an elevated shell), or run a ' +
      'supervisor in the foreground (`pipeline-runner start`).'
  );
}

function winResult(
  action: ServiceResult['action'],
  ctx: ServiceContext,
  state: ServiceState,
  commands: RanCommand[],
  messages: string[]
): ServiceResult {
  return { action, backend: 'windows', platform: ctx.platform, definitionPath: null, state, commands, messages };
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

  // ── x24: start / stop / restart ───────────────────────────────────────────

  start(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SC, args });
      return ctx.exec.run(SC, args);
    };
    const name = plan.identity.serviceName;

    const before = queryState(run(['query', name]));
    if (before === 'missing') throw notInstalled(name, 'start');
    if (before === 'running') {
      return winResult('start', ctx, 'running', commands, [`service '${name}' is already running — nothing to do`]);
    }

    const started = run(['start', name]);
    if (started.code !== 0) {
      // 1056 = ERROR_SERVICE_ALREADY_RUNNING. It raced us between the query
      // above and here — the end state is the wanted one, so this is success.
      if (isAlreadyRunning(started)) {
        return winResult('start', ctx, 'running', commands, [`service '${name}' was already running — nothing to do`]);
      }
      throw new ServiceError(
        `\`${SC} start ${name}\` failed (exit ${started.code})` +
          `${started.stderr ? `: ${started.stderr.trim()}` : ''}${elevationHint(started, 'starting a service')}`
      );
    }

    // `sc start` returns as soon as the SCM ACCEPTS the request, so its exit
    // code is not evidence the process is up. Re-query and report exactly what
    // was seen — including the genuinely inconclusive START_PENDING, which the
    // wrapper caveat at the top of this file makes a normal outcome here.
    const after = run(['query', name]);
    const state = queryState(after);
    if (state === 'running') {
      return winResult('start', ctx, 'running', commands, [
        `started service '${name}'`,
        `check it: ${SC} query ${name}`,
      ]);
    }
    if (isPending(after.stdout)) {
      return winResult('start', ctx, 'unknown', commands, [
        `requested start of service '${name}'; the SCM reports START_PENDING`,
        `it is not confirmed running yet — check it: ${SC} query ${name}`,
      ]);
    }
    throw new ServiceError(
      `\`${SC} start ${name}\` was accepted but the service is not running (${after.stdout.trim() || 'no state reported'}) — ` +
        'a script-backed service that exits immediately looks exactly like this; see the WinSW/NSSM wrapper caveat, ' +
        `and check the daemon by hand: pipeline-runner start`
    );
  }

  stop(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SC, args });
      return ctx.exec.run(SC, args);
    };
    const name = plan.identity.serviceName;

    const before = queryState(run(['query', name]));
    if (before === 'missing') {
      return winResult('stop', ctx, 'not-installed', commands, [`service '${name}' is not installed — nothing to stop`]);
    }
    if (before === 'stopped') {
      return winResult('stop', ctx, 'stopped', commands, [`service '${name}' is already stopped — nothing to do`]);
    }

    const stopped = run(['stop', name]);
    if (stopped.code !== 0) {
      // 1062 = ERROR_SERVICE_NOT_ACTIVE — it stopped between the query and
      // here. The wanted end state holds, so this is success, not a failure.
      if (isNotActive(stopped)) {
        return winResult('stop', ctx, 'stopped', commands, [`service '${name}' was already stopped — nothing to do`]);
      }
      throw new ServiceError(
        `\`${SC} stop ${name}\` failed (exit ${stopped.code})` +
          `${stopped.stderr ? `: ${stopped.stderr.trim()}` : ''}${elevationHint(stopped, 'stopping a service')}`
      );
    }

    const after = run(['query', name]);
    const state = queryState(after);
    if (state === 'stopped') {
      return winResult('stop', ctx, 'stopped', commands, [
        `stopped service '${name}'`,
        `it is still registered and will start again at boot — \`pipeline-runner service uninstall\` removes it`,
      ]);
    }
    if (isPending(after.stdout)) {
      return winResult('stop', ctx, 'unknown', commands, [
        `requested stop of service '${name}'; the SCM reports STOP_PENDING`,
        `it is not confirmed stopped yet — check it: ${SC} query ${name}`,
      ]);
    }
    throw new ServiceError(
      `\`${SC} stop ${name}\` was accepted but the service is still not stopped ` +
        `(${after.stdout.trim() || 'no state reported'}) — check it: ${SC} query ${name}`
    );
  }

  restart(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const name = plan.identity.serviceName;
    const probe = ctx.exec.run(SC, ['query', name]);
    if (queryState(probe) === 'missing') throw notInstalled(name, 'restart');

    // The SCM has no restart verb, so this is genuinely stop-then-start and is
    // composed out of the two above rather than re-implemented — including
    // their tolerance of "already stopped" and their post-action verification.
    // The probe above is what keeps the composed pair from reporting the
    // not-installed case as `stop`'s benign no-op.
    const stopped = this.stop(plan, ctx);
    const started = this.start(plan, ctx);
    return {
      ...started,
      action: 'restart',
      commands: [{ cmd: SC, args: ['query', name] }, ...stopped.commands, ...started.commands],
      messages: [...stopped.messages, ...started.messages],
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
