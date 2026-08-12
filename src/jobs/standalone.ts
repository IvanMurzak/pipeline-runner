/**
 * standalone.ts — HOSTED `standalone` SELECTION AND THE ORG PROVIDER KEY (f1,
 * `.taskflow/2026-08-03-execution-modes/` 01-modes.md E3/E9 + 02-standalone-executor.md).
 *
 * On OUR machine there is no user's Claude Code installation, no user's
 * subscription and no user's configuration — so `standalone` (the owned drive
 * loop + the Agent SDK executor) is the only mode that can run there (E3), and
 * the key it runs on is the ORG's, never the machine's.
 *
 * This module owns exactly three decisions and nothing else:
 *
 *   1. a hosted run drives with `--executor=claude-sdk`   ({@link HOSTED_EXECUTOR})
 *   2. the provider key reaching that run is the ORG's    ({@link hostedDriveEnv})
 *   3. a hosted run with NO org credential does not start ({@link HostedCredentialError})
 *
 * ── THE FAILURE THIS EXISTS TO PREVENT ────────────────────────────────────
 *
 * "One tenant's run silently bills another's balance." A hosted runner is a
 * machine WE own, running a repository the CUSTOMER wrote. If an
 * `ANTHROPIC_API_KEY` is lying in that machine's environment — an operator's
 * debugging leftover, a base image's baked-in default, another tenant's
 * credential still exported in a pooled shell — and a hosted run picks it up,
 * every symptom is invisible: the run succeeds, the records are well-formed,
 * the pipeline completes. The only trace is a charge on the wrong balance.
 *
 * So this module's guarantee is not "the ambient variable loses a race". It is
 * that a hosted drive child's provider-key environment is DETERMINED HERE,
 * never inherited: the value is the org's or the run never spawns.
 *
 * ── WHY THE ENVIRONMENT, AND NOT `--api-key` ──────────────────────────────
 *
 * The CLI's key ladder (c1, `pipeline`'s `src/lib/provider-key.ts`) has four
 * rungs, first match wins:
 *
 *   1. `--api-key <value>` on the invocation      (argv)
 *   2. `PIPELINE_API_KEY_HELPER=<command>`        (a command that prints a key)
 *   3. `ANTHROPIC_API_KEY`                        (the environment)
 *   4. the machine's own credential store          (a per-user file/keychain)
 *
 * We deliver at RUNG 3, deliberately, and c1's own header is the argument:
 * a value passed on the command line "is visible to `ps` and to the shell
 * history for as long as the process lives". On a hosted runner that is
 * disqualifying rather than merely untidy — the very thing running on this
 * machine is a pipeline step executing arbitrary code out of a repository we
 * did not write, and `ps` is one shell-out away from it. A child's environment
 * is readable by that child (unavoidable — the SDK needs the key in-process),
 * but it is not published to every other process on the box the way argv is.
 *
 * Delivering at rung 3 also means the runner introduces NO SECOND KEY PATH:
 * it feeds the existing ladder rather than teaching the CLI a new way to be
 * given a key. There is likewise no second store — nothing here is persisted.
 *
 * ── SO EVERY RUNG ABOVE AND BELOW US MUST BE ACCOUNTED FOR ────────────────
 *
 * Choosing rung 3 is only safe if no OTHER rung can win with a machine value:
 *
 *   rung 1  we never pass `--api-key`, and the runner builds drive's argv
 *           itself ({@link ../jobs/drive#buildDriveArgs}) — a lease cannot
 *           inject flags.
 *   rung 2  ⚠ AMBIENT AND HIGHER-PRECEDENCE. `PIPELINE_API_KEY_HELPER` is an
 *           ordinary environment variable, so a helper configured on the
 *           MACHINE would outrank the org key we just supplied and hand the
 *           run somebody else's credential — the exact failure above, through
 *           a door one rung up. {@link hostedDriveEnv} therefore UNSETS it.
 *           This is the non-obvious half of the guarantee.
 *   rung 3  set by us, unconditionally, to the org's key.
 *   rung 4  unreachable: rung 3 always matches on a hosted run, and when we
 *           have no org key we never spawn at all — so the machine's own
 *           credential store is never consulted either way.
 *
 * ── HOW c2'S SCRUBBER ENDS UP ARMED (AND WHY THAT IS NOT AN ACCIDENT) ─────
 *
 * c2's output scrubber (`pipeline`'s `src/lib/output-scrubber.ts`) redacts
 * values it has been TOLD. c1 tells it: before the ladder runs, it reads
 * `ANTHROPIC_API_KEY` and calls `registerSecret` on it unconditionally —
 * "every key the ladder can produce in one run, not only the one in use".
 * Delivering the org key at rung 3 is therefore precisely what arms c2 against
 * that value inside the drive child, which is where the SDK, its errors and
 * its stack traces actually live. Had we delivered by argv instead, the key
 * would have arrived somewhere c1 does not register from.
 *
 * Runner-side, {@link redactingLogger} is the second layer, mirroring the
 * discipline `core/log.ts` already documents for the runner token.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * `settingSources: ["project"]` (E9) is NOT set here, and cannot be from this
 * repository: the runner reaches the SDK only by spawning `pipeline drive`,
 * and no CLI flag or environment variable maps onto that option today —
 * `drive.ts` builds its SDK seams without it. See `docs/hosted-standalone.md`.
 *
 * The pooled-machine inputs that are read REGARDLESS of `settingSources` —
 * auto memory and the global `~/.claude.json` — are task f4's (wiped home,
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). f4 has NOT landed, and this module
 * must not pretend otherwise: on a fresh per-run container both are empty,
 * which is what makes today survivable, and that premise is recorded in
 * `docs/hosted-standalone.md` rather than assumed.
 */

