/**
 * The PRODUCTION chat-session registry (`pipeline-ui-v2` task
 * `c4-runner-chat-channel`) — the implementation of
 * `../relay/chat.ts`'s {@link ChatSessionRegistry} port that resolves a
 * `chat_send`'s `run_id` against the jobs this runner is actually executing.
 *
 * It sits between two layers that must not know about each other: the relay
 * knows frames and turns and nothing about leases; the job manager knows
 * leases and executors and nothing about chat. Both dependencies here are
 * NARROW STRUCTURAL PORTS ({@link JobSessionSource},
 * {@link ChatDeliveryPort}), so this module is the only place the two meet.
 *
 * ── WHAT "OWNS" MEANS (07 T7) ───────────────────────────────────────────────
 * A run is owned iff this runner holds a LIVE ACTIVE EXECUTOR for it —
 * `JobManager.activeSession(runId)`. Deliberately excluded:
 *
 *   - QUARANTINED records (`../jobs/manager.ts`): a crash leftover whose lease
 *     has already expired server-side. Nothing is executing, so there is no
 *     session for a message to land in; treating one as owned would mean
 *     accepting a message into a run this runner may be about to lose to
 *     another machine.
 *   - Records on disk generally. Ownership is a fact about the running
 *     process, not about the filesystem.
 *
 * A miss returns null and the relay answers `not_owned`. There is no nearest
 * match, no prefix match and no fallback — the lookup is exact-id or nothing.
 *
 * ── HOW THE TEXT REACHES THE SESSION (M6: no second transport) ──────────────
 * Through the SAME seam an `answer` uses. A run parked awaiting input has a
 * pending question in the needs-input bridge (`../relay/bridge.ts`); this
 * registry resolves that pending entry with the chat text, which the bridge
 * hands to its `DriveSession` — in production the `PullRelayAdapter`, which
 * resolves the executor's inline `await` and lets `pipeline drive` re-enter
 * with the text as its `--answer`. That is precisely "delivered the same way
 * answers are delivered today"; chat introduces no second path into a
 * session, no second transport, and no new subprocess mode.
 *
 * ── THE APPROVAL-GATE REFUSAL (07 T2 + T7) ─────────────────────────────────
 * Because the delivery path IS the answer path, a chat message to a run
 * parked on an APPROVAL-GATED question would satisfy that gate. The gate's
 * whole purpose is that a specific role must approve (`required_role`, c2),
 * and chat authorization (d6) is the answer-path check, not the gate's
 * role check. Delivering there would let a chat turn clear an approval the
 * sender may not hold — the exact "steer an executor beyond the owner's
 * intent" hazard T7 names. So a gated park REFUSES chat.
 *
 * That refusal is FAIL-CLOSED in the direction that matters here: a park
 * whose `approval` marker is present but MALFORMED still refuses. Note this
 * is the opposite polarity to `../relay/wire-relay.ts`'s
 * `validateQuestionApproval`, where fail-closed means "ship it as an ordinary
 * question, no gate". Both are conservative for their own consumer: there,
 * an unvalidated marker must not become a gate the CLOUD trusts; here, an
 * unrecognizable marker must not become an opening the CHAT channel walks
 * through. Same principle, different safe direction — and worth stating,
 * because the two rules look contradictory if read side by side without it.
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { ChatReplySink, ChatSessionHandle, ChatSessionRegistry } from '../relay/chat';
import { CHAT_ERROR_CODES } from '../relay/chat-wire';

/**
 * The chat channel's view of ONE live executor. Structural on purpose — a
 * `JobExecutor` (`./executor.ts`) satisfies it as-is, and a test can satisfy
 * it with an object literal.
 */
export interface ChatCapableSession {
  readonly runId: string;
  /** The question this session is currently parked on, or null when it is
   *  not awaiting input. See `JobExecutor.chatTarget`. */
  readonly chatTarget: ChatTarget | null;
}

/** Where in a parked session a chat turn would land. */
export interface ChatTarget {
  questionId: string;
  /** True when the park carries an approval marker of ANY shape — see the
   *  module doc's fail-closed note. */
  approvalGated: boolean;
}

/** The job manager's ownership lookup (`JobManager.activeSession`). */
export interface JobSessionSource {
  activeSession(runId: string): ChatCapableSession | null;
}

/**
 * The needs-input bridge's text-delivery seam (`../relay/bridge.ts`'s
 * `NeedsInputRelay.deliverPending`). Returns false when the named question is
 * no longer pending — the race guard for a park resolved by a real `answer`
 * between this registry's lookup and its delivery.
 */
export interface ChatDeliveryPort {
  deliverPending(runId: string, questionId: string, text: string): boolean;
}

export interface JobChatRegistryOptions {
  jobs: JobSessionSource;
  delivery: ChatDeliveryPort;
  logger?: Logger;
}

/**
 * Build the production {@link ChatSessionRegistry}.
 *
 * Note what the returned handle does NOT expose: `deliver(message, replies)`
 * has no run parameter, so the `session.runId` captured below is the only run
 * this handle can ever address. That is the type-level half of the
 * cross-run-impossibility argument in `../relay/chat.ts`'s module doc; this
 * function is where the closure that makes it true is created.
 */
export function jobChatRegistry(options: JobChatRegistryOptions): ChatSessionRegistry {
  const logger = options.logger ?? nullLogger;
  return {
    lookup(runId: string): ChatSessionHandle | null {
      const session = options.jobs.activeSession(runId);
      if (session === null) {
        logger.info(`chat_send for run ${runId} — no live executor session on this runner`);
        return null;
      }
      if (session.runId !== runId) {
        // Unreachable through `JobManager.activeSession` (it matches on
        // exact run id); kept because "the lookup returned the wrong
        // session" must be a refusal, never a delivery.
        logger.error(`chat session lookup for run ${runId} returned a session for a different run — refusing`);
        return null;
      }
      return {
        runId: session.runId,
        deliver(message: string, replies: ChatReplySink): void {
          const target = session.chatTarget;
          if (target === null) {
            replies.fail(
              CHAT_ERROR_CODES.sessionUnavailable,
              "the run's executor session is not awaiting input; a chat turn can only be delivered to a parked session"
            );
            return;
          }
          if (target.approvalGated) {
            replies.fail(
              CHAT_ERROR_CODES.sessionUnavailable,
              'the run is parked on an approval-gated question — it must be answered through the approval path, not chat'
            );
            return;
          }
          // The run id handed to the delivery port is the SESSION's, closed
          // over above — never a value read off the inbound frame.
          if (!options.delivery.deliverPending(session.runId, target.questionId, message)) {
            replies.fail(
              CHAT_ERROR_CODES.sessionUnavailable,
              'the session resolved its pending question before the chat message could be delivered'
            );
            return;
          }
          // The turn terminates with no content: this runner has no way to
          // stream the session's own prose back over `chat_reply` (the
          // executor's output reaches the cloud on the existing event
          // channel), so a truthful completion is an empty final chunk
          // rather than invented text. The streaming half of the sink
          // (`replies.chunk`) is fully wired for a session that can.
          replies.done();
        },
      };
    },
  };
}
