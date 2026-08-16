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
 * ── WHY THAT MEMORY IS THREE STORES AND NOT ONE (review B1) ────────────────
 * The dedupe guarantee is only as strong as the memory behind it, and a
 * single insertion-ordered map with one global budget is not strong at all:
 * every frame that arrives — including one this runner refuses outright —
 * costs a slot, so anyone able to send `chat_send` frames can flush the
 * replay memory for free. Once a delivered turn's entry has been evicted, an
 * at-least-once F7 redelivery of that `message_id` is indistinguishable from
 * a brand-new turn and gets INJECTED A SECOND TIME — into whatever question
 * the session is parked on *now*, which is not the one the text was written
 * for. A reply meant for "which region?" becoming the answer to "delete the
 * old production bucket?" is a single eviction away. So the budget is split
 * by how much a turn COST TO CREATE:
 *
 *   {@link inFlight} — turns being serviced right now. NEVER evicted, because
 *     evicting one voids both halves of the guarantee at once (no stored
 *     terminal to replay, and no in-flight marker to drop a repeat against).
 *     It is bounded by ADMISSION instead: at the cap, a NEW turn is refused
 *     with `too_many_turns` rather than an accepted one being forgotten.
 *
 *   {@link settled} — terminal frames of turns that actually REACHED a
 *     session, bucketed BY RUN. Per-run bucketing is the point: one run's
 *     traffic cannot evict another run's history, so there is no global flush.
 *     Filling a bucket requires getting that many turns genuinely delivered
 *     into runs this runner owns — which needs a lease, not just a socket.
 *
 *   {@link rejected} — turns refused before any session was touched
 *     (`not_owned`, `too_many_turns`). Separate small budget, and losing an
 *     entry here is SAFE rather than merely cheap: re-processing a forgotten
 *     rejection re-runs the ownership check and produces the same refusal,
 *     injecting nothing. That asymmetry — a forgotten rejection is
 *     re-derivable, a forgotten delivery is not — is the whole reason these
 *     two may not share a budget.
 *
 * Residual, stated plainly: the number of per-run buckets is itself capped,
 * so a runner that has executed more than {@link DEFAULT_MAX_REMEMBERED_RUNS}
 * runs forgets its oldest run's history. Reaching that requires actually
 * leasing and running that many jobs, and those runs are long finished —
 * `activeSession` returns null for them, so a late redelivery is refused
 * `not_owned` rather than injected.
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
  /** Replay budget PER RUN for turns that reached a session. Per-run, not
   *  global — see the module doc's B1 note on why one shared budget is
   *  cheaply flushable. */
  maxRememberedTurns?: number;
  /** How many distinct runs keep a replay bucket at all. */
  maxRememberedRuns?: number;
  /** Budget for turns refused before any session was touched. Small on
   *  purpose: a forgotten rejection is safely re-derivable. */
  maxRememberedRejections?: number;
  /** Admission cap on concurrently in-flight turns. In-flight turns are never
   *  evicted, so this refuses NEW turns rather than forgetting accepted ones. */
  maxInFlightTurns?: number;
  logger?: Logger;
}

export const DEFAULT_MAX_REMEMBERED_TURNS = 256;
export const DEFAULT_MAX_REMEMBERED_RUNS = 64;
export const DEFAULT_MAX_REMEMBERED_REJECTIONS = 64;
export const DEFAULT_MAX_IN_FLIGHT_TURNS = 256;

/** Composite key over (run_id, message_id) — JSON-encoded so neither field's
 *  contents can be mistaken for the separator (mirrors `./bridge.ts`). */
function keyOf(runId: string, messageId: string): string {
  return JSON.stringify([runId, messageId]);
}

/** How a turn was disposed of — which store its terminal frame belongs in,
 *  and therefore which budget it spends. */
type TurnDisposition = 'delivered' | 'refused';

/** What a lookup found for an inbound turn identity. */
type KnownTurn = { kind: 'in-flight' } | { kind: 'settled'; terminal: ChatReplyMessage };

