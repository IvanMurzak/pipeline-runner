/**
 * The runner's ONE OAuth 2.1 confidential client (department-mesh d6 + d5;
 * `13-mcp-authorization.md` §12 and §10.2).
 *
 * Exactly ONE grant is implemented here — `client_credentials` — because it is
 * the only grant a runner ever uses (13 §12). It now buys TWO machine token
 * kinds from the same endpoint, matching the cloud's own
 * `handleClientCredentialsGrant`:
 *
 *   | scope             | audience        | what it is for                     |
 *   |-------------------|-----------------|------------------------------------|
 *   | `mesh:execution`  | `<base>/mcp`    | one live execution (d6, 13 §12)    |
 *   | `runner:register` | `<base>/api`    | the WSS `register` frame (d5, §10.2)|
 *
 * No refresh token is ever requested or accepted (RFC 6749 §4.4.3 / OAuth 2.1
 * §4.2: a refresh token SHOULD NOT accompany this grant) — the runner simply
 * re-requests.
 *
 * ── Which secret authenticates the client (department-mesh d5 / c15) ─────────
 * `clientId` is the server-assigned `runner_id` from `register_ack`
 * (`./register.ts`'s `applyRegisterAck`) — the same id the cloud AS resolves the
 * runner row by. `clientSecret` is whatever the caller hands over, and after
 * c15 that is deliberately a CHOICE, not a fixed field:
 *
 *   - the DISTINCT `oauth_client_secret` when the operator has issued one
 *     (`POST /api/v1/runners/:id/oauth-credentials`), or
 *   - the legacy plaintext `runner_token` when they have not.
 *
 * d6 originally hard-wired the second option ("the runner's existing token IS
 * its OAuth client secret"). c15 broke that entanglement precisely so the legacy
 * credential can retire on its own, and the cloud records which class
 * authenticated (`last_client_auth_class`) to gate that retirement. Choosing the
 * secret is therefore the CALLER's job — see `./register-credential.ts`'s
 * `selectClientSecret`, the single place that ordering is expressed.
 *
 * SECRETS DISCIPLINE (10-security.md §6, mirrors `./register.ts` and
 * `tests/connection.test.ts`'s secrets-discipline suite): `clientSecret` and the
 * returned `accessToken` are NEVER logged, in success or failure. Every
 * `logger.*` call below carries ids and OAuth `error` codes only — never a
 * credential.
 */

import type { Clock } from './clock';
import { systemClock } from './clock';
import type { Logger } from './log';
import { nullLogger } from './log';

/** The one scope a runner ever requests for an execution (13 §6: "machine-only,
 *  never user-delegated"). */
export const MESH_EXECUTION_SCOPE = 'mesh:execution';

/** The scope a MIGRATED runner exchanges its client credentials for in order to
 *  register (13 §10.2; cloud `mesh-oauth/types.ts`'s `RUNNER_REGISTER_SCOPE`). */
export const RUNNER_REGISTER_SCOPE = 'runner:register';

/** The minimal `fetch` surface this module needs — injectable so tests never
 *  hit the network (mirrors `../shipper/upload-transport.ts`'s `FetchLike`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientCredentialsToken {
  accessToken: string;
  tokenType: string;
  /** Clock-ms absolute expiry (`clock.now() + expires_in * 1000` at the
   *  moment the response was received) — never a duration, so callers never
   *  re-derive "now" at a different instant than the request completed. */
  expiresAt: number;
  scope: string;
}

export interface ClientCredentialsError {
  /** RFC 6749 §5.2 `error` code — e.g. `invalid_grant`, `invalid_client`,
   *  `invalid_target`, `invalid_request` — or a LOCAL synthetic code
   *  (`network_error`, `invalid_response`) for failures that never reached
   *  (or never came back as valid JSON from) the token endpoint. */
  error: string;
  description?: string;
  /** HTTP status, when the failure is a real response from the server. */
  status?: number;
}

export type ClientCredentialsResult =
  | { ok: true; token: ClientCredentialsToken }
  | { ok: false; error: ClientCredentialsError };

/** d6-era names, kept as aliases so `../department/execution-token-manager.ts`
 *  and its tests read exactly as they did before d5 generalized this module. */
export type ExecutionAccessToken = ClientCredentialsToken;
export type ExecutionTokenError = ClientCredentialsError;
export type ExecutionTokenResult = ClientCredentialsResult;

