import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildServicePlan, winQuote } from './plan';
import { parseInstanceFlags, selectBackend } from './index';
import { parseTaskState, renderHiddenRunnerWrapper, renderTaskCreateCommand, windowsTaskBackend } from './windows-task';
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

let isStopped = false;
const RUNNING = { 
  match: '', 
  get result() {
    return { stdout: isStopped ? 'TaskName: pipeline-runner\r\nStatus: Ready\r\n' : 'TaskName: pipeline-runner\r\nStatus: Running\r\n' };
  }
};
// Update the world function to handle /End and /Run tracking for RUNNING
// Since world uses answers.find(a => args.includes(a.match)), we can make RUNNING match everything and act as default.
// Wait, actually let's just intercept /End and /Run in world()
function world(answers: Array<{ match: string; result: Partial<ServiceExecResult> }>) {
  const calls: string[][] = [];
  const fsCalls: Array<{ verb: string; path: string; content?: string }> = [];
  let stopped = false;
  const ctx: ServiceContext = {
    fs: {
      writeFileText: (path, content) => { fsCalls.push({ verb: 'write', path, content }); },
      readFileText: () => null,
      removeFile: (path) => { fsCalls.push({ verb: 'remove', path }); },
      mkdirp: (path) => { fsCalls.push({ verb: 'mkdir', path }); },
      exists: () => false,
    },
    exec: {
      run(_cmd, args) {
        calls.push(args);
        if (args.includes('/End')) stopped = true;
        if (args.includes('/Run')) stopped = false;
        
        let hit = answers.find((a) => a.match && args.includes(a.match));
        // If it's a query and we have RUNNING, but it's stopped, return Ready
        if (args.includes('/Query') && answers.includes(RUNNING)) {
          return { code: 0, stdout: stopped ? 'TaskName: pipeline-runner\r\nStatus: Ready\r\n' : 'TaskName: pipeline-runner\r\nStatus: Running\r\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '', ...(hit?.result ?? {}) };
      },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    env: {},
    platform: 'win32',
  };
  return { ctx, calls, fsCalls };
}
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

  test('the scheduler action is a GUI host, never the console-subsystem bun executable', () => {
    expect(cmd.taskRun).toStartWith('wscript.exe ');
    expect(cmd.taskRun).not.toContain('bun.exe');
    expect(cmd.createArgs[cmd.createArgs.indexOf('/TR') + 1]).toBe(cmd.taskRun);
  });

  test('the generated wrapper launches the real runner hidden, waits, and propagates its exit code', () => {
    expect(cmd.wrapperPath).toEndWith('pipeline-runner-hidden.js');
    const runnerCommand = [PLAN.invocation.program, ...PLAN.invocation.args].map(winQuote).join(' ');
    // Compare the embedded JavaScript literal, not a host-specific bun.exe
    // suffix: this pure Windows renderer is also tested on Linux CI.
    expect(cmd.wrapperContent).toContain(JSON.stringify(runnerCommand));
    expect(cmd.wrapperContent).toContain(', 0, true)');
    expect(cmd.wrapperContent).toContain('WScript.Quit(exitCode)');
  });

  test('quotes spaces, backslashes, and embedded quotes as valid JScript data', () => {
    const command = 'C:\\Program Files\\bun.exe "C:\\Some Path\\cli.ts" --label "quoted value"';
    const wrapper = renderHiddenRunnerWrapper(command);
    expect(wrapper).toContain(JSON.stringify(command));
    expect(wrapper).not.toContain(`shell.Run(${command},`);
  });

  test.skipIf(process.platform !== 'win32')('the generated wrapper really propagates a child exit code via wscript', () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-wscript-test-'));
    const file = join(root, 'wrapper.js');
    try {
      writeFileSync(file, renderHiddenRunnerWrapper('cmd.exe /d /c exit 23'));
      const result = spawnSync('wscript.exe', [file], { windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preview output includes both the wrapper and registration command without touching the machine', () => {
    const { ctx, calls, fsCalls } = world([]);
    const definition = windowsTaskBackend.generate(PLAN, ctx);
    expect(windowsTaskBackend.definitionPath(PLAN, ctx)).toEndWith('pipeline-runner-hidden.js');
    expect(definition).toContain('WScript.Shell');
    expect(definition).toContain('schtasks.exe /Create');
    expect(definition).toContain('wscript.exe');
    expect(calls).toHaveLength(0);
    expect(fsCalls).toHaveLength(0);
  });

  test('named instances receive distinct wrappers and task names', () => {
    const a = buildServicePlan({ name: 'cpu', home: 'C:\\runners\\cpu' }, 'win32', {});
    const b = buildServicePlan({ name: 'gpu', home: 'C:\\runners\\gpu' }, 'win32', {});
    const aCommand = renderTaskCreateCommand(a);
    const bCommand = renderTaskCreateCommand(b);
    expect(aCommand.wrapperPath).not.toBe(bCommand.wrapperPath);
    expect(aCommand.createArgs).toContain('pipeline-runner@cpu');
    expect(bCommand.createArgs).toContain('pipeline-runner@gpu');
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
  test('writes the wrapper before replacing and running the task', () => {
    const { ctx, calls, fsCalls } = world([RUNNING]);
    windowsTaskBackend.install(PLAN, ctx);
    const write = fsCalls.find((call) => call.verb === 'write');
    expect(write?.path).toEndWith('pipeline-runner-hidden.js');
    expect(write?.content).toContain(', 0, true)');
    expect(calls.map((args) => args[0]).slice(0, 3)).toEqual(['/End', '/Create', '/Change']);
  });

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

  test('a failed /Create is fatal, carries the real error, AND names the way past it', () => {
    // Registering in the scheduler's root folder is admin-gated on some
    // machines even though running the task afterwards is not. A bare "Access
    // is denied" sends people hunting a bug in the runner.
    const { ctx } = world([{ match: '/Create', result: { code: 1, stderr: 'ERROR: Access is denied.' } }]);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/Access is denied/);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/RunAs/);
  });

  test('a failed /Create removes the orphaned wrapper and never starts the task', () => {
    const { ctx, calls, fsCalls } = world([{ match: '/Create', result: { code: 1, stderr: 'invalid task' } }]);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/invalid task/);
    expect(fsCalls.some((call) => call.verb === 'remove' && call.path.endsWith('-hidden.js'))).toBe(true);
    expect(calls.some((args) => args.includes('/Run'))).toBe(false);
  });

  test('a failed /Run is fatal but leaves the registered definition available for diagnosis', () => {
    const { ctx, fsCalls } = world([{ match: '/Run', result: { code: 1, stderr: 'launch refused' } }]);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/launch refused/);
    expect(fsCalls.some((call) => call.verb === 'remove')).toBe(false);
  });

  test('a NON-privilege failure gets no elevation hint — the blanket advice is what people learn to ignore', () => {
    const { ctx } = world([{ match: '/Create', result: { code: 1, stderr: 'ERROR: The task XML is malformed.' } }]);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).toThrow(/malformed/);
    expect(() => windowsTaskBackend.install(PLAN, ctx)).not.toThrow(/RunAs/);
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

  test('refreshes a legacy definition before /Run and writes the hidden wrapper', () => {
    const { ctx, calls, fsCalls } = world([READY]);
    windowsTaskBackend.restart(PLAN, ctx);
    const verbs = calls.map((args) => args[0]);
    expect(verbs.indexOf('/Create')).toBeLessThan(verbs.indexOf('/Run'));
    expect(fsCalls.some((call) => call.verb === 'write' && call.content?.includes('WScript.Shell'))).toBe(true);
  });

  test('a definition refresh failure never runs a stale task', () => {
    const { ctx, calls } = world([READY, { match: '/Create', result: { code: 1, stderr: 'cannot update' } }]);
    expect(() => windowsTaskBackend.restart(PLAN, ctx)).toThrow(/cannot update/);
    expect(calls.some((args) => args.includes('/Run'))).toBe(false);
  });
});

describe('uninstall', () => {
  test('removes both an installed task and its generated wrapper', () => {
    const { ctx, calls, fsCalls } = world([RUNNING]);
    const result = windowsTaskBackend.uninstall(PLAN, ctx);
    expect(result.state).toBe('not-installed');
    expect(calls.some((args) => args.includes('/Delete'))).toBe(true);
    expect(fsCalls.some((call) => call.verb === 'remove' && call.path.endsWith('-hidden.js'))).toBe(true);
  });

  test('an already absent task still cleans up a leftover wrapper', () => {
    const { ctx, calls, fsCalls } = world([MISSING]);
    const result = windowsTaskBackend.uninstall(PLAN, ctx);
    expect(result.state).toBe('not-installed');
    expect(calls.some((args) => args.includes('/Delete'))).toBe(false);
    expect(fsCalls.some((call) => call.verb === 'remove')).toBe(true);
  });
});

describe('the --service-host flag (0.7.2 regression)', () => {
  // 0.7.2 shipped `windowsHost` as an API option with NO CLI flag behind it.
  // `service uninstall --service-host scm` therefore parsed as plain
  // `uninstall`, ran against the DEFAULT backend, and deleted the caller's
  // SCHEDULED TASK while they believed they were removing the old SCM service.
  // Observed on a real machine minutes after 0.7.2 was published.
  test('--service-host is parsed, on any verb', () => {
    expect(parseInstanceFlags(['--service-host', 'scm']).windowsHost).toBe('scm');
    expect(parseInstanceFlags(['--service-host', 'task']).windowsHost).toBe('task');
    expect(parseInstanceFlags([]).windowsHost).toBeUndefined();
  });

  test('an unknown flag is REFUSED, never ignored', () => {
    // Silently dropping a flag makes a command act on a different target than
    // the one it was asked for. A destructive verb is the worst place to
    // discover that.
    expect(() => parseInstanceFlags(['--not-a-real-flag'])).toThrow(/unknown flag/);
  });

  test('a bad --service-host value is refused rather than defaulted', () => {
    expect(() => parseInstanceFlags(['--service-host', 'systemd'])).toThrow(/must be/);
  });

  test('the flags that were always supported still parse', () => {
    const p = parseInstanceFlags(['--name', 'gpu-01', '--home', 'C:\rt', '--dry-run']);
    expect(p.name).toBe('gpu-01');
    expect(p.home).toBe('C:\rt');
  });

  test('--service-host selects the backend it names', () => {
    expect(selectBackend('win32', 'task').id).toBe('windows-task');
    expect(selectBackend('win32', 'scm').id).toBe('windows');
  });
});
