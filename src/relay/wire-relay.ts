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
 *     `{ text, context?, options?, question_id? }` — the INNER `question_id`
 *     stays optional for v4 back-compat; the relay uses the required SIBLING
 *     one.
 *   - `answer` (INBOUND, server → agent): `{ type, id?, answer }` wrapping the
 *     inner `AnswerMessage` `{ run_id, question_id, answer, answered_by, ts }`.
 *
 * All are additive-forward (zod `.passthrough()`): unknown extra fields a
 * newer same-major peer adds ride along untouched. The frame BUILDER is a
 * runner-local helper the package does not provide, and `parseAnswerDelivery`
 * deliberately stays hand-rolled — see the note on it.
 */

import type { AnswerDeliveryMessage, NeedsInputMessage, Question } from '@baizor/pipeline-protocol';
import type { WireFrame } from '../core/wire';

// ── Protocol surface re-exported from the published package ─────────────────

export type { AnswerDeliveryMessage, AnswerMessage, NeedsInputMessage } from '@baizor/pipeline-protocol';

/** The needs-input QUESTION payload embedded in `needs_input`, under the name
 *  the relay has always used (the package calls it `Question`). */
export type RelayQuestion = Question;

// ── Build helper (OUTBOUND; runner-local — the package ships no builders) ───

/**
 * Build a `needs_input` frame. `id` is the envelope correlation id echoed by
 * the answer so the relay can pair response↔request. The question payload
 * rides through unchanged; the REQUIRED `question_id` sibling carries the
 * identity.
 */
export function buildNeedsInputFrame(
  runId: string,
  questionId: string,
  question: RelayQuestion,
  id: string
): NeedsInputMessage {
  return {
    type: 'needs_input',
    id,
    run_id: runId,
    question_id: questionId,
    question,
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
