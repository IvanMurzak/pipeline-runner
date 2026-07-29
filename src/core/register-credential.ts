/**
 * Which credential this runner presents on the `register` frame
 * (department-mesh d5 — P6; `13-mcp-authorization.md` §10.2,
 * `11-migration-rollout.md` P6 / risk **R11**, `10-security.md` T27).
 *
 * ── The rule that outranks the feature ──────────────────────────────────────
 * Registration is a **hard version gate with no graceful degradation**: a
 * runner refused at `register` goes offline and *cannot re-register itself*.
 * So every decision in this module resolves towards **the credential that
 * works today**, and the only thing that can ever take a runner off the legacy
 * path is an operator explicitly closing the window on the cloud side (c15's
 * `RUNNER_CREDENTIAL_MODE=oauth_only`, or a per-runner legacy revocation).
 *
 * Concretely, this module NEVER fails a registration on its own:
 *
 *   | situation                                   | what is presented        |
 *   |---------------------------------------------|--------------------------|
 *   | no `oauth_client_secret` in config          | legacy `runner_token`    |
 *   | no `runner_id` yet (never registered)       | legacy `runner_token`    |
 *   | `/oauth/token` unreachable / 5xx / 503       | legacy `runner_token`    |
 *   | `/oauth/token` refuses (`invalid_client`, …) | legacy `runner_token`    |
 *   | malformed token response                    | legacy `runner_token`    |
 *   | migrated, exchange succeeded                | `runner:register` JWT    |
 *
 * The only case with no answer is a config holding NEITHER a legacy token nor a
 * usable OAuth pair — which `../core/config.ts`'s `load()` already refuses, so
 * it is a belt-and-braces branch here, reported as a RETRYABLE failure (the
 * caller backs off and reconnects) rather than a fatal stop.
 *
 * ── Why this is not "just always use OAuth" ─────────────────────────────────
 * The cloud (c15) accepts the legacy runner token as an OAuth *client secret*
 * too, so a runner holding only a legacy token COULD bootstrap a
 * `runner:register` JWT with it. This module deliberately does not do that:
 *
 *   1. It buys nothing. The runner would still depend entirely on a plaintext
 *      long-lived secret — the exact thing P6 removes — while *looking*
 *      migrated on the register frame. c15 calls that the false-green trap and
 *      records `last_client_auth_class` specifically to catch it.
 *   2. It costs something real: a mandatory HTTPS round trip, and a new
 *      failure surface, in the connect path of every already-deployed runner —
 *      for zero security gain.
 *
 * A runner with no client secret is therefore reported by the cloud's readiness
 * gate as `no_oauth_credential_issued`, which is the truth. Nothing here hides
 * a legacy dependency from that gate.
 *
 * ── Secrets discipline ──────────────────────────────────────────────────────
 * No function here logs a credential — not the legacy token, not the client
 * secret, not the issued `runner:register` JWT. `RegisterCredential.value` is
 * the ONLY place a secret appears, it is consumed straight into the frame, and
 * every log line carries ids, OAuth `error` codes and class names only.
 * `tests/register-credential.test.ts` + `tests/connection.test.ts` assert it.
 */

import type { Clock } from './clock';
import { systemClock } from './clock';
import type { AgentIdentity, ConfigStore } from './config';
import type { Logger } from './log';
import { nullLogger } from './log';
import type { ClientCredentialsResult, FetchLike, RequestRunnerRegistrationTokenOptions } from './department-oauth';
import { requestRunnerRegistrationToken } from './department-oauth';

/** Mirrors the cloud's `RunnerCredentialClass` (`runners/credential-window.ts`)
 *  — the two classes the gateway's dual-accept window distinguishes. */
export type RegisterCredentialClass = 'oauth' | 'legacy';

