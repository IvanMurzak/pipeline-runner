/**
 * End-to-end integration over REAL HTTP + a REAL OS subprocess (department-
 * mesh d6). The rest of the d6 suite (`./execution-token-manager.test.ts`,
 * `../core/department-oauth.test.ts`, `./manager-oauth.test.ts`,
 * `./mcp-relay.test.ts`) exercises every branch against injected
 * fakes/fetch stubs for speed and determinism; this file proves the
 * PRODUCTION wiring actually works: a real `fetch()` `client_credentials`
 * exchange against a `Bun.serve` mock of c12's `/oauth/token` contract, and
 * a real spawned process reading `PIPELINE_DEPARTMENT_MCP_URL`/
 * `PIPELINE_DEPARTMENT_EXECUTION_TOKEN` from its OWN environment and making a real
 * HTTP call to a mock `/mcp` — the DoD's "runner obtains an execution token
 * … a token for an execution it does not hold is refused" and "runtimes
 * reach /mcp with the execution token and can call the task.* surface",
 * both end to end. Kept to two scenarios (real process start/stop has real
 * overhead) — every edge case is already covered by the fake-driven suites.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import { nodeJobSpawn } from '../jobs/types';
import type { DeptMessage, RuntimeConfig } from './adapter';
import { ExecutionTokenManager } from './execution-token-manager';
import { JsonlProcessAdapter } from './jsonl-process';
import type { DepartmentOfferInput } from './manager';
import { DepartmentManager } from './manager';

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp-client-runtime.ts');
const NULL_DISPATCHER: Pick<Dispatcher, 'on'> = { on: () => () => {} };
const NULL_JOURNAL = { ensureDir: () => {}, appendLine: () => {} };
const CLIENT_ID = 'run_test';
const CLIENT_SECRET = 'secret-runner-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A mock cloud, matching c12's REAL contract shape closely enough to prove
 * the runner-side wiring: `POST /oauth/token` (HTTP Basic client auth,
 * `client_credentials` + `resource`/`scope`/`execution_id`, `invalid_grant`
 * for an execution not in `leasedExecutionIds`) and `POST /mcp` (accepts
 * only a bearer token this mock itself issued).
 */
function startMockCloud(leasedExecutionIds: readonly string[]): { url: string; issuedTokens: Map<string, string>; mcpCalls: number; stop(): void } {
  const issuedTokens = new Map<string, string>();
  const leased = new Set(leasedExecutionIds);
  let mcpCalls = 0;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const form = new URLSearchParams(await req.text());
        const auth = req.headers.get('authorization') ?? '';
        const basic = /^Basic\s+(.+)$/i.exec(auth);
        if (!basic) return jsonResponse(401, { error: 'invalid_client' });
        const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        const clientId = decoded.slice(0, sep);
        const clientSecret = decoded.slice(sep + 1);
        if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
          return jsonResponse(401, { error: 'invalid_client', error_description: 'runner client authentication failed' });
        }
        if (form.get('grant_type') !== 'client_credentials' || form.get('scope') !== 'mesh:execution' || !form.get('execution_id') || !form.get('resource')) {
          return jsonResponse(400, { error: 'invalid_request' });
        }
        const executionId = form.get('execution_id')!;
        if (!leased.has(executionId)) {
          return jsonResponse(400, { error: 'invalid_grant', error_description: 'the named execution is not leased to this runner' });
        }
        const token = `exec-token-${executionId}-${crypto.randomUUID()}`;
        issuedTokens.set(executionId, token);
        return jsonResponse(200, { access_token: token, token_type: 'Bearer', expires_in: 900, scope: 'mesh:execution' });
      }

      if (req.method === 'POST' && url.pathname === '/mcp') {
        mcpCalls += 1;
        const auth = req.headers.get('authorization') ?? '';
        const bearer = /^Bearer\s+(.+)$/i.exec(auth);
        const presented = bearer?.[1];
        if (presented === undefined || ![...issuedTokens.values()].includes(presented)) {
          return jsonResponse(401, { error: 'invalid_token' });
        }
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true, tool: 'task.get_current' } });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    issuedTokens,
    get mcpCalls() {
      return mcpCalls;
    },
    stop: () => server.stop(true),
  };
}

