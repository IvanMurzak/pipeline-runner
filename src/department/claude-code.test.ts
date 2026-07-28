/**
 * `claude-code` engine-module tests (simplified-onboarding b3; design
 * `06-engine-modules.md` §4, `07-approval-policy.md` §8, D23/D24/D28).
 *
 * Three things are worth proving about a module whose whole job is to spawn
 * someone else's CLI: that the invocation it builds is the one the vendor
 * actually accepts (asserted against flags verified from `claude --help`
 * v2.1.220), that no credential ever reaches a place a credential must not be,
 * and that every way the session can fail produces a STATED reason rather than
 * a silence. The stream frames driven below are real, captured shapes from a
 * live `claude --print --output-format stream-json` run — including the two
 * that would have been guessed wrong: an unauthenticated session reports
 * `subtype:"success"` alongside `is_error:true`, and a session whose receiver
 * tools have ALL started refusing still ends `is_error:false` (x16 — the P4
 * gate's false `completed`, driven frame for frame below).
 */

import { describe, expect, test } from 'bun:test';
import type { Clock } from '../core/clock';
import type { Logger } from '../core/log';
import type { InvocationEnvelope, RuntimeEvent } from './adapter';
import { RuntimeAdapterError } from './adapter';
import {
  assistantProgressNotes,
  buildClaudeArgs,
  buildDepartmentMcpConfig,
  buildMcpHeadersHelperCommand,
  buildPromptLines,
  buildSessionContext,
  ClaudeCodeAdapter,
  DEPARTMENT_MCP_SERVER_NAME,
  EXECUTION_ID_PATTERN,
  BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON,
  backgroundTaskIds,
  initFrameListsReceiverTools,
  MAX_TRACKED_RECEIVER_CALLS,
  mcpServerStatus,
  narrowResultFrame,
  NO_REPORT_CHANNEL_FAILURE_REASON,
  RECEIVER_TOOLS,
  receiverToolNames,
  receiverToolUseIds,
  redactSensitive,
  sanitizeMcpToolName,
  SESSION_STARTED_STATUS_MESSAGE,
  TERMINAL_REPORT_REFUSED_FAILURE_REASON,
  TERMINAL_RECEIVER_TOOLS,
  terminalReceiverToolNames,
  toolResultOutcomes,
  UNREPORTED_FAILURE_REASON,
} from './claude-code';
import {
  ENGINE_MCP_HELPER_SECRET_ENV,
  ENGINE_MCP_HELPER_URL_ENV,
  ENGINE_MCP_TOKEN_ENV,
  ENGINE_MCP_URL_ENV,
  EngineMcpUnavailableError,
} from './engine';
// x36: the one adapter that already produced a `status` event — its narrower is
// the contract this module's announcement is checked against.
import { narrowRuntimeEvent } from './jsonl-process';
import { FakeJobSpawn, makeMessage, makeTaskSpec } from './_test-helpers';

const MCP_URL = 'https://ai-pipeline.dev/mcp';
const TOKEN = 'eyJhbGciOi-super-secret-execution-token';
/** x21: the id the envelope now carries and the engine puts on the helper's
 *  argv. An identifier, never a credential — see `InvocationEnvelope`. */
const EXECUTION_ID = 'dexec-42';
/** x21: the loopback grant the supervisor injects. BOTH are secrets in the
 *  same sense the token is, and neither may reach a command line. */
const HELPER_URL = 'http://127.0.0.1:51234/mcp-headers';
const HELPER_SECRET = 'f00dbabe-loopback-grant-secret-32-bytes';

/** A clock whose timers never fire on their own — every test that needs one to
 *  fire drives it explicitly, so nothing here depends on wall time. */
function fakeClock(): Clock & { fire(): void; pending: number } {
  const timers: (() => void)[] = [];
  return {
    setTimeout(fn: () => void) {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeout(handle: unknown) {
      const index = handle as number;
      if (typeof index === 'number' && timers[index] !== undefined) timers[index] = () => {};
    },
    now: () => 1_700_000_000_000,
    fire() {
      const pending = [...timers];
      timers.length = 0;
      for (const fn of pending) fn();
    },
    get pending() {
      return timers.length;
    },
  };
}

function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };
  return { lines, debug: push, info: push, warn: push, error: push };
}

function makeMcpInvocation(overrides: Partial<InvocationEnvelope['runtime']> = {}, executionId = EXECUTION_ID): InvocationEnvelope {
  return {
    executionId,
    runtime: {
      adapterId: 'claude-code',
      command: 'claude',
      cwd: '/srv/departments/save-system',
      env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN },
      ...overrides,
    },
    task: makeTaskSpec({ messages: [makeMessage({ parts: [{ text: 'review the save system' }] })] }),
  };
}

/** The `system`/`init` line Claude Code emits first, trimmed to the fields
 *  this module reads. */
function initFrame(status = 'connected', serverName = DEPARTMENT_MCP_SERVER_NAME): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    cwd: '/srv/departments/save-system',
    mcp_servers: [{ name: serverName, status }],
    permissionMode: 'acceptEdits',
  };
}

/** Start a session and return everything a test needs to drive it. */
async function startSession(
  options: { status?: string; adapter?: ClaudeCodeAdapter; spawn?: FakeJobSpawn; invocation?: InvocationEnvelope } = {}
): Promise<{ spawn: FakeJobSpawn; adapter: ClaudeCodeAdapter; events: RuntimeEvent[]; handle: Awaited<ReturnType<ClaudeCodeAdapter['start']>> }> {
  const spawn = options.spawn ?? new FakeJobSpawn();
  const adapter = options.adapter ?? new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
  const events: RuntimeEvent[] = [];
  const started = adapter.start(options.invocation ?? makeMcpInvocation(), (event) => events.push(event));
  spawn.last.emitJson(initFrame(options.status ?? 'connected'));
  const handle = await started;
  // x36: every session now announces `WORKING` as it starts (its own describe
  // below owns that assertion, on a start this helper does not perform). The
  // tests here are about what the session does NEXT, so the announcement is
  // drained rather than prepended to twenty expectations that are not about it.
  expect(events.shift()).toEqual({ type: 'status', state: 'WORKING', message: SESSION_STARTED_STATUS_MESSAGE });
  return { spawn, adapter, events, handle };
}

// ── The invocation it builds ───────────────────────────────────────────────

describe('the argv (verified against `claude --help`, v2.1.220)', () => {
  test('is a headless stream-json session whose prompt arrives on stdin, not argv', () => {
    const args = buildClaudeArgs({ sessionContext: 'ctx' });
    expect(args).toContain('--print');
    // Not decorative: the CLI exits with "When using --print,
    // --output-format=stream-json requires --verbose" without it.
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    // Responsibility 2: stdin is the prompt channel AND the mid-task channel.
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
  });

  test('states a permission mode and the department-only setting scopes (07 §8)', () => {
    const args = buildClaudeArgs({ sessionContext: 'ctx' });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // The department folder's own settings, not the operator's personal ones.
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  test('never passes --strict-mcp-config (D28) — it would disable the department\'s own servers', () => {
    expect(buildClaudeArgs({ sessionContext: 'ctx' })).not.toContain('--strict-mcp-config');
  });

  test('pre-approves exactly the nine receiver tools, by name', () => {
    const args = buildClaudeArgs({ sessionContext: 'ctx' });
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(receiverToolNames());
    expect(allowed).toHaveLength(9);
    expect(allowed).toContain(`mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_update_progress`);
    expect(allowed).toContain(`mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_complete`);
    expect(new Set(RECEIVER_TOOLS).size).toBe(9);
  });

  test('the allow-list carries the CALLABLE names, not the wire names — dots become underscores', () => {
    // Observed for real before this was handled: a live session ended with
    // "Both department tool calls were denied at the permission prompt, so
    // nothing was reported to the sender". Claude Code normalizes an MCP tool
    // name with `[^a-zA-Z0-9_] → _`, so an allow-list spelled
    // `…__task.complete` matches the callable `…__task_complete` never.
    expect(sanitizeMcpToolName('task.update_progress')).toBe('task_update_progress');
    for (const name of receiverToolNames()) expect(name).not.toContain('.');
    // …and the wire names, which the gateway actually registers, keep theirs.
    for (const tool of RECEIVER_TOOLS) expect(tool).toContain('.');
  });

  test('the MCP server key can never contain `__`, which would make every tool name unparseable', () => {
    // `mcp__<server>__<tool>` is split on `__` and index 1 is taken as the
    // server, so a key carrying `__` silently renames every tool.
    expect(DEPARTMENT_MCP_SERVER_NAME).not.toContain('__');
  });

  test('metadata is context, never concatenated into the prompt (06 §4)', () => {
    const task = makeTaskSpec({
      messages: [makeMessage({ parts: [{ text: 'review the save system' }], metadata: { sender: 'ivan@acme', skill: 'review' } })],
    });
    const args = buildClaudeArgs({ sessionContext: buildSessionContext(task) });
    const context = args[args.indexOf('--append-system-prompt') + 1]!;
    expect(context).toContain(task.taskId);
    expect(context).toContain('ivan@acme');
    // …and the prompt line itself carries the sender's text and nothing else.
    const prompt = JSON.parse(buildPromptLines(task)[0]!) as { message: { content: { text: string }[] } };
    expect(prompt.message.content[0]!.text).toBe('review the save system');
    expect(prompt.message.content[0]!.text).not.toContain('ivan@acme');
    expect(prompt.message.content[0]!.text).not.toContain(task.taskId);
  });

  test('a replayed history contributes the sender\'s turns only — never the session\'s own past output', () => {
    const task = makeTaskSpec({
      messages: [
        makeMessage({ messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'first' }] }),
        makeMessage({ messageId: 'm2', role: 'ROLE_AGENT', parts: [{ text: 'my own earlier answer' }] }),
        makeMessage({ messageId: 'm3', role: 'ROLE_USER', parts: [{ text: 'second' }] }),
      ],
    });
    const texts = buildPromptLines(task).map((line) => (JSON.parse(line) as { message: { content: { text: string }[] } }).message.content[0]!.text);
    expect(texts).toEqual(['first', 'second']);
  });

  test('the session context tells the model the one thing it cannot discover: unreported work reaches nobody', () => {
    const context = buildSessionContext(makeTaskSpec());
    expect(context).toContain(`mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_complete`);
    expect(context).toContain(`mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_fail`);
    expect(context).toContain('reaches nobody');
  });
});

