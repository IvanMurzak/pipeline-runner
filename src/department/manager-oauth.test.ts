/**
 * `DepartmentManager` × `ExecutionTokenSource` wiring (department-mesh d6):
 * every (re)spawn requests an execution token and injects
 * `PIPELINE_DEPARTMENT_MCP_URL`/`PIPELINE_DEPARTMENT_EXECUTION_TOKEN` (and,
 * for b5's window, their pre-rename `PIPELINE_MESH_*` spellings) into the runtime's
 * env (07 §4 — "no adapter work at all", the URL+token are just env); a
 * refused/unavailable token degrades admission gracefully (existing JSONL
 * behaviour is unaffected, DoD: "existing behaviour unchanged"); a
 * successful lease renewal re-REQUESTS (not refreshes) the token; lease
 * revocation and terminal both discard the cached token; nothing here ever
 * logs a token (mirrors `tests/connection.test.ts:359`).
 *
 * Uses the SAME `FakeAdapter`/`makeMessage`/`makeOffer` shape as
 * `./manager.test.ts` but is its own file — this task's wiring is additive
 * and orthogonal to that suite's existing (unaffected) coverage.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { Dispatcher } from '../core/dispatcher';
import type { ExecutionTokenResult } from '../core/department-oauth';
import type { WireFrame } from '../core/wire';
import type { RuntimeConfig } from './adapter';
import { FakeAdapter, makeMessage } from './_test-helpers';
import { readEngineMcpHelperChannel, requireEngineMcpEnv } from './engine';
import type { ExecutionHeaderChannel, ExecutionHeaderChannelSource } from './execution-token-endpoint';
import type { ExecutionTokenSource } from './execution-token-manager';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import {
  DepartmentManager,
  DEPARTMENT_EXECUTION_TOKEN_ENV,
  DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY,
  DEPARTMENT_HELPER_SECRET_ENV,
  DEPARTMENT_HELPER_SECRET_ENV_LEGACY,
  DEPARTMENT_HELPER_URL_ENV,
  DEPARTMENT_HELPER_URL_ENV_LEGACY,
  DEPARTMENT_MCP_URL_ENV,
  DEPARTMENT_MCP_URL_ENV_LEGACY,
} from './manager';

const RESOURCE_URL = 'https://api.ai-pipeline.dev/mcp';

class MemJournal implements JournalWriter {
  lines = new Map<string, string[]>();
  ensureDir(): void {}
  appendLine(path: string, line: string): void {
    const list = this.lines.get(path) ?? [];
    list.push(line);
    this.lines.set(path, list);
  }
}

const NULL_DISPATCHER: Pick<Dispatcher, 'on'> = { on: () => () => {} };

class FrameSink {
  frames: WireFrame[] = [];
  ok = true;
  send = (frame: WireFrame): boolean => {
    if (!this.ok) return false;
    this.frames.push(frame);
    return true;
  };
}

/** Scriptable `ExecutionTokenSource` — records every call so tests assert
 *  exactly when/whether the manager reaches for a token. */
class FakeTokenSource implements ExecutionTokenSource {
  getTokenCalls: string[] = [];
  renewCalls: string[] = [];
  discardCalls: string[] = [];
  script = new Map<string, ExecutionTokenResult>();
  private counter = 0;
  url: string | null = RESOURCE_URL;

  async getToken(executionId: string): Promise<ExecutionTokenResult> {
    this.getTokenCalls.push(executionId);
    return this.respond(executionId);
  }

  async renew(executionId: string): Promise<ExecutionTokenResult> {
    this.renewCalls.push(executionId);
    return this.respond(executionId);
  }

  discard(executionId: string): void {
    this.discardCalls.push(executionId);
  }

  resourceUrl(): string | null {
    return this.url;
  }

  private respond(executionId: string): ExecutionTokenResult {
    const scripted = this.script.get(executionId);
    if (scripted !== undefined) return scripted;
    this.counter += 1;
    return { ok: true, token: { accessToken: `tok-${this.counter}`, tokenType: 'Bearer', expiresAt: 1_000_000, scope: 'mesh:execution' } };
  }
}

/** x21: scriptable `ExecutionHeaderChannelSource` — records grants/revokes so
 *  tests assert exactly when the supervisor opens and closes an execution's
 *  loopback re-auth window. */
class FakeHeaderChannel implements ExecutionHeaderChannelSource {
  grantCalls: string[] = [];
  revokeCalls: string[] = [];
  /** `null` ⇒ the endpoint could not bind; `'throw'` ⇒ it rejected. */
  mode: 'ok' | 'null' | 'throw' = 'ok';
  private counter = 0;