export class ChatRelay {
  private readonly client: RelayClientPort;
  private readonly sessions: ChatSessionRegistry;
  private readonly now: () => string;
  private readonly maxRememberedTurns: number;
  private readonly maxRememberedRuns: number;
  private readonly maxRememberedRejections: number;
  private readonly maxInFlightTurns: number;
  private readonly logger: Logger;
  /** Turns being serviced right now, keyed by (run_id, message_id). NEVER
   *  evicted — bounded by admission (`maxInFlightTurns`) instead. */
  private readonly inFlight = new Set<string>();
  /** Terminal frames of turns that REACHED a session: run_id → message_id →
   *  frame. Both levels are insertion-ordered, so the first key is the
   *  eviction candidate at that level. Bucketing by run is what stops one
   *  run's traffic flushing another's history. */
  private readonly settled = new Map<string, Map<string, ChatReplyMessage>>();
  /** Terminal frames of turns refused before any session was touched. Its own
   *  small budget — see the module doc. */
  private readonly rejected = new Map<string, ChatReplyMessage>();
  private unsubscribe: (() => void) | null;

  constructor(options: ChatRelayOptions) {
    this.client = options.client;
    this.sessions = options.sessions;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxRememberedTurns = options.maxRememberedTurns ?? DEFAULT_MAX_REMEMBERED_TURNS;
    this.maxRememberedRuns = options.maxRememberedRuns ?? DEFAULT_MAX_REMEMBERED_RUNS;
    this.maxRememberedRejections = options.maxRememberedRejections ?? DEFAULT_MAX_REMEMBERED_REJECTIONS;
    this.maxInFlightTurns = options.maxInFlightTurns ?? DEFAULT_MAX_IN_FLIGHT_TURNS;
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
    let settled = 0;
    for (const bucket of this.settled.values()) settled += bucket.size;
    return this.inFlight.size + settled + this.rejected.size;
  }

  /** Turns being serviced right now. Never evicted; see the module doc. */
  get inFlightTurns(): number {
    return this.inFlight.size;
  }

  /** Replayable terminal frames for turns that reached a session on `runId`. */
  rememberedTurnsFor(runId: string): number {
    return this.settled.get(runId)?.size ?? 0;
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
    const known = this.recallTurn(key, turn);
    if (known !== null) {
      if (known.kind === 'settled') {
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
      //
      // `refused`: this turn touched NO session, so it spends the rejection
      // budget, not a run's replay budget (review B1). That is what stops a
      // flood of frames for runs we do not own from evicting the history of
      // turns we actually delivered.
      this.openSink(turn.runId, turn, 'refused').fail(
        CHAT_ERROR_CODES.notOwned,
        'this runner owns no live executor session for that run'
      );
      return;
    }

    // 3b. ADMISSION, not eviction. In-flight turns are never forgotten, so at
    //     the cap the NEW turn is the one refused — forgetting an accepted one
    //     would void both the replay and the in-flight-repeat drop for it.
    if (this.inFlight.size >= this.maxInFlightTurns) {
      this.logger.warn(
        `chat_send for run ${turn.runId} message ${turn.messageId} refused — ` +
          `${this.inFlight.size} turns already in flight (cap ${this.maxInFlightTurns})`
      );
      this.openSink(turn.runId, turn, 'refused').fail(
        CHAT_ERROR_CODES.tooManyTurns,
        'this runner is servicing too many chat turns; retry shortly'
      );
      return;
    }

    // From here the destination is `session`, whose run id is authoritative
    // for every outbound frame of this turn. Mark the turn in flight BEFORE
    // anything can settle it, so a repeat arriving mid-delivery is dropped.
    this.inFlight.add(key);
    const sink = this.openSink(session.runId, turn, 'delivered');

    // 4. STRICT parse — the only source of deliverable text.
    const parsed = parseChatSend(frame);
    if (parsed === null) {
      const oversized = isOversizedChatMessage(frame);
      sink.fail(
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
      const result = session.deliver(parsed.message, sink);
      if (result != null && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err: unknown) => this.onSessionFailure(sink, turn, err));
      }
    } catch (err) {
      this.onSessionFailure(sink, turn, err);
    }
  }