export interface RegisterCredential {
  /** The value that goes in the frame's `runner_token` field. **SECRET.** */
  value: string;
  credentialClass: RegisterCredentialClass;
  /**
   * Log-safe explanation of WHY this class was chosen. Always set for
   * `legacy` (so an operator can see whether it is "not migrated" or "the
   * OAuth path failed"), always null for `oauth`.
   */
  reason: string | null;
  /**
   * **`legacy` presented as a STAND-IN for a `runner:register` token this
   * runner could have minted, because the exchange failed this time.**
   *
   * This is the difference between "legacy is all this runner has" and
   * "migrated, but `/oauth/token` blipped", and it is load-bearing at the
   * reject site: if the cloud then answers `upgrade_required` (the window is
   * closed and this runner's legacy class is retired), the correct response is
   * to **back off and retry** — the next exchange may well succeed — not to
   * stop. Classifying that as fatal would convert a recoverable failure on the
   * token endpoint into a permanent outage driven by an unrelated one, which
   * is a NEW R11 path this migration must not create.
   *
   * Deliberately false for the {@link RegisterCredentialProvider.forceLegacy}
   * pin: there the OAuth credential was *itself* fatally refused, the one
   * retry has already been spent, and a second fatal answer is the real one.
   */
  degraded: boolean;
}

export type RegisterCredentialResolution =
  | { ok: true; credential: RegisterCredential }
  /** No credential at all. Retryable by construction — never a fatal stop. */
  | { ok: false; reason: string };

export interface RegisterCredentialProviderOptions {
  /** Injectable seam — defaults to `requestRunnerRegistrationToken`. Tests
   *  override this instead of stubbing `fetch` when they care about the
   *  DECISION, not the wire shape (mirrors `ExecutionTokenManager`). */
  requestToken?: (options: RequestRunnerRegistrationTokenOptions) => Promise<ClientCredentialsResult>;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Treat a cached registration token as expired this many ms before its real
   *  expiry, so a reconnect never presents a JWT that dies in flight.
   *  Default 30s (registration tokens live 15 minutes). */
  expiryLeewayMs?: number;
  /** How long a {@link RegisterCredentialProvider.forceLegacy} pin lasts.
   *  Default {@link DEFAULT_FORCE_LEGACY_COOLDOWN_MS}. */
  forceLegacyCooldownMs?: number;
}

const DEFAULT_EXPIRY_LEEWAY_MS = 30_000;

/**
 * How long the legacy pin set by {@link RegisterCredentialProvider.forceLegacy}
 * lasts before the OAuth path is tried again.
 *
 * Not permanent, and not immediate. Permanent was wrong: one transient fatal
 * reject during an authorization-server key roll would pin a long-lived runner
 * to the legacy credential for its whole life, holding c15's dual-accept window
 * open indefinitely — and "restart to re-attempt" never fires, because nothing
 * restarts a runner that is working. Immediate would be wrong too: it would
 * spend a fatal-classified register on every reconnect. Half an hour costs one
 * extra handshake per half hour in the bad case and self-heals in the good one.
 */
export const DEFAULT_FORCE_LEGACY_COOLDOWN_MS = 30 * 60_000;

/**
 * Which secret authenticates this runner as an OAuth **client** at
 * `POST /oauth/token` — the DISTINCT `oauth_client_secret` when it has one,
 * else the legacy `runner_token` (which c15's `resolveRunnerClientSecret`
 * still accepts while the window is open).
 *
 * The single expression of that ordering. `../cli.ts` uses it for the d6
 * execution-token path too, so both token kinds migrate together and neither
 * silently keeps using the legacy secret after a client secret is installed.
 *
 * Returns null when neither exists — the caller then has nothing to exchange.
 */
export function selectClientSecret(identity: AgentIdentity): string | null {
  return identity.oauth_client_secret ?? identity.runner_token ?? null;
}

/** Can this identity mint a `runner:register` token at all? Needs the DISTINCT
 *  client secret (see the module doc on why the legacy token does not qualify),
 *  the `runner_id` that is its `client_id`, and a base URL to send it to. */
export function canMintRegistrationToken(identity: AgentIdentity): boolean {
  return (
    identity.oauth_client_secret !== undefined &&
    identity.oauth_client_secret.length > 0 &&
    identity.runner_id !== undefined &&
    identity.runner_id.length > 0 &&
    identity.base_url.length > 0
  );
}