describe('the --mcp-config payload (D23)', () => {
  test('carries `${VAR}` references, so neither the URL nor the bearer is ever on a command line', () => {
    const json = buildDepartmentMcpConfig();
    expect(json).toContain(`\${${ENGINE_MCP_URL_ENV}}`);
    expect(json).toContain(`Bearer \${${ENGINE_MCP_TOKEN_ENV}}`);
    const parsed = JSON.parse(json) as { mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    const server = parsed.mcpServers[DEPARTMENT_MCP_SERVER_NAME]!;
    expect(server.type).toBe('http');
    expect(server.url).toBe(`\${${ENGINE_MCP_URL_ENV}}`);
    expect(server.headers.Authorization).toBe(`Bearer \${${ENGINE_MCP_TOKEN_ENV}}`);
  });

  test('a configured headersHelper REPLACES the static header rather than joining it', () => {
    const json = buildDepartmentMcpConfig({ headersHelper: '/opt/runner/mcp-headers' });
    const server = (JSON.parse(json) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers[DEPARTMENT_MCP_SERVER_NAME]!;
    expect(server.headersHelper).toBe('/opt/runner/mcp-headers');
    // Both at once would let a stale static header win the connect that the
    // helper exists to refresh.
    expect(server.headers).toBeUndefined();
  });
});

// ── x21: the headers helper the module now builds for itself (D33) ─────────

/** An adapter wired with deterministic paths, so the argv assertions below
 *  read the command this module builds rather than the test runner's own
 *  install locations. */
function helperAdapter(spawn: FakeJobSpawn, options: { logger?: Logger & { lines: string[] }; scriptExists?: boolean } = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    spawn,
    clock: fakeClock(),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    bunPath: '/usr/local/bin/bun',
    helperScriptPath: '/opt/pipeline-runner/src/department/mcp-headers-helper.ts',
    helperScriptExists: () => options.scriptExists ?? true,
  });
}

/** The `--mcp-config` entry the adapter actually spawned with. */
function spawnedMcpServer(spawn: FakeJobSpawn): Record<string, unknown> {
  const args = spawn.calls[spawn.calls.length - 1]!.args;
  const json = args[args.indexOf('--mcp-config') + 1]!;
  return (JSON.parse(json) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers[DEPARTMENT_MCP_SERVER_NAME]!;
}

const helperEnv = { [ENGINE_MCP_HELPER_URL_ENV]: HELPER_URL, [ENGINE_MCP_HELPER_SECRET_ENV]: HELPER_SECRET };

describe('x21: surviving an execution token that expires mid-task (D23 as amended by D33)', () => {
  test('buildMcpHeadersHelperCommand names the two paths and the execution — and nothing else', () => {
    expect(
      buildMcpHeadersHelperCommand({ executionId: 'dexec-42', bunPath: '/usr/local/bin/bun', scriptPath: '/opt/r/helper.ts' })
    ).toBe('"/usr/local/bin/bun" "/opt/r/helper.ts" "dexec-42"');
    // Windows paths quote the same way — the command is run with `shell:true`,
    // which is `cmd.exe /d /s /c` there and `sh -c` everywhere else.
    expect(
      buildMcpHeadersHelperCommand({
        executionId: 'dexec-42',
        bunPath: 'C:\\Program Files\\bun\\bun.exe',
        scriptPath: 'C:\\pipeline\\helper.ts',
      })
    ).toBe('"C:\\Program Files\\bun\\bun.exe" "C:\\pipeline\\helper.ts" "dexec-42"');
  });

  test('an execution id that is not an identifier is REFUSED, never escaped', () => {
    // `execution_id` arrives from the cloud, and this command reaches a shell.
    // An allow-list is the check that makes putting it there defensible;
    // escaping for two shells at once is how injection bugs get written.
    const attacks = ['exec-1"; rm -rf /', 'exec-1 && curl evil', '$(id)', '`id`', 'exec\n1', '%PATH%', ''];
    for (const executionId of attacks) {
      expect(buildMcpHeadersHelperCommand({ executionId, bunPath: '/bun', scriptPath: '/h.ts' })).toBeNull();
    }
    expect(EXECUTION_ID_PATTERN.test('dexec-42')).toBe(true);
  });

  test('an install path that cannot be quoted for both shells is refused too', () => {
    for (const bunPath of ['/opt/b"n/bun', '/opt/$HOME/bun', '/opt/%TEMP%/bun', '/opt/bun\\']) {
      expect(buildMcpHeadersHelperCommand({ executionId: 'dexec-42', bunPath, scriptPath: '/h.ts' })).toBeNull();
    }
  });

  test('with a loopback grant injected, the session gets a headersHelper instead of a static header', async () => {
    const spawn = new FakeJobSpawn();
    await startSession({ spawn, adapter: helperAdapter(spawn), invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }) });

    const server = spawnedMcpServer(spawn);
    // The mechanism D23 specified and b3 could not build: re-runs on connect
    // and automatically on 401/403, so a token that dies mid-task is replaced
    // instead of ending the session's ability to report anything.
    expect(server.headersHelper).toBe('"/usr/local/bin/bun" "/opt/pipeline-runner/src/department/mcp-headers-helper.ts" "dexec-42"');
    expect(server.headers).toBeUndefined();
  });

  test('the helper command names the execution — which is why the envelope had to carry it', async () => {
    const spawn = new FakeJobSpawn();
    await startSession({
      spawn,
      adapter: helperAdapter(spawn),
      invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }, 'dexec-other'),
    });
    expect(spawnedMcpServer(spawn).headersHelper).toContain('"dexec-other"');
  });

  test('neither the bearer nor the loopback secret is anywhere on the command line', async () => {
    const spawn = new FakeJobSpawn();
    await startSession({ spawn, adapter: helperAdapter(spawn), invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }) });

    const call = spawn.calls[spawn.calls.length - 1]!;
    const argv = [call.cmd, ...call.args].join(' ');
    // x20's standard, applied to a second command line: `/proc/<pid>/cmdline`
    // is world-readable (0444), `/proc/<pid>/environ` is owner-only (0400).
    // Both credentials travel by environment; the argv carries two paths and
    // an identifier.
    expect(argv).not.toContain(TOKEN);
    expect(argv).not.toContain(HELPER_SECRET);
    expect(argv).not.toContain(HELPER_URL);
    // …and both are in the environment block that was actually passed.
    expect(call.opts?.env?.[ENGINE_MCP_HELPER_SECRET_ENV]).toBe(HELPER_SECRET);
    expect(call.opts?.env?.[ENGINE_MCP_TOKEN_ENV]).toBe(TOKEN);
  });

  test('no grant injected ⇒ the pre-x21 static header, unchanged — this is the normal degraded state', async () => {
    const spawn = new FakeJobSpawn();
    await startSession({ spawn, adapter: helperAdapter(spawn) });
    const server = spawnedMcpServer(spawn);
    expect(server.headersHelper).toBeUndefined();
    expect(server.headers).toEqual({ Authorization: `Bearer \${${ENGINE_MCP_TOKEN_ENV}}` });
  });

  test('half a grant is no grant — a URL without a secret is not wired', async () => {
    const spawn = new FakeJobSpawn();
    await startSession({
      spawn,
      adapter: helperAdapter(spawn),
      invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, [ENGINE_MCP_HELPER_URL_ENV]: HELPER_URL } }),
    });
    expect(spawnedMcpServer(spawn).headersHelper).toBeUndefined();
  });

  test('a missing helper program falls back to the static header, loudly — a helper pointing at nothing breaks the CONNECT', async () => {
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    await startSession({
      spawn,
      adapter: helperAdapter(spawn, { logger, scriptExists: false }),
      invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }),
    });
    expect(spawnedMcpServer(spawn).headersHelper).toBeUndefined();
    expect(spawnedMcpServer(spawn).headers).toBeDefined();
    expect(logger.lines.join('\n')).toContain('cannot re-authorize');
  });

  test('an unquotable execution id falls back rather than refusing to start (D24 is about reporting NOTHING)', async () => {
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    await startSession({
      spawn,
      adapter: helperAdapter(spawn, { logger }),
      invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }, 'exec"; id #'),
    });
    expect(spawnedMcpServer(spawn).headersHelper).toBeUndefined();
    expect(logger.lines.join('\n')).toContain('not safe to place in a shell command');
  });

  test('an operator-configured helper still wins over the one we build', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), headersHelper: '/opt/site/mcp-headers' });
    await startSession({
      spawn,
      adapter,
      invocation: makeMcpInvocation({ env: { [ENGINE_MCP_URL_ENV]: MCP_URL, [ENGINE_MCP_TOKEN_ENV]: TOKEN, ...helperEnv } }),
    });
    expect(spawnedMcpServer(spawn).headersHelper).toBe('/opt/site/mcp-headers');
  });
});