import type { Logger } from '../core/log';

// ---------------------------------------------------------------------------
// Names — the CLI surface this runner drives
// ---------------------------------------------------------------------------

/** `--executor` value for the Agent-SDK executor (E15's vendor-qualified
 *  vocabulary). The ONLY executor that can run on our hardware (E3). */
export const HOSTED_EXECUTOR = 'claude-sdk';

/**
 * Rung 3 — the variable we SET to the org's key.
 *
 * ⚠ CROSS-REPOSITORY CONSTANT. The authority is `pipeline`'s
 * `src/lib/provider-key.ts` (`PROVIDER_KEY_ENV`); this package does not depend
 * on the CLI package, so the name is mirrored rather than imported. It is also
 * the variable the Agent SDK reads directly, which is why it is stable.
 */
export const PROVIDER_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Rung 2 — the variable we UNSET.
 *
 * ⚠ CROSS-REPOSITORY CONSTANT, same authority (`PROVIDER_KEY_HELPER_ENV`), and
 * the one whose drift is dangerous: if the CLI renames its helper variable and
 * this constant is not updated, we would stop closing the rung while still
 * believing we had. `standalone.test.ts` pins the names, and
 * the mismatch is called out in `docs/hosted-standalone.md` as owed follow-up
 * (a cross-repo assertion belongs in the superproject's `tests/cross-repo/`).
 */
export const PROVIDER_KEY_HELPER_ENV = 'PIPELINE_API_KEY_HELPER';

/** What every stringification of a {@link HostedProviderCredential} yields. */
export const REDACTED = '[redacted org provider key]';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A hosted run could not be given an org provider key. NEVER carries a key, a
 * credential source's output, or an underlying error's message — a failure
 * from a secret-delivery path is exactly where a secret is most likely to be
 * quoted back (c1 discards helper output for the same reason).
 */
export class HostedCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedCredentialError';
  }
}

// ---------------------------------------------------------------------------
// The holder
// ---------------------------------------------------------------------------

/** The secret half, off-object by construction — mirrors c1's `ProviderKey`
 *  so the value is not an own property, not inherited, and not reachable from
 *  the object by any whole-object serialisation. */
