/**
 * Windows background backend — Task Scheduler (`schtasks.exe`).
 *
 * WHY THIS EXISTS, and why it is the DEFAULT on Windows rather than an option.
 *
 * The SCM backend (`./windows.ts`) registers `"<bun>" "<cli.ts>" start` as a
 * `WIN32_OWN_PROCESS` service. A native Windows service must connect to the
 * Service Control Manager within 30 seconds and answer its control codes; a
 * Bun script does not, so the SCM waits the full 30s, gives up, and reports
 * the start as failed:
 *
 *     Event 7009: A timeout was reached (30000 milliseconds) while waiting
 *                 for the Pipeline Runner service to connect.
 *     Event 7000: The service did not respond to the start or control
 *                 request in a timely fashion.
 *
 * That module's own header always said so ("A Bun/Node SCRIPT is NOT one …
 * for a production-grade service use a proper wrapper"), but `install` still
 * reported success, and the failure only surfaced later as a service that
 * would not start. Registering something that cannot run is not an install.
 *
 * Task Scheduler runs ORDINARY console programs, which is exactly what the
 * runner is. Three consequences, all of them fixes rather than trade-offs:
 *
 *  1. **No elevation.** A per-user task is created and started by the user who
 *     owns it. `sc.exe start` needs an Administrator shell (exit 5), which
 *     made every restart — including the one after an upgrade — an elevated
 *     ceremony.
 *  2. **It runs as YOU, not LocalSystem.** `sc.exe create` with no `obj=`
 *     defaults to LocalSystem, whose profile is not yours: `bun` lives in
 *     `%USERPROFILE%\.bun`, and the runner's data dir is per-user. That
 *     mismatch is the x22 bug class (the journal read the right path for the
 *     wrong account and rendered `?` for every task). A user task cannot
 *     reproduce it.
 *  3. **Restart-on-failure is native.** `/RI` + `RestartCount` replaces the
 *     `sc failure … actions= restart/5000` stanza.
 *
 * The cost, stated plainly: a per-user task runs AT LOGON, not at boot before
 * anyone signs in. A headless server that must serve while logged out needs a
 * real service — that is what `./windows.ts` remains available for, and
 * `install --service-host scm` selects it.
 *
 * PURE/IMPURE SPLIT mirrors `./windows.ts`: `renderTaskCreateCommand` and
 * `parseTaskState` are pure and unit-tested; only `runTask*` touches the exec
 * seam.
 */

import {
  type RanCommand,
  type ServiceAction,
  type ServiceExecResult,
  type ServiceBackend,
  type ServiceContext,
  ServiceError,
  type ServiceResult,
  type ServiceState,
} from './types';
import { type ServicePlan, winQuote } from './plan';

const SCHTASKS = 'schtasks.exe';

/** `schtasks /Query` exit code when the named task does not exist. */
const ERROR_TASK_DOES_NOT_EXIST = 1;

/**
 * Minutes between restart attempts after a failure, and how many times.
 * Mirrors the SCM backend's `restart/5000` intent; Task Scheduler's minimum
 * restart interval is ONE MINUTE, so this cannot be 5 seconds however much we
 * would like it to be — stated here rather than silently rounded.
 */
const RESTART_INTERVAL_MINUTES = 1;

export interface TaskCreateCommand {
  /** The `/TR` value: the runtime + script + args, quoted for the scheduler. */
  taskRun: string;
  /** Args for the exec seam: `schtasks.exe <these>`. */
  createArgs: string[];
  /** A copy-pasteable command line (for display / docs / --dry-run). */
  commandLine: string;
}

/**
 * PURE: build the `schtasks /Create` invocation for the plan.
 *
 * `/TR` takes the WHOLE command as a single string, so the program and its
 * arguments are quoted individually and joined — the same `winQuote` the SCM
 * backend uses for `binPath=`, for the same reason (paths under
 * `C:\Users\...` routinely contain spaces).
 */
