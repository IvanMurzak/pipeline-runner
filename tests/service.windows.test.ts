import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_IDENTITY,
  installService,
  renderWindowsCreateCommand,
  renderWindowsFailureCommand,
  type ServicePlan,
  serviceStatus,
  ServiceError,
  uninstallService,
} from '../src/service';
import { FakeExec, FakeServiceFs } from './_service-helpers';

function plan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    identity: DEFAULT_IDENTITY,
    invocation: {
      program: 'C:\\Program Files\\bun\\bun.exe',
      args: ['C:\\opt\\agent\\src\\cli.ts', 'start'],
    },
    workingDirectory: 'C:\\opt\\agent\\src',
    environment: {},
    configDir: 'C:\\Users\\u\\AppData\\Roaming\\pipeline-runner',
    ...overrides,
  };
}

const OPTS = {
  platform: 'win32',
  env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
  invocation: {
    program: 'C:\\Program Files\\bun\\bun.exe',
    args: ['C:\\opt\\agent\\src\\cli.ts', 'start'],
  },
  workingDirectory: 'C:\\opt\\agent\\src',
  environment: {},
  configDir: 'C:\\Users\\u\\AppData\\Roaming\\pipeline-runner',
};

describe('renderWindowsCreateCommand (pure)', () => {
  test('quotes the spaced runtime path in binPath, leaves bare tokens bare', () => {
    const cmd = renderWindowsCreateCommand(plan());
    expect(cmd.binPath).toBe('"C:\\Program Files\\bun\\bun.exe" C:\\opt\\agent\\src\\cli.ts start');
  });

  test('a runtime path without spaces is not quoted', () => {
    const cmd = renderWindowsCreateCommand(
      plan({ invocation: { program: 'C:\\bun\\bun.exe', args: ['C:\\agent\\cli.ts', 'start'] } })
    );
    expect(cmd.binPath).toBe('C:\\bun\\bun.exe C:\\agent\\cli.ts start');
  });

  test('createArgs use sc.exe key=/value token pairs (space after =)', () => {
    const cmd = renderWindowsCreateCommand(plan());
    expect(cmd.createArgs).toEqual([
      'create',
      'pipeline-runner',
      'binPath=',
      '"C:\\Program Files\\bun\\bun.exe" C:\\opt\\agent\\src\\cli.ts start',
      'start=',
      'auto',
      'DisplayName=',
      'Pipeline Runner',
    ]);
    expect(cmd.descriptionArgs).toEqual(['description', 'pipeline-runner', DEFAULT_IDENTITY.description]);
  });

  test('commandLine is a copy-pasteable sc.exe create with quoted binPath', () => {
    const cmd = renderWindowsCreateCommand(plan());
    expect(cmd.commandLine).toBe(
      'sc.exe create pipeline-runner binPath= "\\"C:\\Program Files\\bun\\bun.exe\\" C:\\opt\\agent\\src\\cli.ts start" ' +
        'start= auto DisplayName= "Pipeline Runner"'
    );
  });
});

describe('renderWindowsFailureCommand (pure)', () => {
  test('args use sc.exe key=/value token pairs (space after =), 24h reset + 5s restart', () => {
    const cmd = renderWindowsFailureCommand('pipeline-runner');
    expect(cmd.args).toEqual([
      'failure',
      'pipeline-runner',
      'reset=',
      '86400',
      'actions=',
      'restart/5000',
    ]);
  });

  test('commandLine is copy-pasteable', () => {
    const cmd = renderWindowsFailureCommand('pipeline-runner');
    expect(cmd.commandLine).toBe('sc.exe failure pipeline-runner reset= 86400 actions= restart/5000');
  });
});

