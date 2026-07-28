/**
 * The whole x21 chain, for real (simplified-onboarding x21; owner decision
 * D33 amending D23).
 *
 * Everything else in the x21 suite drives one half against a fake. This file
 * is the one that would have caught the P4 gate failure, so nothing in it is
 * simulated except the cloud:
 *
 *   - a REAL `Bun.serve` authorization server + resource server, where `/mcp`
 *     accepts ONLY the most recently issued token — i.e. an execution token
 *     that has expired mid-task, which is exactly the gate's box 5;
 *   - a REAL `ExecutionTokenManager` doing a REAL `client_credentials`
 *     exchange over a REAL `fetch`;
 *   - a REAL `ExecutionTokenEndpoint` on a REAL loopback socket;
 *   - a REAL `ClaudeCodeAdapter` building the command;
 *   - a REAL subprocess, launched through a REAL platform shell exactly the
 *     way Claude Code launches a `headersHelper` (`shell:true`, so `sh -c`
 *     on POSIX and `cmd.exe /d /s /c` on Windows) — which is also the only
 *     way to find out whether the quoting this module emits actually survives
 *     both of them.
 *
 * It fails against `main`: there is no endpoint to grant a channel, no
 * program for the helper to run, no `executionId` on the envelope to name the
 * execution with, and `buildDepartmentMcpConfig` emits a static header
 * unconditionally.
 */

import { exec } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { InvocationEnvelope, RuntimeEvent } from './adapter';
import { ClaudeCodeAdapter, DEPARTMENT_MCP_SERVER_NAME, UNREPORTED_FAILURE_REASON } from './claude-code';
import { ENGINE_MCP_HELPER_SECRET_ENV, ENGINE_MCP_HELPER_URL_ENV, ENGINE_MCP_TOKEN_ENV, ENGINE_MCP_URL_ENV } from './engine';
import { ExecutionTokenEndpoint } from './execution-token-endpoint';
import { ExecutionTokenManager } from './execution-token-manager';
import { FakeJobSpawn, makeMessage, makeTaskSpec } from './_test-helpers';

const CLIENT_ID = 'run_x21';
/** The DURABLE credential. The entire invariant D33 restates is that this
 *  string never reaches a model-driven session and never touches disk; every
 *  test below asserts it against everything the session can see. */
const CLIENT_SECRET = 'the-runners-long-lived-oauth-client-secret';
const EXECUTION_ID = 'dexec-x21';
const HELPER_SCRIPT = join(import.meta.dir, 'mcp-headers-helper.ts');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface MockCloud {
  url: string;
  /** Every token this AS has ever issued, oldest first. */
  issued: string[];
  /** `/mcp` calls, as `{ accepted }`. */
  mcpCalls: { accepted: boolean }[];
  exchanges: number;
  stop(): void;
}

/**
 * The cloud, close enough to c12's real contract to prove the runner side:
 * HTTP Basic client auth on `POST /oauth/token`, and a `/mcp` that accepts
 * ONLY the newest token it issued. That last rule is the whole point — it is
 * how "the execution token expired while the session was working" is made
 * real without waiting 15 minutes.
 */
function startMockCloud(): MockCloud {
  const issued: string[] = [];
  const mcpCalls: { accepted: boolean }[] = [];
  let exchanges = 0;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        exchanges += 1;
        const form = new URLSearchParams(await req.text());
        const basic = /^Basic\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
        if (basic === null) return jsonResponse(401, { error: 'invalid_client' });
        const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (decoded.slice(0, sep) !== CLIENT_ID || decoded.slice(sep + 1) !== CLIENT_SECRET) {
          return jsonResponse(401, { error: 'invalid_client' });
        }
        if (form.get('grant_type') !== 'client_credentials' || form.get('execution_id') !== EXECUTION_ID) {
          return jsonResponse(400, { error: 'invalid_request' });
        }
        const token = `exec-token-${issued.length + 1}`;
        issued.push(token);
        return jsonResponse(200, { access_token: token, token_type: 'Bearer', expires_in: 900, scope: 'mesh:execution' });
      }

      if (url.pathname === '/mcp') {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
        // Only the newest token works: everything older has "expired".
        const accepted = bearer !== undefined && bearer === issued[issued.length - 1];
        mcpCalls.push({ accepted });
        return accepted ? jsonResponse(200, { ok: true }) : jsonResponse(401, { error: 'invalid_token' });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    issued,
    mcpCalls,
    get exchanges() {
      return exchanges;
    },
    stop: () => server.stop(true),
  };
}

interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command the way Claude Code runs a `headersHelper`: through the
 * platform shell, with the SESSION's environment, bounded by a timeout.
 * `node:child_process.exec` is `shell:true` by construction and handles the
 * `cmd.exe /d /s /c` verbatim-argument dance on Windows itself — which is
 * precisely the behaviour `buildMcpHeadersHelperCommand`'s quoting has to
 * survive, so replicating it by hand would be testing the wrong thing.
 */
