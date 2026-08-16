/**
 * P2.5 CHAT wire frames (`pipeline-ui-v2` task `c4-runner-chat-channel`,
 * protocol `a3-protocol-chat-frames`, design `02-target-architecture.md` M6,
 * `07-security.md` T7) — sourced from `@baizor/pipeline-protocol` 0.9.0, the
 * release that introduced them.
 *
 * This module is the chat channel's single import point for protocol shapes,
 * exactly as `./wire-relay.ts` is for `needs_input`/`answer` and
 * `../core/wire.ts` is for the handshake. It holds NO routing, NO ownership
 * and NO session logic — those live in `./chat.ts`.
 *
 * Surface:
 *   - `chat_send`  (INBOUND,  server → agent): `{ type, id?, run_id,
 *     message_id, message, sent_by, ts }`.
 *   - `chat_reply` (OUTBOUND, agent → server): `{ type, id?, run_id,
 *     message_id, message, done, ts, error? }` — streamed as repeated
 *     `done:false` chunks then one `done:true` final chunk.
 *
 * ── Two parses, on purpose (the a3 review note) ─────────────────────────────
 * An inbound `chat_send` is read TWICE and the order is load-bearing:
 *
 *   1. {@link readChatTurnIdentity} — a TOLERANT read of just `(run_id,
 *      message_id)` off the passthrough envelope. It is what makes a
 *      REJECTION POSSIBLE AT ALL. `chat_reply` requires both fields, so a
 *      runner that could not recover them would have no frame to reject with
 *      and would be forced into silence — and silence is not a valid
 *      rejection (a3 review B2). The canonical case is an oversized message:
 *      `ChatSendMessageSchema` caps `message` at
 *      {@link CHAT_MESSAGE_MAX_CHARS} and so fails the strict parse outright,
 *      yet the turn identity beside it is perfectly readable.
 *
 *   2. {@link parseChatSend} — the STRICT, canonical
 *      `ChatSendMessageSchema.safeParse`, which is the only thing that ever
 *      yields a `message` string the runner will deliver into a session.
 *
 * Unlike `./wire-relay.ts`'s deliberately hand-rolled `parseAnswerDelivery`
 * (which stays lenient about `ts` to preserve pre-package inbound
 * acceptance), chat is a NEW channel with no legacy acceptance to preserve —
 * so its strict parse is the canonical schema, bounds included.
 *
 * ── `ts` is display metadata ────────────────────────────────────────────────
 * Producer-stamped, never a sort key (a3 review A2): ordering on this channel
 * is stream/arrival order. Nothing in this module or `./chat.ts` reads an
 * inbound `ts`.
 *
 * ── Nothing here is an authz claim ──────────────────────────────────────────
 * `sent_by` is audit/display identity that the CLOUD stamps after it has
 * already authorized the send (07 T7, the same class of field as
 * `AnswerMessage.answered_by`). This module never returns it as a decision
 * input, and the runner's own ownership check (`./chat.ts`) does not consult
 * it.
 */

import { CHAT_MESSAGE_MAX_CHARS, ChatSendMessageSchema } from '@baizor/pipeline-protocol';
import type { ChatReplyError, ChatReplyMessage, ChatSendMessage } from '@baizor/pipeline-protocol';
import type { WireFrame } from '../core/wire';

// ── Protocol surface re-exported from the published package ─────────────────

export { CHAT_MESSAGE_MAX_CHARS } from '@baizor/pipeline-protocol';
export type { ChatReplyError, ChatReplyMessage, ChatSendMessage } from '@baizor/pipeline-protocol';

/**
 * The documented `ChatReplyError.code` values this runner emits. The protocol
 * types `code` as an OPEN lenient string (so a future failure class needs no
 * schema change), but the runner deliberately draws from a closed local set —
 * a typo in a code string is a silent contract break for the cloud's d6/e9
 * handling, and there is no schema to catch it.
 *
 *   - `not_owned`         — the `chat_send` named a run this runner does not
 *                           own a live executor session for (07 T7). THE
 *                           security rejection.
 *   - `session_busy`      — owned, but the session is mid-turn and not parked,
 *                           so it cannot take a chat turn right now.
 *   - `session_gated`     — owned and parked, but behind an APPROVAL GATE,
 *                           which chat must not clear (see
 *                           `../jobs/chat-session.ts`).
 *   - `session_gone`      — owned when we looked, but the park was resolved
 *                           before the text could be delivered.
 *   - `message_too_large` — the inbound text exceeded
 *                           {@link CHAT_MESSAGE_MAX_CHARS}.
 *   - `invalid_message`   — owned, but the frame failed the canonical parse
 *                           for some other reason.
 *   - `too_many_turns`    — the runner is already servicing its cap of
 *                           concurrent turns; retryable.
 *   - `internal_error`    — an unexpected runner-side failure mid-turn.
 *
 * NOTE FOR THE CLOUD (d6 / e9): the protocol's own doc names
 * `session_unavailable` as one documented value, and this runner deliberately
 * emits **three** codes in its place — `session_busy`, `session_gated` and
 * `session_gone`. They are three genuinely different situations with three
 * different affordances (wait and retry / go answer the approval / the moment
 * has passed), and collapsing them leaves a UI unable to say which. Any
 * receiver that wants the old coarse behaviour can treat the `session_*`
 * prefix as one class; the split only ever adds information. This runner
 * never emits the literal string `session_unavailable`.
 */
