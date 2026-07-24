/**
 * `ExecutionTokenManager` — the in-memory holder for execution-scoped OAuth
 * tokens (department-mesh task d6; `13-mcp-authorization.md` §12). Sits
 * between `../core/mesh-oauth.ts` (the stateless `client_credentials`
 * exchange) and `./manager.ts` (the supervisor): caches one live token per
 * execution, dedupes concurrent requests for the same execution, and
 * exposes the "re-REQUEST, not refresh" operation lease renewal needs.
 *
 * The token is held ONLY here, in memory — never written to disk, never
 * placed on a wire frame, never logged (see `../core/mesh-oauth.ts`'s
 * secrets-discipline note; this module inherits the same rule and adds none
 * of its own logging that could regress it).
 *
 * `./mesh-relay.ts`'s durability relay reads through this same cache at
 * drain time (13 §12.1: "re-attaches a current execution token from memory
 * at drain … if the token has expired by then, the relay re-requests one")
 * — `getToken()` already does exactly that (expired ⇒ transparent
 * re-request), so the relay needs no separate freshness logic of its own.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { ExecutionTokenResult, FetchLike, RequestExecutionTokenOptions } from '../core/mesh-oauth';
import { meshMcpResource, requestExecutionToken } from '../core/mesh-oauth';

/** Narrowed to exactly the shape `./manager.ts` and `./mesh-relay.ts` need —
 *  real callers get `ExecutionTokenManager`; tests substitute a fake this
 *  interface, never a full manager. */
export interface ExecutionTokenSource {
  getToken(executionId: string): Promise<ExecutionTokenResult>;
  renew(executionId: string): Promise<ExecutionTokenResult>;
  discard(executionId: string): void;
  /** `${base_url}/mcp`, or null before this runner has a `base_url` / any
   *  identity configured at all. Lets callers (the manager, when injecting
   *  the runtime's env) build the direct-call URL without duplicating the
   *  `../core/mesh-oauth.ts` normalization. */
  resourceUrl(): string | null;
}

export interface ExecutionTokenManagerOptions {
  /** Live accessors (not captured values) — mirrors `../cli.ts`'s
   *  `runnerId: () => store.load()?.runner_id ?? null` idiom, so a manager
   *  constructed before `register_ack` still works once the identity is
   *  populated. Null from any of the three ⇒ `getToken`/`renew` resolve
   *  `{ ok: false, error: { error: 'not_registered' } }` without a network
   *  call (there is nothing valid to authenticate with yet). */
  baseUrl(): string | null;
  clientId(): string | null;
  clientSecret(): string | null;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Injectable seam — defaults to `requestExecutionToken`. Tests override
   *  this directly instead of stubbing `fetch` when they only care about
   *  the CACHE's behaviour (dedup/expiry/renew), not the wire shape. */
  requestToken?: (options: RequestExecutionTokenOptions) => Promise<ExecutionTokenResult>;
  /** Treat a token as expired this many ms before its real `expiresAt` —
   *  avoids handing a spawned process (or the relay) a token that dies
   *  mid-flight. Default 5s. */
  expiryLeewayMs?: number;
}

const DEFAULT_EXPIRY_LEEWAY_MS = 5_000;

const NOT_REGISTERED: ExecutionTokenResult = {
  ok: false,
  error: { error: 'not_registered', description: 'no runner_id/runner_token/base_url configured yet' },
};

export class ExecutionTokenManager implements ExecutionTokenSource {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly requestToken: (options: RequestExecutionTokenOptions) => Promise<ExecutionTokenResult>;
  private readonly expiryLeewayMs: number;

  /** Live cache, keyed by executionId. */
  private readonly cache = new Map<string, ExecutionTokenResult & { ok: true }>();
  /** In-flight de-dup: concurrent `getToken`/`renew` calls for the SAME
   *  execution share one network request rather than firing N. */
  private readonly inFlight = new Map<string, Promise<ExecutionTokenResult>>();

  constructor(private readonly options: ExecutionTokenManagerOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.requestToken = options.requestToken ?? requestExecutionToken;
    this.expiryLeewayMs = options.expiryLeewayMs ?? DEFAULT_EXPIRY_LEEWAY_MS;
  }

  resourceUrl(): string | null {
    const baseUrl = this.options.baseUrl();
    return baseUrl === null ? null : meshMcpResource(baseUrl);
  }

  /** A live, cached token for `executionId` — requests fresh only when
   *  nothing is cached or the cached one is within `expiryLeewayMs` of
   *  expiry. Concurrent callers for the same execution share one request. */
  async getToken(executionId: string): Promise<ExecutionTokenResult> {
    const cached = this.cache.get(executionId);
    if (cached !== undefined && cached.token.expiresAt - this.expiryLeewayMs > this.clock.now()) {
      return cached;
    }
    return this.fetchAndCache(executionId);
  }

  /** ALWAYS makes a fresh `client_credentials` request, discarding any
   *  cached token first — the DoD's "re-REQUEST (not refresh) on lease
   *  renewal" (there is no refresh-token grant in this design at all, 13
   *  §12: OAuth 2.1 §4.2 / RFC 6749 §4.4.3 forbid one for `client_credentials`). */
  async renew(executionId: string): Promise<ExecutionTokenResult> {
    this.cache.delete(executionId);
    return this.fetchAndCache(executionId);
  }

  /** Drop any cached token for an execution (lease revoked / execution
   *  terminal) — the next `getToken` starts clean rather than ever handing
   *  out a token for a dead execution from a stale cache entry. */
  discard(executionId: string): void {
    this.cache.delete(executionId);
    this.inFlight.delete(executionId);
  }

  private fetchAndCache(executionId: string): Promise<ExecutionTokenResult> {
    const existing = this.inFlight.get(executionId);
    if (existing !== undefined) return existing;

    const baseUrl = this.options.baseUrl();
    const clientId = this.options.clientId();
    const clientSecret = this.options.clientSecret();
    if (baseUrl === null || clientId === null || clientSecret === null) {
      this.logger.warn(`mesh-oauth: cannot request an execution token for ${executionId} — runner is not registered yet`);
      return Promise.resolve(NOT_REGISTERED);
    }

    const promise = this.requestToken({
      baseUrl,
      clientId,
      clientSecret,
      executionId,
      fetchImpl: this.options.fetchImpl,
      clock: this.clock,
      logger: this.logger,
    })
      .then((result) => {
        // Cache ONLY if this request is still the current in-flight one for
        // the execution. A `discard()` (lease revoked / execution terminal)
        // between the request starting and completing removes the in-flight
        // entry, and MUST win — a token for a gone lease is never cached, the
        // guarantee `discard()`'s own doc states ("nothing … could ever hand
        // it out again for a lease that is already gone"). Without this
        // identity check the late `.then` would re-populate the cache after
        // discard. A superseding `renew()`/`getToken` installs a DIFFERENT
        // promise here, so it caches its own fresher result instead.
        if (result.ok && this.inFlight.get(executionId) === promise) {
          this.cache.set(executionId, result);
        }
        return result;
      })
      .finally(() => {
        // Only clear OUR entry — a discard()+new-request sequence may have
        // replaced it with a different in-flight promise we must not delete.
        if (this.inFlight.get(executionId) === promise) this.inFlight.delete(executionId);
      });

    this.inFlight.set(executionId, promise);
    return promise;
  }
}
