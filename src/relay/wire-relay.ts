/**
 * Needs-input relay wire frames — sourced from the published
 * `@baizor/pipeline-protocol` package (repo
 * `github.com/IvanMurzak/pipeline-protocol`), which replaced the hand-rolled
 * vendored copy this file used to be (T8d de-vendoring).
 *
 * This module stays the relay's single import point (`./wire-relay`), so
 * internal import paths are unchanged. Re-exported surface:
 *   - `needs_input` (OUTBOUND, agent → server): `{ type, id?, run_id,
 *     question_id, question }`. `question_id` is REQUIRED (v5-only message)
 *     and is echoed by the answer so the relay can reject a stale answer to a
 *     superseded question.
 *   - the embedded `question` (`RelayQuestion`, the package's `Question`):
 *     `{ text, context?, options?, question_id?, approval? }` — the INNER
 *     `question_id` stays optional for v4 back-compat; the relay uses the
 *     required SIBLING one. `approval` is the T3-14 approval-GATE marker,
 *     preserved end-to-end from drive's park JSON (c2) and validated against
 *     the package's `ApprovalSchema` HERE, at the frame boundary — the one
 *     place on the runner that decides whether a parked question is a gate
 *     (07 T2). See `validateQuestionApproval`.
 *   - `answer` (INBOUND, server → agent): `{ type, id?, answer }` wrapping the
 *     inner `AnswerMessage` `{ run_id, question_id, answer, answered_by, ts }`.
 *
 * All are additive-forward (zod `.passthrough()`): unknown extra fields a
 * newer same-major peer adds ride along untouched. The frame BUILDER is a
 * runner-local helper the package does not provide, and `parseAnswerDelivery`
 * deliberately stays hand-rolled — see the note on it.
 */

import { ApprovalSchema } from '@baizor/pipeline-protocol';
import type { AnswerDeliveryMessage, NeedsInputMessage, Question } from '@baizor/pipeline-protocol';
import type { WireFrame } from '../core/wire';

// ── Protocol surface re-exported from the published package ─────────────────

export type { AnswerDeliveryMessage, AnswerMessage, NeedsInputMessage } from '@baizor/pipeline-protocol';
export type { Approval } from '@baizor/pipeline-protocol';

/** The needs-input QUESTION payload embedded in `needs_input`, under the name
 *  the relay has always used (the package calls it `Question`). */
export type RelayQuestion = Question;

/**
 * A question as the RUNNER holds it, upstream of this boundary: the protocol
 * question shape, except `approval` is still raw drive-supplied data (c2 /
 * 07 T2).
 *
 * The `unknown` is the load-bearing part. `../jobs/drive.ts` copies drive's
 * `question.approval` through verbatim and never judges it, so nothing on the
 * runner path holds a value the compiler will accept as a protocol
 * `Approval` — the ONLY way to obtain one is
 * {@link validateQuestionApproval} below, and the only caller that needs one
 * is the frame builder. A future edit that tries to route an approval to the
 * cloud around this parse does not typecheck.
 */
export type UnvalidatedRelayQuestion = {
  text: string;
  context?: string | null;
  options?: string[] | null;
  question_id?: string;
  /** The T3-14 gate marker as drive emitted it — UNVALIDATED. */
  approval?: unknown;
};

// ── The approval-gate validation boundary (07 T2) ───────────────────────────

/**
 * THE approval boundary. Returns the question exactly as it will go on the
 * wire, with `approval` present ONLY when it parsed clean against the
 * protocol's `ApprovalSchema`.
 *
 * Why here and nowhere else: every `needs_input` frame this runner emits is
 * built by {@link buildNeedsInputFrame} (the bridge's `surface()` is the sole
 * construction site, and its reconnect re-send replays that ALREADY-BUILT
 * frame), so this function sits on the single choke point between everything
 * the runner believes and everything the cloud is told. A gate therefore
 * cannot be FABRICATED runner-side — the marker must have arrived in drive's
 * park JSON AND satisfy the schema — and it cannot be MUTATED into something
 * the cloud reads differently, because what ships is `ApprovalSchema`'s own
 * parse OUTPUT (`parsed.data`), never the raw input that produced it. The
 * cloud's `awaiting_kind` derivation keys on this exact object's presence
 * (d2), so "validated" and "forwarded" are the same event.
 *
 * FAIL CLOSED. A present-but-malformed marker — a legacy boolean `true`, an
 * unknown `required_role`, a string, an array — is DROPPED with a warning and
 * the question ships as an ordinary one. Fail-closed here means "no gate",
 * because the alternative (forwarding it unvalidated) is precisely the
 * spoofing path T2 names; a gate that degrades to a normal question is
 * visible to the answerer and recoverable, an unvalidated marker is neither.
 *
 * ABSENT ≠ MALFORMED. `approval` absent or explicitly `null` is the ordinary
 * no-gate case (`!= null` presence semantics — the protocol's marker is an
 * OBJECT, and its history includes a boolean-typed trap that silently dropped
 * real gates, so presence is never read as truthiness): the key is simply not
 * emitted, no warning, byte-identical to a pre-c2 plain question.
 *
 * Unknown sibling fields on the question, and unknown fields INSIDE a valid
 * approval, ride through untouched — the spread preserves the former and
 * `ApprovalSchema` is `.passthrough()` for the latter (additive-forward).
 */