export function renderTaskCreateCommand(plan: ServicePlan): TaskCreateCommand {
  const name = plan.identity.serviceName;
  const taskRun = [plan.invocation.program, ...plan.invocation.args].map(winQuote).join(' ');
  const createArgs = [
    '/Create',
    '/TN',
    name,
    '/TR',
    taskRun,
    // ONLOGON, not ONSTART: an ONSTART task would run as SYSTEM before any
    // profile is loaded, which is the LocalSystem problem this backend exists
    // to avoid.
    '/SC',
    'ONLOGON',
    // Highest available privileges are deliberately NOT requested (`/RL
    // LIMITED` is the default): the runner needs no elevation, and asking for
    // it would put the elevation prompt back into a flow that just lost it.
    '/RL',
    'LIMITED',
    // Overwrite an existing task of the same name — `install` is documented as
    // idempotent, and without this a re-install fails on "already exists".
    '/F',
  ];
  return {
    taskRun,
    createArgs,
    commandLine: `${SCHTASKS} /Create /TN ${winQuote(name)} /TR "${taskRun.replace(/"/g, '\\"')}" /SC ONLOGON /RL LIMITED /F`,
  };
}

/**
 * PURE: read a state out of `schtasks /Query /FO LIST` output.
 *
 * The scheduler reports `Status: Running | Ready | Disabled`. `Ready` means
 * "registered, not currently executing" — which is this backend's `stopped`,
 * NOT an error. A task that has never run and one that finished are both
 * `Ready`, and the distinction does not exist at this layer.
 *
 * Localised Windows installs print localised status words. Rather than guess,
 * an unrecognised word yields `unknown` and the caller says so instead of
 * claiming the task is stopped — the same posture `./windows.ts` takes with
 * `START_PENDING`.
 */
export function parseTaskState(stdout: string): ServiceState {
  const line = stdout.split(/\r?\n/).find((l) => /^\s*Status:/i.test(l));
  if (line === undefined) return 'unknown';
  const value = line.split(':').slice(1).join(':').trim().toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'ready' || value === 'disabled') return 'stopped';
  return 'unknown';
}

/** Does this Task Scheduler output mean "no such task"? */
function isMissingTask(ran: ServiceExecResult): boolean {
  if (ran.code === 0) return false;
  return (
    ran.code === ERROR_TASK_DOES_NOT_EXIST &&
    /cannot find the file specified|does not exist|ERROR: The system cannot find/i.test(
      `${ran.stderr}${ran.stdout}`,
    )
  );
}

function query(plan: ServicePlan, ctx: ServiceContext): { ran: ServiceExecResult; state: ServiceState | 'not-installed' } {
  const ran = ctx.exec.run(SCHTASKS, ['/Query', '/TN', plan.identity.serviceName, '/FO', 'LIST']);
  if (isMissingTask(ran)) return { ran, state: 'not-installed' };
  if (ran.code !== 0) return { ran, state: 'unknown' };
  return { ran, state: parseTaskState(ran.stdout) };
}

function fail(ran: ServiceExecResult, what: string): never {
  const detail = (ran.stderr || ran.stdout || '').trim().split(/\r?\n/)[0] ?? '';
  throw new ServiceError(`${what} failed (exit ${ran.code})${detail ? `: ${detail}` : ''}`);
}

/** A recording runner: every external call lands in `commands`, so a test can
 *  assert what was invoked without owning the fake exec. Same idiom as
 *  `./windows.ts`'s `status`. */
function recorder(ctx: ServiceContext) {
  const commands: RanCommand[] = [];
  return {
    commands,
    run(args: string[]): ServiceExecResult {
      commands.push({ cmd: SCHTASKS, args });
      return ctx.exec.run(SCHTASKS, args);
    },
  };
}

/** Query THROUGH the recorder, so the state read shows up in `commands` too. */
function queryState(
  plan: ServicePlan,
  rec: { run: (args: string[]) => ServiceExecResult },
): ServiceState | 'not-installed' {
  const ran = rec.run(['/Query', '/TN', plan.identity.serviceName, '/FO', 'LIST']);
  if (isMissingTask(ran)) return 'not-installed';
  if (ran.code !== 0) return 'unknown';
  return parseTaskState(ran.stdout);
}

function result(
  action: ServiceAction,
  ctx: ServiceContext,
  rec: { commands: RanCommand[] },
  state: ServiceState | 'not-installed',
  messages: string[],
): ServiceResult {
  return {
    action,
    backend: 'windows-task',
    platform: ctx.platform,
    definitionPath: null,
    state,
    enabled: state !== 'not-installed',
    commands: rec.commands,
    messages,
  };
}