function runThroughShell(command: string, env: Record<string, string>): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(command, { env: { ...process.env, ...env }, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let cloud: MockCloud;
let tokens: ExecutionTokenManager;
let endpoint: ExecutionTokenEndpoint;

beforeAll(() => {
  cloud = startMockCloud();
  tokens = new ExecutionTokenManager({
    baseUrl: () => cloud.url,
    clientId: () => CLIENT_ID,
    clientSecret: () => CLIENT_SECRET,
  });
  // 0ms: this suite drives the throttle explicitly by making real calls, and
  // a wall-clock window would make it a sleep test. The throttle's own
  // behaviour is proven in `./execution-token-endpoint.test.ts`.
  endpoint = new ExecutionTokenEndpoint({ tokens, minRenewIntervalMs: 0 });
});

afterAll(() => {
  endpoint.stop();
  cloud.stop();
});

/** The environment the supervisor injects for a spawn: the two d6 variables
 *  plus x21's loopback grant. Mirrors `manager.ts`'s `resolveMcpEnv` exactly. */
async function spawnEnv(): Promise<Record<string, string>> {
  const token = await tokens.getToken(EXECUTION_ID);
  if (!token.ok) throw new Error(`could not mint an execution token: ${token.error.error}`);
  const channel = await endpoint.grant(EXECUTION_ID);
  if (channel === null) throw new Error('could not grant a loopback channel');
  return {
    [ENGINE_MCP_URL_ENV]: `${cloud.url}/mcp`,
    [ENGINE_MCP_TOKEN_ENV]: token.token.accessToken,
    [ENGINE_MCP_HELPER_URL_ENV]: channel.url,
    [ENGINE_MCP_HELPER_SECRET_ENV]: channel.secret,
  };
}

/** The `headersHelper` string this build's engine module actually emits for a
 *  session started with `env`, read back off the spawn's argv. */
async function helperCommandFor(env: Record<string, string>): Promise<{ command: string; spawn: FakeJobSpawn; events: RuntimeEvent[]; adapter: ClaudeCodeAdapter }> {
  const spawn = new FakeJobSpawn();
  const adapter = new ClaudeCodeAdapter({ spawn });
  const events: RuntimeEvent[] = [];
  const invocation: InvocationEnvelope = {
    executionId: EXECUTION_ID,
    runtime: { adapterId: 'claude-code', command: 'claude', cwd: process.cwd(), env },
    task: makeTaskSpec({ messages: [makeMessage({ parts: [{ text: 'review the save system' }] })] }),
  };
  const started = adapter.start(invocation, (event) => events.push(event));
  spawn.last.emitJson({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-real',
    mcp_servers: [{ name: DEPARTMENT_MCP_SERVER_NAME, status: 'connected' }],
  });
  await started;
  const args = spawn.calls[spawn.calls.length - 1]!.args;
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as {
    mcpServers: Record<string, { headersHelper?: string }>;
  };
  const command = config.mcpServers[DEPARTMENT_MCP_SERVER_NAME]!.headersHelper;
  if (command === undefined) throw new Error('the engine wired no headersHelper for this invocation');
  return { command, spawn, events, adapter };
}

describe('x21 end to end: a real helper, a real shell, a real token exchange', () => {
  test('the helper the engine wires actually runs, and hands back a FRESH token', async () => {
    const env = await spawnEnv();
    const { command } = await helperCommandFor(env);
    expect(command).toContain(HELPER_SCRIPT);
    expect(command).toContain(EXECUTION_ID);

    const exchangesBefore = cloud.exchanges;
    const result = await runThroughShell(command, env);

    expect(result.code).toBe(0);
    const headers = JSON.parse(result.stdout) as Record<string, string>;
    // A genuinely NEW credential, not the one already in the environment —
    // which is the entire difference between this and a static header.
    expect(headers.Authorization).toBe(`Bearer ${cloud.issued[cloud.issued.length - 1]}`);
    expect(headers.Authorization).not.toBe(`Bearer ${env[ENGINE_MCP_TOKEN_ENV]}`);
    expect(cloud.exchanges).toBe(exchangesBefore + 1);
  }, 30_000);

  test('the durable client secret never appears anywhere the session can see', async () => {
    const env = await spawnEnv();
    const { command } = await helperCommandFor(env);
    const result = await runThroughShell(command, env);

    // The invariant D33 declares survives unchanged. The `client_credentials`
    // exchange happened in the DAEMON; only its output crossed the loopback.
    expect(command).not.toContain(CLIENT_SECRET);
    expect(result.stdout).not.toContain(CLIENT_SECRET);
    expect(result.stderr).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(env)).not.toContain(CLIENT_SECRET);
    // …and the loopback grant itself is not on the command line either.
    expect(command).not.toContain(env[ENGINE_MCP_HELPER_SECRET_ENV]!);
    expect(command).not.toContain(env[ENGINE_MCP_TOKEN_ENV]!);
  }, 30_000);

  test('the fresh token is the one /mcp accepts — the token the session was spawned with is not', async () => {
    const env = await spawnEnv();
    const { command } = await helperCommandFor(env);
    // Before: the token the session holds is the one that works.
    expect((await fetch(`${cloud.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${env[ENGINE_MCP_TOKEN_ENV]}` } })).status).toBe(200);

    // The TTL runs out and the resource server starts refusing it — modelled
    // here by the re-authorization itself rotating what `/mcp` accepts, which
    // is the same observable state a real expiry produces.
    const headers = JSON.parse((await runThroughShell(command, env)).stdout) as Record<string, string>;

    // After: the session's own copy is dead — this is the moment that cost
    // the P4 gate its task — and the helper's is alive.
    const stale = await fetch(`${cloud.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${env[ENGINE_MCP_TOKEN_ENV]}` } });
    expect(stale.status).toBe(401);
    const retried = await fetch(`${cloud.url}/mcp`, { method: 'POST', headers: { authorization: headers.Authorization! } });
    expect(retried.status).toBe(200);
  }, 30_000);

  test('a revoked execution gets nothing back — the helper is not a standing grant', async () => {
    const env = await spawnEnv();
    const { command } = await helperCommandFor(env);
    // A decoy grant so the LISTENER stays open past the revoke: this test is
    // about the grant being gone, not about the socket closing (which is
    // asserted separately in `./execution-token-endpoint.test.ts`).
    await endpoint.grant('dexec-someone-else');
    endpoint.revoke(EXECUTION_ID);

    const result = await runThroughShell(command, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('HTTP 401');
    expect(result.stdout).toBe('');
    endpoint.revoke('dexec-someone-else');
  }, 30_000);
});

