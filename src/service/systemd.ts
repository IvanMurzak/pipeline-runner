/**
 * systemd backend (Linux). We install a USER service (`systemctl --user`) so no
 * root is required; it lives at `~/.config/systemd/user/pipeline-runner.service`
 * and is enabled into `default.target`.
 *
 * A user unit alone does NOT survive logout/reboot — `install` also runs
 * `loginctl enable-linger` so the user's systemd instance (and this unit)
 * keeps running unattended (review B P0: "daemon restarts automatically" was
 * false as shipped). Best-effort: a lingering failure warns with the exact
 * remediation command rather than failing the whole install (the unit is
 * already installed and running by that point). See the README for the
 * root/system-unit alternative when lingering itself is unavailable.
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
const LOGINCTL = 'loginctl';
/** `loginctl enable-linger` with no USER arg operates on the invoking user. */
const ENABLE_LINGER_ARGS = ['enable-linger'];

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

/** `systemctl is-active` prints one word; anything but `active` is not up
 *  (`inactive`, `failed`, `activating`, and — for a unit systemd has never
 *  heard of — `unknown` with a non-zero exit). */
function isActive(r: { stdout: string }): boolean {
  return r.stdout.trim() === 'active';
}

/** `systemctl is-enabled` — `enabled` (or `enabled-runtime`) means it comes
 *  back at boot/login. */
function isEnabled(r: { stdout: string }): boolean {
  return /^enabled(-runtime)?$/.test(r.stdout.trim());
}

/** x24: `start`/`restart` on a unit that does not exist. A `start` that
 *  started nothing must not exit 0, and the message must name the verb that
 *  actually helps — which is `install`, precisely BECAUSE this one refuses to
 *  pretend it can substitute for it. */
function notInstalled(unit: string, unitPath: string, verb: string): ServiceError {
  return new ServiceError(
    `${unit} is not installed (no unit at ${unitPath}) — there is nothing to ${verb}.\n` +
      'hint: install it first (`pipeline-runner service install`), or run a supervisor in the foreground ' +
      '(`pipeline-runner start`).'
  );
}

