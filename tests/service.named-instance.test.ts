import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  buildServicePlan,
  DEFAULT_IDENTITY,
  installService,
  InstanceNameError,
  namedIdentity,
  previewService,
  resolveInvocation,
  serviceStatus,
  systemdUnitName,
  systemdUnitPath,
  uninstallService,
  validateInstanceName,
} from '../src/service';
import { FakeExec, FakeServiceFs } from './_service-helpers';

const LINUX_ENV = { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config' };
const WIN_ENV = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
const INVOCATION = { program: '/usr/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] };

describe('validateInstanceName / namedIdentity', () => {
  test('accepts letters, digits, hyphen, underscore', () => {
    expect(() => validateInstanceName('prod')).not.toThrow();
    expect(() => validateInstanceName('gpu-01')).not.toThrow();
    expect(() => validateInstanceName('gpu_01')).not.toThrow();
    expect(() => validateInstanceName('A1')).not.toThrow();
  });

  test('rejects spaces, slashes, @, empty, and overlong names', () => {
    expect(() => validateInstanceName('')).toThrow(InstanceNameError);
    expect(() => validateInstanceName('has space')).toThrow(InstanceNameError);
    expect(() => validateInstanceName('has/slash')).toThrow(InstanceNameError);
    expect(() => validateInstanceName('has@at')).toThrow(InstanceNameError);
    expect(() => validateInstanceName('-leading-separator')).toThrow(InstanceNameError);
    expect(() => validateInstanceName('a'.repeat(65))).toThrow(InstanceNameError);
  });

  test('namedIdentity derives systemd/launchd/windows naming from the shared default', () => {
    const id = namedIdentity('gpu-01');
    expect(id.serviceName).toBe('pipeline-runner@gpu-01');
    expect(id.launchdLabel).toBe('com.ivanmurzak.pipeline-runner.gpu-01');
    expect(id.displayName).toBe('Pipeline Runner (gpu-01)');
    expect(id.description).toContain('gpu-01');
  });

  test('namedIdentity validates the name first — never reaches a unit filename unsanitized', () => {
    expect(() => namedIdentity('bad name')).toThrow(InstanceNameError);
  });
});

describe('resolveInvocation — home is baked into argv', () => {
  test('no home: argv is unchanged from before d7', () => {
    const inv = resolveInvocation({ execPath: '/x/bun', entry: '/y/cli.ts', command: 'start' });
    expect(inv).toEqual({ program: '/x/bun', args: ['/y/cli.ts', 'start'] });
  });

  test('a home appends --home <path>, uniformly regardless of platform quoting concerns', () => {
    const inv = resolveInvocation({ execPath: '/x/bun', entry: '/y/cli.ts', command: 'start', home: '/srv/runner-a' });
    expect(inv).toEqual({ program: '/x/bun', args: ['/y/cli.ts', 'start', '--home', '/srv/runner-a'] });
  });
});

describe('buildServicePlan — name/home', () => {
  test('no name/home: identical to the pre-d7 default plan', () => {
    const plan = buildServicePlan({ invocation: INVOCATION }, 'linux', LINUX_ENV);
    expect(plan.identity).toEqual(DEFAULT_IDENTITY);
    expect(plan.invocation.args).toEqual(INVOCATION.args);
  });

  test('name alone derives a NAMED identity and leaves configDir on the OS default', () => {
    const plan = buildServicePlan({ name: 'gpu-01' }, 'linux', LINUX_ENV);
    expect(plan.identity.serviceName).toBe('pipeline-runner@gpu-01');
    expect(plan.configDir).toBe(join('/home/u/.config', 'pipeline-runner'));
  });

  test('home alone pins configDir under <home>/config and bakes --home into the default invocation', () => {
    const plan = buildServicePlan({ home: '/srv/runner-a' }, 'linux', LINUX_ENV);
    expect(plan.identity).toEqual(DEFAULT_IDENTITY); // no name ⇒ default identity still
    expect(plan.configDir).toBe(join('/srv/runner-a', 'config'));
    expect(plan.invocation.args).toContain('--home');
    expect(plan.invocation.args).toContain('/srv/runner-a');
  });

  test('name + home together: a named instance pinned to its own home', () => {
    const plan = buildServicePlan({ name: 'gpu-01', home: '/srv/runner-a' }, 'linux', LINUX_ENV);
    expect(plan.identity.serviceName).toBe('pipeline-runner@gpu-01');
    expect(plan.configDir).toBe(join('/srv/runner-a', 'config'));
    expect(plan.invocation.args.slice(-2)).toEqual(['--home', '/srv/runner-a']);
  });

  test('an explicit `identity` override still wins over the derived named identity', () => {
    const plan = buildServicePlan({ name: 'gpu-01', identity: { displayName: 'Custom' } }, 'linux', LINUX_ENV);
    expect(plan.identity.serviceName).toBe('pipeline-runner@gpu-01'); // from namedIdentity
    expect(plan.identity.displayName).toBe('Custom'); // overridden
  });

  test('an explicit `invocation`/`configDir` bypasses home derivation entirely', () => {
    const plan = buildServicePlan(
      { home: '/srv/runner-a', invocation: INVOCATION, configDir: '/explicit/config' },
      'linux',
      LINUX_ENV
    );
    expect(plan.invocation).toEqual(INVOCATION); // no --home appended — caller's invocation wins
    expect(plan.configDir).toBe('/explicit/config');
  });

  test('a bad --name surfaces InstanceNameError from buildServicePlan itself', () => {
    expect(() => buildServicePlan({ name: 'bad name' }, 'linux', LINUX_ENV)).toThrow(InstanceNameError);
  });
});

describe('named instance end-to-end — systemd', () => {
  test('installs pipeline-runner@<name>.service at the standard user-unit path', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const result = installService({ platform: 'linux', env: LINUX_ENV, name: 'gpu-01', invocation: INVOCATION, exec, fs });
    const unitPath = join('/home/u/.config', 'systemd', 'user', 'pipeline-runner@gpu-01.service');
    expect(result.definitionPath).toBe(unitPath);
    expect(fs.files.get(unitPath)).toContain('ExecStart=');
    expect(exec.sequence).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now pipeline-runner@gpu-01.service',
      'loginctl enable-linger',
    ]);
  });

  test('systemdUnitName/-Path reflect the instance', () => {
    const plan = buildServicePlan({ name: 'gpu-01', invocation: INVOCATION }, 'linux', LINUX_ENV);
    expect(systemdUnitName(plan)).toBe('pipeline-runner@gpu-01.service');
    expect(systemdUnitPath(plan, LINUX_ENV)).toBe(join('/home/u/.config', 'systemd', 'user', 'pipeline-runner@gpu-01.service'));
  });

  test('a --home pinned instance bakes --home into ExecStart', () => {
    const preview = previewService({ platform: 'linux', env: LINUX_ENV, name: 'gpu-01', home: '/srv/runner-a' });
    expect(preview.definition).toContain('--home');
    expect(preview.definition).toContain('/srv/runner-a');
  });

  test('two DIFFERENT named instances install to two DIFFERENT unit paths (no collision)', () => {
    const fsA = new FakeServiceFs();
    const fsB = new FakeServiceFs();
    const a = installService({ platform: 'linux', env: LINUX_ENV, name: 'gpu-01', invocation: INVOCATION, exec: new FakeExec(), fs: fsA });
    const b = installService({ platform: 'linux', env: LINUX_ENV, name: 'gpu-02', invocation: INVOCATION, exec: new FakeExec(), fs: fsB });
    expect(a.definitionPath).not.toBe(b.definitionPath);
  });
});