describe('windows install', () => {
  test('best-effort stop+delete, then create/failure/description/start (overwrite semantics)', () => {
    const exec = new FakeExec();
    const result = installService({ ...OPTS, exec, fs: new FakeServiceFs() });

    expect(exec.calls[0]).toEqual({ cmd: 'sc.exe', args: ['stop', 'pipeline-runner'] });
    expect(exec.calls[1]).toEqual({ cmd: 'sc.exe', args: ['delete', 'pipeline-runner'] });
    expect(exec.calls[2]?.args).toEqual(renderWindowsCreateCommand(plan()).createArgs);
    expect(exec.calls[3]?.args).toEqual(renderWindowsFailureCommand('pipeline-runner').args);
    expect(exec.calls[4]).toEqual({
      cmd: 'sc.exe',
      args: ['description', 'pipeline-runner', DEFAULT_IDENTITY.description],
    });
    expect(exec.calls[5]).toEqual({ cmd: 'sc.exe', args: ['start', 'pipeline-runner'] });
    expect(result.definitionPath).toBeNull();
    expect(result.backend).toBe('windows');
    expect(result.messages.some((m) => m.includes('crash recovery'))).toBe(true);
    expect(result.messages.some((m) => m.includes('qfailure'))).toBe(true);
  });

  test('sc create failure throws a ServiceError with an elevation hint', () => {
    const exec = new FakeExec(({ args }) =>
      args[0] === 'create' ? { code: 5, stderr: 'Access is denied.' } : {}
    );
    try {
      installService({ ...OPTS, exec, fs: new FakeServiceFs() });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as Error).message).toContain('Administrator');
    }
  });

  test('sc failure (recovery-action config) failure throws a ServiceError with an elevation hint, and skips description/start', () => {
    const exec = new FakeExec(({ args }) =>
      args[0] === 'failure' ? { code: 5, stderr: 'Access is denied.' } : {}
    );
    try {
      installService({ ...OPTS, exec, fs: new FakeServiceFs() });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as Error).message).toContain('Administrator');
      expect((err as Error).message).toContain('failure actions');
    }
    expect(exec.calls.some((c) => c.args[0] === 'description')).toBe(false);
    expect(exec.calls.some((c) => c.args[0] === 'start')).toBe(false);
  });
});

describe('windows uninstall', () => {
  test('stop then delete', () => {
    const exec = new FakeExec();
    uninstallService({ ...OPTS, exec, fs: new FakeServiceFs() });
    expect(exec.sequence).toEqual(['sc.exe stop pipeline-runner', 'sc.exe delete pipeline-runner']);
  });

  test('a missing service on delete (1060) is not an error', () => {
    const exec = new FakeExec(({ args }) =>
      args[0] === 'delete' ? { code: 1060, stderr: 'The specified service does not exist as an installed service.' } : {}
    );
    expect(() => uninstallService({ ...OPTS, exec, fs: new FakeServiceFs() })).not.toThrow();
  });

  test('a real delete failure (access denied) throws', () => {
    const exec = new FakeExec(({ args }) => (args[0] === 'delete' ? { code: 5, stderr: 'Access is denied.' } : {}));
    expect(() => uninstallService({ ...OPTS, exec, fs: new FakeServiceFs() })).toThrow(ServiceError);
  });
});

describe('windows status', () => {
  test('not-installed when sc query returns 1060', () => {
    const exec = new FakeExec(() => ({ code: 1060, stderr: 'The specified service does not exist as an installed service.' }));
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs() });
    expect(result.state).toBe('not-installed');
    expect(exec.calls).toHaveLength(1); // no qc call after not-installed
  });

  test('running + auto-start parsed from query/qc', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { code: 0, stdout: 'SERVICE_NAME: pipeline-runner\n  STATE : 4  RUNNING\n' };
      if (args[0] === 'qc') return { code: 0, stdout: '  START_TYPE : 2   AUTO_START\n' };
      return {};
    });
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs() });
    expect(result.state).toBe('running');
    expect(result.enabled).toBe(true);
  });

  test('stopped + manual', () => {
    const exec = new FakeExec(({ args }) => {
      if (args[0] === 'query') return { code: 0, stdout: '  STATE : 1  STOPPED\n' };
      if (args[0] === 'qc') return { code: 0, stdout: '  START_TYPE : 3   DEMAND_START\n' };
      return {};
    });
    const result = serviceStatus({ ...OPTS, exec, fs: new FakeServiceFs() });
    expect(result.state).toBe('stopped');
    expect(result.enabled).toBe(false);
  });
});
