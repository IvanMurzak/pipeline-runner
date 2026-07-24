/**
 * `DepartmentManager` × `ExecutionTokenSource` wiring (department-mesh d6):
 * every (re)spawn requests an execution token and injects
 * `PIPELINE_MESH_MCP_URL`/`PIPELINE_MESH_EXECUTION_TOKEN` into the runtime's
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
import type { ExecutionTokenResult } from '../core/mesh-oauth';
import type { WireFrame } from '../core/wire';
import type { RuntimeConfig } from './adapter';
import { FakeAdapter, makeMessage } from './_test-helpers';
import type { ExecutionTokenSource } from './execution-token-manager';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DepartmentManager, MESH_EXECUTION_TOKEN_ENV, MESH_MCP_URL_ENV } from './manager';

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

function makeManager(
  overrides: Partial<{ adapters: FakeAdapter[]; executionTokens: FakeTokenSource; logger: CaptureLogger }> = {}
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
  });
  return { manager, clock, logger, journal, sink, runtimes, adapter: adapters[0]!, executionTokens };
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
  test('a successful token request injects PIPELINE_MESH_MCP_URL/PIPELINE_MESH_EXECUTION_TOKEN into the spawned runtime env', async () => {
    const tokenSource = new FakeTokenSource();
    const { manager, adapter, runtimes } = makeManager({ executionTokens: tokenSource });
    runtimes.set('unity-department', { adapterId: 'fake', command: 'unity-department', env: { EXISTING: '1' } });

    const result = await manager.admitTask(makeOffer());
    expect(result).toEqual({ accepted: true });
    expect(tokenSource.getTokenCalls).toEqual(['dexec-1']);

    const invocation = adapter.startCalls()[0]!;
    expect(invocation.runtime.env).toEqual({
      EXISTING: '1',
      [MESH_MCP_URL_ENV]: RESOURCE_URL,
      [MESH_EXECUTION_TOKEN_ENV]: 'tok-1',
    });
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
    expect(adapter.startCalls()[1]!.runtime.env?.[MESH_EXECUTION_TOKEN_ENV]).toBe('tok-2');
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