export interface RequestExecutionTokenOptions {
  /** Control-plane base URL (`AgentIdentity.base_url`) — the SAME origin
   *  serves `/oauth/token` and `/mcp` (D13: AS and RS are colocated). */
  baseUrl: string;
  /** OAuth client id — the server-assigned `runner_id`. */
  clientId: string;
  /** OAuth client secret — the distinct `oauth_client_secret` when the runner
   *  has one, else its legacy registration token. SECRET. */
  clientSecret: string;
  executionId: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

export interface RequestRunnerRegistrationTokenOptions {
  /** Control-plane base URL (`AgentIdentity.base_url`). */
  baseUrl: string;
  /** OAuth client id — the server-assigned `runner_id`. */
  clientId: string;
  /** OAuth client secret. SECRET. See the module doc on WHICH one. */
  clientSecret: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Abort the exchange after this many ms. Defaults to
   *  {@link REGISTRATION_TOKEN_TIMEOUT_MS} — see that constant for why a
   *  registration-token request MUST be bounded. */
  timeoutMs?: number;
}

/**
 * A registration-token exchange must finish well inside the connection's
 * register timeout (`core/connection.ts`'s `DEFAULT_REGISTER_TIMEOUT_MS`,
 * 10 s): if it does not, the socket is dropped before any `register` frame is
 * sent, and a persistently slow `/oauth/token` would stall a migrated runner
 * indefinitely instead of degrading. Bounding it turns "stalled" into a
 * `network_error`, which `../core/register-credential.ts` answers with the
 * legacy token — the degradation R11 requires.
 */
export const REGISTRATION_TOKEN_TIMEOUT_MS = 7_000;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** `${issuer}/mcp` — the ONE audience an execution token is ever requested
 *  for (13 §10: MCP server canonical resource). Mirrors the cloud's own
 *  `issuer()`/`canonicalResource()` (`cloud/apps/api/src/modules/mesh-oauth/resource.ts`)
 *  trailing-slash normalization so the string matches byte-for-byte. */
export function meshMcpResource(baseUrl: string): string {
  return `${trimBase(baseUrl)}/mcp`;
}

/** `${issuer}/api` — the REST audience, and the ONLY one a `runner:register`
 *  token is ever issued for (13 §10 D15; the cloud refuses any other with
 *  `invalid_target`). No fourth audience was invented for P6. */
export function meshApiResource(baseUrl: string): string {
  return `${trimBase(baseUrl)}/api`;
}

function tokenEndpoint(baseUrl: string): string {
  return `${trimBase(baseUrl)}/oauth/token`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

/** Narrow a decoded JSON success body to the fields we need. Anything
 *  missing/mistyped is treated as `invalid_response` — never a thrown/NaN
 *  `expiresAt`. */
function narrowSuccessBody(
  raw: unknown,
  fallbackScope: string
): { accessToken: string; tokenType: string; expiresInS: number; scope: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.access_token !== 'string' || r.access_token.length === 0) return null;
  if (typeof r.expires_in !== 'number' || !Number.isFinite(r.expires_in) || r.expires_in <= 0) return null;
  return {
    accessToken: r.access_token,
    tokenType: typeof r.token_type === 'string' ? r.token_type : 'Bearer',
    expiresInS: r.expires_in,
    scope: typeof r.scope === 'string' ? r.scope : fallbackScope,
  };
}

/** Narrow a decoded JSON error body to RFC 6749 §5.2 shape. Falls back to a
 *  generic code when the body itself is unparseable — the HTTP status alone
 *  still distinguishes "refused" from "unreachable". */
function narrowErrorBody(raw: unknown): { error: string; description?: string } {
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>;
    if (typeof r.error === 'string' && r.error.length > 0) {
      return { error: r.error, ...(typeof r.error_description === 'string' ? { description: r.error_description } : {}) };
    }
  }
  return { error: 'unknown_error' };
}