function makeManager(cloudUrl: string): { manager: DepartmentManager; frames: WireFrame[] } {
  const frames: WireFrame[] = [];
  const tokenManager = new ExecutionTokenManager({
    baseUrl: () => cloudUrl,
    clientId: () => CLIENT_ID,
    clientSecret: () => CLIENT_SECRET,
  });
  const runtimes = new Map<string, RuntimeConfig>([
    ['unity-department', { adapterId: 'jsonl-process', command: process.execPath, args: [FIXTURE], startupTimeoutSeconds: 15 }],
  ]);
  const manager = new DepartmentManager({
    adapters: [new JsonlProcessAdapter({ spawn: nodeJobSpawn() })],
    resolveRuntimeConfig: (id) => runtimes.get(id) ?? null,
    send: (frame) => {
      frames.push(frame);
      return true;
    },
    dispatcher: NULL_DISPATCHER,
    journal: NULL_JOURNAL,
    executionTokens: tokenManager,
  });
  return { manager, frames };
}

function makeOffer(executionId: string): DepartmentOfferInput {
  const message: DeptMessage = { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'go', mediaType: 'text/plain' }] };
  return { executionId, taskId: `dtask-${executionId}`, contextId: `dctx-${executionId}`, departmentId: 'unity-department', messages: [message] };
}

interface DepartmentEventFrame {
  type: 'department.event';
  event: { type: string; reason?: string; parts?: Array<{ text?: string }> };
}

function asDepartmentEvent(frame: WireFrame): DepartmentEventFrame | null {
  const f = frame as Record<string, unknown>;
  if (f.type !== 'department.event') return null;
  return f as unknown as DepartmentEventFrame;
}

function isTerminal(frame: WireFrame): boolean {
  const event = asDepartmentEvent(frame)?.event;
  return event?.type === 'completed' || event?.type === 'failed';
}

async function waitForTerminal(frames: WireFrame[], deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!frames.some(isTerminal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('d6 real end-to-end: client_credentials exchange + spawned runtime reaching /mcp', () => {
  test('a leased execution gets a token via client_credentials, and the spawned runtime calls /mcp successfully with it', async () => {
    const cloud = startMockCloud(['dexec-leased']);
    try {
      const { manager, frames } = makeManager(cloud.url);
      const result = await manager.admitTask(makeOffer('dexec-leased'));
      expect(result).toEqual({ accepted: true });

      await waitForTerminal(frames);
      const terminal = frames.find(isTerminal);
      expect(asDepartmentEvent(terminal!)?.event.type).toBe('completed');

      const messages = frames
        .map(asDepartmentEvent)
        .filter((f) => f?.event.type === 'message')
        .map((f) => f?.event.parts?.[0]?.text ?? '');

      // b5 — the dual-name window, PROVEN rather than asserted about a map
      // this test built itself. `both` is emitted by the fixture only when the
      // new spelling AND the pre-rename one are present in the REAL spawned
      // process's environment and carry byte-identical values
      // (`./fixtures/mcp-client-runtime.ts`'s `dualNameState`).
      expect(messages).toContain('dual-name url=both token=both');
      // And the call that used them actually landed.
      expect(messages.some((text) => text.includes('mcp-call-ok status=200'))).toBe(true);

      // The AS actually minted a client_credentials token naming THIS execution.
      expect(cloud.issuedTokens.has('dexec-leased')).toBe(true);
      // And the mock /mcp actually received (and accepted) a call.
      expect(cloud.mcpCalls).toBeGreaterThan(0);
    } finally {
      cloud.stop();
    }
  }, 20_000);

  test('an execution NOT leased to this runner is refused (invalid_grant) — admission still succeeds, runtime degrades gracefully', async () => {
    const cloud = startMockCloud(['some-other-execution']); // 'dexec-not-mine' is deliberately absent
    try {
      const { manager, frames } = makeManager(cloud.url);
      const result = await manager.admitTask(makeOffer('dexec-not-mine'));
      // DoD: "existing behaviour unchanged" — a refused token must never
      // block admission; the department still runs (degraded: no MCP env).
      expect(result).toEqual({ accepted: true });

      await waitForTerminal(frames);
      const terminal = asDepartmentEvent(frames.find(isTerminal)!);
      expect(terminal?.event.type).toBe('failed');
      expect(terminal?.event.reason).toContain('no PIPELINE_DEPARTMENT_MCP_URL');

      expect(cloud.issuedTokens.has('dexec-not-mine')).toBe(false);
      expect(cloud.mcpCalls).toBe(0);
    } finally {
      cloud.stop();
    }
  }, 20_000);
});
