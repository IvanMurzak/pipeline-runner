/**
 * `pipeline-runner service ...` — install/uninstall/status the runner daemon as
 * a native OS service, plus a `--dry-run` preview that renders the definition
 * WITHOUT touching the system.
 *
 * Backend selection is by injectable `platform` (default `process.platform`).
 * All system mutation goes through the `ServiceExec` + `ServiceFs` seams, so the
 * public functions below are fully driveable from tests with fakes.
 *
 * Public surface:
 *   - installService / uninstallService / serviceStatus  (structured results)
 *   - startService / stopService / restartService        (x24 — the missing verbs)
 *   - previewService                                     (pure definition preview)
 *   - inspectInstalledService                            (x22 — ./inspect.ts)
 *   - runService(argv)                                   (the CLI dispatcher)
 */

import { consoleLogger, type Logger } from '../core/log';
import { buildServicePlan, type PlanInputs, type ServicePlan } from './plan';
import { createLaunchdBackend } from './launchd';
import { createSystemdBackend } from './systemd';
import { createWindowsBackend } from './windows';
import { windowsTaskBackend } from './windows-task';
import {
  nodeServiceExec,
  nodeServiceFs,
  type ServiceBackend,
  type ServiceContext,
  ServiceError,
  type ServiceExec,
  type ServiceFs,
  type ServiceResult,
} from './types';

export * from './types';
export * from './plan';
// x22: read-only inspection of the INSTALLED definition (where the supervisor
// was told to live, and as whom it runs) — a different question from `status`.
export * from './inspect';
export {
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
  createSystemdBackend,
} from './systemd';
export {
  renderLaunchdPlist,
  launchdPlistName,
  launchdPlistPath,
  createLaunchdBackend,
} from './launchd';
export {
  renderWindowsCreateCommand,
  renderWindowsFailureCommand,
  createWindowsBackend,
  type WindowsCreateCommand,
  type WindowsFailureCommand,
} from './windows';

/** The platforms with a service backend. */
export const SUPPORTED_PLATFORMS = ['linux', 'darwin', 'win32'] as const;

/**
 * Which Windows host to register with. `task` is the DEFAULT and the one that
 * works for the runner; `scm` is the old `sc.exe` service, kept for the one
 * case a scheduled task cannot serve — a headless box that must run while
 * nobody is logged in — and documented as needing elevation.
 *
 * See `./windows-task.ts` for why the default flipped: `sc.exe` registers a
 * Bun script as a `WIN32_OWN_PROCESS`, the SCM waits 30s for a service that
 * will never announce itself, and the start fails (Event 7000/7009). That
 * backend's own header always said a script is not a service; `install`
 * reported success anyway.
 */
export type WindowsServiceHost = 'task' | 'scm';

/** Select the backend for a raw `process.platform` value. */
export function selectBackend(platform: string, windowsHost: WindowsServiceHost = 'task'): ServiceBackend {
  switch (platform) {
    case 'linux':
      return createSystemdBackend();
    case 'darwin':
      return createLaunchdBackend();
    case 'win32':
      return windowsHost === 'scm' ? createWindowsBackend() : windowsTaskBackend;
    default:
      throw new ServiceError(
        `unsupported platform: ${platform} — service install supports ${SUPPORTED_PLATFORMS.join(', ')} ` +
          '(systemd / launchd / Windows Task Scheduler)'
      );
  }
}

/** Options for the service actions; everything is injectable for tests. */
export interface ServiceOptions extends PlanInputs {
  platform?: string;
  env?: Record<string, string | undefined>;
  exec?: ServiceExec;
  fs?: ServiceFs;
  logger?: Logger;
  /** Windows only: which host to register with. Default `task` — see
   *  {@link WindowsServiceHost}. */
  windowsHost?: WindowsServiceHost;
}

