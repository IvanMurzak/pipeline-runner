/**
 * P2.5 CHAT RELAY (`pipeline-ui-v2` task `c4-runner-chat-channel`, design
 * `02-target-architecture.md` M6, `07-security.md` T7) — the runner side of
 * the run-bound chat channel.
 *
 * This class is to `chat_send`/`chat_reply` exactly what `./bridge.ts` is to
 * `needs_input`/`answer`: it owns the wire round-trip, the turn correlation,
 * the OWNERSHIP boundary and the reply stream, and it owns no subprocess
 * logic whatsoever. The session it talks into is an injectable seam
 * ({@link ChatSessionRegistry}), the same way the needs-input bridge talks to
 * an injectable {@link DriveSession}. M6's "reuses the relay bridge to the
 * runner session ... avoids a second transport" is honoured literally: the
 * frames ride the SAME `AgentClient` connection and the SAME dispatcher, and
 * the production registry (`../jobs/chat-session.ts`) delivers text through
 * the very same seam an `answer` is delivered through.
 *
 * ── CROSS-RUN DELIVERY IS IMPOSSIBLE, NOT MERELY AVOIDED (07 T7) ────────────
 * The design constraint is that no chat message may ever be routed into a
 * session other than the one its `run_id` names — "chat must not steer an
 * executor beyond the owner's intent". That is enforced by the SHAPE of the
 * seam, not by a correctly-written call:
 *
 *   1. {@link ChatSessionHandle.deliver} takes `(message, replies)` and NO
 *      run id. There is therefore no expression anywhere in this codebase
 *      that names a destination run independently of the handle it is
 *      calling — the mistake is not available to make. A future edit that
 *      tries to reintroduce one does not typecheck.
 *   2. The only way to obtain a handle is {@link ChatSessionRegistry.lookup},
 *      keyed on the inbound frame's `run_id`, which returns null (never a
 *      nearest match, never a fallback) for a run this runner does not own.
 *   3. The reply's `run_id` is stamped from `handle.runId` — the SESSION's own
 *      identity — never from the inbound frame. A reply therefore names the
 *      session that actually produced it.
 *   4. Because (3) could otherwise let a buggy registry answer one run's send
 *      from another run's session, `handle.runId !== frame.run_id` is treated
 *      as a registry defect and rejected as `not_owned`. Steps 1-3 make the
 *      hazard unreachable through the type system; step 4 makes it unreachable
 *      even through a broken implementation of the port.
 *
 * `sent_by` is display/audit metadata the cloud stamps and is never consulted
 * here; the frame carries no authz claim at all. Authorization proper is
 * enforced cloud-side (task d6) on the identical path `needs_input.answer`
 * uses — this runner-side ownership check is an independent second gate, not
 * the first one.
 *
 * ── SILENCE IS NOT A REJECTION (a3 review B2) ───────────────────────────────
 * Every rejection is a `chat_reply` with `done:true` and a populated `error`.
 * There is exactly ONE case in which this relay stays silent: an inbound
 * frame from which `(run_id, message_id)` cannot be recovered even
 * tolerantly, because a `chat_reply` has nowhere to point. Everything else —
 * non-owned run, dead/unavailable session, oversized text, schema failure, a
 * session implementation that throws — terminates the turn with a frame.
 *
 * ── REDELIVERY (F7) ────────────────────────────────────────────────────────
 * `(run_id, message_id)` is the idempotency key. A repeat is NEVER injected
 * into the session a second time — a double-injected instruction is precisely
 * the "steer an executor beyond the owner's intent" hazard. A repeat of a
 * turn that already TERMINATED replays that turn's stored terminal frame
 * verbatim (so a reply lost to a socket flap does not leave the turn hanging
 * forever cloud-side); a repeat of a turn still IN FLIGHT is dropped, because
 * its terminal frame is still coming.
 *
 * ── LOGGING (the c2 discipline) ────────────────────────────────────────────
 * Never quote a message payload, a rejected value, or `sent_by` into a log
 * line. Ids and codes only — `run_id`, `message_id` and the error `code` say
 * everything an operator needs, and the payload is exactly what the ownership
 * check exists to protect.
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
import type { RelayClientPort } from './bridge';
import {
  buildChatReplyFrame,
  CHAT_ERROR_CODES,
  isOversizedChatMessage,
  parseChatSend,
  readChatTurnIdentity,
  type ChatErrorCode,
  type ChatReplyMessage,
  type ChatTurnIdentity,
} from './chat-wire';

/**
 * The reply channel for ONE turn of ONE session, handed to
 * {@link ChatSessionHandle.deliver}.
 *
 * It carries no run id and no message id: both are closed over by the relay
 * from the handle it looked up and the turn it is servicing. A session
 * implementation therefore cannot mis-address its own reply — see the
 * module doc's cross-run argument, of which this is half.
 */