// ── Responsibility 4: refusing rather than running blind (D24) ─────────────

describe('refusing rather than running blind (D24)', () => {
  test('declares the contract b3 exists to satisfy', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.id).toBe('claude-code');
    expect(adapter.engine).toBe('claude-code');
    expect(adapter.requiresMcpConnection).toBe(true);
    expect(adapter.engineCapabilities.acceptsMidTaskInput).toBe('yes');
  });

  test('no MCP env ⇒ start() rejects and NOTHING is spawned', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const invocation = makeMcpInvocation({ env: {} });
    await expect(adapter.start(invocation, () => {})).rejects.toThrow(EngineMcpUnavailableError);
    // The point of the refusal: no session exists to leave orphaned.
    expect(spawn.calls).toHaveLength(0);
  });

  test('a session whose department server did not connect is refused, not run', async () => {
    for (const status of ['failed', 'needs-auth', 'disabled', 'absent-from-the-list']) {
      const spawn = new FakeJobSpawn();
      const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
      const started = adapter.start(makeMcpInvocation(), () => {});
      spawn.last.emitJson(
        status === 'absent-from-the-list' ? initFrame('connected', 'some-other-server') : initFrame(status)
      );
      await expect(started).rejects.toThrow(EngineMcpUnavailableError);
      // …and the half-started session is force-killed, not left running.
      expect(spawn.last.killedGroupWith).toContain('SIGKILL');
    }
  });

  test('an older CLI that reports no server list is tolerated with a warning, not refused', async () => {
    const spawn = new FakeJobSpawn();
    const logger = capturingLogger();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const started = adapter.start(makeMcpInvocation(), () => {});
    const frame = initFrame();
    delete frame.mcp_servers;
    spawn.last.emitJson(frame);
    await expect(started).resolves.toBeDefined();
    expect(logger.lines.some((line) => line.includes('could not be verified'))).toBe(true);
  });

  test('the refusal never names the URL or the token', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const started = adapter.start(makeMcpInvocation(), () => {});
    spawn.last.emitJson(initFrame('needs-auth'));
    await started.then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: unknown) => {
        expect((err as Error).message).not.toContain(MCP_URL);
        expect((err as Error).message).not.toContain(TOKEN);
        expect((err as Error).message).toContain('needs-auth');
      }
    );
  });

  test('mcpServerStatus tells `cannot verify` (null) apart from `did not load` (absent)', () => {
    expect(mcpServerStatus({ type: 'system' }, 'x')).toBeNull();
    expect(mcpServerStatus({ mcp_servers: [] }, 'x')).toBe('absent');
    expect(mcpServerStatus({ mcp_servers: [{ name: 'x', status: 'connected' }] }, 'x')).toBe('connected');
    expect(mcpServerStatus({ mcp_servers: [{ name: 'x' }] }, 'x')).toBe('unknown');
  });
});

// ── Secrets discipline (10-security.md §6, a6's precedent) ─────────────────

describe('the bearer never leaves the environment', () => {
  test('it is absent from argv, from every log line, and from every event', async () => {
    const spawn = new FakeJobSpawn();
    const logger = capturingLogger();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const { events } = await startSession({ spawn, adapter });

    const call = spawn.calls[0]!;
    expect(call.cmd).toBe('claude');
    for (const arg of call.args) {
      expect(arg).not.toContain(TOKEN);
      expect(arg).not.toContain(MCP_URL);
    }
    // It travels the ONE way it is allowed to: the child's environment.
    expect(call.opts?.env?.[ENGINE_MCP_TOKEN_ENV]).toBe(TOKEN);

    spawn.last.emitJson({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    spawn.last.emitStderr('some diagnostic chatter');
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });

    const written = spawn.last.written.join('\n');
    const logged = logger.lines.join('\n');
    const emitted = JSON.stringify(events);
    for (const haystack of [written, logged, emitted]) {
      expect(haystack).not.toContain(TOKEN);
      expect(haystack).not.toContain(MCP_URL);
    }
  });
});

// ── Start / inject / observe ───────────────────────────────────────────────

describe('starting a session', () => {
  test('runs in the department folder, so its own .claude/ is what governs', async () => {
    const { spawn } = await startSession();
    expect(spawn.calls[0]!.opts?.cwd).toBe('/srv/departments/save-system');
  });

  test('the prompt is written BEFORE the handshake completes — waiting for init first deadlocks', async () => {
    // Verified against the real CLI (v2.1.220): under
    // `--input-format stream-json` nothing but hook frames is emitted until a
    // first input message arrives, so a "wait for init, then write" ordering
    // hangs until `startupTimeoutSeconds`. This assertion is the regression
    // guard for that — it must be written by the time `start()` is pending.
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const started = adapter.start(makeMcpInvocation(), () => {});
    expect(JSON.parse(spawn.last.written[0]!)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'review the save system' }] },
    });
    spawn.last.emitJson(initFrame());
    await started;
    // Open stdin is what makes `acceptsMidTaskInput: 'yes'` true.
    expect(spawn.last.ended).toBe(false);
  });

  test('the handle negotiates mid-task input true and artifacts false', async () => {
    const { handle } = await startSession();
    expect(handle.capabilities).toEqual({ midTaskInput: true, artifacts: false });
    expect(handle.adapterId).toBe('claude-code');
  });

  test('extra RuntimeConfig args are appended verbatim', async () => {
    const { spawn } = await startSession({ invocation: makeMcpInvocation({ args: ['--model', 'sonnet'] }) });
    const args = spawn.calls[0]!.args;
    expect(args.slice(-2)).toEqual(['--model', 'sonnet']);
  });

  test('an envelope with no sender text is refused before spawning', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const invocation = makeMcpInvocation();
    invocation.task = makeTaskSpec({ messages: [makeMessage({ parts: [{ url: 'https://example.test/x' }] })] });
    await expect(adapter.start(invocation, () => {})).rejects.toThrow(RuntimeAdapterError);
    expect(spawn.calls).toHaveLength(0);
  });

  test('a lifecycle this module cannot honour is refused rather than silently downgraded', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    await expect(adapter.start(makeMcpInvocation({ lifecycle: 'per-context' }), () => {})).rejects.toThrow(
      /lifecycle must be 'per-task'/
    );
    expect(spawn.calls).toHaveLength(0);
  });

  test('a missing `claude` binary is a stated, actionable failure', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const started = adapter.start(makeMcpInvocation(), () => {});
    spawn.last.emitExit({ code: 127, error: 'spawn claude ENOENT' });
    await expect(started).rejects.toThrow(/was not found — install Claude Code/);
  });

  test('a startup that never reports a session fails with the window it was given', async () => {
    const spawn = new FakeJobSpawn();
    const clock = fakeClock();
    const adapter = new ClaudeCodeAdapter({ spawn, clock });
    const started = adapter.start(makeMcpInvocation({ startupTimeoutSeconds: 5 }), () => {});
    clock.fire();
    await expect(started).rejects.toThrow(/did not report a started session within 5000ms/);
  });

  test('a CLI that rejects its own invocation is surfaced immediately, not at the timeout', async () => {
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const started = adapter.start(makeMcpInvocation(), () => {});
    spawn.last.emitJson({ type: 'result', is_error: true, result: 'Unknown option --nope' });
    await expect(started).rejects.toThrow(/ended before it started: Unknown option --nope/);
  });
});

// ── Responsibilities 5 + 6: how it ended, and that it is still alive ───────

