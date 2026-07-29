/**
 * `ExecutionTokenEndpoint` — the loopback re-auth seam (simplified-onboarding
 * x21; owner decision D33 amending D23).
 *
 * Driven against a REAL `Bun.serve` listener (the thing under test IS a
 * socket; a fake one would prove nothing about binding, routing or the
 * response shape) but a FAKE `ExecutionTokenSource`, so nothing here touches
 * the network or an authorization server. The real `client_credentials`
 * exchange behind it already has its own suites
 * (`./execution-token-manager.test.ts`, `../core/department-oauth.test.ts`), and
 * the full chain — real AS, real subprocess, real shell — is
 * `./mcp-headers-helper.real.test.ts`.
 *
 * What is worth proving about a listener a model-driven session can reach:
 * that it is bound where it says it is, that it answers ONLY to the secret
 * for the execution named, that the thing it answers with is exactly what the
 * vendor's `headersHelper` contract wants, that it does not burn a token
 * exchange per retry, and that revocation actually closes the door.
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import type { ExecutionTokenResult } from '../core/department-oauth';
import { ExecutionTokenEndpoint, HELPER_ENDPOINT_PATH, readBearer, secretsMatch } from './execution-token-endpoint';
import type { ExecutionTokenSource } from './execution-token-manager';

const RESOURCE_URL = 'https://api.ai-pipeline.dev/mcp';

/** Scriptable token source: every mint returns a DIFFERENT token, so a test
 *  can tell "the cache answered" from "a fresh exchange happened" by reading
 *  the value alone. */
class FakeTokenSource implements ExecutionTokenSource {
  getTokenCalls: string[] = [];
  renewCalls: string[] = [];
  discardCalls: string[] = [];
  failWith: string | null = null;
  private counter = 0;
  private cached = new Map<string, string>();

  async getToken(executionId: string): Promise<ExecutionTokenResult> {
    this.getTokenCalls.push(executionId);
    const existing = this.cached.get(executionId);
    if (existing !== undefined) return this.wrap(existing);
    return this.mint(executionId);
  }

  async renew(executionId: string): Promise<ExecutionTokenResult> {
    this.renewCalls.push(executionId);
    return this.mint(executionId);
  }

  discard(executionId: string): void {
    this.discardCalls.push(executionId);
    this.cached.delete(executionId);
  }

  resourceUrl(): string | null {
    return RESOURCE_URL;
  }

  private mint(executionId: string): ExecutionTokenResult {
    if (this.failWith !== null) return { ok: false, error: { error: this.failWith } };
    this.counter += 1;
    const token = `tok-${this.counter}`;
    this.cached.set(executionId, token);
    return this.wrap(token);
  }

  private wrap(accessToken: string): ExecutionTokenResult {
    return { ok: true, token: { accessToken, tokenType: 'Bearer', expiresAt: 9_999_999, scope: 'mesh:execution' } };
  }
}

interface Harness {
  endpoint: ExecutionTokenEndpoint;
  tokens: FakeTokenSource;
  clock: FakeClock;
  logger: CaptureLogger;
}

function harness(overrides: { minRenewIntervalMs?: number } = {}): Harness {
  const tokens = new FakeTokenSource();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const endpoint = new ExecutionTokenEndpoint({
    tokens,
    clock,
    logger,
    ...(overrides.minRenewIntervalMs !== undefined ? { minRenewIntervalMs: overrides.minRenewIntervalMs } : {}),
  });
  return { endpoint, tokens, clock, logger };
}

/** One helper-shaped request: the secret in `Authorization`, the execution
 *  named in the query — exactly what `./mcp-headers-helper.ts` sends. */
async function ask(url: string, executionId: string, secret: string): Promise<Response> {
  const target = new URL(url);
  target.searchParams.set('execution', executionId);
  return fetch(target.toString(), { headers: { authorization: `Bearer ${secret}` } });
}

