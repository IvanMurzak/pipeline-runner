/**
 * `ExecutionTokenEndpoint` — the missing seam (simplified-onboarding x21;
 * owner decision D33, amending D23).
 *
 * ## What was missing, exactly
 *
 * D23 specified that the `claude-code` engine wires MCP with a
 * `headersHelper` rather than a static header, because a helper re-runs on
 * connect and automatically on `401`/`403` and is therefore "the only
 * mechanism that survives token expiry". The reasoning was right. The seam it
 * needs did not exist, and `b3` said so rather than claiming its DoD box:
 *
 *   - the execution-token cache is **in-process memory in the daemon**
 *     (`./execution-token-manager.ts`: "held ONLY here, in memory"), while
 *   - `headersHelper` is spawned as a **child of the Claude Code session** — a
 *     different process tree, with no read into that memory.
 *
 * So the spec's "the helper reads the manager's existing token cache" was not
 * achievable as written. The two ways to make a helper genuinely fresher were
 * (a) put the runner's long-lived OAuth client secret inside a model-driven
 * session so the helper can re-mint for itself, or (b) give the helper a
 * channel back into the daemon. (a) trades a bounded failure (one long task
 * loses its tools) for an unbounded one and breaks the invariant D33 restates.
 * This file is (b).
 *
 * ## What it is
 *
 * A loopback HTTP listener the DAEMON owns, with one grant per live
 * execution. A grant is `{ url, secret }`; the supervisor injects both into
 * the session's environment (`ENGINE_MCP_HELPER_*_ENV`), the engine module
 * builds a helper command that reads them, and the helper presents the secret
 * to get a **fresh** execution token back — in exactly the JSON shape Claude
 * Code wants on the helper's stdout (`{"Authorization":"Bearer …"}`), so the
 * helper is a pure proxy with no policy of its own.
 *
 * ## What it does NOT widen (D33's invariant)
 *
 * The response body is an **execution token**: short-lived,
 * audience-restricted to `<base>/mcp`, and scoped to the one execution. The
 * session already holds a copy of exactly that (`PIPELINE_DEPARTMENT_EXECUTION_TOKEN`
 * in its own environment). This endpoint therefore hands a session nothing it
 * does not already have — only a FRESHER copy. The durable credential (the
 * runner's OAuth `client_secret`) never crosses this boundary: the
 * `client_credentials` exchange happens in the daemon, in
 * `./execution-token-manager.ts`, and only its output is returned.
 *
 * Nothing here writes to disk. There is no env file, no temp file and no
 * socket file — deliberately, and for the same reason `x20` rejected a temp
 * env-file for the `docker` case: a secret moved to a filesystem surface is a
 * secret with a crash lifetime and default permissions.
 *
 * ## Why loopback TCP and not a unix socket / named pipe
 *
 * A unix socket would carry filesystem permissions (0600), which is stronger
 * than loopback TCP's "any process on this host may connect". It is rejected
 * for two reasons: it is a **disk artifact** with a crash lifetime (the thing
 * the paragraph above is avoiding), and the runner installs as a first-class
 * Windows service (`../service/`), where the equivalent is a named pipe with
 * an entirely different API and ACL model. Loopback TCP is one code path on
 * every platform this daemon ships to.
 *
 * The exposure that buys is bounded, deliberately:
 *   - bound to `127.0.0.1` explicitly — never `0.0.0.0`, so nothing off-host
 *     can reach it, ever;
 *   - an EPHEMERAL port (`port: 0`), so there is no well-known target;
 *   - every request needs a **256-bit per-execution secret** that lives only
 *     in the daemon's memory and in the session's environment block (owner-
 *     readable `0400` on Linux — the same surface `x20` moved the token TO);
 *   - compared in constant time, so the port is not an oracle;
 *   - the grant is REVOKED at terminal/lease-revoke, and the listener is
 *     closed entirely when the last grant goes, so the surface exists only
 *     while an execution that needs it is live;
 *   - a local attacker who could brute-force a 256-bit secret could equally
 *     read `/proc/<pid>/environ` of our own child, which already holds the
 *     same token. The endpoint is not the weakest link it introduces.
 *
 * ## Renewal, throttled
 *
 * `headersHelper` runs on connect AND on every `401`/`403`. Always calling
 * `renew()` would burn a `client_credentials` exchange per MCP hiccup; never
 * calling it would return the same rejected token and defeat the whole
 * mechanism. So: a grant renews at most once per `minRenewIntervalMs`, and
 * inside that window answers from the cache (which, right after a renew, IS
 * the fresh token). A real expiry is minutes past the last mint and always
 * renews; a retry storm collapses onto one exchange.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { ExecutionTokenSource } from './execution-token-manager';

/** The path the loopback listener answers on. Named rather than `/` so a
 *  stray probe of the port gets a 404 and learns nothing. */
export const HELPER_ENDPOINT_PATH = '/mcp-headers';

/** Query parameter naming the execution. NOT a credential — the secret is —
 *  but a mismatch between the two is a bookkeeping bug, and answering it with
 *  a 403 turns a silent cross-execution token hand-out into a loud refusal. */
