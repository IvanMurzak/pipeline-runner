/**
 * `RegisterCredentialProvider` — which credential goes on the `register` frame
 * (department-mesh d5, P6; `13-mcp-authorization.md` §10.2, R11, T27).
 *
 * The suite is organised around the one rule that outranks the feature: **no
 * deployed runner may break**. Every failure mode of the OAuth path gets its
 * own test asserting the runner still ends up with a usable credential, because
 * registration is a hard gate with no graceful degradation — a wrong answer
 * here does not degrade a runner, it removes it from the fleet.
 */

import { describe, expect, test } from 'bun:test';
import { ConfigStore, type AgentIdentity } from '../src/core/config';
import type { ClientCredentialsResult, FetchLike, RequestRunnerRegistrationTokenOptions } from '../src/core/mesh-oauth';
import { REGISTRATION_TOKEN_TIMEOUT_MS, requestRunnerRegistrationToken } from '../src/core/mesh-oauth';
import {
  canMintRegistrationToken,
  RegisterCredentialProvider,
  selectClientSecret,
  storeOAuthClientCredentials,
} from '../src/core/register-credential';
import { CaptureLogger, FakeClock, MemFs } from './_helpers';

const LEGACY_TOKEN = 'rt_legacy-plaintext-token-31337';
const CLIENT_SECRET = 'rcs_distinct-oauth-client-secret-42';
const REGISTER_JWT = 'header.payload.signature-jwt-value';
const RUNNER_ID = 'run_abc123';
const BASE_URL = 'https://api.ai-pipeline.dev';

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    base_url: BASE_URL,
    runner_token: LEGACY_TOKEN,
    labels: ['os:linux'],
    os: 'linux',
    agent_version: '0.1.0',
    cli_version: 'unknown',
    ...overrides,
  };
}

/** A runner the operator HAS migrated: distinct client secret + the runner id
 *  that is its OAuth `client_id`. */
function migrated(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return identity({ oauth_client_secret: CLIENT_SECRET, runner_id: RUNNER_ID, ...overrides });
}

interface FakeExchange {
  requestToken: (options: RequestRunnerRegistrationTokenOptions) => Promise<ClientCredentialsResult>;
  calls: RequestRunnerRegistrationTokenOptions[];
}

function exchangeReturning(result: ClientCredentialsResult | (() => ClientCredentialsResult)): FakeExchange {
  const calls: RequestRunnerRegistrationTokenOptions[] = [];
  return {
    calls,
    requestToken: async (options) => {
      calls.push(options);
      return typeof result === 'function' ? result() : result;
    },
  };
}

function issued(expiresAt: number): ClientCredentialsResult {
  return { ok: true, token: { accessToken: REGISTER_JWT, tokenType: 'Bearer', expiresAt, scope: 'runner:register' } };
}

// ── selectClientSecret / canMintRegistrationToken ────────────────────────────

describe('selectClientSecret (d5/c15: the distinct secret wins, legacy is the fallback)', () => {
  test('prefers the DISTINCT oauth_client_secret when the runner has one', () => {
    expect(selectClientSecret(migrated())).toBe(CLIENT_SECRET);
  });

  test('falls back to the legacy runner token when it does not', () => {
    expect(selectClientSecret(identity())).toBe(LEGACY_TOKEN);
  });

  test('null when the identity holds neither', () => {
    expect(selectClientSecret(identity({ runner_token: undefined }))).toBeNull();
  });
});

describe('canMintRegistrationToken', () => {
  test('needs the distinct client secret AND the runner id (its client_id)', () => {
    expect(canMintRegistrationToken(migrated())).toBe(true);
    expect(canMintRegistrationToken(identity())).toBe(false);
    expect(canMintRegistrationToken(identity({ oauth_client_secret: CLIENT_SECRET }))).toBe(false); // no runner_id
    expect(canMintRegistrationToken(identity({ runner_id: RUNNER_ID }))).toBe(false); // no secret
  });

  test('a legacy token is NOT a substitute — c15 records that as a legacy client auth', () => {
    // The cloud WOULD accept the legacy token as a client secret while the
    // window is open. Doing so would make an un-migrated runner look migrated
    // on the register frame while depending entirely on the plaintext secret,
    // which is exactly the false-green c15 blocks. So we never try.
    expect(canMintRegistrationToken(identity({ runner_id: RUNNER_ID }))).toBe(false);
  });
});

// ── The un-migrated path: byte-for-byte pre-P6 behaviour ─────────────────────