  async grant(executionId: string): Promise<ExecutionHeaderChannel | null> {
    this.grantCalls.push(executionId);
    if (this.mode === 'throw') throw new Error('listener is gone');
    if (this.mode === 'null') return null;
    this.counter += 1;
    return { url: 'http://127.0.0.1:51234/mcp-headers', secret: `grant-secret-${this.counter}` };
  }

  revoke(executionId: string): void {
    this.revokeCalls.push(executionId);
  }
}

function makeManager(
  overrides: Partial<{
    adapters: FakeAdapter[];
    executionTokens: FakeTokenSource;
    executionHeaderChannel: FakeHeaderChannel;
    logger: CaptureLogger;
  }> = {}
) {
  const clock = new FakeClock();
  const logger = overrides.logger ?? new CaptureLogger();
  const journal = new MemJournal();
  const sink = new FrameSink();
  const adapters = overrides.adapters ?? [new FakeAdapter()];
  const runtimes = new Map<string, RuntimeConfig>();
  const executionTokens = overrides.executionTokens;
  const manager = new DepartmentManager({
    adapters,
    resolveRuntimeConfig: (departmentId) => runtimes.get(departmentId) ?? null,
    send: sink.send,
    dispatcher: NULL_DISPATCHER,
    journal,
    journalRoot: join('/data', 'department'),
    clock,
    logger,
    executionTokens,
    ...(overrides.executionHeaderChannel !== undefined ? { executionHeaderChannel: overrides.executionHeaderChannel } : {}),
  });
  return {
    manager,
    clock,
    logger,
    journal,
    sink,
    runtimes,
    adapter: adapters[0]!,
    executionTokens,
    executionHeaderChannel: overrides.executionHeaderChannel,
  };
}

function makeOffer(overrides: Partial<DepartmentOfferInput> = {}): DepartmentOfferInput {
  return {
    executionId: 'dexec-1',
    taskId: 'dtask-1',
    contextId: 'dctx-1',
    departmentId: 'unity-department',
    messages: [makeMessage()],
    ...overrides,
  };
}