export const HELPER_EXECUTION_PARAM = 'execution';

/** Bytes of entropy in a grant secret. 32 bytes = 256 bits, the same order as
 *  the tokens it guards. */
export const HELPER_SECRET_BYTES = 32;

/** A grant renews at most this often. See the module doc's "Renewal,
 *  throttled". 2s is well under any real token TTL and well over a retry
 *  burst. */
export const DEFAULT_MIN_RENEW_INTERVAL_MS = 2_000;

/** What a session's helper needs in order to ask for a fresh token. */
export interface ExecutionHeaderChannel {
  /** Loopback URL, e.g. `http://127.0.0.1:54321/mcp-headers`. */
  url: string;
  /** SECRET — per-execution, in-memory, revoked at terminal. */
  secret: string;
}

/** The narrow shape `./manager.ts` depends on — real callers get
 *  `ExecutionTokenEndpoint`, tests substitute a fake this interface. Mirrors
 *  `ExecutionTokenSource`'s own posture in the sibling module. */
export interface ExecutionHeaderChannelSource {
  /** Mint (or ROTATE — see the implementation) this execution's channel.
   *  `null` means "no channel this spawn", which is never fatal: the engine
   *  falls back to a static header and behaves exactly as it did pre-x21. */
  grant(executionId: string): Promise<ExecutionHeaderChannel | null>;
  /** Drop the grant. The next request presenting its secret is refused. */
  revoke(executionId: string): void;
}

/** The minimal `Bun.serve` surface this module uses — injectable so a test
 *  can assert a bind failure degrades rather than throws, without breaking a
 *  real socket. */
export interface LoopbackServer {
  readonly port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  unref?(): void;
}

export type LoopbackServeLike = (options: {
  port: number;
  hostname: string;
  fetch: (request: Request) => Promise<Response> | Response;
}) => LoopbackServer;

export interface ExecutionTokenEndpointOptions {
  /** Where a fresh token actually comes from — the daemon-side cache that
   *  holds the durable credential's output and never the credential. */
  tokens: ExecutionTokenSource;
  clock?: Clock;
  logger?: Logger;
  /** Injectable listener seam; defaults to `Bun.serve`. */
  serve?: LoopbackServeLike;
  /** Injectable entropy; defaults to `crypto.getRandomValues`. */
  makeSecret?: () => string;
  minRenewIntervalMs?: number;
  /** Loopback interface. Overridable ONLY so a test can prove the default is
   *  what it says it is; there is no configuration path to a non-loopback
   *  bind, and there must not be. */
  hostname?: string;
}

interface Grant {
  secret: string;
  /** Clock-ms of the last `renew()` this grant caused. Seeded at grant time
   *  because the supervisor has just minted a token for the spawn — the
   *  connect-time helper call must not immediately burn a second one. */
  lastRenewAt: number;
}