export const CHAT_ERROR_CODES = {
  notOwned: 'not_owned',
  sessionBusy: 'session_busy',
  sessionGated: 'session_gated',
  sessionGone: 'session_gone',
  messageTooLarge: 'message_too_large',
  invalidMessage: 'invalid_message',
  tooManyTurns: 'too_many_turns',
  internalError: 'internal_error',
} as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[keyof typeof CHAT_ERROR_CODES];

// ── Inbound: the tolerant identity read ─────────────────────────────────────

/** The turn coordinates recovered from an inbound frame — enough to bind a
 *  `chat_reply`, and nothing else. Deliberately carries NO `message`: a
 *  tolerant read must never produce text that could be delivered into a
 *  session (only {@link parseChatSend} may). */
export interface ChatTurnIdentity {
  runId: string;
  messageId: string;
  /** The optional envelope correlation id, echoed back on every reply chunk
   *  as a routing aid (never a schema gate — see `../core/wire.ts`). */
  envelopeId?: string;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Recover `(run_id, message_id)` from an inbound frame WITHOUT validating the
 * rest of it — see the module doc for why this exists. Returns null only when
 * the frame is not a `chat_send`, or is so malformed that no reply could be
 * bound to it; that null is the one and only case where a runner legitimately
 * stays silent, because `chat_reply` has nowhere to point.
 */
export function readChatTurnIdentity(frame: WireFrame): ChatTurnIdentity | null {
  if (frame.type !== 'chat_send') return null;
  const runId = (frame as Record<string, unknown>).run_id;
  const messageId = (frame as Record<string, unknown>).message_id;
  if (!nonEmptyString(runId) || !nonEmptyString(messageId)) return null;
  const envelopeId = frame.id;
  return nonEmptyString(envelopeId) ? { runId, messageId, envelopeId } : { runId, messageId };
}

/** Strict, canonical parse of an inbound `chat_send`. Returns null for
 *  anything the protocol schema rejects — bounds included. */
export function parseChatSend(frame: WireFrame): ChatSendMessage | null {
  const parsed = ChatSendMessageSchema.safeParse(frame);
  return parsed.success ? (frame as ChatSendMessage) : null;
}

/** Did this frame's `message` blow the wire cap? Read with the SAME tolerant
 *  posture as {@link readChatTurnIdentity}, so an oversized send can be
 *  rejected with a precise code instead of a generic one. */
export function isOversizedChatMessage(frame: WireFrame): boolean {
  const message = (frame as Record<string, unknown>).message;
  return typeof message === 'string' && message.length > CHAT_MESSAGE_MAX_CHARS;
}

// ── Outbound: the reply builder ─────────────────────────────────────────────

export interface BuildChatReplyInput {
  /** The run binding. Callers in `./chat.ts` pass the SESSION's own run id —
   *  never a value read off the inbound frame. */
  runId: string;
  messageId: string;
  message: string;
  done: boolean;
  ts: string;
  envelopeId?: string;
  error?: ChatReplyError;
  /** Called when the outbound text had to be clamped, with how many
   *  characters were dropped. The caller logs it; see {@link buildChatReplyFrame}. */
  onTruncated?: (droppedChars: number) => void;
}

/**
 * Build one `chat_reply` chunk.
 *
 * The outbound `message` is CLAMPED to {@link CHAT_MESSAGE_MAX_CHARS}:
 * `ChatReplyMessageSchema` bounds the reply exactly as it bounds the send, so
 * an over-long chunk would be dropped at the cloud's parse — which for a
 * `done:true` chunk means the turn never terminates for the UI. Truncating is
 * the fail-visible choice; emitting an unparseable terminal frame is silence
 * wearing a frame's clothes.
 *
 * Truncation is MARKED, not silent (review A2). The clamped frame carries an
 * additive `truncated: true` (the schema is `.passthrough()`, so it rides
 * along on a same-major peer), and `onTruncated` fires so the runner log says
 * so too. A flag rather than an appended "…" suffix on purpose: a suffix is
 * indistinguishable from content the session actually produced, which is the
 * wrong thing for a reader trying to decide whether they are looking at a
 * whole answer.
 */
export function buildChatReplyFrame(input: BuildChatReplyInput): ChatReplyMessage {
  const dropped = Math.max(0, input.message.length - CHAT_MESSAGE_MAX_CHARS);
  const frame: ChatReplyMessage = {
    type: 'chat_reply',
    run_id: input.runId,
    message_id: input.messageId,
    message: dropped > 0 ? input.message.slice(0, CHAT_MESSAGE_MAX_CHARS) : input.message,
    done: input.done,
    ts: input.ts,
  };
  if (dropped > 0) {
    frame.truncated = true;
    input.onTruncated?.(dropped);
  }
  if (input.envelopeId !== undefined) frame.id = input.envelopeId;
  if (input.error !== undefined) frame.error = input.error;
  return frame;
}