describe('observing the session', () => {
  test('assistant text and tool calls both become progress — the signal b4 times out against', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the save system…' },
          { type: 'tool_use', name: `mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_update_progress`, input: { note: 'x' } },
        ],
      },
    });
    expect(events).toEqual([
      { type: 'progress', note: 'Reading the save system…' },
      { type: 'progress', note: `using mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_update_progress` },
    ]);
  });

  test('a receiver-tool call is named but never has its arguments repeated', () => {
    const notes = assistantProgressNotes({
      message: {
        content: [{ type: 'tool_use', name: `mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_request_input`, input: { question: 'which branch?' } }],
      },
    });
    expect(notes).toEqual([`using mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_request_input`]);
    expect(notes.join('')).not.toContain('which branch?');
  });

  test('a request_input tool call does NOT become an input_required — the gateway already parked it', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: `mcp__${DEPARTMENT_MCP_SERVER_NAME}__task_request_input`, input: {} }] },
    });
    // Synthesizing one here would ask the sender the same question twice.
    expect(events.every((event) => event.type !== 'input_required')).toBe(true);
  });

  test('hook, tool-result, partial and quota frames are noise, not events', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
    spawn.last.emitJson({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
    spawn.last.emitJson({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'partial' } } });
    spawn.last.emitJson({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
    spawn.last.emitLine('not json at all');
    expect(events).toEqual([]);
  });

  test('a clean result completes the task with the session\'s own summary', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson({ type: 'result', is_error: false, subtype: 'success', terminal_reason: 'completed', result: 'PONG' });
    expect(events).toEqual([{ type: 'completed', summary: 'PONG' }]);
  });

  test('an unauthenticated session FAILS, even though it reports subtype:"success"', async () => {
    // The captured shape from a real not-logged-in run: `subtype` says
    // success and `is_error` says otherwise. Keying off `subtype` would report
    // a broken machine as a finished task.
    const { spawn, events } = await startSession();
    spawn.last.emitJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      error: 'authentication_failed',
      is_api_error_message: true,
    });
    spawn.last.emitJson({
      type: 'result',
      is_error: true,
      subtype: 'success',
      terminal_reason: 'api_error',
      result: 'Not logged in · Please run /login',
    });
    const failure = events[events.length - 1] as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failure.type).toBe('failed');
    expect(failure.reason).toContain('api_error');
    expect(failure.reason).toContain('Not logged in');
    // The half an operator can act on — the runner is not what is broken.
    expect(failure.reason).toContain('run `claude` once as that user and sign in');
  });

  test('narrowResultFrame reads is_error, never subtype', () => {
    expect(narrowResultFrame({ type: 'result', is_error: true, subtype: 'success', result: 'x', terminal_reason: 'api_error' })).toEqual({
      isError: true,
      terminalReason: 'api_error',
      text: 'x',
    });
    expect(narrowResultFrame({ type: 'assistant' })).toBeNull();
  });

  test('a session that dies mid-stream is a retry-safe failure, never a silence', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitExit({ code: 1, signal: 'SIGKILL' });
    expect(events).toEqual([
      { type: 'failed', reason: 'claude-code: the session exited without reporting a result (code 1, signal SIGKILL)', retrySafe: true },
    ]);
  });

  test('the exit that FOLLOWS a result is not a second, spurious failure', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    spawn.last.emitExit({ code: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('completed');
  });
});

// ── x16: a completion nothing vouches for ──────────────────────────────────

/** The captured 401 shape, verbatim from a live v2.1.220 run against a
 *  bearer-protected MCP server that had stopped accepting the session's
 *  token — the exact text the P4 gate produced. */
const EXPIRED = 'MCP server "pipeline-department" requires re-authorization (token expired)';

/** One `assistant` frame calling one tool, and the `user` frame answering it —
 *  the two-frame exchange every tool call really is on the stream. */
function toolCall(name: string, id: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } };
}
function toolAnswer(id: string, options: { isError?: boolean; content?: unknown } = {}): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          ...(options.isError === true ? { is_error: true } : {}),
          content: options.content ?? 'ACK',
        },
      ],
    },
  };
}
const receiver = (tool: string): string => `mcp__${DEPARTMENT_MCP_SERVER_NAME}__${tool}`;

describe('x16: a session that exited claiming success is not the same as one that succeeded', () => {
  test('the P4 gate case: the token expires mid-task, every report is refused, and the session still ends is_error:false', async () => {
    // Reproduces the live gate failure frame for frame. The session works
    // normally, loses its receiver tools to an expired execution token, says
    // in plain words that it cannot finish — and `result` still carries
    // `is_error:false`. Before x16 this was a `completed`, and the sender was
    // told a task had succeeded when nothing was reported and nothing done.
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const { events } = await startSession({ spawn, adapter });

    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_ok'));
    spawn.last.emitJson(toolAnswer('toolu_ok'));
    spawn.last.emitJson(toolCall(receiver('task_check_cancelled'), 'toolu_401'));
    spawn.last.emitJson(toolAnswer('toolu_401', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({
      type: 'result',
      is_error: false,
      subtype: 'success',
      terminal_reason: 'completed',
      result: 'my single task_check_cancelled call failed … the remaining steps go through that same server',
    });

    const terminal = events[events.length - 1]!;
    expect(terminal).toEqual({ type: 'failed', reason: UNREPORTED_FAILURE_REASON, retrySafe: true });
    expect(UNREPORTED_FAILURE_REASON).toBe('unreported');
    // The detail an operator needs is in the log, never in the wire value.
    expect(logger.lines.join('\n')).toContain('did not land');
    expect(logger.lines.join('\n')).toContain('token expired');
  });

  test('the terminal tool call itself failing is the same verdict', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'all done!' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: UNREPORTED_FAILURE_REASON, retrySafe: true });
  });

  test('a receiver call that works AFTER the failure disarms it — the channel recovered', async () => {
    // Exactly what D23's `headersHelper` is for: a 401 is retried once with
    // fresh headers. A session that lost its tools for a moment and then
    // reported properly has not failed, and must not be relabelled.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_1'));
    spawn.last.emitJson(toolAnswer('toolu_1', { isError: true, content: EXPIRED }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_2'));
    spawn.last.emitJson(toolAnswer('toolu_2', { content: [{ type: 'text', text: 'ACK: task marked complete.' }] }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'reviewed the save system' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'reviewed the save system' });
  });

  test('an ORDINARY tool failing is not evidence of anything — a failed Read is session business', async () => {
    // The false-positive guard. A model works around a failing `Read` or a
    // denied `Bash` constantly; only the receiver tools report to the sender.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall('Read', 'toolu_read'));
    spawn.last.emitJson(toolAnswer('toolu_read', { isError: true, content: 'ENOENT: no such file' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done anyway' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done anyway' });
  });

  test('a session whose reports all land completes exactly as before', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_a'));
    spawn.last.emitJson(toolAnswer('toolu_a'));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_b'));
    spawn.last.emitJson(toolAnswer('toolu_b'));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'PONG' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'PONG' });
  });

  test('a stated failure keeps its own more specific reason — `unreported` never overwrites it', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_x'));
    spawn.last.emitJson(toolAnswer('toolu_x', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'Overloaded' });
    const failure = events[events.length - 1] as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failure.reason).toContain('api_error');
    expect(failure.reason).toContain('Overloaded');
  });

  test('watching a tool call emits no extra event — b4 times out on the same signals as before', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_1'));
    spawn.last.emitJson(toolAnswer('toolu_1', { isError: true, content: EXPIRED }));
    // One `progress` for the CALL, nothing at all for the answer: a tool
    // result is not a signal, and counting it would change what the
    // supervisor's watchdog measures.
    expect(events).toEqual([{ type: 'progress', note: `using ${receiver('task_update_progress')}` }]);
  });

  test('receiverToolUseIds picks out receiver calls and ignores every other tool', () => {
    const names = new Set(receiverToolNames());
    const frame = {
      message: {
        content: [
          { type: 'tool_use', name: receiver('task_complete'), id: 'a' },
          { type: 'tool_use', name: 'Bash', id: 'b' },
          { type: 'tool_use', name: receiver('task_fail') }, // no id ⇒ unusable
          { type: 'text', text: 'hello' },
        ],
      },
    };
    expect(receiverToolUseIds(frame, names)).toEqual(['a']);
    expect(receiverToolUseIds({ message: { content: 'not a list' } }, names)).toEqual([]);
  });

  test('toolResultOutcomes reads is_error, and treats its ABSENCE as success (captured shape)', () => {
    expect(toolResultOutcomes(toolAnswer('id-1', { isError: true, content: EXPIRED }))).toEqual([
      { toolUseId: 'id-1', isError: true, text: EXPIRED },
    ]);
    expect(toolResultOutcomes(toolAnswer('id-2', { content: 'ACK' }))).toEqual([
      { toolUseId: 'id-2', isError: false, text: 'ACK' },
    ]);
    expect(toolResultOutcomes(toolAnswer('id-3', { content: [{ type: 'text', text: 'ok' }] }))).toEqual([
      { toolUseId: 'id-3', isError: false, text: 'ok' },
    ]);
    // A block with no `tool_use_id` cannot be attributed to a call at all.
    expect(toolResultOutcomes({ message: { content: [{ type: 'tool_result', content: 'ok' }] } })).toEqual([]);
  });

  test('third-party tool-result text is scrubbed before it is ever logged (D24)', async () => {
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const { events } = await startSession({ spawn, adapter });

    // A transport-level failure legitimately names the endpoint it could not
    // reach, and an auth failure can echo the header it sent.
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_leak'));
    spawn.last.emitJson(toolAnswer('toolu_leak', { isError: true, content: `connect ECONNREFUSED ${MCP_URL} (Bearer ${TOKEN})` }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });

    expect(events[events.length - 1]!.type).toBe('failed');
    const logged = logger.lines.join('\n');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(MCP_URL);
    expect(logged).toContain('<url>');
  });

  test('redactSensitive removes urls, bearers and jwt-shaped strings, and leaves the rest readable', () => {
    expect(redactSensitive(EXPIRED)).toBe(EXPIRED);
    expect(redactSensitive('POST https://ai-pipeline.dev/mcp failed')).toBe('POST <url> failed');
    expect(redactSensitive('sent Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('sent Bearer <redacted>');
    expect(redactSensitive('token eyJhbGciOiJIUzI1NiJ9.abc expired')).toBe('token <redacted> expired');
  });

  test('the set of watched calls is bounded — a daemon runs for weeks', async () => {
    const { spawn, events } = await startSession();
    for (let i = 0; i < MAX_TRACKED_RECEIVER_CALLS + 10; i += 1) {
      spawn.last.emitJson(toolCall(receiver('task_update_progress'), `toolu_${i}`));
    }
    // The oldest ids were forgotten; the newest is still judged. Forgetting
    // costs the ability to judge THAT call — never a false failure.
    spawn.last.emitJson(toolAnswer('toolu_0', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]!.type).toBe('completed');
  });
});