/**
 * Carry a previously-stored legacy `runner_token` forward onto an identity that
 * does not name one.
 *
 * `pipeline-runner register` **overwrites** the config wholesale, so running
 * the documented migration command — `register --url … --client-id …
 * --client-secret …` on a live runner — would otherwise delete the legacy token
 * silently, along with the fallback this entire migration depends on. An
 * operator who then mistypes the secret (or hits a token-endpoint blip) has a
 * runner that backs off forever and cannot recover without finding the old
 * token again. Removing the legacy credential must be the explicit act it is in
 * `set-credentials --drop-token`, never a side effect of re-registering.
 *
 * Returns `carried: true` when a token was actually preserved, so the caller
 * can say so rather than change the config quietly.
 */
export function carryForwardLegacyToken(
  previous: AgentIdentity | null,
  next: AgentIdentity
): { identity: AgentIdentity; carried: boolean } {
  const existing = previous?.runner_token;
  if (next.runner_token !== undefined && next.runner_token.length > 0) return { identity: next, carried: false };
  if (existing === undefined || existing.length === 0) return { identity: next, carried: false };
  return { identity: { ...next, runner_token: existing }, carried: true };
}

/**
 * Persist OAuth client credentials onto an EXISTING identity — the runner side
 * of `POST /api/v1/runners/:id/oauth-credentials`. The legacy `runner_token` is
 * deliberately left in place: it is the fallback that keeps this runner online
 * if anything about the OAuth path misbehaves, and the operator removes it only
 * after the cloud's readiness gate says the window can close.
 *
 * `clientId` is the runner row id, which is also the `runner_id` the register
 * ack persists — so storing it under `runner_id` is not a coincidence, it is
 * the same value by the cloud's own construction.
 */
export function storeOAuthClientCredentials(
  store: ConfigStore,
  credentials: { clientId: string; clientSecret: string }
): AgentIdentity {
  return store.update({ runner_id: credentials.clientId, oauth_client_secret: credentials.clientSecret });
}

/**
 * Chooses (and caches) the credential for the next `register` frame.
 *
 * One instance per `AgentClient`. The cached `runner:register` token is held
 * **in memory only** — never written to disk, exactly like the d6 execution
 * tokens — and is re-requested per connect once it nears expiry.
 */
export class RegisterCredentialProvider {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly requestToken: (options: RequestRunnerRegistrationTokenOptions) => Promise<ClientCredentialsResult>;
  private readonly expiryLeewayMs: number;
  private readonly forceLegacyCooldownMs: number;

  private cached: { value: string; expiresAt: number } | null = null;
  private inFlight: Promise<ClientCredentialsResult> | null = null;
  /** Clock-ms at which a {@link forceLegacy} pin lapses; null ⇒ not pinned. */
  private legacyForcedUntil: number | null = null;

  constructor(private readonly options: RegisterCredentialProviderOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
    this.requestToken = options.requestToken ?? requestRunnerRegistrationToken;
    this.expiryLeewayMs = options.expiryLeewayMs ?? DEFAULT_EXPIRY_LEEWAY_MS;
    this.forceLegacyCooldownMs = options.forceLegacyCooldownMs ?? DEFAULT_FORCE_LEGACY_COOLDOWN_MS;
  }

  /** Is a {@link forceLegacy} pin in force RIGHT NOW? Lapses on its own after
   *  {@link RegisterCredentialProviderOptions.forceLegacyCooldownMs}. */
  get legacyForced(): boolean {
    return this.legacyForcedUntil !== null && this.clock.now() < this.legacyForcedUntil;
  }

  /**
   * Resolve WITHOUT any I/O, or null when a token exchange is required.
   *
   * The fast path matters beyond speed: a runner that is not migrated returns
   * here, so its connect sequence is byte-for-byte what it was before P6 — the
   * register frame still leaves in the same turn the socket opened, with no new
   * network dependency anywhere in it.
   */
  immediate(identity: AgentIdentity): RegisterCredentialResolution | null {
    if (this.legacyForced) {
      // Re-stated on EVERY register while the pin holds, at warn, so an
      // operator watching logs or `status` sees a runner that is silently
      // still on the legacy credential — the state that holds c15's window
      // open — rather than one warning scrolling away hours ago.
      this.logger.warn(
        'register: still using this runner\'s LEGACY token because its OAuth registration credential was ' +
          'refused. Fix the client secret (`pipeline-runner set-credentials`); the OAuth path is retried ' +
          'automatically once the cooldown lapses.'
      );
      return this.legacy(identity, 'the OAuth registration credential was refused earlier in this process', false);
    }
    if (!canMintRegistrationToken(identity)) {
      return this.legacy(identity, 'no OAuth client credentials configured for this runner', false);
    }
    const cached = this.cached;
    if (cached !== null && cached.expiresAt - this.expiryLeewayMs > this.clock.now()) {
      return { ok: true, credential: { value: cached.value, credentialClass: 'oauth', reason: null, degraded: false } };
    }
    return null;
  }

