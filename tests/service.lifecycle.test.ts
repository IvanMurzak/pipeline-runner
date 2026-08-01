/**
 * x24 — `pipeline-runner service start|stop|restart`, on all three backends.
 *
 * Before these verbs, the ONLY route from `stopped` back to `running` was
 * `service install`, which stop+deletes+recreates the service and needs
 * elevation on Windows — and `x13` had meanwhile taught `pipeline department
 * serve` to correctly detect and report a stopped supervisor, so the product
 * could name the problem and had no clean command to name as the fix.
 *
 * What is actually under test here is not "does start call start". It is the
 * FOUR AWKWARD STATES, because this epic has found seven "confident success
 * line with nothing behind it" defects and each verb has four chances to be an
 * eighth:
 *
 *   1. not installed          — `start`/`restart` must FAIL and name `install`;
 *                               `stop` may succeed, because its end state holds
 *   2. already in that state  — succeed, say "already", claim no action
 *   3. no privilege           — say elevation, and only when that is the cause
 *   4. command ok, service not— re-query and refuse to claim what was not seen
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeExec, FakeServiceFs } from './_service-helpers';
import { restartService, startService, stopService } from '../src/service';
import { ServiceError } from '../src/service/types';

const LINUX_ENV = { HOME: '/home/ada', XDG_CONFIG_HOME: '/home/ada/.config' };
const UNIT_PATH = join('/home/ada/.config', 'systemd', 'user', 'pipeline-runner.service');
const MAC_ENV = { HOME: '/Users/ada' };
const PLIST_PATH = join('/Users/ada', 'Library', 'LaunchAgents', 'com.ivanmurzak.pipeline-runner.plist');

const INVOCATION = { program: '/usr/bin/bun', args: ['/pkg/src/cli.ts', 'start'] };

function linux(fs: FakeServiceFs, exec: FakeExec) {
  return { platform: 'linux', env: LINUX_ENV, fs, exec, invocation: INVOCATION };
}
function mac(fs: FakeServiceFs, exec: FakeExec) {
  return { platform: 'darwin', env: MAC_ENV, fs, exec, invocation: INVOCATION };
}
function win(exec: FakeExec) {
  // APPDATA only so `buildServicePlan` can resolve a configDir; the Windows
  // backend is SCM-only and never touches the filesystem seam.
  return {
    platform: 'win32', windowsHost: 'scm' as const,
    env: { APPDATA: join('C:', 'Users', 'ada', 'AppData', 'Roaming') },
    fs: new FakeServiceFs(),
    exec,
    invocation: INVOCATION,
  };
}

// ── systemd ────────────────────────────────────────────────────────────────

describe('x24 systemd — start', () => {
  test('not installed: refuses, names `service install`, and never runs systemctl', () => {
    const exec = new FakeExec();
    expect(() => startService(linux(new FakeServiceFs(), exec))).toThrow(ServiceError);
    try {
      startService(linux(new FakeServiceFs(), exec));
    } catch (err) {
      expect((err as Error).message).toContain('nothing to start');
      expect((err as Error).message).toContain('pipeline-runner service install');
      expect((err as Error).message).toContain('pipeline-runner start');
    }
    expect(exec.calls).toHaveLength(0);
  });

  test('already running: success, says "already", and issues no start command', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(() => ({ stdout: 'active\n' }));
    const r = startService(linux(fs, exec));
    expect(r.action).toBe('start');
    expect(r.state).toBe('running');
    expect(r.messages[0]).toContain('already running');
    expect(exec.sequence.some((c) => c.includes(' start '))).toBe(false);
  });

  test('starts a stopped unit and CONFIRMS it with is-active afterwards', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    let activeCalls = 0;
    const exec = new FakeExec(({ args }) => {
      if (args.includes('is-active')) return { stdout: ++activeCalls === 1 ? 'inactive\n' : 'active\n' };
      if (args.includes('is-enabled')) return { stdout: 'enabled\n' };
      return {};
    });
    const r = startService(linux(fs, exec));
    expect(r.state).toBe('running');
    expect(r.messages[0]).toBe('started pipeline-runner.service');
    // is-active (before) → start → is-active (verify) → is-enabled (advisory)
    expect(exec.sequence).toEqual([
      'systemctl --user is-active pipeline-runner.service',
      'systemctl --user start pipeline-runner.service',
      'systemctl --user is-active pipeline-runner.service',
      'systemctl --user is-enabled pipeline-runner.service',
    ]);
  });

  test('a started-but-not-enabled unit is told it will not come back at boot', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    let activeCalls = 0;
    const exec = new FakeExec(({ args }) => {
      if (args.includes('is-active')) return { stdout: ++activeCalls === 1 ? 'inactive\n' : 'active\n' };
      if (args.includes('is-enabled')) return { stdout: 'disabled\n', code: 1 };
      return {};
    });
    const r = startService(linux(fs, exec));
    expect(r.messages.join('\n')).toContain('NOT enabled');
  });

  test('exit 0 from systemctl but an inactive unit is a FAILURE, not a success line', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(({ args }) => (args.includes('is-active') ? { stdout: 'failed\n' } : {}));
    expect(() => startService(linux(fs, exec))).toThrow(/returned success but .* is NOT active/);
  });

  test('a systemctl failure carries its stderr and the logind hint', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(({ args }) => {
      if (args.includes('is-active')) return { stdout: 'inactive\n' };
      return { code: 1, stderr: 'Failed to connect to bus: No medium found' };
    });
    try {
      startService(linux(fs, exec));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Failed to connect to bus');
      expect((err as Error).message).toContain('loginctl enable-linger');
    }
  });
});

describe('x24 systemd — stop / restart', () => {
  test('stop on a not-installed unit is a benign no-op success (its end state already holds)', () => {
    const exec = new FakeExec();
    const r = stopService(linux(new FakeServiceFs(), exec));
    expect(r.state).toBe('not-installed');
    expect(r.messages[0]).toContain('nothing to stop');
    expect(exec.calls).toHaveLength(0);
  });

  test('stop on an already-stopped unit says "already", runs no stop', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(() => ({ stdout: 'inactive\n' }));
    const r = stopService(linux(fs, exec));
    expect(r.state).toBe('stopped');
    expect(r.messages[0]).toContain('already stopped');
  });

  test('stop verifies, and says the unit is still installed and comes back at boot', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    let calls = 0;
    const exec = new FakeExec(({ args }) =>
      args.includes('is-active') ? { stdout: ++calls === 1 ? 'active\n' : 'inactive\n' } : {},
    );
    const r = stopService(linux(fs, exec));
    expect(r.state).toBe('stopped');
    expect(r.messages.join('\n')).toContain('will start again at boot');
    expect(r.messages.join('\n')).toContain('uninstall');
  });

  test('a unit that is STILL active after a successful stop is a failure', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(({ args }) => (args.includes('is-active') ? { stdout: 'active\n' } : {}));
    expect(() => stopService(linux(fs, exec))).toThrow(/STILL active/);
  });

  test('restart refuses when nothing is installed', () => {
    expect(() => restartService(linux(new FakeServiceFs(), new FakeExec()))).toThrow(/nothing to restart/);
  });

  test('restart uses systemctl restart (which starts a stopped unit) and verifies', () => {
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'unit');
    const exec = new FakeExec(({ args }) => (args.includes('is-active') ? { stdout: 'active\n' } : {}));
    const r = restartService(linux(fs, exec));
    expect(r.action).toBe('restart');
    expect(r.state).toBe('running');
    expect(exec.sequence).toEqual([
      'systemctl --user restart pipeline-runner.service',
      'systemctl --user is-active pipeline-runner.service',
    ]);
  });
});

// ── Windows ────────────────────────────────────────────────────────────────

const SC_MISSING = { code: 1060, stdout: '', stderr: 'The specified service does not exist as an installed service.' };

describe('x24 windows — start', () => {
  test('not installed: refuses and names install (the verb that needs elevation), plus the foreground escape', () => {
    const exec = new FakeExec(() => SC_MISSING);
    try {
      startService(win(exec));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('nothing to start');
      expect((err as Error).message).toContain('service install');
      expect((err as Error).message).toContain('pipeline-runner start');
    }
  });

  test('already running: success, no `sc start` issued', () => {
    const exec = new FakeExec(() => ({ stdout: 'STATE : 4 RUNNING' }));
    const r = startService(win(exec));
    expect(r.state).toBe('running');
    expect(r.messages[0]).toContain('already running');
    expect(exec.sequence).toEqual(['sc.exe query pipeline-runner']);
  });

  test('ACCESS DENIED (exit 5) is reported AS an elevation problem', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { stdout: 'STATE : 1 STOPPED' };
      return { code: 5, stdout: '[SC] StartService FAILED 5:\n\nAccess is denied.' };
    });
    try {
      startService(win(exec));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('elevated (Administrator) shell');
    }
  });

  test('a NON-privilege failure does NOT claim elevation is the fix', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { stdout: 'STATE : 1 STOPPED' };
      return { code: 1053, stdout: '[SC] StartService FAILED 1053: the service did not respond in time' };
    });
    try {
      startService(win(exec));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('1053');
      expect((err as Error).message).not.toContain('elevated');
    }
  });

  test('START_PENDING is reported as inconclusive — never rounded up to "running"', () => {
    let queries = 0;
    const exec = new FakeExec(({ args }) => {
      if (args[0] !== 'query') return {};
      return { stdout: ++queries === 1 ? 'STATE : 1 STOPPED' : 'STATE : 2 START_PENDING' };
    });
    const r = startService(win(exec));
    expect(r.state).toBe('unknown');
    expect(r.messages.join('\n')).toContain('START_PENDING');
    expect(r.messages.join('\n')).toContain('not confirmed running');
  });

  test('an accepted start with a service that is still STOPPED is a failure, not a success', () => {
    const exec = new FakeExec(({ args }) => (args[0] === 'query' ? { stdout: 'STATE : 1 STOPPED' } : {}));
    expect(() => startService(win(exec))).toThrow(/accepted but the service is not running/);
  });

  test('a service that started between the query and the start (1056) is success, not an error', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { stdout: 'STATE : 1 STOPPED' };
      return { code: 1056, stdout: '[SC] StartService FAILED 1056: An instance of the service is already running.' };
    });
    const r = startService(win(exec));
    expect(r.state).toBe('running');
    expect(r.messages[0]).toContain('already running');
  });
});

describe('x24 windows — stop / restart', () => {
  test('stop on a service the SCM never heard of is a no-op success', () => {
    const exec = new FakeExec(() => SC_MISSING);
    const r = stopService(win(exec));
    expect(r.state).toBe('not-installed');
    expect(r.messages[0]).toContain('nothing to stop');
  });

  test('stop verifies STOPPED and says it is still registered', () => {
    const exec = new FakeExec(({ args }) => (args[0] === 'query' ? { stdout: 'STATE : 4 RUNNING' } : {}));
    // Second query still says RUNNING → must NOT claim success.
    expect(() => stopService(win(exec))).toThrow(/still not stopped/);
  });

  test('1062 (not active) races are success, not an error', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { stdout: 'STATE : 4 RUNNING' };
      return { code: 1062, stdout: '[SC] ControlService FAILED 1062: The service has not been started.' };
    });
    const r = stopService(win(exec));
    expect(r.state).toBe('stopped');
    expect(r.messages[0]).toContain('already stopped');
  });

  test('restart on a missing service refuses BEFORE composing stop+start (whose stop would no-op)', () => {
    const exec = new FakeExec(() => SC_MISSING);
    expect(() => restartService(win(exec))).toThrow(/nothing to restart/);
  });

  test('restart composes stop then start and reports the start outcome', () => {
    const states = ['STATE : 4 RUNNING', 'STATE : 4 RUNNING', 'STATE : 1 STOPPED', 'STATE : 1 STOPPED', 'STATE : 4 RUNNING'];
    let i = 0;
    const exec = new FakeExec(({ args }) => (args[0] === 'query' ? { stdout: states[i++] ?? 'STATE : 4 RUNNING' } : {}));
    const r = restartService(win(exec));
    expect(r.action).toBe('restart');
    expect(r.state).toBe('running');
    expect(exec.sequence).toContain('sc.exe stop pipeline-runner');
    expect(exec.sequence).toContain('sc.exe start pipeline-runner');
  });
});

// ── launchd ────────────────────────────────────────────────────────────────

describe('x24 launchd — start / stop / restart', () => {
  test('no plist: refuses to start', () => {
    expect(() => startService(mac(new FakeServiceFs(), new FakeExec()))).toThrow(/nothing to start/);
  });

  test('already running (a pid in `launchctl list`): success, no action command', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(() => ({ stdout: '{ "PID" = 4242; };' }));
    const r = startService(mac(fs, exec));
    expect(r.state).toBe('running');
    expect(r.messages[0]).toContain('already running');
    expect(exec.sequence).toEqual(['launchctl list com.ivanmurzak.pipeline-runner']);
  });

  test('NOT LOADED is fixed with `load -w`, not with `start`', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    let listed = 0;
    const exec = new FakeExec(({ args }) => {
      if (args[0] !== 'list') return {};
      return ++listed === 1 ? { code: 1 } : { code: 0, stdout: '{ "PID" = 7; };' };
    });
    const r = startService(mac(fs, exec));
    expect(r.state).toBe('running');
    expect(exec.sequence[1]).toBe(`launchctl load -w ${PLIST_PATH}`);
  });

  test('LOADED WITH NO PID is fixed with `start`, not with `load`', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    let listed = 0;
    const exec = new FakeExec(({ args }) => {
      if (args[0] !== 'list') return {};
      return ++listed === 1 ? { code: 0, stdout: '{ "Label" = "x"; };' } : { code: 0, stdout: '{ "PID" = 9; };' };
    });
    const r = startService(mac(fs, exec));
    expect(exec.sequence[1]).toBe('launchctl start com.ivanmurzak.pipeline-runner');
    expect(r.state).toBe('running');
  });

  test('loaded but no pid yet is INCONCLUSIVE — neither a claim of running nor a false alarm', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    let listed = 0;
    const exec = new FakeExec(({ args }) => {
      if (args[0] !== 'list') return {};
      return ++listed === 1 ? { code: 1 } : { code: 0, stdout: '{ "Label" = "x"; };' };
    });
    const r = startService(mac(fs, exec));
    expect(r.state).toBe('unknown');
    expect(r.messages.join('\n')).toContain('has not reported a pid yet');
  });

  test('still not loaded after a successful load is a failure', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(({ args }) => (args[0] === 'list' ? { code: 1 } : {}));
    expect(() => startService(mac(fs, exec))).toThrow(/still does not know it/);
  });

  test('a launchd permission refusal names the account, and says sudo is NOT the fix', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'list') return { code: 1 };
      return { code: 1, stderr: 'Load failed: 1: Operation not permitted' };
    });
    try {
      startService(mac(fs, exec));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('ONE account');
      expect((err as Error).message).toContain('sudo');
    }
  });

  test('stop UNLOADS (KeepAlive would relaunch a plain `stop`) and says it stays down at login', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    let listed = 0;
    const exec = new FakeExec(({ args }) => {
      if (args[0] !== 'list') return {};
      return ++listed === 1 ? { code: 0, stdout: '{ "PID" = 3; };' } : { code: 1 };
    });
    const r = stopService(mac(fs, exec));
    expect(r.state).toBe('stopped');
    expect(exec.sequence).toContain(`launchctl unload -w ${PLIST_PATH}`);
    expect(exec.sequence.some((c) => c.startsWith('launchctl stop'))).toBe(false);
    expect(r.messages.join('\n')).toContain('will NOT start at the next login');
    expect(r.messages.join('\n')).toContain('the plist is kept');
  });

  test('stop on a plist that is not loaded says so, and unloads nothing', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(() => ({ code: 1 }));
    const r = stopService(mac(fs, exec));
    expect(r.state).toBe('stopped');
    expect(r.messages[0]).toContain('not loaded');
    expect(exec.sequence).toEqual(['launchctl list com.ivanmurzak.pipeline-runner']);
  });

  test('stop on a missing plist is a no-op success', () => {
    const r = stopService(mac(new FakeServiceFs(), new FakeExec()));
    expect(r.state).toBe('not-installed');
    expect(r.messages[0]).toContain('nothing to stop');
  });

  test('a still-loaded agent after a successful unload is a failure', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(({ args }) => (args[0] === 'list' ? { code: 0, stdout: '{ "PID" = 3; };' } : {}));
    expect(() => stopService(mac(fs, exec))).toThrow(/still loaded/);
  });

  test('restart unloads then loads, and verifies', () => {
    const fs = new FakeServiceFs().seed(PLIST_PATH, '<plist/>');
    const exec = new FakeExec(({ args }) => (args[0] === 'list' ? { code: 0, stdout: '{ "PID" = 11; };' } : {}));
    const r = restartService(mac(fs, exec));
    expect(r.action).toBe('restart');
    expect(r.state).toBe('running');
    expect(exec.sequence).toEqual([
      `launchctl unload ${PLIST_PATH}`,
      `launchctl load -w ${PLIST_PATH}`,
      'launchctl list com.ivanmurzak.pipeline-runner',
    ]);
  });

  test('restart refuses when there is no plist', () => {
    expect(() => restartService(mac(new FakeServiceFs(), new FakeExec()))).toThrow(/nothing to restart/);
  });
});

// ── platform selection ─────────────────────────────────────────────────────

describe('x24 — the new verbs go through the same backend selection as the old ones', () => {
  test('an unsupported platform is refused, never silently no-opped', () => {
    for (const action of [startService, stopService, restartService]) {
      expect(() => action({ platform: 'aix', env: {}, exec: new FakeExec(), fs: new FakeServiceFs() })).toThrow(
        /unsupported platform: aix/,
      );
    }
  });
});