export function validateQuestionApproval(
  question: UnvalidatedRelayQuestion,
  onInvalid?: (detail: string) => void
): RelayQuestion {
  const { approval, ...rest } = question;
  const plain = rest as RelayQuestion;
  if (approval == null) return plain;
  const parsed = ApprovalSchema.safeParse(approval);
  if (!parsed.success) {
    // PATH + CODE only, never zod's `message`. The runner's secrets discipline
    // keeps question payload out of the log (see ./bridge.ts's header), and
    // zod's `invalid_enum_value` message QUOTES THE REJECTED VALUE verbatim —
    // so forwarding messages would have leaked the very payload the drop was
    // protecting against, into every warn line. `required_role:
    // invalid_enum_value` says everything an operator needs about a 3-field
    // schema without echoing a byte of the question.
    onInvalid?.(parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`).join('; '));
    return plain;
  }
  return { ...plain, approval: parsed.data };
}

// ── Build helper (OUTBOUND; runner-local — the package ships no builders) ───

/**
 * Build a `needs_input` frame. `id` is the envelope correlation id echoed by
 * the answer so the relay can pair response↔request. The REQUIRED
 * `question_id` sibling carries the identity.
 *
 * The question payload rides through unchanged EXCEPT for its `approval`
 * marker, which is validated here — see {@link validateQuestionApproval} for
 * why this is the one place that decides. `onInvalidApproval` receives the
 * schema's complaint when a malformed marker is dropped (the bridge passes a
 * logger warning); omitting it drops silently, which only a caller with no
 * logger should do.
 */
export function buildNeedsInputFrame(
  runId: string,
  questionId: string,
  question: UnvalidatedRelayQuestion,
  id: string,
  onInvalidApproval?: (detail: string) => void
): NeedsInputMessage {
  return {
    type: 'needs_input',
    id,
    run_id: runId,
    question_id: questionId,
    question: validateQuestionApproval(question, onInvalidApproval),
  };
}

// ── Runtime guard for INBOUND (untrusted) frames ────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse an inbound frame into a well-formed `answer` delivery, or null if it
 * is not one (wrong type, missing/malformed inner payload). Requires the inner
 * `run_id`, `question_id`, `answer`, `answered_by`, `ts` all non-empty
 * strings.
 *
 * KEPT HAND-ROLLED on purpose (not `AnswerDeliveryMessageSchema.safeParse`):
 * the package schema refines the inner `ts` to a strict ISO-8601 datetime
 * (`z.string().datetime({ offset: true })`), while this relay has always
 * accepted `ts` as any non-empty string — it does not parse it, only forwards
 * it for audit. Swapping in the schema would change inbound acceptance (an
 * answer with a non-conforming `ts` would be silently dropped instead of
 * routed). Behavior is preserved verbatim; tightening to the canonical schema
 * is an owner decision.
 */
export function parseAnswerDelivery(frame: WireFrame): AnswerDeliveryMessage | null {
  if (frame.type !== 'answer') return null;
  const answer = frame.answer;
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return null;
  const a = answer as Record<string, unknown>;
  if (
    !isNonEmptyString(a.run_id) ||
    !isNonEmptyString(a.question_id) ||
    !isNonEmptyString(a.answer) ||
    !isNonEmptyString(a.answered_by) ||
    !isNonEmptyString(a.ts)
  ) {
    return null;
  }
  return frame as AnswerDeliveryMessage;
}