describe('a runner that has not migrated (no OAuth client credentials)', () => {
  test('resolves the legacy token SYNCHRONOUSLY — no token endpoint call at all', () => {
    const exchange = exchangeReturning(issued(1_000_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });

    const immediate = provider.immediate(identity());
    expect(immediate).toEqual({
      ok: true,
      credential: {
        value: LEGACY_TOKEN,
        credentialClass: 'legacy',
        reason: 'no OAuth client credentials configured for this runner',
      },
    });
    expect(exchange.calls).toHaveLength(0);
  });

  test('resolve() agrees with immediate() and still makes no request', async () => {
    const exchange = exchangeReturning(issued(1_000_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const resolution = await provider.resolve(identity());
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.credential.credentialClass).toBe('legacy');
    expect(exchange.calls).toHaveLength(0);
  });

  test('a client secret without a runner_id cannot mint, so it stays on legacy', async () => {
    const exchange = exchangeReturning(issued(1_000_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const resolution = await provider.resolve(identity({ oauth_client_secret: CLIENT_SECRET }));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.credential.value).toBe(LEGACY_TOKEN);
    expect(exchange.calls).toHaveLength(0);
  });
});

// ── The migrated path ────────────────────────────────────────────────────────

describe('a migrated runner (DoD: the plaintext token is no longer required)', () => {
  test('exchanges its client credentials for a runner:register token', async () => {
    const clock = new FakeClock();
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken, clock });

    expect(provider.immediate(migrated())).toBeNull(); // an exchange is required
    const resolution = await provider.resolve(migrated());

    expect(resolution).toEqual({
      ok: true,
      credential: { value: REGISTER_JWT, credentialClass: 'oauth', reason: null },
    });
    expect(exchange.calls).toHaveLength(1);
    expect(exchange.calls[0]!.clientId).toBe(RUNNER_ID);
    // The DISTINCT secret — NOT the legacy token. c15 issued a separate secret
    // precisely so the legacy class can retire independently.
    expect(exchange.calls[0]!.clientSecret).toBe(CLIENT_SECRET);
  });

  test('registers with NO legacy token in the config at all', async () => {
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const resolution = await provider.resolve(migrated({ runner_token: undefined }));
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.credential.value).toBe(REGISTER_JWT);
      expect(resolution.credential.credentialClass).toBe('oauth');
    }
  });

  test('caches the token in memory: a reconnect reuses it with no second request', async () => {
    const clock = new FakeClock();
    const exchange = exchangeReturning(() => issued(clock.now() + 900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken, clock });

    await provider.resolve(migrated());
    const second = provider.immediate(migrated());
    expect(second?.ok).toBe(true);
    expect(exchange.calls).toHaveLength(1);
  });

  test('re-requests once the cached token is within the expiry leeway', async () => {
    const clock = new FakeClock();
    const exchange = exchangeReturning(() => issued(clock.now() + 60_000));
    const provider = new RegisterCredentialProvider({
      requestToken: exchange.requestToken,
      clock,
      expiryLeewayMs: 30_000,
    });

    await provider.resolve(migrated());
    clock.advance(29_000); // 31s of life left — still outside the leeway
    expect(provider.immediate(migrated())).not.toBeNull();
    clock.advance(2_000); // 29s left — inside the leeway now
    expect(provider.immediate(migrated())).toBeNull();
    await provider.resolve(migrated());
    expect(exchange.calls).toHaveLength(2);
  });

  test('concurrent resolves share ONE token request', async () => {
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const [a, b] = await Promise.all([provider.resolve(migrated()), provider.resolve(migrated())]);
    expect(a.ok && b.ok).toBe(true);
    expect(exchange.calls).toHaveLength(1);
  });

  test('invalidate() drops the cache so a retry never re-presents a refused token', async () => {
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    await provider.resolve(migrated());
    provider.invalidate();
    expect(provider.immediate(migrated())).toBeNull();
    await provider.resolve(migrated());
    expect(exchange.calls).toHaveLength(2);
  });
});

// ── R11: every OAuth failure degrades, none of them breaks a runner ──────────