describe('DepartmentManager — execution-token env injection (d6, 13 §12 / 07 §4)', () => {
  test('a successful token request injects PIPELINE_DEPARTMENT_MCP_URL/PIPELINE_DEPARTMENT_EXECUTION_TOKEN into the spawned runtime env — AND the pre-b5 spellings, same values', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department', env: { EXISTING: '1' } });

    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: true });
    expect(tokenSource.getTokenCalls).toEqual(['dexec-1']);

    const invocation = adapter.startCalls()[0]!;
    // b5's dual-name window, stated exhaustively rather than by containment:
    // an EXACT map, so a future change that drops either spelling fails here.
    expect(invocation.runtime.env).toEqual({
      EXISTING: '1',
      [DEPARTMENT_MCP_URL_ENV]: RESOURCE_URL,
      [DEPARTMENT_EXECUTION_TOKEN_ENV]: 'tok-1',
      [DEPARTMENT_MCP_URL_ENV_LEGACY]: RESOURCE_URL,
      [DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]: 'tok-1',
    });
  });

  test('b5 — the four names are the two the design named, and old and new are distinct keys carrying identical values', async () => {
    // The names themselves, so a typo in either spelling is caught here and
    // not by a session that silently loses its MCP connection.
    expect(DEPARTMENT_MCP_URL_ENV).toBe('PIPELINE_DEPARTMENT_MCP_URL');
    expect(DEPARTMENT_EXECUTION_TOKEN_ENV).toBe('PIPELINE_DEPARTMENT_EXECUTION_TOKEN');
    expect(DEPARTMENT_MCP_URL_ENV_LEGACY).toBe('PIPELINE_MESH_MCP_URL');
    expect(DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY).toBe('PIPELINE_MESH_EXECUTION_TOKEN');
    expect(DEPARTMENT_HELPER_URL_ENV).toBe('PIPELINE_DEPARTMENT_HELPER_URL');
    expect(DEPARTMENT_HELPER_SECRET_ENV).toBe('PIPELINE_DEPARTMENT_HELPER_SECRET');
    expect(DEPARTMENT_HELPER_URL_ENV_LEGACY).toBe('PIPELINE_MESH_HELPER_URL');
    expect(DEPARTMENT_HELPER_SECRET_ENV_LEGACY).toBe('PIPELINE_MESH_HELPER_SECRET');

    const channel = new FakeHeaderChannel();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    const env = adapter.startCalls()[0]!.runtime.env ?? {};

    // A consumer reading EITHER generation of names gets the same thing —
    // which is the whole claim the window rests on.
    for (const [current, legacy] of [
      [DEPARTMENT_MCP_URL_ENV, DEPARTMENT_MCP_URL_ENV_LEGACY],
      [DEPARTMENT_EXECUTION_TOKEN_ENV, DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY],
      [DEPARTMENT_HELPER_URL_ENV, DEPARTMENT_HELPER_URL_ENV_LEGACY],
      [DEPARTMENT_HELPER_SECRET_ENV, DEPARTMENT_HELPER_SECRET_ENV_LEGACY],
    ] as const) {
      expect(current).not.toBe(legacy);
      expect(env[current]).toBeDefined();
      expect(env[legacy]).toBe(env[current]!);
    }
  });

  test('b5 — an engine reading a LEGACY-ONLY invocation still connects; the fallback path is exercised, not assumed', () => {
    // The case the window exists for: a session whose env was built by a
    // supervisor from before this rename. `requireEngineMcpEnv` must resolve
    // it rather than refuse to start.
    const legacyOnly = {
      runtime: { env: { [DEPARTMENT_MCP_URL_ENV_LEGACY]: RESOURCE_URL, [DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]: 'tok-legacy' } },
    } as unknown as Parameters<typeof requireEngineMcpEnv>[0];
    expect(requireEngineMcpEnv(legacyOnly, 'claude-code')).toEqual({ url: RESOURCE_URL, token: 'tok-legacy' });
    expect(readEngineMcpHelperChannel(legacyOnly)).toBeNull();

    const legacyHelper = {
      runtime: {
        env: {
          [DEPARTMENT_MCP_URL_ENV_LEGACY]: RESOURCE_URL,
          [DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]: 'tok-legacy',
          [DEPARTMENT_HELPER_URL_ENV_LEGACY]: 'http://127.0.0.1:1/mcp-headers',
          [DEPARTMENT_HELPER_SECRET_ENV_LEGACY]: 'legacy-secret',
        },
      },
    } as unknown as Parameters<typeof requireEngineMcpEnv>[0];
    expect(readEngineMcpHelperChannel(legacyHelper)).toEqual({ url: 'http://127.0.0.1:1/mcp-headers', secret: 'legacy-secret' });

    // And the new name WINS when both are present, so a supervisor mid-upgrade
    // is never ambiguous.
    const both = {
      runtime: {
        env: {
          [DEPARTMENT_MCP_URL_ENV]: RESOURCE_URL,
          [DEPARTMENT_EXECUTION_TOKEN_ENV]: 'tok-new',
          [DEPARTMENT_MCP_URL_ENV_LEGACY]: 'https://stale.example/mcp',
          [DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]: 'tok-stale',
        },
      },
    } as unknown as Parameters<typeof requireEngineMcpEnv>[0];
    expect(requireEngineMcpEnv(both, 'claude-code')).toEqual({ url: RESOURCE_URL, token: 'tok-new' });
  });

  test('with no executionTokens configured, admission is byte-for-byte the pre-d6 path — no env injected, no token call', async () => {
    const { manager, adapter, runtimes } = makeManager(); // no executionTokens
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department' });
    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: true });
    const invocation = adapter.startCalls()[0]!;
    expect(invocation.runtime.env).toBeUndefined();
  });

  test('a refused execution token (e.g. invalid_grant) degrades gracefully — admission still succeeds, no MCP env injected', async () => {
    const tokenSource = new FakeTokenSource();
    tokenSource.script.set('dexec-1', { ok: false, error: { error: 'invalid_grant', description: 'not leased to this runner' } });
    const { manager, adapter, runtimes, logger } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department' });

    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: true }); // existing behaviour unchanged — the DEPARTMENT still runs
    const invocation = adapter.startCalls()[0]!;
    expect(invocation.runtime.env).toBeUndefined();
    expect(logger.joined()).toContain('invalid_grant');
  });

  test('a per-context respawn requests a FRESH token for the new spawn', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });
    await manager.admitTask(makeOffer());
    expect(tokenSource.getTokenCalls).toEqual(['dexec-1']);

    adapter.emitLatest({ type: 'failed', reason: 'crash', retrySafe: true }); // triggers the ONE silent auto-respawn (d2)
    // With executionTokens wired, the respawn awaits a fresh token before
    // calling adapter.start() again — unlike the pre-d6 synchronous path
    // (`./manager.test.ts`'s equivalent assertion, deliberately untouched),
    // so this test flushes a tick rather than asserting same-turn.
    await tick();
    expect(tokenSource.getTokenCalls).toEqual(['dexec-1', 'dexec-1']);
    expect(adapter.startCalls()).toHaveLength(2);
    expect(adapter.startCalls()[1]!.runtime.env?.[DEPARTMENT_EXECUTION_TOKEN_ENV]).toBe('tok-2');
  });
});

