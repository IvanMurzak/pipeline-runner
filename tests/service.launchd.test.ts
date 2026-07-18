import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_IDENTITY,
  installService,
  launchdPlistName,
  launchdPlistPath,
  renderLaunchdPlist,
  type ServicePlan,
  serviceStatus,
  uninstallService,
} from '../src/service';
import { FakeExec, FakeServiceFs } from './_service-helpers';

const ENV = { HOME: '/Users/u' };

function plan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    identity: DEFAULT_IDENTITY,
    invocation: { program: '/opt/homebrew/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] },
    workingDirectory: '/opt/agent/src',
    environment: { HOME: '/Users/u' },
    configDir: '/Users/u/.config/pipeline-runner',
    ...overrides,
  };
}

const OPTS = {
  platform: 'darwin',
  env: ENV,
  invocation: { program: '/opt/homebrew/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] },
  workingDirectory: '/opt/agent/src',
  environment: { HOME: '/Users/u' },
  configDir: '/Users/u/.config/pipeline-runner',
};

const PLIST_PATH = join('/Users/u', 'Library', 'LaunchAgents', 'com.ivanmurzak.pipeline-runner.plist');

describe('renderLaunchdPlist (pure)', () => {
  test('emits Label, ProgramArguments array, RunAtLoad, KeepAlive', () => {
    const plist = renderLaunchdPlist(plan(), ENV);
    expect(plist).toContain('<key>Label</key>\n  <string>com.ivanmurzak.pipeline-runner</string>');
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('    <string>/opt/homebrew/bin/bun</string>');
    expect(plist).toContain('    <string>/opt/agent/src/cli.ts</string>');
    expect(plist).toContain('    <string>start</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/opt/agent/src</string>');
    expect(plist).toContain(join('/Users/u', 'Library', 'Logs', 'pipeline-runner.out.log'));
    expect(plist).toContain(join('/Users/u', 'Library', 'Logs', 'pipeline-runner.err.log'));
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
  });

  test('emits EnvironmentVariables from the plan environment', () => {
    const plist = renderLaunchdPlist(plan(), ENV);
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('    <key>HOME</key>\n    <string>/Users/u</string>');
  });

  test('XML-escapes string content (& < >)', () => {
    const plist = renderLaunchdPlist(plan({ workingDirectory: '/opt/a & b/<x>' }), ENV);
    expect(plist).toContain('<string>/opt/a &amp; b/&lt;x&gt;</string>');
    expect(plist).not.toContain('/opt/a & b/<x>');
  });

  test('no EnvironmentVariables block when environment is empty', () => {
    const plist = renderLaunchdPlist(plan({ environment: {} }), ENV);
    expect(plist).not.toContain('EnvironmentVariables');
  });
});

describe('launchd install', () => {
  test('writes the plist and unload-then-load -w', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const result = installService({ ...OPTS, exec, fs });

    expect(fs.files.get(PLIST_PATH)).toContain('<key>Label</key>');
    expect(fs.dirs.has(join('/Users/u', 'Library', 'LaunchAgents'))).toBe(true);
    expect(exec.sequence).toEqual([
      `launchctl unload ${PLIST_PATH}`,
      `launchctl load -w ${PLIST_PATH}`,
    ]);
    expect(result.definitionPath).toBe(PLIST_PATH);
    expect(result.backend).toBe('launchd');
  });

  test('surfaces the explicit login-not-boot caveat (LaunchDaemon deferred)', () => {
    const result = installService({ ...OPTS, exec: new FakeExec(), fs: new FakeServiceFs() });
    const caveat = result.messages.find((m) => m.startsWith('caveat:'));
    expect(caveat).toBeDefined();
    expect(caveat).toContain('LOGIN, not boot');
    expect(caveat).toContain('LaunchDaemon');
    expect(caveat).toContain('not yet supported');
  });
});

describe('launchd uninstall', () => {
  test('unloads -w and removes the plist', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs().seed(PLIST_PATH, 'x');
    uninstallService({ ...OPTS, exec, fs });
    expect(exec.sequence).toEqual([`launchctl unload -w ${PLIST_PATH}`]);
    expect(fs.removed).toContain(PLIST_PATH);
  });
});

describe('launchd status', () => {
  test('not-installed when the plist is absent', () => {
    const result = serviceStatus({ ...OPTS, exec: new FakeExec(), fs: new FakeServiceFs() });
    expect(result.state).toBe('not-installed');
  });

  test('running when launchctl list reports a PID', () => {
    const exec = new FakeExec(() => ({ code: 0, stdout: '{\n  "PID" = 4321;\n  "Label" = "com.ivanmurzak.pipeline-runner";\n}' }));
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs().seed(PLIST_PATH, 'x') });
    expect(result.state).toBe('running');
    expect(result.enabled).toBe(true);
  });

  test('loaded but not running when no PID', () => {
    const exec = new FakeExec(() => ({ code: 0, stdout: '{\n  "LastExitStatus" = 0;\n}' }));
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs().seed(PLIST_PATH, 'x') });
    expect(result.state).toBe('stopped');
    expect(result.enabled).toBe(true);
  });

  test('present on disk but not loaded (launchctl list non-zero)', () => {
    const exec = new FakeExec(() => ({ code: 1, stderr: 'Could not find service' }));
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs().seed(PLIST_PATH, 'x') });
    expect(result.state).toBe('stopped');
    expect(result.enabled).toBe(false);
  });
});

describe('launchd path helpers', () => {
  test('plist name + path', () => {
    expect(launchdPlistName(plan())).toBe('com.ivanmurzak.pipeline-runner.plist');
    expect(launchdPlistPath(plan(), ENV)).toBe(PLIST_PATH);
  });
});