describe('R11 — every way the OAuth path can fail falls back to the legacy token', () => {
  const failures: Array<[string, ClientCredentialsResult]> = [
    ['the token endpoint is unreachable', { ok: false, error: { error: 'network_error', description: 'ECONNREFUSED' } }],
    ['the mesh kill switch / OAUTH_TOKEN_SECRET makes /oauth/token 503', { ok: false, error: { error: 'unknown_error', status: 503 } }],
    ['the client secret is wrong or stale', { ok: false, error: { error: 'invalid_client', status: 401 } }],
    ['the deployment refuses the api audience', { ok: false, error: { error: 'invalid_target', status: 400 } }],
    ['the success body is malformed', { ok: false, error: { error: 'invalid_response', status: 200 } }],
  ];

  for (const [label, failure] of failures) {
    test(`${label} ⇒ the legacy token is presented, not a failure`, async () => {
      const exchange = exchangeReturning(failure);
      const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
      const resolution = await provider.resolve(migrated());
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        expect(resolution.credential.value).toBe(LEGACY_TOKEN);
        expect(resolution.credential.credentialClass).toBe('legacy');
        expect(resolution.credential.reason).toContain(failure.ok ? '' : failure.error.error);
      }
    });
  }

  test('a failure is NOT cached — the next connect tries OAuth again', async () => {
    let attempt = 0;
    const exchange = exchangeReturning(() =>
      ++attempt === 1 ? ({ ok: false, error: { error: 'network_error' } } as ClientCredentialsResult) : issued(900_000)
    );
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });

    const first = await provider.resolve(migrated());
    expect(first.ok && first.credential.credentialClass).toBe('legacy');
    const second = await provider.resolve(migrated());
    expect(second.ok && second.credential.credentialClass).toBe('oauth');
  });

  test('a migrated runner with NO legacy token reports a RETRYABLE failure, never a fatal one', async () => {
    const exchange = exchangeReturning({ ok: false, error: { error: 'network_error' } });
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const resolution = await provider.resolve(migrated({ runner_token: undefined }));
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toContain('no legacy runner_token to fall back on');
  });
});

describe('forceLegacy — the safety net for a fatally refused OAuth credential', () => {
  test('pins the process to the legacy token and stops calling the token endpoint', async () => {
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    await provider.resolve(migrated());
    expect(exchange.calls).toHaveLength(1);

    provider.forceLegacy();
    expect(provider.legacyForced).toBe(true);
    const resolution = await provider.resolve(migrated());
    expect(resolution.ok && resolution.credential.value).toBe(LEGACY_TOKEN);
    expect(exchange.calls).toHaveLength(1); // no further exchange attempted
  });
});

// ── The wire shape, against the cloud's own contract ─────────────────────────

