import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_IDENTITY,
  installService,
  renderSystemdUnit,
  type ServicePlan,
  serviceStatus,
  ServiceError,
  systemdUnitName,
  systemdUnitPath,
  uninstallService,
} from '../src/service';
import { FakeExec, FakeServiceFs } from './_service-helpers';

const ENV = { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config' };

function plan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    identity: DEFAULT_IDENTITY,
    invocation: { program: '/usr/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] },
    workingDirectory: '/opt/agent/src',
    environment: { HOME: '/home/u' },
    configDir: '/home/u/.config/pipeline-runner',
    ...overrides,
  };
}

const OPTS = {
  platform: 'linux',
  env: ENV,
  invocation: { program: '/usr/bin/bun', args: ['/opt/agent/src/cli.ts', 'start'] },
  workingDirectory: '/opt/agent/src',
  environment: { HOME: '/home/u' },
  configDir: '/home/u/.config/pipeline-runner',
};

const UNIT_PATH = join('/home/u/.config', 'systemd', 'user', 'pipeline-runner.service');

describe('renderSystemdUnit (pure)', () => {
  test('emits [Unit]/[Service]/[Install] with the required fields', () => {
    const unit = renderSystemdUnit(plan());
    expect(unit).toContain('[Unit]');
    expect(unit).toContain(`Description=${DEFAULT_IDENTITY.description}`);
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('ExecStart=/usr/bin/bun /opt/agent/src/cli.ts start');
    expect(unit).toContain('WorkingDirectory=/opt/agent/src');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('Environment=HOME=/home/u');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  test('quotes ExecStart tokens that contain spaces', () => {
    const unit = renderSystemdUnit(
      plan({ invocation: { program: '/opt/my apps/bun', args: ['/opt/agent/src/cli.ts', 'start'] } })
    );
    expect(unit).toContain('ExecStart="/opt/my apps/bun" /opt/agent/src/cli.ts start');
  });

  test('never embeds a secret — only how to run the daemon', () => {
    const unit = renderSystemdUnit(plan());
    expect(unit.toLowerCase()).not.toContain('token');
  });
});

describe('systemd install', () => {
  test('writes the unit and reloads + enables --now', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs();
    const result = installService({ ...OPTS, exec, fs });

    expect(fs.files.get(UNIT_PATH)).toContain('ExecStart=/usr/bin/bun /opt/agent/src/cli.ts start');
    expect(fs.dirs.has(join('/home/u/.config', 'systemd', 'user'))).toBe(true);
    expect(exec.sequence).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now pipeline-runner.service',
    ]);
    expect(result.action).toBe('install');
    expect(result.backend).toBe('systemd');
    expect(result.definitionPath).toBe(UNIT_PATH);
  });

  test('daemon-reload failure throws a ServiceError with a logind hint', () => {
    const exec = new FakeExec(({ args }) =>
      args.includes('daemon-reload') ? { code: 1, stderr: 'Failed to connect to bus: No such file or directory' } : {}
    );
    expect(() => installService({ ...OPTS, exec, fs: new FakeServiceFs() })).toThrow(ServiceError);
    try {
      installService({ ...OPTS, exec: new FakeExec(({ args }) =>
        args.includes('daemon-reload') ? { code: 1, stderr: 'Failed to connect to bus' } : {}
      ), fs: new FakeServiceFs() });
    } catch (err) {
      expect((err as Error).message).toContain('enable-linger');
    }
  });
});

describe('systemd uninstall', () => {
  test('disables --now, removes the unit, reloads', () => {
    const exec = new FakeExec();
    const fs = new FakeServiceFs().seed(UNIT_PATH, 'x');
    const result = uninstallService({ ...OPTS, exec, fs });

    expect(exec.sequence).toEqual([
      'systemctl --user disable --now pipeline-runner.service',
      'systemctl --user daemon-reload',
    ]);
    expect(fs.removed).toContain(UNIT_PATH);
    expect(fs.exists(UNIT_PATH)).toBe(false);
    expect(result.action).toBe('uninstall');
  });
});

describe('systemd status', () => {
  test('not-installed when the unit file is absent (no systemctl call)', () => {
    const exec = new FakeExec();
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs() });
    expect(result.state).toBe('not-installed');
    expect(result.enabled).toBe(false);
    expect(exec.calls).toHaveLength(0);
  });

  test('running + enabled parsed from is-active/is-enabled', () => {
    const exec = new FakeExec(({ args }) => {
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n' };
      if (args.includes('is-enabled')) return { code: 0, stdout: 'enabled\n' };
      return {};
    });
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs().seed(UNIT_PATH, 'x') });
    expect(result.state).toBe('running');
    expect(result.enabled).toBe(true);
  });

  test('stopped + disabled', () => {
    const exec = new FakeExec(({ args }) => {
      if (args.includes('is-active')) return { code: 3, stdout: 'inactive\n' };
      if (args.includes('is-enabled')) return { code: 1, stdout: 'disabled\n' };
      return {};
    });
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs().seed(UNIT_PATH, 'x') });
    expect(result.state).toBe('stopped');
    expect(result.enabled).toBe(false);
  });
});

describe('systemd path helpers', () => {
  test('unit name + path', () => {
    expect(systemdUnitName(plan())).toBe('pipeline-runner.service');
    expect(systemdUnitPath(plan(), ENV)).toBe(UNIT_PATH);
  });
});