describe('DepartmentManager — lease renewal re-REQUESTS the execution token (not refresh)', () => {
  test('a successful department.lease_renew send triggers executionTokens.renew() for that execution', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, clock, runtimes, sink } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 })); // TTL/3 = 30s
    expect(tokenSource.renewCalls).toEqual([]);

    clock.advance(30_000);
    manager.renewLeases();
    await Promise.resolve(); // let the fire-and-forget renew() settle
    await Promise.resolve();

    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(1);
    expect(tokenSource.renewCalls).toEqual(['dexec-1']);
  });

  test('a lease_renew that could not be sent (offline) does NOT trigger a token renew', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, clock, runtimes, sink } = makeManager({ executionTokens: tokenSource });
    sink.ok = false;
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 }));

    clock.advance(30_000);
    manager.renewLeases();
    await Promise.resolve();

    expect(tokenSource.renewCalls).toEqual([]);
  });
});

describe('DepartmentManager — execution-token cache discard', () => {
  test('department.lease_revoked discards the cached execution token', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, runtimes } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    const dispatcher = new Dispatcher();
    const off = manager.attach(dispatcher);
    dispatcher.dispatch({ type: 'department.lease_revoked', execution_id: 'dexec-1', reason: 'reassigned' });
    off();

    expect(tokenSource.discardCalls).toEqual(['dexec-1']);
  });

  test('a terminal (completed) execution discards the cached execution token', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'completed', summary: 'done' });
    expect(tokenSource.discardCalls).toEqual(['dexec-1']);
  });
});

describe('secrets discipline (mirrors tests/connection.test.ts:359)', () => {
  test('no execution token is ever logged across admission, respawn, renewal, and terminal', async () => {
    const tokenSource = new FakeTokenSource();
    const logger = new CaptureLogger();
    const { manager, adapter, clock, runtimes, sink } = makeManager({ executionTokens: tokenSource, logger });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });

    await manager.admitTask(makeOffer({ leaseToken: 'lease-abc', leaseTtlS: 90 }));
    adapter.emitLatest({ type: 'failed', reason: 'crash', retrySafe: true }); // respawn -> 2nd token
    clock.advance(30_000);
    manager.renewLeases(); // renew -> 3rd token
    await Promise.resolve();
    await Promise.resolve();
    adapter.emitLatest({ type: 'completed', summary: 'done' }); // terminal -> discard

    expect(sink.frames.filter((f) => f.type === 'department.lease_renew')).toHaveLength(1);
    for (const line of logger.lines) {
      expect(line).not.toContain('tok-1');
      expect(line).not.toContain('tok-2');
      expect(line).not.toContain('tok-3');
    }
  });
});

// ── x21: the loopback re-auth channel (D33) ────────────────────────────────

