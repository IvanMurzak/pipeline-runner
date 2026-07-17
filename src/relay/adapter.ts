/**
 * Pull -> push adapter (T1-13 / c3): reconciles the executor's SYNCHRONOUS
 * PULL needs-input seam (`../jobs/executor.ts` `NeedsInputRelay.onQuestion`,
 * awaited inline at `executor.ts:377`) with the WSS relay bridge's
 * ASYNCHRONOUS PUSH seam (`./bridge.ts` `NeedsInputRelay.surface` +
 * `DriveSession.resumeWithAnswer`) — the "two incompatible shapes, neither
 * wired" gap `01-current-architecture.md` §1.5 documents as E3.
 *
 * Wiring (see `../cli.ts`):
 *
 *   const adapter = new PullRelayAdapter({ logger });
 *   const bridge = new NeedsInputRelay({ client, drive: adapter, logger });
 *   adapter.attach(bridge);
 *
 * Two-phase construction is required because the two objects reference each
 * other: the bridge's constructor takes its `DriveSession` (this adapter) as
 * an option, so the adapter cannot receive a fully-built bridge until AFTER
 * the bridge exists. `attach()` closes that loop; `cli.ts` calls it once,
 * synchronously, before `client.start()` — no lease can arrive before then.
 *
 * How it works:
 *   - The executor calls `onQuestion(parked)` and awaits the returned
 *     Promise. This adapter records a `resolve` callback keyed by
 *     `(run_id, question_id)` and calls `bridge.surface(...)` to send the
 *     `needs_input` frame — mirroring `NeedsInputRelay.surface`'s own
 *     pending-question bookkeeping, but on the PULL side.
 *   - When the bridge's `answer` frame handling resolves a pending question,
 *     it calls `resumeWithAnswer(runId, questionId, answerText)` on its
 *     `DriveSession` (this adapter, per the constructor above) INSTEAD OF
 *     re-invoking `pipeline drive` itself. This adapter resolves the
 *     matching pending Promise with the answer text — which is exactly the
 *     value the executor's inline `await` needed to continue its OWN drive
 *     loop with `mode = { kind: 'answer', ... }` (`executor.ts:389`). There
 *     is exactly ONE re-invoker of drive: the executor. The bridge's
 *     `DriveSession.resumeWithAnswer` re-invocation path stays exactly as
 *     written for the bridge's own standalone-mode tests (`tests/relay.test.ts`)
 *     — this adapter is simply a DIFFERENT implementation of that same seam.
 *
 * Once-only delivery: NOT reimplemented here — inherited from the bridge.
 * `NeedsInputRelay.onAnswer` (bridge.ts) deletes the pending entry BEFORE
 * calling `resumeWithAnswer` (bridge.ts ~line 224), so a stale/duplicate/
 * cross-run answer for an already-resolved (run_id, question_id) never
 * reaches this adapter at all. The `pending.delete` guard in
 * `resumeWithAnswer` below is purely defensive (an unexpected direct call
 * outside the bridge, or a future re-wiring) — it is not load-bearing for
 * the once-only guarantee, which is bridge.ts's contract.
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { NeedsInputRelay as ExecutorNeedsInputRelay, ParkedQuestion } from '../jobs/executor';
import type { DriveSession, SurfacedQuestion, SurfaceResult } from './bridge';

/** The narrow slice of the bridge (`NeedsInputRelay`, ./bridge.ts) this
 *  adapter needs — just enough to surface a question. Kept narrow (rather
 *  than importing the whole class) so tests can inject a minimal fake. */
export interface BridgeSurfacer {
  surface(q: SurfacedQuestion): SurfaceResult;
}

export interface PullRelayAdapterOptions {
  /** The bridge to surface through. May be supplied here OR via `attach()`
   *  after construction (the two-phase pattern the module doc describes) —
   *  whichever fits the construction order at the call site. */
  bridge?: BridgeSurfacer;
  logger?: Logger;
}

interface PendingAnswer {
  resolve(answer: string | null): void;
}

/** Composite key over (run_id, question_id) — mirrors bridge.ts's `keyOf`
 *  (not exported there; re-derived identically here — JSON-encoded so
 *  neither field's contents can be mistaken for a separator). */
function keyOf(runId: string, questionId: string): string {
  return JSON.stringify([runId, questionId]);
}

export class PullRelayAdapter implements ExecutorNeedsInputRelay, DriveSession {
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingAnswer>();
  private bridge: BridgeSurfacer | null;

  constructor(options: PullRelayAdapterOptions = {}) {
    this.bridge = options.bridge ?? null;
    this.logger = options.logger ?? nullLogger;
  }

  /** Wire the bridge to surface through (see the module doc's two-phase
   *  construction note). Idempotent — a later call just replaces the
   *  target. */
  attach(bridge: BridgeSurfacer): void {
    this.bridge = bridge;
  }

  /** The executor's PULL seam (`../jobs/executor.ts` `NeedsInputRelay`):
   *  surface the parked question through the bridge and resolve when
   *  `resumeWithAnswer` below delivers the matching answer. Never rejects —
   *  a mis-wired adapter (no bridge attached) resolves `null`, which the
   *  executor treats as "no answer available" and fails the job with its
   *  existing actionable reason, rather than hanging forever. */
  onQuestion(parked: ParkedQuestion): Promise<string | null> {
    const bridge = this.bridge;
    if (bridge === null) {
      this.logger.error(
        `needs-input relay adapter has no bridge attached — question ${parked.question_id} on run ${parked.run_id} cannot be surfaced`
      );
      return Promise.resolve(null);
    }
    const key = keyOf(parked.run_id, parked.question_id);
    if (this.pending.has(key)) {
      // Defensive: onQuestion is documented as one-outstanding-await-per-key
      // (the executor's drive loop is sequential — it never asks a second
      // question on the same run before the first resolves). A second
      // firing for the same key would otherwise leak the earlier Promise
      // forever; replacing it at least keeps a single live waiter.
      this.logger.warn(`needs-input relay: question ${parked.question_id} on run ${parked.run_id} already pending — replacing`);
    }
    return new Promise<string | null>((resolve) => {
      this.pending.set(key, { resolve });
      bridge.surface({
        run_id: parked.run_id,
        question_id: parked.question_id,
        question: parked.question,
      });
    });
  }

  /** The bridge's PUSH delivery seam (`./bridge.ts` `DriveSession`):
   *  resolves the matching pending `onQuestion` await with the answer text,
   *  instead of the bridge re-invoking `pipeline drive` itself. Fires at
   *  most once per (run_id, question_id) — see the module doc. */
  resumeWithAnswer(runId: string, questionId: string, answerText: string): void {
    const key = keyOf(runId, questionId);
    const waiter = this.pending.get(key);
    if (waiter === undefined) {
      // Purely defensive (see module doc) — the bridge never double-delivers
      // for a question this adapter surfaced.
      this.logger.warn(`needs-input relay: answer delivered for run ${runId} question ${questionId} but no pull await is pending`);
      return;
    }
    this.pending.delete(key);
    waiter.resolve(answerText);
  }
}