export const windowsTaskBackend: ServiceBackend = {
  id: 'windows-task',

  // No file on disk: the definition lives in the scheduler's own store.
  definitionPath(): string | null {
    return null;
  },

  generate(plan: ServicePlan): string {
    return renderTaskCreateCommand(plan).commandLine;
  },

  install(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    const messages: string[] = [];

    const created = rec.run(renderTaskCreateCommand(plan).createArgs);
    if (created.code !== 0) fail(created, 'schtasks /Create');

    // Restart-on-failure, best effort: `/Create` cannot express it and the task
    // is already useful without it. Reported, never fatal — losing auto-restart
    // is worse than nothing, and far better than rolling back a registration
    // that works.
    const restart = rec.run(['/Change', '/TN', name, '/RI', String(RESTART_INTERVAL_MINUTES)]);
    if (restart.code !== 0) {
      messages.push(
        `warning: registered, but restart-on-failure could not be configured (exit ${restart.code}) — a crashed runner stays down until the next logon`,
      );
    }

    // `install` means RUNNING, not merely registered.
    const started = rec.run(['/Run', '/TN', name]);
    if (started.code !== 0) fail(started, 'schtasks /Run');

    const after = queryState(plan, rec);
    messages.unshift(
      `scheduled task '${name}' installed and started; it starts again at logon, as you, with no elevation`,
    );
    return result('install', ctx, rec, after, messages);
  },

  uninstall(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    if (queryState(plan, rec) === 'not-installed') {
      return result('uninstall', ctx, rec, 'not-installed', [`no scheduled task '${name}' to remove`]);
    }
    rec.run(['/End', '/TN', name]); // best effort — not running is fine
    const deleted = rec.run(['/Delete', '/TN', name, '/F']);
    if (deleted.code !== 0) fail(deleted, 'schtasks /Delete');
    return result('uninstall', ctx, rec, 'not-installed', [`scheduled task '${name}' removed`]);
  },

  status(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    const state = queryState(plan, rec);
    const messages =
      state === 'not-installed'
        ? [`scheduled task '${name}' is not installed`]
        : state === 'running'
          ? [`scheduled task '${name}' is running`]
          : state === 'stopped'
            ? [`scheduled task '${name}' is registered but not running`]
            : [`scheduled task '${name}' is registered; the scheduler reported a status this build does not recognise`];
    return result('status', ctx, rec, state, messages);
  },

  start(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    const before = queryState(plan, rec);
    if (before === 'not-installed') {
      throw new ServiceError(
        `scheduled task '${name}' is not installed — run \`pipeline-runner service install\` first`,
      );
    }
    if (before === 'running') {
      return result('start', ctx, rec, 'running', [`scheduled task '${name}' is already running`]);
    }
    const ran = rec.run(['/Run', '/TN', name]);
    if (ran.code !== 0) fail(ran, 'schtasks /Run');
    const after = queryState(plan, rec);
    // `/Run` returns before the process is necessarily up, so an immediate
    // `Ready` is inconclusive rather than a failure — say so, claim nothing.
    return result(
      'start',
      ctx,
      rec,
      after,
      after === 'running'
        ? [`scheduled task '${name}' started`]
        : [`start requested; the scheduler has not yet reported '${name}' running`],
    );
  },

  stop(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    const before = queryState(plan, rec);
    if (before === 'not-installed') {
      return result('stop', ctx, rec, 'not-installed', [
        `scheduled task '${name}' is not installed — nothing to stop`,
      ]);
    }
    if (before === 'stopped') {
      return result('stop', ctx, rec, 'stopped', [`scheduled task '${name}' is already stopped`]);
    }
    const ran = rec.run(['/End', '/TN', name]);
    if (ran.code !== 0) fail(ran, 'schtasks /End');
    return result('stop', ctx, rec, 'stopped', [`scheduled task '${name}' stopped`]);
  },

  restart(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const rec = recorder(ctx);
    const name = plan.identity.serviceName;
    const before = queryState(plan, rec);
    if (before === 'not-installed') {
      throw new ServiceError(
        `scheduled task '${name}' is not installed — run \`pipeline-runner service install\` first`,
      );
    }
    if (before === 'running') {
      const ended = rec.run(['/End', '/TN', name]);
      if (ended.code !== 0) fail(ended, 'schtasks /End');
    }
    const ran = rec.run(['/Run', '/TN', name]);
    if (ran.code !== 0) fail(ran, 'schtasks /Run');
    const after = queryState(plan, rec);
    return result(
      'restart',
      ctx,
      rec,
      after,
      after === 'running'
        ? [`scheduled task '${name}' restarted`]
        : [`restart requested; the scheduler has not yet reported '${name}' running`],
    );
  },
};
