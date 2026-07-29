/**
 * `ExecutionTokenManager` — the in-memory execution-token cache
 * (department-mesh d6). Tests the CACHE's behaviour (reuse/expiry/dedup/
 * renew/discard) against an injected `requestToken` fake — the wire shape
 * itself is `../core/department-oauth.test.ts`'s job.
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { ExecutionTokenManager } from './execution-token-manager';
import type { ExecutionTokenResult } from '../core/department-oauth';

const BASE_URL = 'https://api.ai-pipeline.dev';

function makeFakeRequestToken() {
  const calls: string[] = [];
  let nextToken = 0;
  const responses = new Map<string, ExecutionTokenResult>();
  const request = async (opts: { executionId: string }): Promise<ExecutionTokenResult> => {
    calls.push(opts.executionId);
    const override = responses.get(opts.executionId);
    if (override !== undefined) return override;
    nextToken += 1;
    // Well beyond the default clock start (0) + default expiry leeway (5s) —
    // a real token's TTL, not an edge case; tests that care about expiry
    // build their own fake with an explicit expiresAt (see the "requests a
    // fresh token once the cached one is within the expiry leeway" test).
    return { ok: true, token: { accessToken: `tok-${nextToken}`, tokenType: 'Bearer', expiresAt: 1_000_000, scope: 'mesh:execution' } };
  };
  return { request, calls, responses };
}

function makeManager(overrides: Partial<{ clock: FakeClock; logger: CaptureLogger; requestToken: ReturnType<typeof makeFakeRequestToken>['request'] }> = {}) {
  const clock = overrides.clock ?? new FakeClock();
  const logger = overrides.logger ?? new CaptureLogger();
  const fake = makeFakeRequestToken();
  const manager = new ExecutionTokenManager({
    baseUrl: () => BASE_URL,
    clientId: () => 'run_1',
    clientSecret: () => 'rt_secret',
    clock,
    logger,
    requestToken: overrides.requestToken ?? fake.request,
  });
  return { manager, clock, logger, fake };
}

describe('ExecutionTokenManager — resourceUrl', () => {
  test('derives the mcp resource from baseUrl()', () => {
    const { manager } = makeManager();
    expect(manager.resourceUrl()).toBe('https://api.ai-pipeline.dev/mcp');
  });

  test('null when baseUrl() is not yet configured', () => {
    const clock = new FakeClock();
    const manager = new ExecutionTokenManager({ baseUrl: () => null, clientId: () => null, clientSecret: () => null, clock });
    expect(manager.resourceUrl()).toBeNull();
  });
});

describe('ExecutionTokenManager — caching', () => {
  test('reuses a cached, still-live token — one network request for two getToken calls', async () => {
    const { manager, fake } = makeManager();
    const first = await manager.getToken('exec-1');
    const second = await manager.getToken('exec-1');
    expect(first).toEqual(second);
    expect(fake.calls).toEqual(['exec-1']);
  });

  test('requests a fresh token once the cached one is within the expiry leeway', async () => {
    const clock = new FakeClock();
    const fake = makeFakeRequestToken();
    let call = 0;
    fake.request = (async (opts: { executionId: string }) => {
      call += 1;
      fake.calls.push(opts.executionId);
      return { ok: true, token: { accessToken: `tok-${call}`, tokenType: 'Bearer', expiresAt: clock.now() + 10_000, scope: 'mesh:execution' } };
    }) as typeof fake.request;
    const manager = new ExecutionTokenManager({
      baseUrl: () => BASE_URL,
      clientId: () => 'run_1',
      clientSecret: () => 'secret',
      clock,
      requestToken: fake.request,
      expiryLeewayMs: 1_000,
    });

    const first = await manager.getToken('exec-1');
    expect(first.ok && first.token.accessToken).toBe('tok-1');

    clock.advance(9_500); // within 1s of the 10s expiry
    const second = await manager.getToken('exec-1');
    expect(second.ok && second.token.accessToken).toBe('tok-2');
    expect(fake.calls).toEqual(['exec-1', 'exec-1']);
  });

  test('separate executions get separate cache entries', async () => {
    const { manager, fake } = makeManager();
    const a = await manager.getToken('exec-a');
    const b = await manager.getToken('exec-b');
    expect(a.ok && b.ok && a.token.accessToken !== b.token.accessToken).toBe(true);
    expect(fake.calls).toEqual(['exec-a', 'exec-b']);
  });

  test('a refused token is never cached — the next getToken tries again', async () => {
    const { manager, fake } = makeManager();
    fake.responses.set('exec-1', { ok: false, error: { error: 'invalid_grant' } });
    const first = await manager.getToken('exec-1');
    expect(first.ok).toBe(false);
    fake.responses.delete('exec-1');
    const second = await manager.getToken('exec-1');
    expect(second.ok).toBe(true);
    expect(fake.calls).toEqual(['exec-1', 'exec-1']);
  });
});

describe('ExecutionTokenManager — concurrent dedup', () => {
  test('N concurrent getToken calls for the same execution share ONE in-flight request', async () => {
    const { manager, fake } = makeManager();
    const results = await Promise.all([manager.getToken('exec-1'), manager.getToken('exec-1'), manager.getToken('exec-1')]);
    expect(fake.calls).toEqual(['exec-1']);
    expect(new Set(results.map((r) => (r.ok ? r.token.accessToken : null))).size).toBe(1);
  });
});

describe('ExecutionTokenManager — renew (d6 DoD: "re-REQUEST, not refresh")', () => {
  test('renew() always makes a fresh request, even with a live cached token', async () => {
    const { manager, fake } = makeManager();
    const first = await manager.getToken('exec-1');
    const renewed = await manager.renew('exec-1');
    expect(fake.calls).toEqual(['exec-1', 'exec-1']);
    expect(first.ok && renewed.ok && first.token.accessToken !== renewed.token.accessToken).toBe(true);
  });

  test('after renew(), getToken() returns the RENEWED token without another request', async () => {
    const { manager, fake } = makeManager();
    await manager.getToken('exec-1');
    const renewed = await manager.renew('exec-1');
    const after = await manager.getToken('exec-1');
    expect(fake.calls).toEqual(['exec-1', 'exec-1']);
    expect(renewed).toEqual(after);
  });
});

describe('ExecutionTokenManager — discard', () => {
  test('discard() drops the cache — the next getToken() requests fresh', async () => {
    const { manager, fake } = makeManager();
    await manager.getToken('exec-1');
    manager.discard('exec-1');
    await manager.getToken('exec-1');
    expect(fake.calls).toEqual(['exec-1', 'exec-1']);
  });

  test('discard() on an unknown execution is a harmless no-op', () => {
    const { manager } = makeManager();
    expect(() => manager.discard('never-seen')).not.toThrow();
  });

  test('discard() DURING an in-flight request wins — the late response is not cached (lease-gone guarantee)', async () => {
    // A lease revoked / execution turned terminal WHILE its token request is
    // still on the wire must not leave a usable token in the cache: discard()
    // must win the race. Reproduce with a request whose resolution we control.
    let resolveReq: ((r: ExecutionTokenResult) => void) | null = null;
    const calls: string[] = [];
    const requestToken = (opts: { executionId: string }): Promise<ExecutionTokenResult> => {
      calls.push(opts.executionId);
      return new Promise<ExecutionTokenResult>((res) => {
        resolveReq = res;
      });
    };
    const clock = new FakeClock();
    const manager = new ExecutionTokenManager({
      baseUrl: () => BASE_URL,
      clientId: () => 'run_1',
      clientSecret: () => 'rt_secret',
      clock,
      requestToken,
    });

    const inflight = manager.getToken('exec-1'); // starts the request, not yet resolved
    manager.discard('exec-1'); // lease revoked mid-flight
    resolveReq!({ ok: true, token: { accessToken: 'tok-late', tokenType: 'Bearer', expiresAt: 1_000_000, scope: 'mesh:execution' } });
    await inflight; // the caller still receives its (now-stale) result — that is fine

    // But the cache must be EMPTY: the next getToken issues a brand-new request
    // (2 total), never returning the discarded token from a stale cache entry.
    const second = manager.getToken('exec-1');
    expect(calls).toEqual(['exec-1', 'exec-1']); // hit the network again, not a cache hit
    resolveReq!({ ok: true, token: { accessToken: 'tok-2', tokenType: 'Bearer', expiresAt: 1_000_000, scope: 'mesh:execution' } });
    const secondResult = await second;
    expect(secondResult.ok && secondResult.token.accessToken).toBe('tok-2');
  });
});

describe('ExecutionTokenManager — not registered yet', () => {
  test('resolves ok:false without a network call when clientId is not yet known', async () => {
    const fake = makeFakeRequestToken();
    const manager = new ExecutionTokenManager({
      baseUrl: () => BASE_URL,
      clientId: () => null, // pre-register_ack
      clientSecret: () => 'secret',
      requestToken: fake.request,
    });
    const result = await manager.getToken('exec-1');
    expect(result).toEqual({ ok: false, error: { error: 'not_registered', description: 'no runner_id/runner_token/base_url configured yet' } });
    expect(fake.calls).toEqual([]);
  });
});

describe('secrets discipline', () => {
  test('never logs the client secret or any issued access token', async () => {
    const logger = new CaptureLogger();
    const fake = makeFakeRequestToken();
    const SECRET = 'rt_super-secret-runner-token';
    const manager = new ExecutionTokenManager({
      baseUrl: () => BASE_URL,
      clientId: () => 'run_1',
      clientSecret: () => SECRET,
      logger,
      requestToken: fake.request,
    });
    await manager.getToken('exec-1');
    await manager.renew('exec-1');
    manager.discard('exec-1');
    await manager.getToken('exec-1');

    for (const line of logger.lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('tok-1');
      expect(line).not.toContain('tok-2');
    }
  });
});