export interface ChatReplySink {
  /** Emit a non-final chunk (`done:false`). More must follow. */
  chunk(text: string): void;
  /** Emit the final chunk (`done:true`) and close the turn successfully.
   *  `text` defaults to empty — a legal completion sentinel. */
  done(text?: string): void;
  /** Terminate the turn with a failure (`done:true` + `error`). `partialText`
   *  is whatever content the session managed before failing. */
  fail(code: ChatErrorCode, message: string, partialText?: string): void;
  /** True once a `done`/`fail` has closed this turn. */
  readonly settled: boolean;
}

/**
 * A live executor session, ALREADY BOUND to its run. Obtained only from
 * {@link ChatSessionRegistry.lookup}.
 */
export interface ChatSessionHandle {
  /** The run this session belongs to — the sole source of a reply's run
   *  binding. */
  readonly runId: string;
  /**
   * Deliver one chat turn's text into this session and stream the reply back
   * through `replies`. Note the absent run id: the destination is `this`.
   *
   * Must terminate the turn (`replies.done()` or `replies.fail()`) on every
   * path. A throw or a rejected promise is caught by the relay and turned
   * into an `internal_error` terminal frame, so a buggy session degrades to a
   * visible failure rather than a hung turn.
   */
  deliver(message: string, replies: ChatReplySink): void | Promise<void>;
}

/**
 * THE OWNERSHIP BOUNDARY (07 T7). Resolves a run id to a session this runner
 * actually owns, or null.
 *
 * "Owns" means a live executor session on THIS runner for THAT run — not "a
 * run we have heard of", not "a record on disk". Returning a handle is the
 * single act that authorizes delivery; there is no other door into a session
 * on this path.
 */
export interface ChatSessionRegistry {
  lookup(runId: string): ChatSessionHandle | null;
}

export interface ChatRelayOptions {
  /** The agent connection — same port the needs-input bridge uses (M6: one
   *  transport, not two). */
  client: RelayClientPort;
  sessions: ChatSessionRegistry;
  /** ISO-8601 stamp factory for outbound `ts` (injectable for deterministic
   *  tests). Display metadata only — never a sort key. */
  now?: () => string;
  /** How many settled turns to remember for redelivery replay. Bounded so a
   *  long-lived daemon cannot grow this map without limit. */
  maxRememberedTurns?: number;
  logger?: Logger;
}

export const DEFAULT_MAX_REMEMBERED_TURNS = 256;

/** Composite key over (run_id, message_id) — JSON-encoded so neither field's
 *  contents can be mistaken for the separator (mirrors `./bridge.ts`). */
function keyOf(runId: string, messageId: string): string {
  return JSON.stringify([runId, messageId]);
}

interface TurnState {
  /** The terminal frame already emitted for this turn, or null while the turn
   *  is still streaming. A redelivery replays this. */
  terminal: ChatReplyMessage | null;
}

export class ChatRelay {
  private readonly client: RelayClientPort;
  private readonly sessions: ChatSessionRegistry;
  private readonly now: () => string;
  private readonly maxRememberedTurns: number;
  private readonly logger: Logger;
  /** Turn state keyed by (run_id, message_id). Insertion-ordered, so the
   *  oldest entry is the first key — that is the eviction order. */
  private readonly turns = new Map<string, TurnState>();
  private unsubscribe: (() => void) | null;

  constructor(options: ChatRelayOptions) {
    this.client = options.client;
    this.sessions = options.sessions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxRememberedTurns = options.maxRememberedTurns ?? DEFAULT_MAX_REMEMBERED_TURNS;
    this.logger = options.logger ?? nullLogger;
    this.unsubscribe = this.client.dispatcher.on('chat_send', (frame) => this.onChatSend(frame));
  }

