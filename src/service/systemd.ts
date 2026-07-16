/**
 * systemd backend (Linux). We install a USER service (`systemctl --user`) so no
 * root is required; it lives at `~/.config/systemd/user/pipeline-runner.service`
 * and is enabled into `default.target`.
 *
 * `renderSystemdUnit` is PURE (plan → unit text) and unit-tested directly.
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
import { type ServicePlan, systemdQuote, systemdUserDir } from './plan';

const SYSTEMCTL = 'systemctl';
const USER = '--user';

/** `pipeline-runner.service`. */
export function systemdUnitName(plan: ServicePlan): string {
  return `${plan.identity.serviceName}.service`;
}

/** Absolute path of the user unit file. */
export function systemdUnitPath(plan: ServicePlan, env: Record<string, string | undefined>): string {
  return join(systemdUserDir(env), systemdUnitName(plan));
}

/** PURE: the exact `[Unit]/[Service]/[Install]` text for the plan. */
export function renderSystemdUnit(plan: ServicePlan): string {
  const execStart = [plan.invocation.program, ...plan.invocation.args].map(systemdQuote).join(' ');
  const envLines = Object.entries(plan.environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`);
  return [
    '[Unit]',
    `Description=${plan.identity.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    `WorkingDirectory=${plan.workingDirectory}`,
    'Restart=on-failure',
    'RestartSec=5',
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Append an actionable hint when systemctl fails for the usual session reason. */
function withLoginctlHint(stderr: string): string {
  if (/bus|logind|session|display|no medium/i.test(stderr)) {
    return (
      '\nhint: `systemctl --user` needs an active logind session. Run inside your ' +
      'login session, or enable lingering so the user manager runs at boot:\n' +
      '  loginctl enable-linger "$USER"'
    );
  }
  return '';
}

class SystemdBackend implements ServiceBackend {
  readonly id = 'systemd';

  definitionPath(plan: ServicePlan, ctx: ServiceContext): string {
    return systemdUnitPath(plan, ctx.env);
  }

  generate(plan: ServicePlan): string {
    return renderSystemdUnit(plan);
  }

  install(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const dir = systemdUserDir(ctx.env);
    const unitPath = join(dir, unit);

    ctx.fs.mkdirp(dir);
    ctx.fs.writeFileText(unitPath, renderSystemdUnit(plan));

    const reload = run([USER, 'daemon-reload']);
    if (reload.code !== 0) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} daemon-reload\` failed (exit ${reload.code})` +
          `${reload.stderr ? `: ${reload.stderr.trim()}` : ''}${withLoginctlHint(reload.stderr)}`
      );
    }
    const enable = run([USER, 'enable', '--now', unit]);
    if (enable.code !== 0) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} enable --now ${unit}\` failed (exit ${enable.code})` +
          `${enable.stderr ? `: ${enable.stderr.trim()}` : ''}${withLoginctlHint(enable.stderr)}`
      );
    }

    return {
      action: 'install',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: unitPath,
      commands,
      messages: [
        `wrote systemd user unit: ${unitPath}`,
        `enabled + started ${unit}`,
        `check it: systemctl --user status ${unit}`,
      ],
    };
  }

  uninstall(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const unitPath = systemdUnitPath(plan, ctx.env);

    // Best-effort: disabling a not-installed/not-enabled unit is harmless.
    run([USER, 'disable', '--now', unit]);
    ctx.fs.removeFile(unitPath);
    run([USER, 'daemon-reload']);

    return {
      action: 'uninstall',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: unitPath,
      commands,
      messages: [`disabled + removed ${unit}`, `deleted unit: ${unitPath}`],
    };
  }

  status(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const unitPath = systemdUnitPath(plan, ctx.env);

    if (!ctx.fs.exists(unitPath)) {
      return {
        action: 'status',
        backend: this.id,
        platform: ctx.platform,
        definitionPath: unitPath,
        state: 'not-installed',
        enabled: false,
        commands,
        messages: [`${unit} is not installed`],
      };
    }

    const active = run([USER, 'is-active', unit]);
    const enabled = run([USER, 'is-enabled', unit]);
    const activeWord = active.stdout.trim();
    const state: ServiceState = activeWord === 'active' ? 'running' : 'stopped';
    const isEnabled = enabled.stdout.trim() === 'enabled';

    return {
      action: 'status',
      backend: this.id,
      platform: ctx.platform,
      definitionPath: unitPath,
      state,
      enabled: isEnabled,
      commands,
      messages: [`${unit}: ${state} (${isEnabled ? 'enabled' : 'disabled'})`],
    };
  }
}

export function createSystemdBackend(): ServiceBackend {
  return new SystemdBackend();
}
