/**
 * Execution-token exchange (department-mesh task d6; `13-mcp-authorization.md`
 * §12). The runner is a confidential OAuth 2.1 client whose credential is its
 * EXISTING runner registration secret — reused as the OAuth `client_secret`,
 * never a new credential (§10.2/§12: "the runner's existing token is its
 * OAuth client secret"). `client_id` is the server-assigned `runner_id` from
 * `register_ack` (`../core/register.ts`'s `applyRegisterAck`) — the same id
 * the cloud AS resolves the runner row by
 * (`cloud/apps/api/src/modules/mesh-oauth/routes.ts`'s
 * `handleClientCredentialsGrant`: `runnerAuth.runner.id !== clientId` is the
 * uniform `invalid_client` check).
 *
 * Exactly ONE grant is implemented here — `client_credentials` — because it
 * is the ONLY grant a runner ever uses (13 §12: "client_credentials is
 * EXCLUSIVELY the runner execution-token path"). No refresh token is ever
 * requested or accepted (RFC 6749 §4.4.3 / OAuth 2.1 §4.2: a refresh token
 * SHOULD NOT accompany this grant) — a dead/renewed lease means the runner
 * calls this function again, naming the SAME `execution_id`, and gets either
 * a fresh token (lease still live) or `invalid_grant` (lease gone).
 *
 * SECRETS DISCIPLINE (10-security.md §6, mirrors `../core/register.ts` and
 * `tests/connection.test.ts:359`): `clientSecret` and the returned
 * `accessToken` are NEVER logged, in success or failure. Every `logger.*`
 * call below carries execution ids and OAuth `error` codes only — never a
 * credential.
 */

import type { Clock } from './clock';
import { systemClock } from './clock';
import type { Logger } from './log';
import { nullLogger } from './log';

/** The one scope a runner ever requests (13 §6: "machine-only, never
 *  user-delegated"). */
export const MESH_EXECUTION_SCOPE = 'mesh:execution';

/** The minimal `fetch` surface this module needs — injectable so tests never
 *  hit the network (mirrors `../shipper/upload-transport.ts`'s `FetchLike`). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExecutionAccessToken {
  accessToken: string;
  tokenType: string;
  /** Clock-ms absolute expiry (`clock.now() + expires_in * 1000` at the
   *  moment the response was received) — never a duration, so callers never
   *  re-derive "now" at a different instant than the request completed. */
  expiresAt: number;
  scope: string;
}

export interface ExecutionTokenError {
  /** RFC 6749 §5.2 `error` code — e.g. `invalid_grant`, `invalid_client`,
   *  `invalid_target`, `invalid_request` — or a LOCAL synthetic code
   *  (`network_error`, `invalid_response`) for failures that never reached
   *  (or never came back as valid JSON from) the token endpoint. */
  error: string;
  description?: string;
  /** HTTP status, when the failure is a real response from the server. */
  status?: number;
}

export type ExecutionTokenResult = { ok: true; token: ExecutionAccessToken } | { ok: false; error: ExecutionTokenError };

export interface RequestExecutionTokenOptions {
  /** Control-plane base URL (`AgentIdentity.base_url`) — the SAME origin
   *  serves `/oauth/token` and `/mcp` (D13: AS and RS are colocated). */
  baseUrl: string;
  /** OAuth client id — the server-assigned `runner_id`. */
  clientId: string;
  /** OAuth client secret — the runner's EXISTING registration token. SECRET. */
  clientSecret: string;
  executionId: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

/** `${issuer}/mcp` — the ONE audience an execution token is ever requested
 *  for (13 §10: MCP server canonical resource). Mirrors the cloud's own
 *  `issuer()`/`canonicalResource()` (`cloud/apps/api/src/modules/mesh-oauth/resource.ts`)
 *  trailing-slash normalization so the string matches byte-for-byte. */
export function meshMcpResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp`;
}

function tokenEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/oauth/token`;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

/** Narrow a decoded JSON success body to the fields we need. Anything
 *  missing/mistyped is treated as `invalid_response` — never a thrown/NaN
 *  `expiresAt`. */
function narrowSuccessBody(raw: unknown): { accessToken: string; tokenType: string; expiresInS: number; scope: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.access_token !== 'string' || r.access_token.length === 0) return null;
  if (typeof r.expires_in !== 'number' || !Number.isFinite(r.expires_in) || r.expires_in <= 0) return null;
  return {
    accessToken: r.access_token,
    tokenType: typeof r.token_type === 'string' ? r.token_type : 'Bearer',
    expiresInS: r.expires_in,
    scope: typeof r.scope === 'string' ? r.scope : MESH_EXECUTION_SCOPE,
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

/**
 * Exchange the runner's client credentials for one execution-scoped access
 * token naming `options.executionId` (13 §12). Never throws — every failure
 * mode (network error, non-2xx response, malformed body) resolves to
 * `{ ok: false, error }`.
 */
export async function requestExecutionToken(options: RequestExecutionTokenOptions): Promise<ExecutionTokenResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? nullLogger;

  const resource = meshMcpResource(options.baseUrl);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    resource,
    scope: MESH_EXECUTION_SCOPE,
    execution_id: options.executionId,
  });

  logger.debug(`mesh-oauth: requesting execution token for execution ${options.executionId}`);

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: basicAuthHeader(options.clientId, options.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`mesh-oauth: execution token request for ${options.executionId} failed — network error: ${message}`);
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
      `mesh-oauth: execution token for ${options.executionId} refused (HTTP ${response.status}, ${error})${description ? `: ${description}` : ''}`
    );
    return { ok: false, error: { error, ...(description !== undefined ? { description } : {}), status: response.status } };
  }

  const success = narrowSuccessBody(decoded);
  if (success === null) {
    logger.warn(`mesh-oauth: execution token response for ${options.executionId} was malformed`);
    return { ok: false, error: { error: 'invalid_response', description: 'token endpoint returned a malformed success body', status: response.status } };
  }

  logger.debug(`mesh-oauth: execution token obtained for ${options.executionId} (expires in ${success.expiresInS}s)`);
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