interface ClientCredentialsRequest {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  resource: string;
  /** Grant-specific form fields (e.g. `execution_id`). */
  extraParams?: Record<string, string>;
  /** Log-safe noun for this token kind, e.g. `execution token`. */
  what: string;
  /** Log-safe subject, e.g. `execution dexec-1` / `runner run_abc`. NEVER a
   *  secret — every id here is server-assigned and non-sensitive. */
  subject: string;
  /** Abort the request after this many ms. Omitted ⇒ no client-side deadline
   *  (the d6 execution-token path, whose caller has its own retry cadence). */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

/**
 * The single `client_credentials` exchange every runner token kind goes
 * through. Never throws — every failure mode (network error, non-2xx response,
 * malformed body) resolves to `{ ok: false, error }`, because every caller of
 * this module has a degradation path and none of them may take a runner down.
 */
async function requestClientCredentialsToken(request: ClientCredentialsRequest): Promise<ClientCredentialsResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const clock = request.clock ?? systemClock;
  const logger = request.logger ?? nullLogger;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    resource: request.resource,
    scope: request.scope,
    ...(request.extraParams ?? {}),
  });

  logger.debug(`mesh-oauth: requesting ${request.what} for ${request.subject}`);

  // The deadline (when one is asked for). Deliberately NOT `AbortSignal.timeout`
  // — under Bun that signal's `abort` event does not reach a plain listener, so
  // a race against it would silently never fire and the "bounded" guarantee
  // would be a lie. A timer on the INJECTED clock is portable, observable, and
  // deterministic under the tests' `FakeClock`. The `AbortController` is still
  // passed to `fetch` so a real in-flight request is actually cancelled rather
  // than left running after we stop waiting for it.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let deadlineTimer: unknown = null;
  const deadline =
    request.timeoutMs === undefined
      ? null
      : new Promise<never>((_resolve, reject) => {
          deadlineTimer = clock.setTimeout(() => {
            controller?.abort();
            reject(new Error(`timed out after ${request.timeoutMs}ms`));
          }, request.timeoutMs!);
        });
  const clearDeadline = (): void => {
    if (deadlineTimer !== null) {
      clock.clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  let response: Response;
  try {
    const attempt = fetchImpl(tokenEndpoint(request.baseUrl), {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(request.clientId, request.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      ...(controller !== null ? { signal: controller.signal } : {}),
    });
    response = deadline === null ? await attempt : await Promise.race([attempt, deadline]);
    clearDeadline();
  } catch (err) {
    clearDeadline();
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`mesh-oauth: ${request.what} request for ${request.subject} failed — network error: ${message}`);
    return { ok: false, error: { error: 'network_error', description: message } };
  }

  let decoded: unknown = null;
  try {
    decoded = await response.json();
  } catch {
    /* fall through — handled below by the shape checks */
  }

  if (!response.ok) {
    const { error, description } = narrowErrorBody(decoded);
    logger.warn(
      `mesh-oauth: ${request.what} for ${request.subject} refused (HTTP ${response.status}, ${error})${description ? `: ${description}` : ''}`
    );
    return { ok: false, error: { error, ...(description !== undefined ? { description } : {}), status: response.status } };
  }

  const success = narrowSuccessBody(decoded, request.scope);
  if (success === null) {
    logger.warn(`mesh-oauth: ${request.what} response for ${request.subject} was malformed`);
    return {
      ok: false,
      error: { error: 'invalid_response', description: 'token endpoint returned a malformed success body', status: response.status },
    };
  }

  logger.debug(`mesh-oauth: ${request.what} obtained for ${request.subject} (expires in ${success.expiresInS}s)`);
  return {
    ok: true,
    token: {
      accessToken: success.accessToken,
      tokenType: success.tokenType,
      expiresAt: clock.now() + success.expiresInS * 1000,
      scope: success.scope,
    },
  };
}

/**
 * Exchange the runner's client credentials for one execution-scoped access
 * token naming `options.executionId` (13 §12). Never throws.
 */
export async function requestExecutionToken(options: RequestExecutionTokenOptions): Promise<ExecutionTokenResult> {
  return await requestClientCredentialsToken({
    baseUrl: options.baseUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: MESH_EXECUTION_SCOPE,
    resource: meshMcpResource(options.baseUrl),
    extraParams: { execution_id: options.executionId },
    what: 'execution token',
    subject: `execution ${options.executionId}`,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/**
 * Exchange the runner's client credentials for one short-lived
 * `runner:register` token — the credential a MIGRATED runner presents on the
 * WSS `register` frame instead of its plaintext long-lived token (13 §10.2, P6).
 *
 * Never throws, and the caller (`./register-credential.ts`) treats EVERY
 * failure as "use the legacy token instead". That is the whole safety story of
 * P6 on this side of the wire: the cloud dual-accepts (c15), so a runner that
 * cannot mint a registration token still registers.
 */
export async function requestRunnerRegistrationToken(
  options: RequestRunnerRegistrationTokenOptions
): Promise<ClientCredentialsResult> {
  return await requestClientCredentialsToken({
    baseUrl: options.baseUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: RUNNER_REGISTER_SCOPE,
    resource: meshApiResource(options.baseUrl),
    what: 'registration token',
    subject: `runner ${options.clientId}`,
    timeoutMs: options.timeoutMs ?? REGISTRATION_TOKEN_TIMEOUT_MS,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
