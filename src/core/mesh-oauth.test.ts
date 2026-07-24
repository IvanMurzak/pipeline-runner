/**
 * `requestExecutionToken` — the `client_credentials` execution-token
 * exchange (department-mesh d6, 13-mcp-authorization.md §12). Mocks the
 * cloud AS's `/oauth/token` endpoint at the `fetch` seam, matching
 * `cloud/apps/api/src/modules/mesh-oauth/routes.ts`'s
 * `handleClientCredentialsGrant` contract exactly: HTTP Basic
 * `client_id:client_secret`, form body `grant_type=client_credentials
 * &resource=<mcp aud>&scope=mesh:execution&execution_id=<id>`, success body
 * `{access_token, token_type, expires_in, scope}` (no `refresh_token`),
 * RFC 6749 §5.2 `{error, error_description}` on refusal.
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import type { FetchLike } from './mesh-oauth';
import { meshMcpResource, requestExecutionToken } from './mesh-oauth';

const BASE_URL = 'https://api.ai-pipeline.dev';
const CLIENT_ID = 'run_abc123';
const CLIENT_SECRET = 'rt_hyper-secret-runner-token-31337';
const EXECUTION_ID = 'dexec-1';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (req: CapturedRequest) => Response): { fetchImpl: FetchLike; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req = { url, init };
    calls.push(req);
    return handler(req);
  }) as FetchLike;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('meshMcpResource', () => {
  test('appends /mcp and strips trailing slashes', () => {
    expect(meshMcpResource('https://api.ai-pipeline.dev')).toBe('https://api.ai-pipeline.dev/mcp');
    expect(meshMcpResource('https://api.ai-pipeline.dev/')).toBe('https://api.ai-pipeline.dev/mcp');
    expect(meshMcpResource('https://api.ai-pipeline.dev///')).toBe('https://api.ai-pipeline.dev/mcp');
  });
});

describe('requestExecutionToken — request shape', () => {
  test('POSTs form-urlencoded client_credentials with HTTP Basic auth and the c12 contract fields', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(200, { access_token: 'exec-token-xyz', token_type: 'Bearer', expires_in: 900, scope: 'mesh:execution' })
    );
    const clock = new FakeClock();

    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
      clock,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.url).toBe('https://api.ai-pipeline.dev/oauth/token');
    expect(req.init?.method).toBe('POST');

    const headers = req.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const decoded = Buffer.from(headers.authorization!.replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(decoded).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);

    const body = new URLSearchParams(req.init?.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('resource')).toBe('https://api.ai-pipeline.dev/mcp');
    expect(body.get('scope')).toBe('mesh:execution');
    expect(body.get('execution_id')).toBe(EXECUTION_ID);
    // No refresh_token grant / no code_verifier / no client_secret in the
    // body — Basic auth carries the credential, RFC 6749 §4.4.3 (13 §12).
    expect(body.get('refresh_token')).toBeNull();
  });

  test('computes expiresAt as clock.now() + expires_in * 1000', async () => {
    const clock = new FakeClock();
    clock.advance(1_000_000);
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { access_token: 'tok', expires_in: 300 }));

    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
      clock,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.accessToken).toBe('tok');
      expect(result.token.expiresAt).toBe(1_000_000 + 300_000);
      expect(result.token.tokenType).toBe('Bearer');
    }
  });
});

describe('requestExecutionToken — refusal (§14 test plan: execution not held by this runner)', () => {
  test('an invalid_grant refusal is returned, not thrown, and carries no token', async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(400, { error: 'invalid_grant', error_description: 'the named execution is not leased to this runner, or is not in an active state' })
    );

    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: 'dexec-not-mine',
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        error: 'invalid_grant',
        description: 'the named execution is not leased to this runner, or is not in an active state',
        status: 400,
      },
    });
  });

  test('invalid_client (wrong runner credentials) is surfaced distinctly', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, { error: 'invalid_client', error_description: 'runner client authentication failed' }));
    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: 'wrong-secret',
      executionId: EXECUTION_ID,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe('invalid_client');
  });
});

describe('requestExecutionToken — never throws', () => {
  test('a network error resolves ok:false rather than rejecting', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as FetchLike;

    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, error: { error: 'network_error', description: 'ECONNREFUSED' } });
  });

  test('a malformed 200 body (missing access_token) is invalid_response, not a throw/NaN expiry', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { token_type: 'Bearer', expires_in: 900 }));
    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe('invalid_response');
  });

  test('a non-JSON error body still resolves with a status-derived failure, never throws', async () => {
    const fetchImpl = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as FetchLike;
    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(502);
      expect(result.error.error).toBe('unknown_error');
    }
  });
});

describe('secrets discipline (mirrors tests/connection.test.ts:359)', () => {
  test('the client secret and the issued access token never appear in any log line — success path', async () => {
    const logger = new CaptureLogger();
    const { fetchImpl } = fakeFetch(() => jsonResponse(200, { access_token: 'super-secret-exec-token', expires_in: 900 }));

    await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
      logger,
    });

    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.joined()).not.toContain(CLIENT_SECRET);
    expect(logger.joined()).not.toContain('super-secret-exec-token');
  });

  test('the client secret never appears in any log line — refusal path', async () => {
    const logger = new CaptureLogger();
    const { fetchImpl } = fakeFetch(() => jsonResponse(400, { error: 'invalid_grant', error_description: 'nope' }));

    await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
      logger,
    });

    expect(logger.joined()).not.toContain(CLIENT_SECRET);
  });

  test('the client secret never appears in any log line — network error path', async () => {
    const logger = new CaptureLogger();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as FetchLike;

    const result = await requestExecutionToken({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      executionId: EXECUTION_ID,
      fetchImpl,
      logger,
    });

    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.joined()).not.toContain(CLIENT_SECRET);
    expect(result.ok).toBe(false);
  });
});