describe('x21 × x16: a real mid-session re-authorization ends in a completion', () => {
  test('the P4 gate case, but with the seam in place: token expires, helper re-auths, task completes', async () => {
    // The same frame sequence `x16`'s "the P4 gate case" test drives — except
    // that the recovery between the 401 and the second call is not scripted:
    // the REAL helper the engine wired is REALLY run against the REAL
    // endpoint, and only if it comes back with a working token does this test
    // emit the tool_result that disarms x16's judgement.
    const env = await spawnEnv();
    const { command, spawn, events } = await helperCommandFor(env);
    const receiver = (tool: string): string => `mcp__${DEPARTMENT_MCP_SERVER_NAME}__${tool}`;
    const toolCall = (name: string, id: string): Record<string, unknown> => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, id, input: {} }] },
    });
    const toolAnswer = (id: string, options: { isError?: boolean; content?: unknown } = {}): Record<string, unknown> => ({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, ...(options.isError === true ? { is_error: true } : {}), content: options.content ?? 'ACK' }],
      },
    });

    // 1. The session works normally for a while.
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_ok'));
    spawn.last.emitJson(toolAnswer('toolu_ok'));

    // 2. Its execution token expires; the next receiver call comes back the
    //    way the live gate captured it, verbatim.
    spawn.last.emitJson(toolCall(receiver('task_update_progress'), 'toolu_401'));
    spawn.last.emitJson(toolAnswer('toolu_401', { isError: true, content: 'MCP server "pipeline-department" requires re-authorization (token expired)' }));

    // 3. Claude Code re-runs the headers helper on that 401. For real.
    const helper = await runThroughShell(command, env);
    expect(helper.code).toBe(0);
    const headers = JSON.parse(helper.stdout) as Record<string, string>;
    const proof = await fetch(`${cloud.url}/mcp`, { method: 'POST', headers: { authorization: headers.Authorization! } });
    expect(proof.status).toBe(200); // the retried call really would land now

    // 4. So the retried terminal call lands, and the session ends claiming
    //    success — a claim that is now TRUE.
    spawn.last.emitJson(toolCall(receiver('task_complete'), 'toolu_done'));
    spawn.last.emitJson(toolAnswer('toolu_done', { content: 'ACK: task marked complete.' }));
    spawn.last.emitJson({ type: 'result', is_error: false, subtype: 'success', result: 'reviewed the save system' });

    const terminal = events[events.length - 1]!;
    // Pre-x21 this same sequence could only end one way: the 401 stood, x16
    // read the broken channel at the terminal frame, and the sender was told
    // `unreported`. The task is now genuinely finished, and says so.
    expect(terminal).toEqual({ type: 'completed', summary: 'reviewed the save system' });
    // …and specifically NOT the verdict x16 would have reached had the 401
    // stood, which is what makes this the disarm path rather than a happy one.
    expect(events.filter((event) => event.type === 'failed' && event.reason === UNREPORTED_FAILURE_REASON)).toHaveLength(0);
  }, 30_000);
});
