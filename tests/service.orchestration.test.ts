import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import {
  buildServicePlan,
  DEFAULT_IDENTITY,
  installService,
  previewService,
  resolveInvocation,
  selectBackend,
  ServiceError,
  serviceStatus,
  SUPPORTED_PLATFORMS,
  systemdQuote,
  uninstallService,
  winQuote,
  xmlEscape,
} from '../src/service';
import { FakeExec, FakeServiceFs } from './_service-helpers';

const LINUX_ENV = { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config' };
const INVOCATION = { program: '/usr/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] };

describe('selectBackend', () => {
  test('maps each supported platform to its backend', () => {
    expect(selectBackend('linux').id).toBe('systemd');
    expect(selectBackend('darwin').id).toBe('launchd');
    expect(selectBackend('win32').id).toBe('windows');
  });

  test('supported platform list is [linux, darwin, win32]', () => {
    expect([...SUPPORTED_PLATFORMS]).toEqual(['linux', 'darwin', 'win32']);
  });

  test('unsupported platform throws a clear ServiceError (never a silent no-op)', () => {
    expect(() => selectBackend('freebsd')).toThrow(ServiceError);
    try {
      selectBackend('sunos');
    } catch (err) {
      expect((err as Error).message).toContain('unsupported platform: sunos');
      expect((err as Error).message).toContain('linux, darwin, win32');
    }
  });
});

describe('installService/uninstallService/serviceStatus route by injected platform', () => {
  const base = {
    env: LINUX_ENV,
    invocation: INVOCATION,
    workingDirectory: '/opt/agent/src',
    environment: { HOME: '/home/u' },
    configDir: '/home/u/.config/pipeline-runner',
  };

  test('install on unsupported platform throws before touching seams', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    expect(() => installService({ ...base, platform: 'aix', exec, fs })).toThrow(ServiceError);
    expect(exec.calls).toHaveLength(0);
    expect(fs.files.size).toBe(0);
  });

  test('status/uninstall also select the right backend', () => {
    const statusResult = serviceStatus({ ...base, platform: 'linux', exec: new FakeExec(), fs: new FakeServiceFs() });
    expect(statusResult.backend).toBe('systemd');
    const uninstallResult = uninstallService({ ...base, platform: 'darwin', exec: new FakeExec(), fs: new FakeServiceFs() });
    expect(uninstallResult.backend).toBe('launchd');
  });
});

describe('previewService (pure, touches nothing)', () => {
  test('systemd preview renders the unit + its path without exec/fs', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const preview = previewService({
      platform: 'linux',
      env: LINUX_ENV,
      invocation: INVOCATION,
      workingDirectory: '/opt/agent/src',
      environment: { HOME: '/home/u' },
      configDir: '/home/u/.config/pipeline-runner',
      exec,
      fs,
    });
    expect(preview.backend).toBe('systemd');
    expect(preview.definitionPath).toBe(join('/home/u/.config', 'systemd', 'user', 'pipeline-runner.service'));
    expect(preview.definition).toContain('ExecStart=/usr/bin/bun /opt/agent/src/cli.ts start');
    expect(exec.calls).toHaveLength(0);
    expect(fs.files.size).toBe(0);
  });

  test('windows preview has a null path and the sc.exe create command', () => {
    const preview = previewService({
      platform: 'win32',
      invocation: { program: 'C:\\bun\\bun.exe', args: ['C:\\agent\\cli.ts', 'start'] },
      workingDirectory: 'C:\\agent',
      environment: {},
      configDir: 'C:\\cfg',
    });
    expect(preview.definitionPath).toBeNull();
    expect(preview.definition).toContain('sc.exe create pipeline-runner binPath=');
    expect(preview.definition).toContain(
      'sc.exe failure pipeline-runner reset= 86400 actions= restart/5000'
    );
  });
});

describe('resolveInvocation', () => {
  test('defaults to the current runtime running this package cli.ts start', () => {
    const inv = resolveInvocation();
    expect(inv.program).toBe(process.execPath);
    expect(inv.args[1]).toBe('start');
    expect(inv.args[0]?.endsWith('cli.ts')).toBe(true);
  });

  test('is fully overridable', () => {
    const inv = resolveInvocation({ execPath: '/x/bun', entry: '/y/cli.ts', command: 'start' });
    expect(inv).toEqual({ program: '/x/bun', args: ['/y/cli.ts', 'start'] });
  });
});

describe('buildServicePlan', () => {
  test('resolves configDir from env when not provided, workingDirectory from the entry', () => {
    const plan = buildServicePlan({ invocation: INVOCATION }, 'linux', LINUX_ENV);
    expect(plan.configDir).toBe(join('/home/u/.config', 'pipeline-runner'));
    expect(plan.workingDirectory).toBe(dirname('/opt/agent/src/cli.ts'));
  });

  test('merges an identity override', () => {
    const plan = buildServicePlan({ invocation: INVOCATION, identity: { serviceName: 'custom-agent' } }, 'linux', LINUX_ENV);
    expect(plan.identity.serviceName).toBe('custom-agent');
    expect(plan.identity.launchdLabel).toBe(DEFAULT_IDENTITY.launchdLabel); // untouched
  });

  test('propagates HOME + XDG_CONFIG_HOME (never secrets) into the posix environment', () => {
    const plan = buildServicePlan({ invocation: INVOCATION }, 'linux', LINUX_ENV);
    expect(plan.environment).toEqual({ HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config' });
  });

  test('windows environment is empty (services inherit machine/user env)', () => {
    const plan = buildServicePlan({ invocation: INVOCATION, configDir: 'C:\\cfg' }, 'win32', {});
    expect(plan.environment).toEqual({});
  });
});

describe('quoting helpers', () => {
  test('systemdQuote quotes whitespace/special tokens, leaves plain ones bare', () => {
    expect(systemdQuote('/usr/bin/bun')).toBe('/usr/bin/bun');
    expect(systemdQuote('/opt/my apps/bun')).toBe('"/opt/my apps/bun"');
    expect(systemdQuote('a"b')).toBe('"a\\"b"');
    expect(systemdQuote('')).toBe('""');
  });

  test('winQuote quotes only when whitespace is present', () => {
    expect(winQuote('C:\\bun\\bun.exe')).toBe('C:\\bun\\bun.exe');
    expect(winQuote('C:\\Program Files\\bun.exe')).toBe('"C:\\Program Files\\bun.exe"');
  });

  test('xmlEscape escapes & < >', () => {
    expect(xmlEscape('a & b <c>')).toBe('a &amp; b &lt;c&gt;');
  });
});
