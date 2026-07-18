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
 *   - previewService                                     (pure definition preview)
 *   - runService(argv)                                   (the CLI dispatcher)
 */

import { consoleLogger, type Logger } from '../core/log';
import { buildServicePlan, type PlanInputs, type ServicePlan } from './plan';
import { createLaunchdBackend } from './launchd';
import { createSystemdBackend } from './systemd';
import { createWindowsBackend } from './windows';
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

/** Select the backend for a raw `process.platform` value. */
export function selectBackend(platform: string): ServiceBackend {
  switch (platform) {
    case 'linux':
      return createSystemdBackend();
    case 'darwin':
      return createLaunchdBackend();
    case 'win32':
      return createWindowsBackend();
    default:
      throw new ServiceError(
        `unsupported platform: ${platform} — service install supports ${SUPPORTED_PLATFORMS.join(', ')} ` +
          '(systemd / launchd / Windows Service)'
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
}

function resolve(opts: ServiceOptions): {
  backend: ServiceBackend;
  plan: ServicePlan;
  ctx: ServiceContext;
} {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const backend = selectBackend(platform); // throws on unsupported — never a silent no-op
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
      'usage: pipeline-runner service <install|uninstall|status> [--dry-run]',
      '',
      '  install    register + start the runner as an OS service (systemd/launchd/Windows)',
      '  uninstall  stop + deregister the service',
      '  status     report running/enabled state',
      '',
      '  --dry-run  (install) print the generated unit/plist/command; touch nothing',
    ].join('\n')
  );
}

/**
 * Handle `pipeline-runner service ...`. Prints outcome lines and exits non-zero
 * on a `ServiceError` (unsupported platform, privilege, session hints) — never
 * crashes with a raw stack.
 */
export function runService(argv: string[]): void {
  const [sub, ...rest] = argv;
  const dryRun = rest.includes('--dry-run');
  try {
    switch (sub) {
      case 'install': {
        if (dryRun) {
          const preview = previewService();
          console.log(`[pipeline-runner] service preview (${preview.backend}, ${preview.platform})`);
          if (preview.definitionPath) console.log(`[pipeline-runner] path: ${preview.definitionPath}`);
          console.log(preview.definition);
          return;
        }
        printResult(installService());
        return;
      }
      case 'uninstall':
        printResult(uninstallService());
        return;
      case 'status':
        printResult(serviceStatus());
        return;
      default:
        serviceUsage();
        return;
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