function resolve(opts: ServiceOptions): {
  backend: ServiceBackend;
  plan: ServicePlan;
  ctx: ServiceContext;
} {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const backend = selectBackend(platform, opts.windowsHost); // throws on unsupported — never a silent no-op
  const plan = buildServicePlan(opts, platform, env);
  const ctx: ServiceContext = {
    fs: opts.fs ?? nodeServiceFs(),
    exec: opts.exec ?? nodeServiceExec(),
    logger: opts.logger ?? consoleLogger,
    env,
    platform,
  };
  return { backend, plan, ctx };
}

export function installService(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.install(plan, ctx);
}

export function uninstallService(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.uninstall(plan, ctx);
}

export function serviceStatus(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.status(plan, ctx);
}

/**
 * x24 — the three verbs that were missing.
 *
 * Before this, the only route from `stopped` to `running` was `installService`,
 * which stop+deletes+recreates the service (and needs elevation on Windows) to
 * do what `start` does. `x13` had already taught `pipeline department serve` to
 * detect and report a stopped supervisor, so the product could name the problem
 * with no clean command to name as the fix; `department-serve.ts`'s
 * `SUPERVISOR_START_HINT` is literally `pipeline-runner service install` for
 * exactly that reason. See `ServiceBackend.start`'s doc for the rules every
 * backend keeps about the awkward states.
 */
export function startService(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.start(plan, ctx);
}

export function stopService(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.stop(plan, ctx);
}

export function restartService(opts: ServiceOptions = {}): ServiceResult {
  const { backend, plan, ctx } = resolve(opts);
  return backend.restart(plan, ctx);
}

/** Pure preview: the generated definition + its target path. No system touch. */
export interface ServicePreview {
  backend: string;
  platform: string;
  definitionPath: string | null;
  definition: string;
}

export function previewService(opts: ServiceOptions = {}): ServicePreview {
  const { backend, plan, ctx } = resolve(opts);
  return {
    backend: backend.id,
    platform: ctx.platform,
    definitionPath: backend.definitionPath(plan, ctx),
    definition: backend.generate(plan, ctx),
  };
}

// ── CLI dispatcher (routed to from src/cli.ts) ───────────────────────────────

function serviceUsage(): void {
  console.log(
    [
      'usage: pipeline-runner service <install|uninstall|status|start|stop|restart>',
      '                               [--dry-run] [--name <name>] [--home <path>]',
      '                               [--service-host <task|scm>]   (Windows only)',
      '',
      '  install    register + start the runner as an OS service (systemd/launchd/Windows)',
      '  uninstall  stop + deregister the service',
      '  status     report running/enabled state',
      '  start      start the ALREADY-INSTALLED service (no re-registration, no elevation on',
      '             systemd/launchd). Fails if it is not installed; a no-op if already running.',
      '  stop       stop it, keeping it installed. A no-op if not installed or already stopped.',
      '  restart    stop then start it, in one verb.',
      '',
      '  --dry-run       (install) print the generated unit/plist/command; touch nothing',
      '  --name <name>   NAMED instance (D17): systemd pipeline-runner@<name>, a per-label',
      '                  launchd agent, a per-name Windows service. Omit for the single',
      '                  default instance.',
      '  --home <path>   pin this instance to an isolated home (PIPELINE_RUNNER_HOME) — its',
      '                  own config dir, data dir, job-workspace root, and lock file, so it',
      '                  never collides with another instance on the same host.',
      '  --service-host <task|scm>   Windows only. `task` (default) is a per-user scheduled',
      '                  task: no elevation, runs as YOU, starts at logon. `scm` is a real',
      '                  Windows service — it needs an elevated shell and CANNOT start this',
      '                  runner (a Bun script never answers the Service Control Manager);',
      '                  it exists for a headless box that must run while logged out, behind',
      '                  a wrapper. EVERY verb takes it: pass the SAME host you installed',
      '                  with, or you will address the other one.',
    ].join('\n')
  );
}

/** Parse `--name <val>`/`--home <val>` out of the service subcommand's rest
 *  args (positional-friendly, mirrors the pre-existing `--dry-run` check). */