const SECRETS = new WeakMap<HostedProviderCredential, string>();

/**
 * The org's provider key, in the ONE shape the runner passes around.
 *
 * Every stringification path is overridden to produce {@link REDACTED}, so a
 * credential that ends up inside a log line, a job record, an error, a wire
 * frame or a debugger dump serialises as the marker rather than as itself:
 *
 *   - `JSON.stringify(x)` at ANY nesting depth  → the marker
 *   - `` `${cred}` `` / `String(cred)`          → the marker
 *   - `console.log(cred)` / `util.inspect`      → the marker
 *
 * Read it only through {@link revealHostedProviderKey}.
 */
export class HostedProviderCredential {
  /** Where the credential came from — a LABEL, never a secret (e.g. the
   *  secret slug it was delivered under). Safe to log. */
  readonly source: string;

  constructor(source: string, secret: string) {
    const value = secret.trim();
    if (value.length === 0) {
      throw new HostedCredentialError('refusing to build an org provider credential from an empty value');
    }
    this.source = source;
    SECRETS.set(this, value);
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  /** Covers `` `${cred}` `` and `'' + cred`, which skip `toJSON`. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'HostedProviderCredential';
  }

  /** `util.inspect` / `console.log` on Node and Bun. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/**
 * THE ONE BOUNDARY. Returns the plaintext.
 *
 * Callers must pass the value straight into the sink that needs it (here: the
 * drive child's environment) and must not park it in a variable that outlives
 * the call, put it on an object, or log it.
 */
export function revealHostedProviderKey(credential: HostedProviderCredential): string {
  const secret = SECRETS.get(credential);
  if (secret === undefined) {
    throw new HostedCredentialError('not an org provider credential holder (or its value has been released)');
  }
  return secret;
}

/**
 * A safe, loggable description: the source label and the key's BYTE LENGTH.
 * This project's hard-won rule — when inspecting a secret, print the LENGTH,
 * never the content — is why this returns a byte count and nothing derived
 * from the value.
 */
export function describeHostedProviderKey(credential: HostedProviderCredential): string {
  const secret = SECRETS.get(credential);
  if (secret === undefined) return `org provider key from ${credential.source} (unavailable)`;
  return `org provider key from ${credential.source} (${Buffer.byteLength(secret, 'utf-8')} bytes)`;
}

// ---------------------------------------------------------------------------
// The credential source seam
// ---------------------------------------------------------------------------

/** What a credential source is told about the job it is resolving for. Carries
 *  the job JWT because the control plane's delivery endpoint
 *  (`POST /api/v1/secrets/deliver`) authenticates with exactly that token, and
 *  the declared slugs because only those decrypt. */
export interface ProviderCredentialRequest {
  jobId: string;
  runId: string;
  /** SECRET — the short-lived per-job token. Never log it. */
  jobJwt: string;
  /** Declared secret NAMES from the lease (never values). */
  secretSlugs: string[];
}

/**
 * Resolves the ORG's provider key for one hosted job.
 *
 * INJECTED, never defaulted: this package deliberately ships no built-in
 * implementation, because the only correct source is the control plane's
 * secrets-delivery endpoint and wiring an HTTP secret fetch is a separate,
 * separately-reviewed piece of work. A runner with no source configured is
 * simply not a hosted standalone runner — see {@link HostedStandaloneOptions}.
 *
 * Returning `null` means "this org has no key configured", which is FATAL for
 * a hosted run (see {@link resolveHostedCredential}) — never a cue to fall
 * back to anything on the machine.
 */
export type ProviderCredentialSource = (
  request: ProviderCredentialRequest,
) => Promise<HostedProviderCredential | null> | HostedProviderCredential | null;

/** Hosted-standalone configuration. Its PRESENCE on `JobExecutorOptions` is
 *  what makes a runner hosted; absent, every existing behaviour is unchanged. */
export interface HostedStandaloneOptions {
  /** Where the org's key comes from. Required — a hosted runner without one
   *  cannot run anything, and must not discover that mid-job. */
  credential: ProviderCredentialSource;
}

/**
 * Resolve the org credential, FAILING CLOSED.
 *
 * Absent, empty, or erroring — all three end the same way: a
 * {@link HostedCredentialError} and no drive process. There is no fallback
 * rung here by construction, because every fallback available on a hosted
 * machine is somebody else's credential.
 *
 * A thrown cause is swallowed rather than chained: a delivery failure's
 * message is a plausible place for a secret (or a URL carrying one) to be
 * quoted back, and c1 sets the precedent of discarding it.
 */
export async function resolveHostedCredential(
  source: ProviderCredentialSource,
  request: ProviderCredentialRequest,
): Promise<HostedProviderCredential> {
  let credential: HostedProviderCredential | null;
  try {
    credential = await source(request);
  } catch {
    throw new HostedCredentialError(
      `the org provider credential could not be resolved for job ${request.jobId}; ` +
        'the underlying error is withheld because it may quote a secret',
    );
  }
  if (credential === null || credential === undefined) {
    throw new HostedCredentialError(
      `no org provider key is configured for job ${request.jobId} — a hosted standalone run ` +
        'requires the org\'s own credential and will not fall back to anything on this machine',
    );
  }
  return credential;
}

// ---------------------------------------------------------------------------
// The hosted drive environment
// ---------------------------------------------------------------------------

/**
 * The environment OVERLAY for a hosted drive child.
 *
 * The overlay is applied by `JobExec` as `{ ...process.env, ...overlay }`, so
 * each entry is either a value that REPLACES whatever the machine had, or
 * `undefined` — which Node and Bun both omit from the child's environment
 * entirely (verified, and pinned by `standalone.test.ts`
 * against a real subprocess, because the whole guarantee rests on it).
 *
 * Two entries, and the second is the one that is easy to miss:
 *
 *   `ANTHROPIC_API_KEY`      = the org's key      — replaces any ambient value
 *   `PIPELINE_API_KEY_HELPER` = undefined         — closes the HIGHER rung
 *
 * `base` lets a caller's own overlay ride along (the runner's existing
 * `JobExecutorOptions.env`); the two provider-key entries are applied LAST and
 * are not overridable, because a caller quietly re-adding either one is the
 * bug this module exists to make impossible.
 */
export function hostedDriveEnv(
  credential: HostedProviderCredential,
  base?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...base,
    // Rung 3, set — never inherited.
    [PROVIDER_KEY_ENV]: revealHostedProviderKey(credential),
    // Rung 2, closed — a machine-configured helper outranks the org key.
    [PROVIDER_KEY_HELPER_ENV]: undefined,
  };
}

// ---------------------------------------------------------------------------
// Layer two, runner-side
// ---------------------------------------------------------------------------

/**
 * A `Logger` that replaces the credential's value with {@link REDACTED} in
 * every message.
 *
 * Defence in depth, not the primary control: the runner does not log the key,
 * the holder makes serialising it accidentally very hard, and the drive
 * child's own output is scrubbed by c2 before the runner ever sees it. This
 * covers the remaining path — text DERIVED from a child's output that the
 * runner formats into a reason string (`classifyDriveOutcome` quotes drive's
 * first stderr line into a usage-error reason, for instance).
 *
 * Mirrors the discipline `core/log.ts` already states for the runner token.
 */
export function redactingLogger(inner: Logger, credential: HostedProviderCredential): Logger {
  const secret = revealHostedProviderKey(credential);
  const scrub = (message: string): string => message.split(secret).join(REDACTED);
  return {
    debug: (message) => inner.debug(scrub(message)),
    info: (message) => inner.info(scrub(message)),
    warn: (message) => inner.warn(scrub(message)),
    error: (message) => inner.error(scrub(message)),
  };
}
