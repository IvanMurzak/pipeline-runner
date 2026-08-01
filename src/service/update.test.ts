import { describe, expect, test } from 'bun:test';
import { installCommand, PACKAGE_NAME, runUpdate } from './update';
import { ServiceError, type ServiceExec, type ServiceExecResult } from './types';

/**
 * `pipeline-runner update`.
 *
 * The failure it exists for: `bun add -g` rewrites files, Bun read the source
 * at startup, so a live runner keeps executing the OLD code with the NEW files
 * underneath it — and looks up to date. That is how the 2026-08-01 ROLE_AGENT
 * fix reached a machine and did nothing.
 */

const TASK_RUNNING = 'TaskName: pipeline-runner\r\nStatus: Running\r\n';
const NO_TASK = { code: 1, stderr: 'ERROR: The system cannot find the file specified.' };

/** Fake exec: answers by first-matching predicate, records every call. */
function world(
  answers: Array<{ when: (cmd: string, args: string[]) => boolean; give: Partial<ServiceExecResult> }>,
) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ServiceExec = {
    run(cmd, args) {
      calls.push({ cmd, args });
      const hit = answers.find((a) => a.when(cmd, args));
      return { code: 0, stdout: '', stderr: '', ...(hit?.give ?? {}) };
    },
  };
  return { exec, calls };
}

const viewGives = (v: string) => ({
  when: (c: string, a: string[]) => c === 'npm' && a[0] === 'view',
  give: { stdout: `${v}\n` },
});
const taskIs = (stdout: string | typeof NO_TASK) => ({
  when: (c: string) => c === 'schtasks.exe',
  give: typeof stdout === 'string' ? { stdout } : stdout,
});

// A realistic env: `buildServicePlan` needs a config dir, and an empty env
// makes it throw — which is a DIFFERENT outcome from "no service installed"
// and is covered on its own below.
const base = {
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\Dev' },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};

describe('installCommand (pure)', () => {
  test('installs the package globally at the requested target', () => {
    expect(installCommand('latest')).toEqual({ cmd: 'bun', args: ['add', '-g', `${PACKAGE_NAME}@latest`] });
    expect(installCommand('0.7.2').args).toContain(`${PACKAGE_NAME}@0.7.2`);
  });
});

describe('the restart is the point', () => {
  test('installs, then asks the SUPERVISOR to restart — never re-execs itself', () => {
    // A process that re-execs has to outlive its own replacement, and a service
    // host would read that exit as a crash and race its own recovery.
    const { exec, calls } = world([viewGives('0.7.2'), taskIs(TASK_RUNNING)]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1' });

    expect(r.installed).toBe(true);
    expect(r.restarted).toBe(true);
    expect(calls.some((c) => c.cmd === 'bun' && c.args.includes('add'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'schtasks.exe' && c.args.includes('/End'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'schtasks.exe' && c.args.includes('/Run'))).toBe(true);
  });

  test('the install runs BEFORE the restart — a half-swapped tree is never started', () => {
    const { exec, calls } = world([viewGives('0.7.2'), taskIs(TASK_RUNNING)]);
    runUpdate({ ...base, exec, currentVersion: '0.7.1' });
    const install = calls.findIndex((c) => c.cmd === 'bun');
    const run = calls.findIndex((c) => c.args.includes('/Run'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(run);
  });
});

describe('when there is nothing to restart', () => {
  test('not installed as a service: says so, and says what to do', () => {
    const { exec, calls } = world([viewGives('0.7.2'), taskIs(NO_TASK)]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1' });

    expect(r.installed).toBe(true);
    expect(r.restarted).toBe(false);
    expect(r.restartSkippedReason).toContain('not installed as a service');
    expect(r.messages.join(' ')).toContain('restart the runner yourself');
    // It must NOT kill a foreground process the operator is watching.
    expect(calls.some((c) => c.args.includes('/End'))).toBe(false);
  });

  test('--no-restart updates the files and SAYS the running code is still old', () => {
    const { exec } = world([viewGives('0.7.2'), taskIs(TASK_RUNNING)]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1', noRestart: true });
    expect(r.installed).toBe(true);
    expect(r.restarted).toBe(false);
    expect(r.messages.join(' ')).toContain('still holds the OLD code');
  });
});

describe('already current', () => {
  test('skips the install but STILL restarts — files current, process stale is the bug', () => {
    // This is exactly the state the machine was in: 0.7.1 on disk, 0.7.0
    // running. Returning early here would leave it unfixable by this command.
    const { exec, calls } = world([viewGives('0.7.1'), taskIs(TASK_RUNNING)]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1' });

    expect(r.installed).toBe(false);
    expect(r.restarted).toBe(true);
    expect(calls.some((c) => c.cmd === 'bun')).toBe(false);
    expect(r.messages.join(' ')).toContain('already on 0.7.1');
  });
});

describe('failure and rehearsal', () => {
  test('a failed install throws with the real error and restarts NOTHING', () => {
    const { exec, calls } = world([
      viewGives('0.7.2'),
      { when: (c) => c === 'bun', give: { code: 1, stderr: 'error: package not found' } },
    ]);
    expect(() => runUpdate({ ...base, exec, currentVersion: '0.7.1' })).toThrow(ServiceError);
    expect(calls.some((c) => c.args.includes('/Run'))).toBe(false);
  });

  test('--dry-run changes nothing and names both steps', () => {
    const { exec, calls } = world([viewGives('0.7.2'), taskIs(TASK_RUNNING)]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1', dryRun: true });
    expect(r.installed).toBe(false);
    expect(r.restarted).toBe(false);
    expect(r.messages.join(' ')).toContain('would run');
    expect(r.messages.join(' ')).toContain('restart');
    expect(calls.some((c) => c.cmd === 'bun')).toBe(false);
    expect(calls.some((c) => c.cmd === 'schtasks.exe')).toBe(false);
  });

  test('"could not determine" is never reported as "no service installed"', () => {
    // The two send an operator to different places: one to `service install`
    // for a service that may already exist, the other to the real fault. An
    // empty env is the cheapest way to make the lookup genuinely fail.
    const { exec, calls } = world([viewGives('0.7.2'), taskIs(TASK_RUNNING)]);
    const r = runUpdate({ ...base, env: {}, exec, currentVersion: '0.7.1' });

    expect(r.installed).toBe(true); // the files DID update
    expect(r.restarted).toBe(false);
    expect(r.restartSkippedReason).toContain('could not determine');
    expect(r.restartSkippedReason).not.toContain('not installed as a service');
    expect(calls.some((c) => c.args.includes('/Run'))).toBe(false);
  });

  test('an unreadable npm view is cosmetic — the update still proceeds', () => {
    const { exec } = world([
      { when: (c, a) => c === 'npm' && a[0] === 'view', give: { code: 1, stderr: 'offline' } },
      taskIs(TASK_RUNNING),
    ]);
    const r = runUpdate({ ...base, exec, currentVersion: '0.7.1' });
    expect(r.installed).toBe(true);
    expect(r.restarted).toBe(true);
  });
});
