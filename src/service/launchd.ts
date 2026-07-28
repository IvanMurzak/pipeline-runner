/**
 * launchd backend (macOS). We install a per-user LaunchAgent (no root) at
 * `~/Library/LaunchAgents/com.ivanmurzak.pipeline-runner.plist` with
 * `RunAtLoad` + `KeepAlive` so it starts at login and restarts on crash.
 *
 * CAVEAT (review B, not fixed here): a LaunchAgent starts at LOGIN, not boot —
 * on a reboot with no interactive/auto login the runner stays down until
 * someone logs in (unlike the Linux/Windows fixes in this backend's siblings,
 * which reach true unattended-boot recovery). A root LaunchDaemon
 * (`/Library/LaunchDaemons`, starts at boot, no login required) would close
 * this gap but is explicitly DEFERRED — `install` surfaces the caveat instead
 * of silently pretending boot-level recovery exists. See the README.
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

// ── x24 helpers ─────────────────────────────────────────────────────────────

/** `launchctl list <label>` prints a plist-ish dict; a `"PID" = <n>` entry is
 *  the only evidence that something is actually EXECUTING (loaded ≠ running). */
function hasPid(stdout: string): boolean {
  return /"PID"\s*=\s*\d+/.test(stdout);
}

/** launchd's own words when the operation was refused rather than failed. */
function permissionHint(r: { stdout: string; stderr: string }): string {
  return /operation not permitted|permission denied|not privileged/i.test(`${r.stdout}\n${r.stderr}`)
    ? '\nhint: launchd refused the operation. A LaunchAgent belongs to ONE account — run this as the account that ' +
        'installed it (a root/sudo shell is a DIFFERENT launchd domain and is not the fix).'
    : '';
}

/** x24: `start`/`restart` with no plist on disk. */
function notInstalled(label: string, plistPath: string, verb: string): ServiceError {
  return new ServiceError(
    `${label} is not installed (no plist at ${plistPath}) — there is nothing to ${verb}.\n` +
      'hint: install it first (`pipeline-runner service install`), or run a supervisor in the foreground ' +
      '(`pipeline-runner start`).'
  );
}

/**
 * Post-action verification, shared by `start` and `restart`.
 *
 * launchd spawns asynchronously, so "loaded, no pid yet" is a real and
 * legitimately inconclusive observation — reported as exactly that instead of
 * being rounded up to "running" (a success line with nothing behind it) or down
 * to a failure (a false alarm on a perfectly healthy agent).
 */
function verifyUp(
  action: 'start' | 'restart',
  plan: ServicePlan,
  ctx: ServiceContext,
  commands: RanCommand[],
  run: (args: string[]) => { code: number; stdout: string; stderr: string }
): ServiceResult {
  const label = plan.identity.launchdLabel;
  const plistPath = launchdPlistPath(plan, ctx.env);
  const after = run(['list', label]);
  if (after.code !== 0) {
    throw new ServiceError(
      `${label} was ${action === 'start' ? 'started' : 'restarted'} without error, but \`${LAUNCHCTL} list ${label}\` ` +
        'still does not know it — it is not loaded. Check the plist and the launchd log: ' +
        `log show --predicate 'process == "launchd"' --last 5m`
    );
  }
  const verb = action === 'start' ? 'started' : 'restarted';
  return hasPid(after.stdout)
    ? macResult(action, ctx, plistPath, 'running', commands, [`${verb} ${label}`, `check it: ${LAUNCHCTL} list ${label}`])
    : macResult(action, ctx, plistPath, 'unknown', commands, [
        `loaded ${label}, but launchd has not reported a pid yet`,
        `it is not confirmed running — check it: ${LAUNCHCTL} list ${label}`,
      ]);
}