describe('DepartmentManager — the loopback re-auth channel (x21, D33)', () => {
  test('a granted channel is injected alongside the token — and the envelope names the execution', async () => {
    const channel = new FakeHeaderChannel();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department', env: { EXISTING: '1' } });

    expect(await manager.admitTask(makeOffer())).toEqual({ accepted: true });
    expect(channel.grantCalls).toEqual(['dexec-1']);

    const invocation = adapter.startCalls()[0]!;
    expect(invocation.runtime.env).toEqual({
      EXISTING: '1',
      [DEPARTMENT_MCP_URL_ENV]: RESOURCE_URL,
      [DEPARTMENT_EXECUTION_TOKEN_ENV]: 'tok-1',
      [DEPARTMENT_HELPER_URL_ENV]: 'http://127.0.0.1:51234/mcp-headers',
      [DEPARTMENT_HELPER_SECRET_ENV]: 'grant-secret-1',
      // b5 dual-name window — the helper pair aliases too, not just the token.
      [DEPARTMENT_MCP_URL_ENV_LEGACY]: RESOURCE_URL,
      [DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]: 'tok-1',
      [DEPARTMENT_HELPER_URL_ENV_LEGACY]: 'http://127.0.0.1:51234/mcp-headers',
      [DEPARTMENT_HELPER_SECRET_ENV_LEGACY]: 'grant-secret-1',
    });
    // The half of D33 that is not about tokens at all: an engine module can
    // now name its own execution.
    expect(invocation.executionId).toBe('dexec-1');
  });

  test('no channel configured ⇒ byte-for-byte the pre-x21 env — this is the shipped fallback, not a bug', async () => {
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource() });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    // Still exactly the token pair and nothing else — now in both spellings
    // (b5), which is what "the helper vars are absent" has to mean after the
    // aliasing pass runs over the whole map.
    expect(Object.keys(adapter.startCalls()[0]!.runtime.env ?? {}).sort()).toEqual(
      [DEPARTMENT_EXECUTION_TOKEN_ENV, DEPARTMENT_MCP_URL_ENV, DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY, DEPARTMENT_MCP_URL_ENV_LEGACY].sort()
    );
  });

  test('a channel that cannot be granted degrades — admission still succeeds, the session still runs', async () => {
    for (const mode of ['null', 'throw'] as const) {
      const channel = new FakeHeaderChannel();
      channel.mode = mode;
      const logger = new CaptureLogger();
      const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel, logger });
      runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });

      // The whole posture: a missing RECOVERY path is not a reason to refuse
      // a task, exactly as a refused token is not (`resolveMcpEnv`).
      expect(await manager.admitTask(makeOffer())).toEqual({ accepted: true });
      const env = adapter.startCalls()[0]!.runtime.env ?? {};
      expect(env[DEPARTMENT_EXECUTION_TOKEN_ENV]).toBe('tok-1');
      expect(env[DEPARTMENT_HELPER_URL_ENV]).toBeUndefined();
      expect(env[DEPARTMENT_HELPER_SECRET_ENV]).toBeUndefined();
      // b5: and the aliasing pass must not conjure a legacy spelling of a
      // variable that was never set — "no grant" has to mean no grant in
      // BOTH generations of names, or a pre-b5 engine sees a half-channel.
      expect(env[DEPARTMENT_HELPER_URL_ENV_LEGACY]).toBeUndefined();
      expect(env[DEPARTMENT_HELPER_SECRET_ENV_LEGACY]).toBeUndefined();
      expect(env[DEPARTMENT_EXECUTION_TOKEN_ENV_LEGACY]).toBe('tok-1');
    }
  });

  test('no execution token ⇒ no channel either — there is nothing for a helper to refresh', async () => {
    const tokenSource = new FakeTokenSource();
    tokenSource.script.set('dexec-1', { ok: false, error: { error: 'invalid_grant' } });
    const channel = new FakeHeaderChannel();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: tokenSource, executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });

    expect(await manager.admitTask(makeOffer())).toEqual({ accepted: true });
    expect(channel.grantCalls).toEqual([]);
    expect(adapter.startCalls()[0]!.runtime.env).toBeUndefined();
  });

  test('a per-context respawn ROTATES the grant — the dead process\'s secret stops working', async () => {
    const channel = new FakeHeaderChannel();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x', lifecycle: 'per-context' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'failed', reason: 'crash', retrySafe: true });
    // Same flush the d6 respawn test above needs: the respawn awaits a fresh
    // token (and now a fresh grant) before calling `start()` again.
    await tick();

    expect(channel.grantCalls).toEqual(['dexec-1', 'dexec-1']);
    expect(adapter.startCalls()[1]!.runtime.env?.[DEPARTMENT_HELPER_SECRET_ENV]).toBe('grant-secret-2');
  });

  test('a terminal execution revokes the grant — the window closes with the task', async () => {
    const channel = new FakeHeaderChannel();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    adapter.emitLatest({ type: 'completed', summary: 'done' });
    expect(channel.revokeCalls).toEqual(['dexec-1']);
  });

  test('lease_revoked revokes the grant too — a dead lease must not be re-authorizable', async () => {
    const channel = new FakeHeaderChannel();
    const { manager, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());

    const dispatcher = new Dispatcher();
    const off = manager.attach(dispatcher);
    dispatcher.dispatch({ type: 'department.lease_revoked', execution_id: 'dexec-1', reason: 'reassigned' });
    off();

    expect(channel.revokeCalls).toEqual(['dexec-1']);
  });

  test('no grant secret is ever logged', async () => {
    const channel = new FakeHeaderChannel();
    const logger = new CaptureLogger();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: new FakeTokenSource(), executionHeaderChannel: channel, logger });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'x' });
    await manager.admitTask(makeOffer());
    adapter.emitLatest({ type: 'completed', summary: 'done' });
    expect(logger.joined()).not.toContain('grant-secret-1');
  });
});