function result(
  action: ServiceResult['action'],
  ctx: ServiceContext,
  unitPath: string,
  state: ServiceState,
  commands: RanCommand[],
  messages: string[]
): ServiceResult {
  return { action, backend: 'systemd', platform: ctx.platform, definitionPath: unitPath, state, commands, messages };
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

    // A `--user` unit only survives logout/reboot when lingering is on (the
    // whole point of this step — review B P0). This is best-effort: unlike
    // `daemon-reload`/`enable --now` above (required for the unit to exist at
    // all), lingering can fail for reasons unrelated to the unit's own health
    // (missing polkit/D-Bus permission in a locked-down or containerized
    // session) even though the service is installed and running RIGHT NOW. We
    // never let that block an otherwise-successful install; instead we surface
    // it loudly with the exact remediation command, plus the system-unit
    // alternative for hosts where lingering is unavailable entirely.
    commands.push({ cmd: LOGINCTL, args: ENABLE_LINGER_ARGS });
    const linger = ctx.exec.run(LOGINCTL, ENABLE_LINGER_ARGS);
    const lingerMessages =
      linger.code === 0
        ? [`enabled lingering: loginctl enable-linger "$USER" (unit survives logout/reboot)`]
        : [
            `warning: \`${LOGINCTL} enable-linger\` failed (exit ${linger.code})` +
              `${linger.stderr ? `: ${linger.stderr.trim()}` : ''}`,
            `the unit will run while you are logged in, but will NOT survive logout/reboot until you run:`,
            `  loginctl enable-linger "$USER"`,
            `alternatively, install a SYSTEM unit instead (root, no lingering needed, starts at boot) — see README's system-unit alternative`,
          ];

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
        ...lingerMessages,
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

  // ── x24: start / stop / restart ───────────────────────────────────────────

  start(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const unitPath = systemdUnitPath(plan, ctx.env);

    if (!ctx.fs.exists(unitPath)) throw notInstalled(unit, unitPath, 'start');
    if (isActive(run([USER, 'is-active', unit]))) {
      return result('start', ctx, unitPath, 'running', commands, [`${unit} is already running — nothing to do`]);
    }

    const started = run([USER, 'start', unit]);
    if (started.code !== 0) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} start ${unit}\` failed (exit ${started.code})` +
          `${started.stderr ? `: ${started.stderr.trim()}` : ''}${withLoginctlHint(started.stderr)}`
      );
    }
    // The exit code says the REQUEST was accepted; only `is-active` says the
    // unit is up. A unit whose ExecStart dies immediately exits 0 here.
    if (!isActive(run([USER, 'is-active', unit]))) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} start ${unit}\` returned success but ${unit} is NOT active — it started and exited. ` +
          `Look at why: systemctl --user status ${unit} ; journalctl --user -u ${unit} -n 50`
      );
    }

    const messages = [`started ${unit}`, `check it: systemctl --user status ${unit}`];
    // `start` starts; it does not enable. Saying so is the difference between
    // a supervisor that is up now and one that is up after the next reboot.
    if (!isEnabled(run([USER, 'is-enabled', unit]))) {
      messages.push(
        `note: ${unit} is NOT enabled, so it will not come back at boot/login. Enable it with ` +
          `\`pipeline-runner service install\` (idempotent) or \`systemctl --user enable ${unit}\`.`
      );
    }
    return result('start', ctx, unitPath, 'running', commands, messages);
  }

  stop(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const unitPath = systemdUnitPath(plan, ctx.env);

    if (!ctx.fs.exists(unitPath)) {
      return result('stop', ctx, unitPath, 'not-installed', commands, [`${unit} is not installed — nothing to stop`]);
    }
    if (!isActive(run([USER, 'is-active', unit]))) {
      return result('stop', ctx, unitPath, 'stopped', commands, [`${unit} is already stopped — nothing to do`]);
    }

    const stopped = run([USER, 'stop', unit]);
    if (stopped.code !== 0) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} stop ${unit}\` failed (exit ${stopped.code})` +
          `${stopped.stderr ? `: ${stopped.stderr.trim()}` : ''}${withLoginctlHint(stopped.stderr)}`
      );
    }
    if (isActive(run([USER, 'is-active', unit]))) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} stop ${unit}\` returned success but ${unit} is STILL active — check ` +
          `\`systemctl --user status ${unit}\``
      );
    }

    return result('stop', ctx, unitPath, 'stopped', commands, [
      `stopped ${unit}`,
      // Stopping is not disabling; a still-enabled unit is back after a reboot.
      `it is still installed and will start again at boot/login — \`pipeline-runner service uninstall\` removes it`,
    ]);
  }

  restart(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: SYSTEMCTL, args });
      return ctx.exec.run(SYSTEMCTL, args);
    };
    const unit = systemdUnitName(plan);
    const unitPath = systemdUnitPath(plan, ctx.env);

    if (!ctx.fs.exists(unitPath)) throw notInstalled(unit, unitPath, 'restart');

    // `systemctl restart` starts a stopped unit rather than failing, which is
    // exactly the semantics wanted here: "make it be running, freshly".
    const restarted = run([USER, 'restart', unit]);
    if (restarted.code !== 0) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} restart ${unit}\` failed (exit ${restarted.code})` +
          `${restarted.stderr ? `: ${restarted.stderr.trim()}` : ''}${withLoginctlHint(restarted.stderr)}`
      );
    }
    if (!isActive(run([USER, 'is-active', unit]))) {
      throw new ServiceError(
        `\`${SYSTEMCTL} ${USER} restart ${unit}\` returned success but ${unit} is NOT active — it started and exited. ` +
          `Look at why: systemctl --user status ${unit} ; journalctl --user -u ${unit} -n 50`
      );
    }
    return result('restart', ctx, unitPath, 'running', commands, [
      `restarted ${unit}`,
      `check it: systemctl --user status ${unit}`,
    ]);
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