function macResult(
  action: ServiceResult['action'],
  ctx: ServiceContext,
  plistPath: string,
  state: ServiceState,
  commands: RanCommand[],
  messages: string[]
): ServiceResult {
  return { action, backend: 'launchd', platform: ctx.platform, definitionPath: plistPath, state, commands, messages };
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
        'caveat: this LaunchAgent starts at LOGIN, not boot — after a reboot with no ' +
          'interactive/auto login the runner stays down until someone logs in. A ' +
          'root LaunchDaemon (starts at boot, no login required) is not yet supported ' +
          'by this installer (deferred); see the README.',
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

  // ── x24: start / stop / restart ───────────────────────────────────────────

  start(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const plistPath = launchdPlistPath(plan, ctx.env);
    const label = plan.identity.launchdLabel;

    if (!ctx.fs.exists(plistPath)) throw notInstalled(label, plistPath, 'start');

    const listed = run(['list', label]);
    if (listed.code === 0 && hasPid(listed.stdout)) {
      return macResult('start', ctx, plistPath, 'running', commands, [`${label} is already running — nothing to do`]);
    }
    // Two genuinely different "not running" states, and they need different
    // verbs: NOT LOADED (the plist is on disk but launchd does not have it —
    // what `stop` below leaves behind) is fixed by `load -w`; LOADED WITH NO
    // PID (loaded, not currently executing) is fixed by `start`.
    const loaded = listed.code === 0;
    const action = loaded ? run(['start', label]) : run(['load', '-w', plistPath]);
    if (action.code !== 0) {
      const cmd = loaded ? `${LAUNCHCTL} start ${label}` : `${LAUNCHCTL} load -w ${plistPath}`;
      throw new ServiceError(
        `\`${cmd}\` failed (exit ${action.code})${action.stderr ? `: ${action.stderr.trim()}` : ''}${permissionHint(action)}`
      );
    }

    return verifyUp('start', plan, ctx, commands, run);
  }

  stop(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const plistPath = launchdPlistPath(plan, ctx.env);
    const label = plan.identity.launchdLabel;

    if (!ctx.fs.exists(plistPath)) {
      return macResult('stop', ctx, plistPath, 'not-installed', commands, [`${label} is not installed — nothing to stop`]);
    }
    const listed = run(['list', label]);
    if (listed.code !== 0) {
      return macResult('stop', ctx, plistPath, 'stopped', commands, [`${label} is not loaded — nothing to stop`]);
    }

    // `launchctl stop` on THIS agent would be theatre: `install` writes
    // `KeepAlive: true`, so launchd relaunches it immediately. `unload -w` is
    // the only thing that actually keeps it down — and it is not `uninstall`,
    // because the plist stays exactly where it is.
    const unloaded = run(['unload', '-w', plistPath]);
    if (unloaded.code !== 0) {
      throw new ServiceError(
        `\`${LAUNCHCTL} unload -w ${plistPath}\` failed (exit ${unloaded.code})` +
          `${unloaded.stderr ? `: ${unloaded.stderr.trim()}` : ''}${permissionHint(unloaded)}`
      );
    }
    if (run(['list', label]).code === 0) {
      throw new ServiceError(
        `\`${LAUNCHCTL} unload -w ${plistPath}\` returned success but ${label} is still loaded — check ` +
          `\`${LAUNCHCTL} list ${label}\``
      );
    }

    return macResult('stop', ctx, plistPath, 'stopped', commands, [
      `unloaded ${label} (the plist is kept at ${plistPath})`,
      // `-w` writes the disabled override, so this survives a reboot. Say it:
      // "stopped" that silently comes back at the next login is a lie.
      `it will NOT start at the next login until you run \`pipeline-runner service start\``,
    ]);
  }

  restart(plan: ServicePlan, ctx: ServiceContext): ServiceResult {
    const commands: RanCommand[] = [];
    const run = (args: string[]) => {
      commands.push({ cmd: LAUNCHCTL, args });
      return ctx.exec.run(LAUNCHCTL, args);
    };
    const plistPath = launchdPlistPath(plan, ctx.env);
    const label = plan.identity.launchdLabel;

    if (!ctx.fs.exists(plistPath)) throw notInstalled(label, plistPath, 'restart');

    // Best-effort unload (it may not be loaded at all), then a real load.
    run(['unload', plistPath]);
    const load = run(['load', '-w', plistPath]);
    if (load.code !== 0) {
      throw new ServiceError(
        `\`${LAUNCHCTL} load -w ${plistPath}\` failed (exit ${load.code})` +
          `${load.stderr ? `: ${load.stderr.trim()}` : ''}${permissionHint(load)}`
      );
    }
    return verifyUp('restart', plan, ctx, commands, run);
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