/**
 * ⚠ An UNKNOWN flag is a hard error here, and that is the whole point.
 *
 * `windowsHost` shipped in 0.7.2 as an API option whose CLI flag was never
 * wired up. `service uninstall --service-host scm` therefore parsed as
 * `uninstall` with an ignored argument, ran against the DEFAULT backend, and
 * deleted the caller's scheduled task while they believed they were removing
 * the old SCM service. Silently ignoring a flag makes a command do something
 * other than what it was asked, and a destructive verb is the worst possible
 * place to find that out.
 */
function parseInstanceFlags(rest: string[]): {
  name?: string;
  home?: string;
  windowsHost?: WindowsServiceHost;
} {
  const out: { name?: string; home?: string; windowsHost?: WindowsServiceHost } = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--name' && rest[i + 1] !== undefined) out.name = rest[++i];
    else if (arg === '--home' && rest[i + 1] !== undefined) out.home = rest[++i];
    else if (arg === '--service-host' && rest[i + 1] !== undefined) {
      const value = rest[++i]!;
      if (value !== 'task' && value !== 'scm') {
        throw new ServiceError(`--service-host must be 'task' or 'scm' — got '${value}'`);
      }
      out.windowsHost = value;
    } else if (arg === '--dry-run') continue;
    else if (arg.startsWith('-')) {
      throw new ServiceError(
        `unknown flag '${arg}' — a flag this build does not understand is refused rather than ignored, ` +
          'because ignoring it would run the command against a different target than you asked for',
      );
    }
  }
  return out;
}

/**
 * Handle `pipeline-runner service ...`. Prints outcome lines and exits non-zero
 * on a `ServiceError` (unsupported platform, privilege, session hints, or an
 * unrecognized verb — see the `default` case below) — never crashes with a
 * raw stack.
 */
export function runService(argv: string[]): void {
  const [sub, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  const opts: ServiceOptions = parseInstanceFlags(rest);
  try {
    switch (sub) {
      case 'install': {
        if (dryRun) {
          const preview = previewService(opts);
          console.log(`[pipeline-runner] service preview (${preview.backend}, ${preview.platform})`);
          if (preview.definitionPath) console.log(`[pipeline-runner] path: ${preview.definitionPath}`);
          console.log(preview.definition);
          return;
        }
        printResult(installService(opts));
        return;
      }
      case 'uninstall':
        printResult(uninstallService(opts));
        return;
      case 'status':
        printResult(serviceStatus(opts));
        return;
      // x24: the three verbs `install` was standing in for. Each throws a
      // `ServiceError` (caught below → stderr, exit 1) when it did not reach
      // the state it names, so a caller that only inspects the exit code — the
      // `pipeline` CLI does exactly that — can trust it.
      case 'start':
        printResult(startService(opts));
        return;
      case 'stop':
        printResult(stopService(opts));
        return;
      case 'restart':
        printResult(restartService(opts));
        return;
      // Asking for help is not an error: no verb at all, `--help`, and `-h`
      // all print the usage text and exit 0 — mirrors src/cli.ts's top-level
      // dispatcher.
      case undefined:
      case '--help':
      case '-h':
        serviceUsage();
        return;
      default:
        // x11 (follow-up): a genuinely unrecognized `service` verb is a
        // usage ERROR, not a no-op. This is on the SAME false-success path
        // as the top-level fix — the plugin's `runner-enrol.ts` shells out
        // to `pipeline-runner service install` as `department serve`'s
        // supervisor step and checks the exit code, so a version-skewed
        // runner that predates a verb must fail loudly here too, not print
        // usage to stdout and exit 0.
        throw new ServiceError(`unknown service command '${sub}' — run \`pipeline-runner service --help\` for usage`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline-runner] error: ${message}`);
    process.exit(1);
  }
}

function printResult(result: ServiceResult): void {
  for (const line of result.messages) console.log(`[pipeline-runner] ${line}`);
}