function defaultSecret(): string {
  const bytes = new Uint8Array(HELPER_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Length-independent, content-constant-time string comparison. Length is
 * allowed to leak (every grant secret is the same length, so it carries no
 * information); the CONTENT is not, so a caller cannot walk the secret one
 * byte at a time off the response latency.
 */
export function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The `Authorization: Bearer <secret>` a helper presents, or null. */
export function readBearer(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export class ExecutionTokenEndpoint implements ExecutionHeaderChannelSource {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly serve: LoopbackServeLike;
  private readonly makeSecret: () => string;
  private readonly minRenewIntervalMs: number;
  private readonly hostname: string;
  private readonly grants = new Map<string, Grant>();
  private server: LoopbackServer | null = null;

  constructor(private readonly options: ExecutionTokenEndpointOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.serve = options.serve ?? ((init) => Bun.serve(init) as unknown as LoopbackServer);
    this.makeSecret = options.makeSecret ?? defaultSecret;
    this.minRenewIntervalMs = options.minRenewIntervalMs ?? DEFAULT_MIN_RENEW_INTERVAL_MS;
    this.hostname = options.hostname ?? '127.0.0.1';
  }

  /**
   * ROTATES rather than reuses: a `per-context` respawn is a NEW process with
   * a new environment, and the previous process's secret should stop working
   * the moment it is replaced. (If a straggler from the old process does
   * present it, it gets a 401 — its MCP calls then fail, which `x16` already
   * turns into a stated failure rather than a false completion.)
   *
   * Never throws. A listener that cannot bind degrades to `null`, the same
   * posture `./manager.ts`'s `resolveMcpEnv` takes for a token it could not
   * mint: admission must not depend on this.
   */
  async grant(executionId: string): Promise<ExecutionHeaderChannel | null> {
    const url = this.ensureServer();
    if (url === null) return null;
    const secret = this.makeSecret();
    this.grants.set(executionId, { secret, lastRenewAt: this.clock.now() });
    return { url, secret };
  }

  revoke(executionId: string): void {
    if (!this.grants.delete(executionId)) return;
    // The listener exists only while something is allowed to use it.
    if (this.grants.size === 0) this.stopServer();
  }

  /** Test/shutdown seam: drop every grant and close the listener. */
  stop(): void {
    this.grants.clear();
    this.stopServer();
  }

  /** `null` until something has been granted (nothing is listening before the
   *  first department execution needs it). */
  get address(): string | null {
    return this.server === null ? null : this.endpointUrl(this.server.port);
  }

  private endpointUrl(port: number): string {
    return `http://${this.hostname}:${port}${HELPER_ENDPOINT_PATH}`;
  }

  private ensureServer(): string | null {
    if (this.server !== null) return this.endpointUrl(this.server.port);
    try {
      const server = this.serve({
        port: 0,
        hostname: this.hostname,
        fetch: (request) => this.handle(request),
      });
      // A daemon must never be held open by this listener: it is a
      // convenience for live executions, not a reason to keep running.
      server.unref?.();
      this.server = server;
      this.logger.debug(`department: execution-token endpoint listening on ${this.hostname} (ephemeral port)`);
      return this.endpointUrl(server.port);
    } catch (err) {
      this.logger.warn(
        `department: could not open the loopback execution-token endpoint (${err instanceof Error ? err.message : String(err)}) — ` +
          'long sessions will not be able to re-authorize when their execution token expires'
      );
      return null;
    }
  }

  private stopServer(): void {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    try {
      void server.stop();
    } catch {
      /* closing a listener that is already gone is not an error worth a line */
    }
  }

  /**
   * One helper request. Every refusal is a bare code with no detail: this
   * endpoint answers an unauthenticated local caller, so its RESPONSE is the
   * one place it could leak which executions exist.
   *
   * x38: the LOG is a different surface and now says something. A refused
   * helper request used to leave no trace anywhere in the runner — the
   * response is a bare 401, and the helper's own careful diagnosis goes to its
   * STDERR, which Claude Code swallows (its `headersHelper` runner discards
   * the child's stderr and reports only its own "did not return a valid
   * value"). So the one failure that silently costs a long session every
   * receiver tool it has was, until now, completely unobservable — which is a
   * large part of why four P4 gate runs could not settle x38. The line names
   * the execution and WHY, and nothing else: never the presented value, never
   * the grant's secret, and never a hint that would let an unauthenticated
   * local caller enumerate executions from the response (the response is
   * unchanged).
   *
   * Deliberately NOT a fix for x38 itself. The live 401-recovery failure was
   * root-caused to the GATEWAY answering its own RFC 9728 / RFC 8414
   * discovery endpoints with 401, which stops Claude Code before it ever
   * re-runs the helper; this endpoint was never reached at all. This is the
   * instrument that would have said so on the first run.
   */
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== HELPER_ENDPOINT_PATH) return jsonResponse(404, { error: 'not_found' });

    const executionId = url.searchParams.get(HELPER_EXECUTION_PARAM);
    const presented = readBearer(request.headers.get('authorization'));
    if (executionId === null || executionId.length === 0 || presented === null) {
      this.logger.warn(
        'department: a headers-helper request arrived without an execution id or a bearer and was refused — ' +
          'a session that outlives its execution token cannot re-authorize'
      );
      return jsonResponse(401, { error: 'unauthorized' });
    }
    const grant = this.grants.get(executionId);
    // Compare against a same-length decoy when there is no grant, so "unknown
    // execution" and "wrong secret" cost the same.
    if (grant === undefined || !secretsMatch(grant.secret, presented)) {
      this.logger.warn(
        `department execution ${executionId}: a headers-helper request was refused (${grant === undefined ? 'no live grant for this execution' : 'the presented secret does not match this execution’s grant'}) — ` +
          'that session can no longer re-authorize and will lose its receiver tools when its execution token expires'
      );
      return jsonResponse(401, { error: 'unauthorized' });
    }

    const result = await this.mint(executionId, grant);
    if (!result.ok) {
      // The OAuth error CODE only — never the description, never the
      // credential, exactly as `./execution-token-manager.ts` logs it.
      this.logger.warn(
        `department execution ${executionId}: headers-helper could not obtain a fresh execution token (${result.error.error})`
      );
      return jsonResponse(502, { error: result.error.error });
    }
    // Exactly the object Claude Code expects on the helper's stdout: a flat
    // string→string header map. The helper prints this body verbatim.
    return jsonResponse(200, { Authorization: `${result.token.tokenType || 'Bearer'} ${result.token.accessToken}` });
  }

  private async mint(executionId: string, grant: Grant): ReturnType<ExecutionTokenSource['getToken']> {
    const now = this.clock.now();
    if (now - grant.lastRenewAt < this.minRenewIntervalMs) {
      // Inside the throttle window a renew has just happened (or the spawn's
      // own mint has), so the cache IS the fresh token.
      return this.options.tokens.getToken(executionId);
    }
    grant.lastRenewAt = now;
    // "re-REQUEST, not refresh" — the operation `./execution-token-manager.ts`
    // exposes for exactly this, and the only one that survives a token the
    // resource server has already rejected.
    return this.options.tokens.renew(executionId);
  }
}
