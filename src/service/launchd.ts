/**
 * launchd backend (macOS). We install a per-user LaunchAgent (no root) at
 * `~/Library/LaunchAgents/com.ivanmurzak.pipeline-runner.plist` with
 * `RunAtLoad` + `KeepAlive` so it starts at login and restarts on crash.
 *
 * `renderLaunchdPlist` is PURE (plan → plist XML) and unit-tested directly.
 * ProgramArguments is an ARRAY, so argv is passed verbatim — no shell quoting,
 * only XML escaping.
 */

import { join } from 'node:path';
import {
  type RanCommand,
  type ServiceBackend,
  type ServiceContext,
  ServiceError,
  type ServiceResult,
  type ServiceState,
} from './types';
import { launchAgentsDir, macLogsDir, type ServicePlan, xmlEscape } from './plan';

const LAUNCHCTL = 'launchctl';

/** `com.ivanmurzak.pipeline-runner.plist`. */
export function launchdPlistName(plan: ServicePlan): string {
  return `${plan.identity.launchdLabel}.plist`;
}

/** Absolute path of the LaunchAgent plist. */
export function launchdPlistPath(plan: ServicePlan, env: Record<string, string | undefined>): string {
  return join(launchAgentsDir(env), launchdPlistName(plan));
}

/** PURE: the exact LaunchAgent plist XML for the plan. */
export function renderLaunchdPlist(plan: ServicePlan, env: Record<string, string | undefined>): string {
  const argv = [plan.invocation.program, ...plan.invocation.args];
  const logs = macLogsDir(env);
  const argEls = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const envEntries = Object.entries(plan.environment).sort(([a], [b]) => a.localeCompare(b));
  const envBlock =
    envEntries.length === 0
      ? ''
      : [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          ...envEntries.flatMap(([k, v]) => [
            `    <key>${xmlEscape(k)}</key>`,
            `    <string>${xmlEscape(v)}</string>`,
          ]),
          '  </dict>',
        ].join('\n') + '\n';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    `  <key>Label</key>\n  <string>${xmlEscape(plan.identity.launchdLabel)}</string>\n` +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    `${argEls}\n` +
    '  </array>\n' +
    `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(plan.workingDirectory)}</string>\n` +
    envBlock +
    '  <key>RunAtLoad</key>\n  <true/>\n' +
    '  <key>KeepAlive</key>\n  <true/>\n' +
    `  <key>StandardOutPath</key>\n  <string>${xmlEscape(join(logs, `${plan.identity.serviceName}.out.log`))}</string>\n` +
    `  <key>StandardErrorPath</key>\n  <string>${xmlEscape(join(logs, `${plan.identity.serviceName}.err.log`))}</string>\n` +
    '</dict>\n' +
    '</plist>\n'
  );
}

class LaunchdBackend implements ServiceBackend {
  readonly id = 'launchd';

  definitionPath(plan: ServicePlan, ctx: ServiceContext): string {
    return launchdPlistPath(plan, ctx.env);
  }

  generate(plan: ServicePlan, ctx: ServiceContext): string {
    return renderLaunchdPlist(plan, ctx.env);
  }

  install(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const dir = launchAgentsDir(ctx.env);
    const plistPath = join(dir, launchdPlistName(plan));

    ctx.fs.mkdirp(dir);
    ctx.fs.writeFileText(plistPath, renderLaunchdPlist(plan, ctx.env));

    // Best-effort unload first so re-install cleanly reloads the new plist.
    run(['unload', plistPath]);
    const load = run(['load', '-w', plistPath]);
    if (load.code !== 0) {
      throw new ServiceError(
        `\`${LAUNCHCTL} load -w ${plistPath}\` failed (exit ${load.code})` +
          `${load.stderr ? `: ${load.stderr.trim()}` : ''}`
      );
    }

    return {
      action: 'install',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: plistPath,
      commands,
      messages: [
        `wrote LaunchAgent plist: ${plistPath}`,
        `loaded ${plan.identity.launchdLabel} (RunAtLoad + KeepAlive)`,
        `check it: launchctl list ${plan.identity.launchdLabel}`,
      ],
    };
  }

  uninstall(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const plistPath = launchdPlistPath(plan, ctx.env);

    run(['unload', '-w', plistPath]); // best-effort — may already be unloaded
    ctx.fs.removeFile(plistPath);

    return {
      action: 'uninstall',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: plistPath,
      commands,
      messages: [`unloaded + removed ${plan.identity.launchdLabel}`, `deleted plist: ${plistPath}`],
    };
  }

  status(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const plistPath = launchdPlistPath(plan, ctx.env);
    const label = plan.identity.launchdLabel;

    if (!ctx.fs.exists(plistPath)) {
      return {
        action: 'status',
        backend: this.id,
        platform: ctx.platform,
        definitionPath: plistPath,
        state: 'not-installed',
        enabled: false,
        commands,
        messages: [`${label} is not installed`],
      };
    }

    const list = run(['list', label]);
    let state: ServiceState;
    let enabled: boolean;
    if (list.code !== 0) {
      // Plist on disk but not loaded into launchd.
      state = 'stopped';
      enabled = false;
    } else {
      enabled = true; // loaded → will run at login
      state = /"PID"\s*=\s*\d+/.test(list.stdout) ? 'running' : 'stopped';
    }

    return {
      action: 'status',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: plistPath,
      state,
      enabled,
      commands,
      messages: [`${label}: ${state} (${enabled ? 'loaded' : 'not loaded'})`],
    };
  }
}

export function createLaunchdBackend(): ServiceBackend {
  return new LaunchdBackend();
}