// ── x27: a session that never had a report channel in the first place ──────

/**
 * The `init` frame's `tools` array, captured from v2.1.220 with the argv this
 * module builds: 41 entries with the server `connected` (nine of them ours),
 * 32 with it `pending` (none of them ours). Only the `mcp__` half matters
 * here, so the built-in tools are represented by two of their real names.
 */
function initFrameWithTools(status: string, options: { receiverTools?: boolean } = {}): Record<string, unknown> {
  return {
    ...initFrame(status),
    tools: ['Read', 'Bash', ...(options.receiverTools === true ? receiverToolNames() : [])],
  };
}

/** Start a session on an arbitrary `init` frame — the x27 cases turn on what
 *  that frame says, so they cannot go through `startSession`'s fixed one. */
async function startOnInit(
  frame: Record<string, unknown>,
  options: { logger?: Logger } = {}
): Promise<{ spawn: FakeJobSpawn; adapter: ClaudeCodeAdapter; events: RuntimeEvent[] }> {
  const spawn = new FakeJobSpawn();
  const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), ...(options.logger ? { logger: options.logger } : {}) });
  const events: RuntimeEvent[] = [];
  const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
  spawn.last.emitJson(frame);
  await started;
  // x36: drained for the same reason `startSession` drains it — these cases
  // turn on what the `init` frame SAID, not on the announcement that follows.
  expect(events.shift()).toEqual({ type: 'status', state: 'WORKING', message: SESSION_STARTED_STATUS_MESSAGE });
  return { spawn, adapter, events };
}