  private onSessionFailure(sink: ChatReplySink, turn: ChatTurnIdentity, err: unknown): void {
    // review A1: the thrown detail goes to the OPERATOR LOG only. The error
    // frame is UI-bound and leaves this process, so it carries the code and a
    // generic sentence — an internal exception message is not a class of text
    // whose contents this relay can vouch for (it can quote a path, a config
    // value, or whatever the throwing seam interpolated), and the code is
    // what a receiver actually branches on.
    const detail = err instanceof Error ? err.message : String(err);
    this.logger.error(`chat delivery for run ${turn.runId} message ${turn.messageId} failed: ${detail}`);
    if (!sink.settled) {
      sink.fail(CHAT_ERROR_CODES.internalError, 'the runner failed to deliver this chat turn; see the runner log');
    }
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  /**
   * Open a reply sink bound to `runId` (the SESSION's id) and this turn. The
   * binding is captured here and is not a parameter of anything the session
   * can call.
   *
   * `disposition` decides which memory the turn's terminal frame lands in when
   * it settles — `delivered` spends the run's replay budget, `refused` spends
   * the (separate, cheap-to-lose) rejection budget. See the module doc's B1
   * note; getting this wrong is exactly the defect the split exists to fix.
   */
  private openSink(runId: string, turn: ChatTurnIdentity, disposition: TurnDisposition): ChatReplySink {
    // Keyed on the FRAME's run id, because that is what a redelivery will
    // present. For a delivered turn the two are equal by the ownership check
    // above; for a refused one there is no session id to use.
    const key = keyOf(turn.runId, turn.messageId);
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
        onTruncated: (dropped) =>
          this.logger.warn(
            `chat_reply chunk for run ${runId} message ${turn.messageId} exceeded the wire cap — ` +
              `truncated (${dropped} characters dropped, frame marked truncated)`
          ),
      });
      if (done) {
        settled = true;
        this.settleTurn(key, turn.runId, turn.messageId, frame, disposition);
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
    return sink;
  }

  // ── Bookkeeping (review B1) ────────────────────────────────────────────────

  /**
   * Has this turn identity been seen? Checked in cost order: in-flight first
   * (a repeat mid-delivery must be dropped, never re-injected), then the
   * per-run replay bucket, then the rejection window.
   */
  private recallTurn(key: string, turn: ChatTurnIdentity): KnownTurn | null {
    if (this.inFlight.has(key)) return { kind: 'in-flight' };
    const delivered = this.settled.get(turn.runId)?.get(turn.messageId);
    if (delivered !== undefined) return { kind: 'settled', terminal: delivered };
    const refused = this.rejected.get(key);
    if (refused !== undefined) return { kind: 'settled', terminal: refused };
    return null;
  }

  /** Move a turn out of flight and into the memory its disposition earns. */
  private settleTurn(
    key: string,
    runId: string,
    messageId: string,
    terminal: ChatReplyMessage,
    disposition: TurnDisposition
  ): void {
    this.inFlight.delete(key);
    if (disposition === 'refused') {
      // Cheap to create, and SAFE to forget: re-processing a forgotten
      // rejection re-runs the ownership check and refuses again, injecting
      // nothing. Its own small budget, so it can never buy the eviction of a
      // delivered turn's replay entry.
      this.rejected.set(key, terminal);
      evictOldest(this.rejected, this.maxRememberedRejections);
      return;
    }
    // Delivered: bucket BY RUN, so one run's traffic cannot flush another's.
    let bucket = this.settled.get(runId);
    if (bucket === undefined) {
      bucket = new Map<string, ChatReplyMessage>();
      this.settled.set(runId, bucket);
    } else {
      // Refresh this run's recency so an ACTIVE run's bucket is not the one
      // reaped when the run cap bites.
      this.settled.delete(runId);
      this.settled.set(runId, bucket);
    }
    bucket.set(messageId, terminal);
    evictOldest(bucket, this.maxRememberedTurns);
    evictOldest(this.settled, this.maxRememberedRuns);
  }
}

/** Trim an insertion-ordered map to `max` entries, oldest first. */
function evictOldest(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
