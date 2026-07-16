/**
 * Needs-input RELAY BRIDGE (T1-13).
 *
 * When a job's `pipeline drive` run parks on a question (exit 4, an
 * `awaiting_input` journal record + a final JSON carrying the question), the
 * runner must (1) surface that question UP to the control plane as a
 * `needs_input` frame, and (2) when the control plane sends the matching
 * `answer` frame back DOWN, feed the answer text into `drive`'s resume path so
 * the SAME claude session continues (`pipeline drive --resume --start
 * <same-iteration> --answer "<text>"`).
 *
 * This bridge owns ONLY the wire round-trip + correlation. It is deliberately
 * pure of subprocess logic: the lease->execute loop that actually spawns
 * `pipeline drive` is a LATER task, so the drive side is an injectable seam
 * ({@link DriveSession}). The relay:
 *
 *   surface(q)  -> build a `needs_input` frame (correlation `id`), record it
 *                 PENDING keyed by (run_id, question_id), and send it. Sending
 *                 goes through {@link RelayClientPort.send}, which returns false
 *                 when the agent is OFFLINE — the frame is not lost (drive
 *                 journalled the park as `awaiting_input`); it stays pending and
 *                 `resurfacePending()` re-sends it on reconnect.
 *
 *   on `answer` -> validated against the pending set: an answer whose
 *                 (run_id, question_id) matches no pending question — STALE /
 *                 SUPERSEDED, CROSS-RUN, or a DUPLICATE of an already-resolved
 *                 one — is ignored (no double-resume); a correlation-`id`
 *                 mismatch is ignored. A good match resolves the pending entry
 *                 (removed BEFORE delivery, so a duplicate finds nothing) and
 *                 hands the answer text to {@link DriveSession.resumeWithAnswer}.
 *
 * Secrets discipline: the runner never logs the answer TEXT or the answer
 * AUTHOR (`answered_by`) — only `run_id` + `question_id`, which are safe
 * correlation ids. All I/O (the client port, id generation) is injectable; the
 * relay never touches a real socket or clock directly.
 */

import type { WireFrame } from '../core/wire';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import {
  buildNeedsInputFrame,
  parseAnswerDelivery,
  type NeedsInputMessage,
  type RelayQuestion,
} from './wire-relay';

/**
 * The narrow port the relay needs over the agent CORE. An `AgentClient`
 * (`../core/connection`) satisfies it directly: its additive `send()` (returns
 * false when not `online`) and its public `dispatcher`.
 */
export interface RelayClientPort {
  /** Send a frame; true iff a live online connection accepted it. */
  send(frame: WireFrame): boolean;
  /** Inbound routing: attach the `answer` handler. Returns an unsubscribe fn. */
  readonly dispatcher: {
    on(type: string, handler: (frame: WireFrame) => void): () => void;
  };
}

/**
 * The DRIVE-SESSION SEAM the (future) lease->execute loop implements. The relay
 * calls it to feed a delivered answer back into `drive`'s resume path; the
 * implementation re-invokes `pipeline drive --resume --start <same-iteration>
 * --answer "<answerText>"` for the parked run. Injectable so tests use a mock
 * and the relay stays free of subprocess logic. May be sync or async — a
 * rejected promise is logged, never thrown into the dispatch loop.
 */
export interface DriveSession {
  resumeWithAnswer(runId: string, questionId: string, answerText: string): void | Promise<void>;
}

/** The parked-question input to {@link NeedsInputRelay.surface}. The executor
 *  derives it from `drive`'s awaiting-input JSON (`run_id` + the assigned
 *  `question_id` + the `{text,context,options}` question). */
export interface SurfacedQuestion {
  run_id: string;
  question_id: string;
  question: RelayQuestion;
}

/** The result of {@link NeedsInputRelay.surface}. */
export interface SurfaceResult {
  /** The envelope correlation id carried on the `needs_input` frame (stable per
   *  (run_id, question_id) — a re-surface reuses it). */
  id: string;
  /** True iff a live online connection accepted the frame. False = OFFLINE:
   *  the question stays pending and `resurfacePending()` re-sends it on
   *  reconnect (not lost — drive journalled it as `awaiting_input`). */
  delivered: boolean;
}

export interface NeedsInputRelayOptions {
  client: RelayClientPort;
  drive: DriveSession;
  /** Correlation-id factory (injectable for deterministic tests). */
  makeId?: () => string;
  logger?: Logger;
}

interface PendingQuestion {
  runId: string;
  questionId: string;
  /** The correlation id on the `needs_input` frame; the `answer` echoes it. */
  id: string;
  /** The exact frame sent — stored so `resurfacePending()` re-sends it verbatim. */
  frame: NeedsInputMessage;
}