describe('requestRunnerRegistrationToken — the c15 contract', () => {
  function fakeFetch(response: Response): { fetchImpl: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    return {
      calls,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return response;
      }) as FetchLike,
    };
  }

  test('POSTs client_credentials + scope=runner:register + the API audience, with Basic auth', async () => {
    const { fetchImpl, calls } = fakeFetch(
      new Response(JSON.stringify({ access_token: REGISTER_JWT, token_type: 'Bearer', expires_in: 900, scope: 'runner:register' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await requestRunnerRegistrationToken({
      baseUrl: BASE_URL,
      clientId: RUNNER_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    const req = calls[0]!;
    expect(req.url).toBe('https://api.ai-pipeline.dev/oauth/token');
    const body = new URLSearchParams(req.init?.body as string);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('runner:register');
    // D15: the REST audience, and only it — the cloud answers invalid_target
    // for anything else (`issueRunnerRegistrationToken`).
    expect(body.get('resource')).toBe('https://api.ai-pipeline.dev/api');
    expect(body.get('execution_id')).toBeNull();
    expect(body.get('refresh_token')).toBeNull();
    const headers = req.init?.headers as Record<string, string>;
    const decoded = Buffer.from(headers.authorization!.replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(decoded).toBe(`${RUNNER_ID}:${CLIENT_SECRET}`);
  });

  test('the request carries an abort signal and the deadline is inside the register timeout', async () => {
    const { fetchImpl, calls } = fakeFetch(
      new Response(JSON.stringify({ access_token: REGISTER_JWT, expires_in: 900 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await requestRunnerRegistrationToken({ baseUrl: BASE_URL, clientId: RUNNER_ID, clientSecret: CLIENT_SECRET, fetchImpl });
    const signal = calls[0]!.init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false); // a completed request is not aborted
    // Bounded well inside connection.ts's 10s register timeout, so a slow
    // endpoint degrades to the legacy token instead of the socket being
    // dropped with no register frame ever sent.
    expect(REGISTRATION_TOKEN_TIMEOUT_MS).toBeLessThan(10_000);
  });

  test('an endpoint that never answers hits the deadline, aborts, and degrades to the legacy token', async () => {
    // A fetch that NEVER settles and ignores the signal entirely — the worst
    // case, and the one `AbortSignal.timeout` alone would not have rescued.
    const seen: AbortSignal[] = [];
    const hangingFetch = ((_url: string, init?: RequestInit) => {
      if (init?.signal) seen.push(init.signal);
      return new Promise<Response>(() => {});
    }) as FetchLike;
    const clock = new FakeClock();

    const pending = requestRunnerRegistrationToken({
      baseUrl: BASE_URL,
      clientId: RUNNER_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: hangingFetch,
      clock,
      timeoutMs: 5_000,
    });
    clock.advance(5_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBe('network_error');
      expect(result.error.description).toContain('timed out');
    }
    expect(seen[0]!.aborted).toBe(true); // the in-flight request was cancelled
  });

  test('…and through the provider, that deadline becomes a working legacy registration', async () => {
    const clock = new FakeClock();
    const provider = new RegisterCredentialProvider({
      clock,
      requestToken: (options) =>
        requestRunnerRegistrationToken({ ...options, clock, timeoutMs: 5_000, fetchImpl: (() => new Promise<Response>(() => {})) as FetchLike }),
    });
    const pending = provider.resolve(migrated());
    clock.advance(5_000);
    const resolution = await pending;
    expect(resolution.ok && resolution.credential.value).toBe(LEGACY_TOKEN);
  });

  test('a refusal resolves ok:false — it never throws into the connect path', async () => {
    const { fetchImpl } = fakeFetch(
      new Response(JSON.stringify({ error: 'invalid_client', error_description: 'runner client authentication failed' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    const result = await requestRunnerRegistrationToken({ baseUrl: BASE_URL, clientId: RUNNER_ID, clientSecret: 'wrong', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe('invalid_client');
  });
});

// ── Secrets discipline ───────────────────────────────────────────────────────

describe('secrets discipline — no credential is ever logged', () => {
  const secrets = [LEGACY_TOKEN, CLIENT_SECRET, REGISTER_JWT];

  function assertClean(logger: CaptureLogger): void {
    const joined = logger.joined();
    for (const secret of secrets) {
      expect(joined).not.toContain(secret);
      expect(joined).not.toContain(secret.slice(0, 12)); // no prefix leaks either
    }
  }

  test('success path (the issued runner:register token never appears)', async () => {
    const logger = new CaptureLogger();
    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken, logger });
    await provider.resolve(migrated());
    assertClean(logger);
  });

  test('fallback path (the legacy token it falls back to never appears)', async () => {
    const logger = new CaptureLogger();
    const exchange = exchangeReturning({ ok: false, error: { error: 'invalid_client', status: 401 } });
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken, logger });
    const resolution = await provider.resolve(migrated());
    expect(resolution.ok && resolution.credential.value).toBe(LEGACY_TOKEN); // it WAS used...
    expect(logger.lines.length).toBeGreaterThan(0); // ...and plenty was logged...
    assertClean(logger); // ...none of it a credential
  });

  test('the real exchange over a fake fetch — request, response and error bodies stay out of the log', async () => {
    const logger = new CaptureLogger();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: REGISTER_JWT, expires_in: 900 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as FetchLike;
    const provider = new RegisterCredentialProvider({ logger, fetchImpl });
    const resolution = await provider.resolve(migrated());
    expect(resolution.ok && resolution.credential.value).toBe(REGISTER_JWT);
    assertClean(logger);
  });

  test('the network-error path logs the OS error but not the credential', async () => {
    const logger = new CaptureLogger();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as FetchLike;
    const provider = new RegisterCredentialProvider({ logger, fetchImpl });
    await provider.resolve(migrated());
    expect(logger.joined()).toContain('ECONNREFUSED');
    assertClean(logger);
  });
});

// ── Installing the credentials on an existing identity ───────────────────────

describe('storeOAuthClientCredentials (`pipeline-runner set-credentials`)', () => {
  test('persists the pair and KEEPS the legacy token as the fallback', () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity());
    const updated = storeOAuthClientCredentials(store, { clientId: RUNNER_ID, clientSecret: CLIENT_SECRET });

    expect(updated.oauth_client_secret).toBe(CLIENT_SECRET);
    expect(updated.runner_id).toBe(RUNNER_ID);
    expect(updated.runner_token).toBe(LEGACY_TOKEN); // untouched — R11's escape hatch
    expect(canMintRegistrationToken(store.load()!)).toBe(true);
  });

  test('the identity survives a save/load round trip and the runner is then migrated', async () => {
    const store = new ConfigStore({ dir: 'cfg', fs: new MemFs() });
    store.save(identity());
    storeOAuthClientCredentials(store, { clientId: RUNNER_ID, clientSecret: CLIENT_SECRET });

    const exchange = exchangeReturning(issued(900_000));
    const provider = new RegisterCredentialProvider({ requestToken: exchange.requestToken });
    const resolution = await provider.resolve(store.load()!);
    expect(resolution.ok && resolution.credential.credentialClass).toBe('oauth');
  });
});
