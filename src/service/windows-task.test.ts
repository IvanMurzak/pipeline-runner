import { describe, expect, test } from 'bun:test';
import { buildServicePlan } from './plan';
import { selectBackend } from './index';
import { parseTaskState, renderTaskCreateCommand, windowsTaskBackend } from './windows-task';
import { ServiceError, type ServiceContext, type ServiceExecResult } from './types';

/**
 * The Task Scheduler backend, which replaced `sc.exe` as the Windows default.
 *
 * The bug it exists for: `sc.exe create` registered `"<bun>" "<cli.ts>" start`
 * as a WIN32_OWN_PROCESS. A native service must answer the SCM within 30s; a
 * Bun script never does, so every start failed with Event 7000/7009 — while
 * `install` had reported success. Observed on a real machine 2026-08-01.
 */

const PLAN = buildServicePlan({ home: 'C:\\Users\\Dev\\.pipeline-runner' }, 'win32', {});

/** A fake exec that answers by matched arg, and records every call. */
function world(answers: Array<{ match: string; result: Partial<ServiceExecResult> }>) {
  const calls: string[][] = [];
  const ctx: ServiceContext = {
    fs: {
      writeFileText: () => {},
      readFileText: () => null,
      removeFile: () => {},
      mkdirp: () => {},
      exists: () => false,
    },
    exec: {
      run(_cmd, args) {
        calls.push(args);
        const hit = answers.find((a) => args.includes(a.match));
        return { code: 0, stdout: '', stderr: '', ...(hit?.result ?? {}) };
      },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    env: {},
    platform: 'win32',
  };
  return { ctx, calls };
}

const RUNNING = { match: '/Query', result: { stdout: 'TaskName: pipeline-runner\r\nStatus: Running\r\n' } };
const READY = { match: '/Query', result: { stdout: 'TaskName: pipeline-runner\r\nStatus: Ready\r\n' } };
const MISSING = {
  match: '/Query',
  result: { code: 1, stderr: 'ERROR: The system cannot find the file specified.' },
};

describe('win32 default backend', () => {
  test('is the scheduler, not the SCM — a Bun script cannot be a Windows service', () => {
    expect(selectBackend('win32').id).toBe('windows-task');
  });

  test('the SCM backend is still reachable for a headless box that must run logged-out', () => {
    expect(selectBackend('win32', 'scm').id).toBe('windows');
  });
});

describe('renderTaskCreateCommand (pure)', () => {
  const cmd = renderTaskCreateCommand(PLAN);

  test('runs at LOGON as the user, never elevated', () => {
    // ONSTART would run as SYSTEM before a profile is loaded — the LocalSystem
    // problem this backend exists to avoid (bun lives in %USERPROFILE%\.bun,
    // and the runner's data dir is per-user: the x22 bug class).
    expect(cmd.createArgs).toContain('ONLOGON');
    expect(cmd.createArgs).toContain('LIMITED');
    expect(cmd.createArgs).not.toContain('HIGHEST');
  });

  test('overwrites an existing task, because install is documented idempotent', () => {
    expect(cmd.createArgs).toContain('/F');
  });

  test('quotes the program and each argument — Windows paths contain spaces', () => {
    const spaced = buildServicePlan({ home: 'C:\\Users\\Some One\\.pipeline-runner' }, 'win32', {});
    expect(renderTaskCreateCommand(spaced).taskRun).toContain('"');
  });
});

describe('parseTaskState (pure)', () => {
  test('Ready means registered-and-idle, which is stopped — not an error', () => {
    expect(parseTaskState('Status: Ready')).toBe('stopped');
    expect(parseTaskState('Status: Running')).toBe('running');
    expect(parseTaskState('Status: Disabled')).toBe('stopped');
  });

  test('an unrecognised status is UNKNOWN, never guessed as stopped', () => {
    // Localised Windows prints localised words. Claiming "stopped" for a word
    // we cannot read would be inventing an observation.
    expect(parseTaskState('Status: Wird ausgeführt')).toBe('unknown');
    expect(parseTaskState('no status line at all')).toBe('unknown');
  });
});

describe('the awkward states every backend owes an answer to', () => {
  test('start on a task that is not installed THROWS and names the fix', () => {
    const { ctx } = world([MISSING]);
    expect(() => windowsTaskBackend.start(PLAN, ctx)).toThrow(ServiceError);
    try {
      windowsTaskBackend.start(PLAN, ctx);
    } catch (e) {
      expect((e as Error).message).toContain('service install');
    }
  });

  test('stop on a task that is not installed SUCCEEDS — the end state is already true', () => {
    const { ctx } = world([MISSING]);
    const r = windowsTaskBackend.stop(PLAN, ctx);
    expect(r.state).toBe('not-installed');
    expect(r.messages.join(' ')).toContain('nothing to stop');
  });

  test('start on a running task says "already", never "started"', () => {
    const { ctx, calls } = world([RUNNING]);
    const r = windowsTaskBackend.start(PLAN, ctx);
    expect(r.messages.join(' ')).toContain('already running');
    expect(calls.some((c) => c.includes('/Run'))).toBe(false); // idempotent: nothing done
  });

  test('a start the scheduler has not confirmed claims nothing more than it knows', () => {
    // /Run returns before the process is necessarily up. Reporting "started"
    // off a Ready read would be asserting an observation we do not have.
    const { ctx } = world([READY]);
    const r = windowsTaskBackend.start(PLAN, ctx);
    expect(r.state).toBe('stopped');
    expect(r.messages.join(' ')).toContain('has not yet reported');
  });
});

describe('install', () => {
  test('ends RUNNING, not merely registered, and records every command it ran', () => {
    const { ctx } = world([RUNNING]);
    const r = windowsTaskBackend.install(PLAN, ctx);
    const verbs = r.commands.map((c) => c.args[0]);
    expect(verbs).toContain('/Create');
    expect(verbs).toContain('/Run');
    expect(r.state).toBe('running');
    expect(r.enabled).toBe(true);
  });

  test('a failed restart-on-failure warns and keeps the install — it does not roll back', () => {
    const { ctx } = world([RUNNING, { match: '/Change', result: { code: 1, stderr: 'nope' } }]);
    const r = windowsTaskBackend.install(PLAN, ctx);
    expect(r.state).toBe('running'); // still installed and started
    expect(r.messages.join(' ')).toContain('restart-on-failure could not be configured');
  });

  test('a failed /Create is fatal and carries the real error text', () => {
    const { ctx } = world([{ match: '/Create', result: { code: 1, stderr: 'ERROR: Access is denied.' } }]);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/Access is denied/);
  });
});

describe('restart — the verb an upgrade depends on', () => {
  test('ends the running task, then runs it again', () => {
    const { ctx } = world([RUNNING]);
    const r = windowsTaskBackend.restart(PLAN, ctx);
    const verbs = r.commands.map((c) => c.args[0]);
    expect(verbs).toContain('/End');
    expect(verbs).toContain('/Run');
    expect(r.state).toBe('running');
  });

  test('does not try to end a task that is not running', () => {
    const { ctx } = world([READY]);
    const r = windowsTaskBackend.restart(PLAN, ctx);
    expect(r.commands.map((c) => c.args[0])).not.toContain('/End');
  });
});