/** Composite key over (run_id, question_id) — JSON-encoded so neither field's
 *  contents can be mistaken for the separator. */
function keyOf(runId: string, questionId: string): string {
  return JSON.stringify([runId, questionId]);
}

export class NeedsInputRelay {
  private readonly client: RelayClientPort;
  private readonly drive: DriveSession;
  private readonly makeId: () => string;
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingQuestion>();
  private unsubscribe: (() => void) | null;

  constructor(options: NeedsInputRelayOptions) {
    this.client = options.client;
    this.drive = options.drive;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
    this.logger = options.logger ?? nullLogger;
    // Route inbound `answer` frames through this relay. Attached to the SAME
    // dispatcher the connection feeds (the T1-13 hook the dispatcher reserved).
    this.unsubscribe = this.client.dispatcher.on('answer', (frame) => this.onAnswer(frame));
  }

  /** Number of questions awaiting an answer. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** True while (run_id, question_id) is still awaiting an answer. */
  hasPending(runId: string, questionId: string): boolean {
    return this.pending.has(keyOf(runId, questionId));
  }

  /**
   * Surface a parked question: record it pending and send its `needs_input`
   * frame. Idempotent — re-surfacing the SAME (run_id, question_id) reuses the
   * stored correlation id + frame and just re-sends (so an offline question can
   * be retried without a new identity). Returns whether the live channel
   * accepted it.
   */
  surface(q: SurfacedQuestion): SurfaceResult {
    const key = keyOf(q.run_id, q.question_id);
    const existing = this.pending.get(key);
    const id = existing?.id ?? this.makeId();
    const frame = existing?.frame ?? buildNeedsInputFrame(q.run_id, q.question_id, q.question, id);
    this.pending.set(key, { runId: q.run_id, questionId: q.question_id, id, frame });

    const delivered = this.client.send(frame);
    if (delivered) {
      this.logger.info(`needs_input surfaced for run ${q.run_id} question ${q.question_id}`);
    } else {
      // OFFLINE: not lost (drive journalled the park). Stays pending for
      // resurfacePending() on reconnect.
      this.logger.warn(
        `needs_input for run ${q.run_id} question ${q.question_id} not delivered (offline) — queued; will resurface on reconnect`
      );
    }
    return { id, delivered };
  }

  /**
   * RECONNECT SEAM: re-send every still-pending `needs_input` frame. The
   * (future) executor wires this to the client's `onOnline` event so questions
   * surfaced while offline reach the control plane once the socket is back.
   * Returns how many were accepted by the live channel.
   */
  resurfacePending(): number {
    let delivered = 0;
    for (const p of this.pending.values()) {
      if (this.client.send(p.frame)) delivered += 1;
    }
    if (this.pending.size > 0) {
      this.logger.info(`resurfaced ${delivered}/${this.pending.size} pending question(s) after reconnect`);
    }
    return delivered;
  }

  /** Detach the inbound `answer` handler. Idempotent. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -- Inbound -----------------------------------------------------------------

  private onAnswer(frame: WireFrame): void {
    const parsed = parseAnswerDelivery(frame);
    if (parsed === null) {
      this.logger.warn('malformed answer frame ignored');
      return;
    }
    const runId = parsed.answer.run_id;
    const questionId = parsed.answer.question_id;
    const answerText = parsed.answer.answer;
    const key = keyOf(runId, questionId);
    const pending = this.pending.get(key);

    if (pending === undefined) {
      // No pending match: STALE / SUPERSEDED question_id, CROSS-RUN answer, or a
      // DUPLICATE of an already-resolved one. Never resume.
      this.logger.info(`answer for run ${runId} question ${questionId} matches no pending question — ignored`);
      return;
    }
    if (parsed.id !== undefined && parsed.id !== pending.id) {
      // Correlation id echoed but does not match the frame we sent — treat as a
      // mis-routed / stale echo and ignore (the pending question stays open).
      this.logger.warn(`answer for run ${runId} question ${questionId} correlation id mismatch — ignored`);
      return;
    }

    // Resolve exactly once: remove BEFORE delivery so a duplicate answer racing
    // behind this one finds nothing pending (no double-resume).
    this.pending.delete(key);
    this.logger.info(`answer routed for run ${runId} question ${questionId}`);
    this.deliver(runId, questionId, answerText);
  }

  private deliver(runId: string, questionId: string, answerText: string): void {
    try {
      const result = this.drive.resumeWithAnswer(runId, questionId, answerText);
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => {
          this.logger.error(`drive resume for run ${runId} question ${questionId} failed: ${errMessage(err)}`);
        });
      }
    } catch (err) {
      this.logger.error(`drive resume for run ${runId} question ${questionId} threw: ${errMessage(err)}`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