describe('x27: a session whose MCP server never connected did not complete anything', () => {
  test('the P4 gate case: `pending` at init, no receiver tools all session, and it still exits is_error:false', async () => {
    // The live gate transcript, driven frame for frame. The server is still
    // connecting when `init` is emitted and never finishes, so the session has
    // none of its nine tools; it does ordinary file work instead, says in
    // plain words that it reported nothing — and `result` carries
    // `is_error:false`. Before x27 this was a `completed`: `b4` needs total
    // silence (there were 13 signals), and x16 needs a receiver call to have
    // FAILED (there was never one to fail).
    const logger = capturingLogger();
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'), { logger });

    spawn.last.emitJson({ type: 'assistant', message: { content: [{ type: 'text', text: "I'll check for the department tools first." }] } });
    spawn.last.emitJson(toolCall('ToolSearch', 'toolu_search'));
    spawn.last.emitJson(
      toolAnswer('toolu_search', { content: 'No matching deferred tools found. Some MCP servers are still connecting: pipeline-department.' })
    );
    spawn.last.emitJson(toolCall('Read', 'toolu_read'));
    spawn.last.emitJson(toolAnswer('toolu_read', { content: 'TICKET-4417 …' }));
    spawn.last.emitJson(toolCall('Write', 'toolu_write'));
    spawn.last.emitJson(toolAnswer('toolu_write', { content: 'wrote note-slow.md' }));
    spawn.last.emitJson({
      type: 'result',
      is_error: false,
      subtype: 'success',
      terminal_reason: 'completed',
      result:
        'Because the department tools were unreachable, this summary has reached nobody but you — ' +
        'ops-oncall@acme.example has received no completion for gate-task-slow. The runner will only observe that the session ended.',
    });

    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: NO_REPORT_CHANNEL_FAILURE_REASON, retrySafe: true });
    expect(NO_REPORT_CHANNEL_FAILURE_REASON).toBe('no_report_channel');
    // Three failures, three words: an operator sent to the gateway's connect
    // by this one would be sent to a token by `unreported` and to a hang by
    // `stuck`.
    expect(NO_REPORT_CHANNEL_FAILURE_REASON).not.toBe(UNREPORTED_FAILURE_REASON);
    // The detail is in the log; the wire value stays a bare word.
    expect(logger.lines.join('\n')).toContain('still connecting when it started');
    expect(logger.lines.join('\n')).toContain('never held the tools it reports through');
  });

  test('a slow connect that COMPLETES is not touched — captured live, and the reason this is not a start-time refusal', async () => {
    // Against a gateway answering `initialize` 12s late, the real binary
    // reported `pending` at `init` with zero `mcp__…` tools, connected
    // MID-TURN, and the session then called task.update_progress and
    // task.complete successfully. Refusing on `pending` at init — the obvious
    // fix — would have killed exactly this session.
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(toolCall('ToolSearch', 'toolu_wait'));
    spawn.last.emitJson(toolAnswer('toolu_wait', { content: 'Some MCP servers are still connecting: pipeline-department.' }));
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_p'));
    spawn.last.emitJson(toolAnswer('toolu_p', { content: 'ACK: task.update_progress recorded.' }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_c'));
    spawn.last.emitJson(toolAnswer('toolu_c', { content: 'ACK: task marked complete.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'x27 slowok' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'x27 slowok' });
  });

  test('one landed receiver call is enough — the channel proved itself, whatever init said', async () => {
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_one'));
    spawn.last.emitJson(toolAnswer('toolu_one'));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
  });

  test('a later `init` reporting connected retires the doubt', async () => {
    // The CLI re-emits `system`/`init` with a refreshed `mcp_servers` status
    // (captured: `pending` on the first, `failed` on the second of a
    // never-connecting server). A `connected` there is the connect completing.
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(initFrameWithTools('connected', { receiverTools: true }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
  });

  test('a session that started CONNECTED is never judged by this rule, even if it called no receiver tool', async () => {
    // The guard against widening into "believe a completed only if a receiver
    // call landed". That rule would be right about this defect and wrong about
    // a parked session, so it is not the rule this implements — the supervisor
    // (b4) is what judges a connected session that reported nothing.
    const { spawn, events } = await startSession();
    spawn.last.emitJson({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
  });

  test('an older CLI that reports no server list is still tolerated, not failed at the other end', async () => {
    // "Cannot verify" is not evidence. D24 answers it with a warning and a
    // start; turning the same non-evidence into a terminal failure would be a
    // different policy wearing this task's name.
    const frame = initFrame();
    delete frame.mcp_servers;
    const { spawn, events } = await startOnInit(frame);
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
  });

  test('`pending` while the receiver tools are ALREADY listed is treated as usable', async () => {
    const logger = capturingLogger();
    const { spawn, events } = await startOnInit(initFrameWithTools('pending', { receiverTools: true }), { logger });
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
    expect(logger.lines.join('\n')).toContain('receiver tools are already available');
  });

  test('a receiver call that FAILED keeps x16\'s more specific reason', async () => {
    // Both judgements are true of this session; `unreported` is the one that
    // says more — it had the tools long enough to be refused.
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_401'));
    spawn.last.emitJson(toolAnswer('toolu_401', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'all done!' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: UNREPORTED_FAILURE_REASON, retrySafe: true });
  });

  test('a slow start whose channel then broke and RECOVERED is x16\'s disarm, and still a completion', async () => {
    // The combination the two flags exist separately to express: init never
    // confirmed the channel (`pending`), a call was refused, and a later call
    // landed. x16 disarms on the recovery and x27 stands down on the landed
    // call — neither judgement is left half-applied.
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_1'));
    spawn.last.emitJson(toolAnswer('toolu_1', { isError: true, content: EXPIRED }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_2'));
    spawn.last.emitJson(toolAnswer('toolu_2', { content: 'ACK: task marked complete.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'reviewed the save system' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'reviewed the save system' });
  });

  test('a stated failure keeps its own reason — `no_report_channel` never overwrites one', async () => {
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'Overloaded' });
    const failure = events[events.length - 1] as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failure.reason).toContain('api_error');
    expect(failure.reason).toContain('Overloaded');
  });

  test('judging it emits no extra event — b4 times out on the same signals as before', async () => {
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    spawn.last.emitJson(initFrameWithTools('connected', { receiverTools: true }));
    expect(events).toEqual([{ type: 'progress', note: 'working' }]);
  });

  test('initFrameListsReceiverTools reads the tools array, and says false when there is none', () => {
    const names = new Set(receiverToolNames());
    expect(initFrameListsReceiverTools({ tools: ['Read', ...receiverToolNames()] }, names)).toBe(true);
    expect(initFrameListsReceiverTools({ tools: ['Read', 'Bash'] }, names)).toBe(false);
    expect(initFrameListsReceiverTools({ tools: 'not a list' }, names)).toBe(false);
    expect(initFrameListsReceiverTools({}, names)).toBe(false);
  });
});

// ── The parking flow (D34/x17's territory) is untouched by x27 ──────────────

describe('a session that parks on task.request_input still completes its turn (D34/x17, NOT x27)', () => {
  test('a connected session that parks and ends its turn is a completed, exactly as before', async () => {
    // Parking is the case the general rule "believe a completed only if a
    // receiver call landed" would have relabelled. It is not relabelled: the
    // question DID land, over a channel that WAS confirmed. Whether parking
    // deserves a terminal state of its own is D34, tracked as x17, and is not
    // decided here.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_request_input'), 'toolu_ask'));
    spawn.last.emitJson(
      toolAnswer('toolu_ask', {
        content: 'PARKED: the question was delivered to the sender. Their answer will arrive as a new user message in this session.',
      })
    );
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'asked the sender which branch to use' });
    expect(events).toEqual([
      { type: 'progress', note: `using ${receiver('task_request_input')}` },
      { type: 'completed', summary: 'asked the sender which branch to use' },
    ]);
    // And still no synthesized input_required — the gateway is the parking
    // authority, and asking twice was already refused in this module.
    expect(events.every((event) => event.type !== 'input_required')).toBe(true);
  });

  test('a session that parks after a SLOW connect is a completed too — x27 disarms on the landed question', async () => {
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(toolCall(receiver('task_request_input'), 'toolu_ask'));
    spawn.last.emitJson(toolAnswer('toolu_ask', { content: 'PARKED: the question was delivered to the sender.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'waiting on the sender' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'waiting on the sender' });
  });
});

// ── x31: a completed for work that had not finished ────────────────────────

/**
 * The CLI's `system`/`background_tasks_changed` snapshot, captured shape from
 * v2.1.220 — one entry the instant a `run_in_background` command starts, and
 * `tasks:[]` the instant the last one ends.
 */
function backgroundTasksFrame(...taskIds: string[]): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: taskIds.map((taskId) => ({ task_id: taskId, task_type: 'local_bash', description: 'Run x31 background probe' })),
  };
}

/** The captured `tool_result` for a backgrounded `Bash` — the CLI answers the
 *  call immediately, which is exactly why nothing downstream looks unfinished. */
const BACKGROUNDED =
  'Command running in background with ID: b5n82zftn. Output is being written to: …\\tasks\\b5n82zftn.output. ' +
  'You will be notified when it completes.';

describe('x31: a session that ended its turn with its own work still running has not completed', () => {
  test('the captured case: healthy channel, `sleep 40` backgrounded, turn ends, result says completed', async () => {
    // Driven frame for frame from a live v2.1.220 capture against a CONNECTED
    // stub gateway (all nine receiver tools in hand, task.update_progress
    // acknowledged). The session backgrounds `sleep 40`, ends its turn, and
    // the CLI emits `is_error:false` / `terminal_reason:"completed"` carrying
    // the session's own words that it is still waiting. Forty seconds later a
    // SECOND turn read the output and called task.complete — the turn this
    // module never sees, because it finalizes on the first `result`.
    //
    // Neither existing guard reaches it: nothing failed (x16 is null) and the
    // server was connected with a landed call (x27 is disarmed). On today's
    // `main` this is a `completed`, and the sender is told a running task
    // succeeded.
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const events: RuntimeEvent[] = [];
    const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
    spawn.last.emitJson(initFrame('connected'));
    await started;

    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_p'));
    spawn.last.emitJson(toolAnswer('toolu_p', { content: 'ACK: task.update_progress recorded.' }));
    spawn.last.emitJson(toolCall('Bash', 'toolu_bg'));
    spawn.last.emitJson(backgroundTasksFrame('b5n82zftn'));
    spawn.last.emitJson(toolAnswer('toolu_bg', { content: BACKGROUNDED }));
    spawn.last.emitJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Background task `b5n82zftn` started — waiting for it to finish before reporting completion.' }] },
    });
    spawn.last.emitJson({
      type: 'result',
      is_error: false,
      subtype: 'success',
      terminal_reason: 'completed',
      result: 'Background task `b5n82zftn` started — waiting for it to finish before reporting completion.',
    });

    expect(events[events.length - 1]).toEqual({
      type: 'failed',
      reason: BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON,
      // Not retry-safe, unlike x16 and x27: those fail on a transport fault a
      // fresh spawn gets past. Nothing about a respawn changes what this
      // session did, and the abandoned process may still be writing in the
      // same department folder.
      retrySafe: false,
    });
    expect(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON).toBe('background_work_outstanding');
    // The detail is in the log; the wire value stays a bare word.
    expect(logger.lines.join('\n')).toContain('b5n82zftn');
    expect(logger.lines.join('\n')).toContain('still running');
  });

  test('four failures, four words — an operator is sent somewhere different by each', () => {
    // `stuck` sends them to a hang, `unreported` to a token, `no_report_channel`
    // to the gateway's connect, and this one to a background command.
    expect(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON).not.toBe(UNREPORTED_FAILURE_REASON);
    expect(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON).not.toBe(NO_REPORT_CHANNEL_FAILURE_REASON);
    expect(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON).not.toBe('stuck');
    expect(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON).not.toBe('isolation_unsupported');
  });

  test('a background task that FINISHED before the turn ended is not held against the session', async () => {
    // The snapshot is exactly that — the CLI emits `tasks:[]` when the last
    // one ends, so a session that waited for its own background work and then
    // reported is an ordinary completion.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall('Bash', 'toolu_bg'));
    spawn.last.emitJson(backgroundTasksFrame('b5n82zftn'));
    spawn.last.emitJson(toolAnswer('toolu_bg', { content: BACKGROUNDED }));
    spawn.last.emitJson(backgroundTasksFrame());
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_c'));
    spawn.last.emitJson(toolAnswer('toolu_c', { content: 'ACK: task marked complete.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'the build finished clean' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'the build finished clean' });
  });

  test('the snapshot is REPLACED, never accumulated — two started, one still running, one left', async () => {
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const events: RuntimeEvent[] = [];
    const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
    spawn.last.emitJson(initFrame('connected'));
    await started;
    spawn.last.emitJson(backgroundTasksFrame('bg_one', 'bg_two'));
    spawn.last.emitJson(backgroundTasksFrame('bg_two'));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'still going' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON, retrySafe: false });
    // One outstanding, not three: the count came from the LAST snapshot.
    expect(logger.lines.join('\n')).toContain('1 background task(s) it started were still running (bg_two)');
  });

  test('a session that already reported through task.complete keeps its completion, stray task and all', async () => {
    // The narrowing that keeps this out of healthy sessions' way: a model that
    // leaves a dev server or a log tailer running after saying how the task
    // ended has not lost a report, and failing it would be a regression.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall('Bash', 'toolu_server'));
    spawn.last.emitJson(backgroundTasksFrame('bg_devserver'));
    spawn.last.emitJson(toolAnswer('toolu_server', { content: BACKGROUNDED }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_c'));
    spawn.last.emitJson(toolAnswer('toolu_c', { content: 'ACK: task marked complete.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'reviewed the save system' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'reviewed the save system' });
  });

  test('task.fail is a report too — a session that stated its failure is not re-judged', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson(toolCall(receiver('task_fail'), 'toolu_f'));
    spawn.last.emitJson(toolAnswer('toolu_f', { content: 'ACK: task marked failed.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'reported the failure to the sender' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'reported the failure to the sender' });
  });

  test('a terminal call that did NOT land is no report at all — x16 keeps its more specific reason', async () => {
    // Both judgements are true of this session. `unreported` says more: the
    // channel was refusing, which is the thing to go and fix.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_401'));
    spawn.last.emitJson(toolAnswer('toolu_401', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'all done!' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: UNREPORTED_FAILURE_REASON, retrySafe: true });
  });

  test('x27 keeps precedence too — a channel that never came up is the more fundamental failure', async () => {
    const { spawn, events } = await startOnInit(initFrameWithTools('pending'));
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'backgrounded a check and stopped' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: NO_REPORT_CHANNEL_FAILURE_REASON, retrySafe: true });
  });

  test('a stated failure keeps its own reason — `background_work_outstanding` never overwrites one', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'Overloaded' });
    const failure = events[events.length - 1] as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failure.reason).toContain('api_error');
    expect(failure.reason).toContain('Overloaded');
  });

  test('the snapshot frame emits no supervisor event — b4 times out on the same signals as before', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson(backgroundTasksFrame());
    expect(events).toEqual([]);
  });

  test('backgroundTaskIds reads the snapshot, and says null to everything that is not one', () => {
    expect(backgroundTaskIds(backgroundTasksFrame('bg_one', 'bg_two'))).toEqual(['bg_one', 'bg_two']);
    // An empty snapshot is real evidence — "nothing outstanding" — not absence.
    expect(backgroundTaskIds(backgroundTasksFrame())).toEqual([]);
    // An entry the frame does not name still COUNTS; dropping it would
    // under-report the very thing being measured.
    expect(backgroundTaskIds({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_type: 'local_bash' }] })).toEqual(['#0']);
    expect(backgroundTaskIds({ type: 'system', subtype: 'task_started', task_id: 'bg_one' })).toBeNull();
    expect(backgroundTaskIds({ type: 'system', subtype: 'init', tasks: [] })).toBeNull();
    expect(backgroundTaskIds({ type: 'system', subtype: 'background_tasks_changed', tasks: 'not a list' })).toBeNull();
    expect(backgroundTaskIds({ type: 'system', subtype: 'background_tasks_changed' })).toBeNull();
  });

  test('the terminal pair is a SUBSET of the receiver tools, spelled the same way', () => {
    for (const tool of TERMINAL_RECEIVER_TOOLS) expect(RECEIVER_TOOLS).toContain(tool);
    for (const name of terminalReceiverToolNames()) expect(receiverToolNames()).toContain(name);
    expect(terminalReceiverToolNames()).toEqual([receiver('task_complete'), receiver('task_fail')]);
  });
});

// ── Parking (D34/x17) is untouched by x31 either ───────────────────────────

describe('parking is out of x31 reach: a parked session emits no background task at all', () => {
  test('the captured park: update_progress, request_input, end of turn — and ZERO background_tasks_changed frames', async () => {
    // Captured live against the same CONNECTED stub gateway, same argv, in the
    // same session as the x31 capture above. The parked session's `result` is
    // shape-identical to the premature one — `is_error:false`,
    // `terminal_reason:"completed"` — and the ONLY thing telling them apart is
    // that this one never backgrounded anything. Twelve frames, not one of
    // them a `background_tasks_changed`. So the snapshot this judgement reads
    // is empty for its whole life and the judgement cannot reach it: parking
    // becoming its own terminal state is still [D34]/`x17`, undecided.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_p'));
    spawn.last.emitJson(toolAnswer('toolu_p', { content: 'ACK: task.update_progress recorded.' }));
    spawn.last.emitJson(toolCall(receiver('task_request_input'), 'toolu_ask'));
    spawn.last.emitJson(
      toolAnswer('toolu_ask', {
        content:
          'PARKED: the question was delivered to the sender. Their answer will arrive as a new user message in this session — ' +
          'stop and wait for it, do not guess.',
      })
    );
    spawn.last.emitJson({
      type: 'result',
      is_error: false,
      subtype: 'success',
      terminal_reason: 'completed',
      result: 'Progress note sent, and the question is parked with the sender. Waiting for their answer.',
    });

    expect(events).toEqual([
      { type: 'progress', note: `using ${receiver('task_update_progress')}` },
      { type: 'progress', note: `using ${receiver('task_request_input')}` },
      { type: 'completed', summary: 'Progress note sent, and the question is parked with the sender. Waiting for their answer.' },
    ]);
    // Still no synthesized input_required — the gateway is the parking
    // authority, and x31 did not change who asks.
    expect(events.every((event) => event.type !== 'input_required')).toBe(true);
  });

  test('a park that DOES leave a background task running is still judged — the task is the trigger, not the park', async () => {
    // The honest edge of the narrowing above. A session that backgrounds work,
    // parks a question and stops has outstanding work AND no terminal report,
    // so it is judged — not because it parked, but because nothing it started
    // is finished and nothing has been said about how the task ended. The
    // captured park does not do this; the case is pinned so a future reader
    // can see the boundary was chosen rather than missed.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson(toolCall(receiver('task_request_input'), 'toolu_ask'));
    spawn.last.emitJson(toolAnswer('toolu_ask', { content: 'PARKED: the question was delivered to the sender.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'asked while the check runs' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON, retrySafe: false });
  });
});

// ── x36: saying the session STARTED ────────────────────────────────────────

/** Start a session WITHOUT draining the announcement — these cases are about
 *  the announcement itself, so they cannot go through `startSession`. */
async function startRaw(
  frame: Record<string, unknown> = initFrame('connected')
): Promise<{ spawn: FakeJobSpawn; adapter: ClaudeCodeAdapter; events: RuntimeEvent[] }> {
  const spawn = new FakeJobSpawn();
  const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
  const events: RuntimeEvent[] = [];
  const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
  spawn.last.emitJson(frame);
  await started;
  return { spawn, adapter, events };
}

const WORKING_ANNOUNCEMENT: RuntimeEvent = { type: 'status', state: 'WORKING', message: SESSION_STARTED_STATUS_MESSAGE };

describe('x36: a task that never leaves SUBMITTED can never report anything', () => {
  test('the P4 gate case: the session announces WORKING at its init frame', async () => {
    // The defect this replaces was an ABSENCE: `grep -c "type: 'status'"` over
    // this module returned 0, and the runner-emitted `status` event is the only
    // thing in the system that moves a task off `SUBMITTED` (the cloud's
    // transition table admits SUBMITTED -> WORKING|REJECTED|CANCELED, and its
    // scheduler states outright that `department.accept` does not do it). So a
    // twelve-minute session published an artifact, wrote a full summary, and had
    // task.request_input, task.complete and task.fail ALL come back
    // `task_conflict` — while its sender was shown `queued`.
    const { events } = await startRaw();
    expect(events).toEqual([WORKING_ANNOUNCEMENT]);
  });

  test('the announcement is the shape ./jsonl-process.ts already produces, not a new one', () => {
    // The one adapter that got this right is the contract. Driving its narrower
    // with the up-line a runtime would send yields the event this module now
    // emits directly — same `type`, same single legal `state` literal, same
    // optional `message`.
    expect(narrowRuntimeEvent({ type: 'task.status', state: 'WORKING', message: SESSION_STARTED_STATUS_MESSAGE })).toEqual({
      event: WORKING_ANNOUNCEMENT,
    });
  });

  test('it precedes the first receiver tool call — anything later would race the call it exists to unblock', async () => {
    // The requirement, stated as an ordering: a receiver call IS a `tool_use`
    // block on an `assistant` frame, and the CLI invokes the tool the moment it
    // emits one. The announcement must already be out by then, and at `init` it
    // is out before the model has produced a single token.
    const { spawn, events } = await startRaw();
    expect(events).toEqual([WORKING_ANNOUNCEMENT]); // already, with no active line routed at all
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_first'));
    expect(events).toEqual([WORKING_ANNOUNCEMENT, { type: 'progress', note: `using ${receiver('task_update_progress')}` }]);
  });

  test('exactly once — a second init frame mid-session does not re-announce', async () => {
    // The CLI re-emits `system`/`init` on a new turn (x27 reads the refreshed
    // mcp status off exactly that frame). Announcing again would be actively
    // wrong: INPUT_REQUIRED -> WORKING is a legal transition, so a second
    // announcement could yank a parked task back out of the state its sender is
    // being asked to answer in.
    const { spawn, events } = await startRaw(initFrameWithTools('pending'));
    spawn.last.emitJson(initFrameWithTools('connected', { receiverTools: true }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events.filter((event) => event.type === 'status')).toEqual([WORKING_ANNOUNCEMENT]);
  });

  test('a session that dies straight after init has still started — and its failure now lands AS a failure', async () => {
    // The cost of the early instant, priced. The session genuinely had started:
    // under `--input-format stream-json` the CLI emits nothing until it has the
    // prompt, so `init` means the binary ran, the department server connected
    // and the turn began. Without the announcement this `failed` arrives on a
    // SUBMITTED task, where WORKING -> FAILED is illegal and the cloud's x18
    // has to divert it to REJECTED; with it, the terminal is the one that
    // actually happened.
    const { spawn, events } = await startRaw();
    spawn.last.emitExit({ code: 1, signal: 'SIGKILL' });
    expect(events).toEqual([
      WORKING_ANNOUNCEMENT,
      { type: 'failed', reason: 'claude-code: the session exited without reporting a result (code 1, signal SIGKILL)', retrySafe: true },
    ]);
  });

  test('a session that is REFUSED at init announces nothing — it never started', async () => {
    // D24's refusal happens before the handle exists, so there is no session to
    // call working. The supervisor turns the rejection into its own terminal.
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock() });
    const events: RuntimeEvent[] = [];
    const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
    spawn.last.emitJson(initFrame('failed'));
    await expect(started).rejects.toThrow(EngineMcpUnavailableError);
    expect(events).toEqual([]);
  });

  test('the announcement carries no credential and no session detail', async () => {
    // Same standing rule as every other event this module emits (10-security §6).
    const { events } = await startRaw();
    expect(events).toHaveLength(1); // non-vacuous: there IS something to inspect
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(MCP_URL);
  });
});

// ── x37: a terminal report the gateway refused ─────────────────────────────

/** What the gateway actually said on the live path, before x36: the task never
 *  left SUBMITTED, so the two calls that would have ended it were refused. */
const TASK_CONFLICT = 'task_conflict: the task is in SUBMITTED state and cannot be closed by this execution';

describe('x37: a session whose terminal report was REFUSED did not complete', () => {
  test('the live sequence: fail and complete both refused, then two ordinary calls that WORK', async () => {
    // Driven in the captured order. x16 arms on the refusals and then DISARMS
    // on the two later successes — deliberately, so a headersHelper re-auth
    // that recovers still completes — and x31 only looks at a missing terminal
    // report when background tasks are outstanding, which here there are none.
    // On today's `main` this session reports `completed` while the gateway
    // refused every word it said about how the task ended.
    const logger = capturingLogger();
    const spawn = new FakeJobSpawn();
    const adapter = new ClaudeCodeAdapter({ spawn, clock: fakeClock(), logger });
    const events: RuntimeEvent[] = [];
    const started = adapter.start(makeMcpInvocation(), (event) => events.push(event));
    spawn.last.emitJson(initFrame('connected'));
    await started;

    spawn.last.emitJson(toolCall(receiver('task_fail'), 'toolu_fail'));
    spawn.last.emitJson(toolAnswer('toolu_fail', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_get_current'), 'toolu_get'));
    spawn.last.emitJson(toolAnswer('toolu_get', { content: 'state: SUBMITTED' }));
    spawn.last.emitJson(toolCall(receiver('task_send_message'), 'toolu_say'));
    spawn.last.emitJson(toolAnswer('toolu_say', { content: 'ACK: message appended.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, subtype: 'success', terminal_reason: 'completed', result: 'summary written' });

    expect(events[events.length - 1]).toEqual({
      type: 'failed',
      reason: TERMINAL_REPORT_REFUSED_FAILURE_REASON,
      // Retry-safe, with x16 and x27: a fresh spawn is minted a fresh execution
      // token and a fresh lease, and nothing was left running to collide with.
      retrySafe: true,
    });
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).toBe('terminal_report_refused');
    // The detail is in the log; the wire value stays a bare word.
    expect(logger.lines.join('\n')).toContain('refused');
  });

  test('one refused terminal call and nothing after it is still x16 — `unreported` keeps its own case', async () => {
    // The boundary with the shape already handled. Nothing disarmed x16 here,
    // so the more specific "the channel was broken at the end" still applies
    // and this branch must not steal it.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: EXPIRED }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'all done' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: UNREPORTED_FAILURE_REASON, retrySafe: true });
  });

  test('a refused terminal call that is RETRIED successfully is an ordinary completion', async () => {
    // `landed` beats `refused`, exactly as x16 forgives a channel that
    // recovers. A model that hit a transient conflict and tried again has
    // reported, and failing it would be a regression.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_1'));
    spawn.last.emitJson(toolAnswer('toolu_1', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_2'));
    spawn.last.emitJson(toolAnswer('toolu_2', { content: 'ACK: task.complete recorded.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done' });
  });

  test('a PARKED session never attempts one, and is untouched — that is D34/x17, not this', async () => {
    // The boundary that matters most. `!terminalReportLanded` on its own
    // describes every parked session too; only `terminalReportRefused` marks
    // the ones that tried. A park makes a request_input call and stops.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_request_input'), 'toolu_ask'));
    spawn.last.emitJson(toolAnswer('toolu_ask', { content: 'PARKED: the question was delivered to the sender.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'asked the sender which branch to use' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'asked the sender which branch to use' });
  });

  test('a healthy session whose report landed is untouched', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { content: 'ACK: task.complete recorded.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'shipped' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'shipped' });
  });

  test('an ORDINARY tool being refused is not a terminal report — a failed Read is session business', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall('Read', 'toolu_read'));
    spawn.last.emitJson(toolAnswer('toolu_read', { isError: true, content: 'ENOENT' }));
    spawn.last.emitJson(toolCall(receiver('task_get_current'), 'toolu_get'));
    spawn.last.emitJson(toolAnswer('toolu_get', { content: 'state: WORKING' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done anyway' });
    expect(events[events.length - 1]).toEqual({ type: 'completed', summary: 'done anyway' });
  });

  test('x31 keeps precedence — a live background process must not be respawned onto', async () => {
    // Both judgements fit this session, and the ORDER is the safety property:
    // x31 is not retry-safe precisely so a second session does not land on top
    // of a background command still writing in the same department folder.
    // Taking the more precise noun here would trade that away.
    const { spawn, events } = await startSession();
    spawn.last.emitJson(backgroundTasksFrame('bg_one'));
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_get_current'), 'toolu_get'));
    spawn.last.emitJson(toolAnswer('toolu_get', { content: 'state: SUBMITTED' }));
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'still going' });
    expect(events[events.length - 1]).toEqual({ type: 'failed', reason: BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON, retrySafe: false });
  });

  test('a stated failure keeps its own reason — `terminal_report_refused` never overwrites one', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_get_current'), 'toolu_get'));
    spawn.last.emitJson(toolAnswer('toolu_get', { content: 'state: SUBMITTED' }));
    spawn.last.emitJson({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'Overloaded' });
    const failure = events[events.length - 1] as Extract<RuntimeEvent, { type: 'failed' }>;
    expect(failure.reason).toContain('api_error');
    expect(failure.reason).not.toContain(TERMINAL_REPORT_REFUSED_FAILURE_REASON);
  });

  test('judging it emits no extra event — b4 times out on the same signals as before', async () => {
    const { spawn, events } = await startSession();
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { isError: true, content: TASK_CONFLICT }));
    spawn.last.emitJson(toolCall(receiver('task_get_current'), 'toolu_get'));
    spawn.last.emitJson(toolAnswer('toolu_get', { content: 'state: SUBMITTED' }));
    expect(events).toEqual([
      { type: 'progress', note: `using ${receiver('task_complete')}` },
      { type: 'progress', note: `using ${receiver('task_get_current')}` },
    ]);
  });

  test('five failures, five words — an operator is sent somewhere different by each', () => {
    // `stuck` sends them to a hang, `unreported` to a token, `no_report_channel`
    // to the gateway's connect, `background_work_outstanding` to a background
    // command — and this one to why the gateway REJECTED a call that reached it.
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).not.toBe(UNREPORTED_FAILURE_REASON);
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).not.toBe(NO_REPORT_CHANNEL_FAILURE_REASON);
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).not.toBe(BACKGROUND_WORK_OUTSTANDING_FAILURE_REASON);
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).not.toBe('stuck');
    expect(TERMINAL_REPORT_REFUSED_FAILURE_REASON).not.toBe('isolation_unsupported');
  });
});

// ── send / cancel / dispose ────────────────────────────────────────────────

describe('reaching and ending a live session', () => {
  test('a mid-task message reaches the running session as a stream-json user turn', async () => {
    const { spawn, adapter, handle } = await startSession();
    await adapter.send(handle, { kind: 'message', message: makeMessage({ parts: [{ text: 'use the develop branch' }] }) });
    expect(JSON.parse(spawn.last.written[1]!)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'use the develop branch' }] },
    });
  });

  test('a message to an already-finished session is refused, not silently dropped', async () => {
    const { spawn, adapter, handle } = await startSession();
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'done' });
    await expect(adapter.send(handle, { kind: 'message', message: makeMessage() })).rejects.toThrow(/already ended/);
  });

  test('a second task.start is refused — this module is per-task only', async () => {
    const { adapter, handle } = await startSession();
    await expect(adapter.send(handle, { kind: 'task.start', task: makeTaskSpec() })).rejects.toThrow(/per-task/);
  });

  test('a handle from another adapter is rejected rather than acted on', async () => {
    const adapter = new ClaudeCodeAdapter();
    const foreign = { adapterId: 'jsonl-process', taskId: 't', contextId: 'c', capabilities: { midTaskInput: true, artifacts: true } };
    await expect(adapter.cancel(foreign)).rejects.toThrow(/was not minted by this adapter/);
  });

  test('cancel is the polite ask; dispose is what actually ends it', async () => {
    const spawn = new FakeJobSpawn();
    const clock = fakeClock();
    const adapter = new ClaudeCodeAdapter({ spawn, clock });
    const { handle } = await startSession({ spawn, adapter });

    await adapter.cancel(handle, 'sender cancelled');
    expect(spawn.last.ended).toBe(true);
    // Nothing was killed yet — a tool call mid-write is not torn out.
    expect(spawn.last.killedGroupWith).toHaveLength(0);

    const disposed = adapter.dispose(handle);
    expect(spawn.last.killedGroupWith).toEqual(['SIGTERM']);
    clock.fire(); // the graceful window elapses
    expect(spawn.last.killedGroupWith).toEqual(['SIGTERM', 'SIGKILL']);
    spawn.last.emitExit({ code: null, signal: 'SIGKILL' });
    await disposed;
  });

  test('a result that lands after cancel is dropped — the supervisor already moved on', async () => {
    const { spawn, adapter, handle, events } = await startSession();
    await adapter.cancel(handle, 'lease revoked');
    spawn.last.emitJson({ type: 'result', is_error: false, result: 'too late' });
    expect(events).toEqual([]);
  });

  test('dispose is idempotent and resolves on a confirmed exit', async () => {
    const spawn = new FakeJobSpawn();
    const clock = fakeClock();
    const adapter = new ClaudeCodeAdapter({ spawn, clock });
    const { handle } = await startSession({ spawn, adapter });
    const first = adapter.dispose(handle);
    spawn.last.emitExit({ code: 0 });
    await first;
    await adapter.dispose(handle); // no second kill, no hang
    expect(spawn.last.killedGroupWith).toEqual(['SIGTERM']);
  });
});

// ── probe ──────────────────────────────────────────────────────────────────

describe('probe', () => {
  test('reports the installed version', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: { run: async () => ({ code: 0, stdout: '2.1.220 (Claude Code)\n', stderr: '' }) },
    });
    await expect(adapter.probe({ adapterId: 'claude-code', command: 'claude' })).resolves.toEqual({
      ok: true,
      runtime: 'claude-code',
      capabilities: { midTaskInput: true, artifacts: false },
      version: '2.1.220 (Claude Code)',
    });
  });

  test('a missing binary is reported as something an operator can fix', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: { run: async () => ({ code: 127, stdout: '', stderr: '', error: 'ENOENT' }) },
    });
    const result = await adapter.probe({ adapterId: 'claude-code', command: 'claude' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("make it reachable on this machine's PATH");
  });
});