describe('named instance end-to-end — launchd', () => {
  test('installs a per-label LaunchAgent plist', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const result = installService({ platform: 'darwin', env: LINUX_ENV, name: 'gpu-01', invocation: INVOCATION, exec, fs });
    const plistPath = join('/home/u', 'Library', 'LaunchAgents', 'com.ivanmurzak.pipeline-runner.gpu-01.plist');
    expect(result.definitionPath).toBe(plistPath);
    expect(exec.calls.some((c) => c.args.includes(plistPath))).toBe(true);
  });
});

describe('named instance end-to-end — windows', () => {
  test('creates a per-name Windows service (pipeline-runner@<name>)', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const result = installService({
      platform: 'win32',
      env: WIN_ENV,
      name: 'gpu-01',
      invocation: { program: 'C:\\bun\\bun.exe', args: ['C:\\agent\\cli.ts', 'start'] },
      exec,
      fs,
    });
    expect(result.backend).toBe('windows');
    expect(exec.calls[1]).toEqual({ cmd: 'sc.exe', args: ['delete', 'pipeline-runner@gpu-01'] });
    expect(exec.calls[2]?.args).toContain('pipeline-runner@gpu-01');
  });

  test('status/uninstall address the SAME per-name service (no accidental default-instance touch)', () => {
    const exec = new FakeExec(({ args }) => (args[0] === 'query' ? { code: 1060 } : {}));
    const fs = new FakeServiceFs();
    const status = serviceStatus({ platform: 'win32', env: WIN_ENV, name: 'gpu-01', invocation: { program: 'x', args: ['y'] }, exec, fs });
    expect(status.state).toBe('not-installed');
    expect(exec.calls[0]).toEqual({ cmd: 'sc.exe', args: ['query', 'pipeline-runner@gpu-01'] });

    const uninstall = uninstallService({ platform: 'win32', env: WIN_ENV, name: 'gpu-01', invocation: { program: 'x', args: ['y'] }, exec: new FakeExec(), fs });
    expect(uninstall.definitionPath).toBeNull();
  });
});