  /** Detach the inbound `chat_send` handler. Idempotent. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Turns currently remembered (in flight + settled-and-replayable). */
  get trackedTurns(): number {
    return this.turns.size;
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  private onChatSend(frame: WireFrame): void {
    // 1. TOLERANT identity read FIRST. Without (run_id, message_id) there is
    //    no frame to reject with, and this is the only silent path.
    const turn = readChatTurnIdentity(frame);
    if (turn === null) {
      this.logger.warn('malformed chat_send ignored — no (run_id, message_id) to bind a chat_reply to');
      return;
    }

    // 2. REDELIVERY (F7): never a second injection.
    const key = keyOf(turn.runId, turn.messageId);
    const known = this.turns.get(key);
    if (known !== undefined) {
      if (known.terminal !== null) {
        this.client.send(known.terminal);
        this.logger.info(
          `chat_send for run ${turn.runId} message ${turn.messageId} is a redelivery of a settled turn — ` +
            'terminal reply replayed, not re-injected'
        );
      } else {
        this.logger.info(
          `chat_send for run ${turn.runId} message ${turn.messageId} is a redelivery of an in-flight turn — dropped`
        );
      }
      return;
    }

    // 3. THE OWNERSHIP BOUNDARY (07 T7) — before the payload parse, before any
    //    session is touched, and before anything about this frame beyond its
    //    turn identity is acted on.
    const session = this.sessions.lookup(turn.runId);
    if (session === null || session.runId !== turn.runId) {
      // The `session.runId !== turn.runId` half is a registry-defect guard:
      // reachable only through a broken ChatSessionRegistry implementation,
      // never through this relay's own routing (see the module doc). The
      // rejection is bound to the run the FRAME named — there is no session
      // whose identity could be used instead, and that is the whole point.
      const rejected = this.openSink(turn.runId, turn);
      this.remember(key, rejected.state);
      rejected.sink.fail(CHAT_ERROR_CODES.notOwned, 'this runner owns no live executor session for that run');
      return;
    }

    // From here the destination is `session`, whose run id is authoritative
    // for every outbound frame of this turn.
    const sink = this.openSink(session.runId, turn);
    this.remember(key, sink.state);

    // 4. STRICT parse — the only source of deliverable text.
    const parsed = parseChatSend(frame);
    if (parsed === null) {
      const oversized = isOversizedChatMessage(frame);
      sink.sink.fail(
        oversized ? CHAT_ERROR_CODES.messageTooLarge : CHAT_ERROR_CODES.invalidMessage,
        oversized
          ? 'chat message exceeded the wire limit for a single turn'
          : 'chat_send failed the protocol schema and was not delivered'
      );
      return;
    }

    // 5. Deliver. Nothing about the frame reaches the session except its text.
    this.logger.info(`chat_send routed for run ${session.runId} message ${turn.messageId}`);
    try {
      const result = session.deliver(parsed.message, sink.sink);
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => this.onSessionFailure(sink.sink, turn, err));
      }
    } catch (err) {
      this.onSessionFailure(sink.sink, turn, err);
    }
  }

  private onSessionFailure(sink: ChatReplySink, turn: ChatTurnIdentity, err: unknown): void {
    // The session's own message is runner-internal prose, not user payload —
    // safe to log and to carry on the error frame.
    const detail = err instanceof Error ? err.message : String(err);
    this.logger.error(`chat delivery for run ${turn.runId} message ${turn.messageId} failed: ${detail}`);
    if (!sink.settled) sink.fail(CHAT_ERROR_CODES.internalError, `chat delivery failed: ${detail}`);
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Open a reply sink bound to `runId` (the SESSION's id) and this turn. The
   * binding is captured here and is not a parameter of anything the session
   * can call.
   */
  private openSink(runId: string, turn: ChatTurnIdentity): { sink: ChatReplySink; state: TurnState } {
    const state: TurnState = { terminal: null };
    let settled = false;
    const emit = (message: string, done: boolean, error?: { code: ChatErrorCode; message: string }): void => {
      const frame = buildChatReplyFrame({
        runId,
        messageId: turn.messageId,
        message,
        done,
        ts: this.now(),
        ...(turn.envelopeId === undefined ? {} : { envelopeId: turn.envelopeId }),
        ...(error === undefined ? {} : { error }),
      });
      if (done) {
        settled = true;
        state.terminal = frame;
      }
      if (!this.client.send(frame)) {
        // OFFLINE. Unlike a `needs_input` (which the cloud durably parked and
        // the bridge resurfaces on reconnect), a chat turn is EPHEMERAL: the
        // cloud's F7 202-queue is the retry mechanism, and it will redeliver
        // the `chat_send` — at which point step 2 above replays this stored
        // terminal frame. Nothing is retried from here.
        this.logger.warn(
          `chat_reply for run ${runId} message ${turn.messageId} not delivered (offline) — ` +
            'awaiting the cloud redelivery of the send'
        );
      }
    };
    const sink: ChatReplySink = {
      get settled() {
        return settled;
      },
      chunk: (text: string): void => {
        if (settled) {
          this.logger.warn(`chat_reply chunk for run ${runId} message ${turn.messageId} arrived after the turn closed — dropped`);
          return;
        }
        emit(text, false);
      },
      done: (text = ''): void => {
        if (settled) {
          this.logger.warn(`chat_reply completion for run ${runId} message ${turn.messageId} arrived twice — dropped`);
          return;
        }
        emit(text, true);
      },
      fail: (code: ChatErrorCode, message: string, partialText = ''): void => {
        if (settled) {
          this.logger.warn(`chat_reply failure for run ${runId} message ${turn.messageId} arrived after the turn closed — dropped`);
          return;
        }
        // Code only — never the message payload or the rejected value (c2).
        this.logger.info(`chat turn for run ${runId} message ${turn.messageId} terminated with ${code}`);
        emit(partialText, true, { code, message });
      },
    };
    return { sink, state };
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────

  private remember(key: string, state: TurnState): void {
    this.turns.set(key, state);
    while (this.turns.size > this.maxRememberedTurns) {
      const oldest = this.turns.keys().next();
      if (oldest.done === true) break;
      this.turns.delete(oldest.value);
    }
  }
}