  /**
   * The full resolution, including a `client_credentials` exchange when one is
   * needed. **Never throws, and never rejects** — every failure degrades to the
   * legacy token.
   */
  async resolve(identity: AgentIdentity): Promise<RegisterCredentialResolution> {
    const immediate = this.immediate(identity);
    if (immediate !== null) return immediate;

    const result = await this.exchange(identity);
    if (result.ok) {
      this.cached = { value: result.token.accessToken, expiresAt: result.token.expiresAt };
      return {
        ok: true,
        credential: { value: result.token.accessToken, credentialClass: 'oauth', reason: null, degraded: false },
      };
    }

    // Every refusal, every network failure, every malformed body lands here.
    // `department-oauth.ts` has already logged the OAuth error code; this line says
    // what the runner is going to DO about it, which is the operator-facing
    // half. Neither line carries a credential.
    const reason = `could not obtain a runner:register token (${result.error.error})`;
    this.logger.warn(
      `register: ${reason} — falling back to the legacy runner token (the cloud dual-accepts during the P6 window)`
    );
    // `degraded` — this runner CAN mint, the exchange just failed. See the
    // field doc: a fatal reject of this stand-in must be retried, not honoured.
    return this.legacy(identity, reason, true);
  }

  /**
   * Drop the cached registration token. Called on every `register_reject` so a
   * retry never re-presents a token the server just refused.
   */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Pin this process to the legacy token.
   *
   * The safety net for the one way P6 could take a live runner offline: the
   * runner presents a `runner:register` JWT, the cloud refuses it *fatally*
   * (`invalid_token`) — a rotated `OAUTH_TOKEN_SECRET`, a stale client secret,
   * clock skew — and the pre-P6 runner, which would have presented its still
   * valid legacy token, would have stayed online. So `AgentClient` calls this
   * and retries with legacy once before honouring a fatal reject.
   *
   * The pin is time-boxed ({@link DEFAULT_FORCE_LEGACY_COOLDOWN_MS}) rather
   * than permanent: a *rejected* OAuth credential is usually a configuration
   * fault, but "usually" is not "always" — an authorization-server key roll
   * looks identical and heals itself. A permanent pin would hold c15's window
   * open for the life of a runner that nothing ever restarts, so the OAuth path
   * is retried once the cooldown lapses, and the pin is re-stated at `warn` on
   * every register while it holds.
   *
   * This does not defeat c15's telemetry — the fallback registers as `legacy`,
   * which is exactly what the readiness gate must see about a runner that
   * currently depends on the legacy credential.
   */
  forceLegacy(): void {
    this.legacyForcedUntil = this.clock.now() + this.forceLegacyCooldownMs;
    this.invalidate();
  }

  private legacy(identity: AgentIdentity, reason: string, degraded: boolean): RegisterCredentialResolution {
    const token = identity.runner_token;
    if (token === undefined || token.length === 0) {
      return {
        ok: false,
        reason: `${reason}, and this runner holds no legacy runner_token to fall back on`,
      };
    }
    return { ok: true, credential: { value: token, credentialClass: 'legacy', reason, degraded } };
  }

  private exchange(identity: AgentIdentity): Promise<ClientCredentialsResult> {
    const existing = this.inFlight;
    if (existing !== null) return existing;

    const promise = this.requestToken({
      baseUrl: identity.base_url,
      // `canMintRegistrationToken` proved both of these non-empty before
      // `immediate()` returned null, which is the only way we get here.
      clientId: identity.runner_id!,
      clientSecret: identity.oauth_client_secret!,
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      clock: this.clock,
      logger: this.logger,
    }).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });

    this.inFlight = promise;
    return promise;
  }
}