describe('ExecutionTokenEndpoint — the seam D23 needed and b3 could not build', () => {
  test('nothing is listening until an execution needs it, and nothing is listening once none does', async () => {
    const { endpoint } = harness();
    // The exposure window is exactly "a live execution might still need a
    // fresh token" — not "the daemon is running".
    expect(endpoint.address).toBeNull();

    const grant = await endpoint.grant('exec-1');
    expect(grant).not.toBeNull();
    expect(endpoint.address).not.toBeNull();

    endpoint.revoke('exec-1');
    expect(endpoint.address).toBeNull();
    endpoint.stop();
  });

  test('binds to loopback only — an ephemeral port on 127.0.0.1, never a routable interface', async () => {
    const { endpoint } = harness();
    const grant = await endpoint.grant('exec-1');
    const url = new URL(grant!.url);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe(HELPER_ENDPOINT_PATH);
    // `port: 0` ⇒ the OS picks; the only thing worth asserting is that it is
    // not a well-known target anyone could guess ahead of time.
    expect(Number(url.port)).toBeGreaterThan(0);
    endpoint.stop();
  });

  test('answers with exactly the header map Claude Code wants on the helper\'s stdout', async () => {
    const { endpoint, tokens, clock } = harness();
    const grant = (await endpoint.grant('exec-1'))!;
    clock.advance(10_000);
    const response = await ask(grant.url, 'exec-1', grant.secret);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    // A flat string→string object, and nothing else in it: the helper prints
    // this body verbatim, so anything extra would reach the MCP client.
    expect(await response.json()).toEqual({ Authorization: 'Bearer tok-1' });
    expect(tokens.renewCalls).toEqual(['exec-1']);
    endpoint.stop();
  });

  test('a fresh token is what comes back — the whole point, and what a static header cannot do', async () => {
    const { endpoint, clock } = harness({ minRenewIntervalMs: 2_000 });
    const grant = (await endpoint.grant('exec-1'))!;
    // The spawn's own token was just minted, so the CONNECT-time call must
    // not burn a second exchange…
    clock.advance(2_001);
    const first = (await (await ask(grant.url, 'exec-1', grant.secret)).json()) as Record<string, string>;
    clock.advance(2_001);
    const second = (await (await ask(grant.url, 'exec-1', grant.secret)).json()) as Record<string, string>;
    // …but a later 401 gets a genuinely different credential, which is the
    // difference between a task that finishes and one that loses its tools.
    expect(first.Authorization).not.toBe(second.Authorization);
    endpoint.stop();
  });

  test('a retry burst collapses onto one exchange — the helper re-runs on every 401', async () => {
    const { endpoint, tokens, clock } = harness({ minRenewIntervalMs: 2_000 });
    const grant = (await endpoint.grant('exec-1'))!;
    clock.advance(2_001);
    await ask(grant.url, 'exec-1', grant.secret);
    // Three more calls inside the window: served from the cache, not re-minted.
    await ask(grant.url, 'exec-1', grant.secret);
    await ask(grant.url, 'exec-1', grant.secret);
    await ask(grant.url, 'exec-1', grant.secret);
    expect(tokens.renewCalls).toEqual(['exec-1']);
    expect(tokens.getTokenCalls).toEqual(['exec-1', 'exec-1', 'exec-1']);
    endpoint.stop();
  });

  test('the wrong secret, no secret, and a secret for another execution are all one answer: 401', async () => {
    const { endpoint } = harness();
    const one = (await endpoint.grant('exec-1'))!;
    const two = (await endpoint.grant('exec-2'))!;

    expect((await ask(one.url, 'exec-1', 'not-the-secret')).status).toBe(401);
    expect((await fetch(`${one.url}?execution=exec-1`)).status).toBe(401);
    // The check that makes putting the execution id on the helper's argv
    // worth doing: a grant for exec-2 cannot name exec-1 and get its token.
    expect((await ask(one.url, 'exec-1', two.secret)).status).toBe(401);
    expect((await ask(one.url, 'exec-nonexistent', one.secret)).status).toBe(401);
    // …and the legitimate pairing still works, so the refusals above are the
    // check and not a broken endpoint.
    expect((await ask(two.url, 'exec-2', two.secret)).status).toBe(200);
    endpoint.stop();
  });

  test('x38: a refusal is LOGGED — until now the one failure that silently costs a session its tools left no trace at all', async () => {
    // The response stays a bare `401 {"error":"unauthorized"}` (the test above
    // is the guard for that). The LOG is a different surface: without a line
    // here, a helper that is refused is invisible everywhere — its own stderr
    // explains the problem to Claude Code, which discards it. Four P4 gate
    // runs could not tell "the helper was refused" from "the helper never
    // ran", and this is the instrument that separates them.
    const { endpoint, logger } = harness();
    const one = (await endpoint.grant('exec-1'))!;

    await ask(one.url, 'exec-1', 'not-the-secret');
    await ask(one.url, 'exec-nonexistent', one.secret);
    await fetch(`${one.url}?execution=exec-1`); // no bearer at all

    const lines = logger.lines.filter((line) => line.includes('warn:'));
    expect(lines.some((line) => line.includes('exec-1') && line.includes('does not match'))).toBe(true);
    expect(lines.some((line) => line.includes('exec-nonexistent') && line.includes('no live grant'))).toBe(true);
    expect(lines.some((line) => line.includes('without an execution id or a bearer'))).toBe(true);
    // Never the credential, on any of the three.
    expect(logger.joined()).not.toContain(one.secret);
    expect(logger.joined()).not.toContain('not-the-secret');
    endpoint.stop();
  });

  test('a revoked execution is refused — the lease is gone, so the door is closed', async () => {
    const { endpoint } = harness();
    const a = (await endpoint.grant('exec-1'))!;
    await endpoint.grant('exec-2'); // keeps the listener open past the revoke
    expect((await ask(a.url, 'exec-1', a.secret)).status).toBe(200);

    endpoint.revoke('exec-1');
    expect((await ask(a.url, 'exec-1', a.secret)).status).toBe(401);
    endpoint.stop();
  });

  test('a respawn ROTATES the secret — the replaced process\'s copy stops working', async () => {
    const { endpoint } = harness();
    const first = (await endpoint.grant('exec-1'))!;
    const second = (await endpoint.grant('exec-1'))!;
    expect(second.secret).not.toBe(first.secret);
    expect((await ask(first.url, 'exec-1', first.secret)).status).toBe(401);
    expect((await ask(second.url, 'exec-1', second.secret)).status).toBe(200);
    endpoint.stop();
  });

  test('a path that is not the endpoint learns nothing', async () => {
    const { endpoint } = harness();
    const grant = (await endpoint.grant('exec-1'))!;
    const root = new URL(grant.url);
    root.pathname = '/';
    expect((await fetch(root.toString())).status).toBe(404);
    endpoint.stop();
  });

  test('a refused token exchange is a 502 carrying the OAuth error CODE and nothing else', async () => {
    const { endpoint, tokens, logger } = harness();
    const grant = (await endpoint.grant('exec-1'))!;
    tokens.failWith = 'invalid_grant';
    const response = await ask(grant.url, 'exec-1', grant.secret);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(logger.joined()).toContain('invalid_grant');
    endpoint.stop();
  });

  test('a listener that cannot bind degrades to null — admission never depends on this', async () => {
    const tokens = new FakeTokenSource();
    const logger = new CaptureLogger();
    const endpoint = new ExecutionTokenEndpoint({
      tokens,
      logger,
      serve: () => {
        throw new Error('EADDRNOTAVAIL');
      },
    });
    expect(await endpoint.grant('exec-1')).toBeNull();
    expect(logger.joined()).toContain('re-authorize');
  });

  test('nothing here ever logs a token or a grant secret', async () => {
    const { endpoint, logger, clock } = harness();
    const grant = (await endpoint.grant('exec-1'))!;
    clock.advance(10_000);
    await ask(grant.url, 'exec-1', grant.secret);
    await ask(grant.url, 'exec-1', 'wrong');
    endpoint.revoke('exec-1');
    const text = logger.joined();
    expect(text).not.toContain(grant.secret);
    expect(text).not.toContain('tok-');
    endpoint.stop();
  });
});

describe('the primitives the endpoint is built on', () => {
  test('secretsMatch is content-constant-time and length-strict', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });

  test('readBearer accepts exactly the header the helper sends', () => {
    expect(readBearer('Bearer s3cret')).toBe('s3cret');
    expect(readBearer('bearer s3cret')).toBe('s3cret');
    expect(readBearer('Basic s3cret')).toBeNull();
    expect(readBearer('Bearer')).toBeNull();
    expect(readBearer(null)).toBeNull();
  });

  test('a default grant secret is 256 bits of real entropy, and never repeats', async () => {
    const { endpoint } = harness();
    const seen = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const grant = (await endpoint.grant(`exec-${i}`))!;
      expect(grant.secret).toMatch(/^[0-9a-f]{64}$/);
      seen.add(grant.secret);
    }
    expect(seen.size).toBe(8);
    endpoint.stop();
  });
});
