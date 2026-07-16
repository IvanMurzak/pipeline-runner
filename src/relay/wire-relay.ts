/**
 * VENDORED from ai-pipeline `packages/protocol/src/{wire,records,common}` —
 * source of truth; replace with the published `@ai-pipeline/protocol` package
 * once available (npm publish blocked). Same vendoring discipline as the T1-11
 * agent CORE `src/core/wire.ts`: the source encodes these shapes with zod; this
 * copy hand-rolls the TS types plus light runtime guards for INBOUND (untrusted)
 * frames, keeping the agent dependency-free. Field names, optionality, and enum
 * values match the zod schemas 1:1 — verify against the source on every sync.
 *
 * Vendored subset (exactly what the needs-input RELAY needs — nothing more):
 *   - `needs_input` (OUTBOUND, agent → server) — `wire/client.ts`
 *     `NeedsInputMessageSchema`: `{ type, id?, run_id, question_id, question }`.
 *     `question_id` is REQUIRED (v5-only message) and is echoed by the answer so
 *     the relay can reject a stale answer to a superseded question.
 *   - the embedded `question` — `common/question.ts` `QuestionSchema`:
 *     `{ text, context?, options?, question_id? }` (the INNER `question_id` stays
 *     optional for v4 back-compat; the relay uses the required SIBLING one).
 *   - `answer` (INBOUND, server → agent) — `wire/server.ts`
 *     `AnswerDeliveryMessageSchema`: `{ type, id?, answer }` wrapping
 *   - the inner `records/answer.ts` `AnswerMessageSchema`:
 *     `{ run_id, question_id, answer, answered_by, ts }`.
 *
 * All are additive-forward (`.passthrough()` in the source): unknown extra
 * fields a newer same-major peer adds ride along untouched.
 */

import type { WireFrame } from '../core/wire';

/**
 * The needs-input QUESTION payload embedded in `needs_input` (mirrors
 * `common/question.ts` `QuestionSchema`). The index signature carries the
 * passthrough semantics.
 */
export interface RelayQuestion {
  [field: string]: unknown;
  /** The question to put to the answerer. Required + non-empty. */
  text: string;
  /** What the step already did/found, so the answerer can decide. */
  context?: string | null;
  /** Optional preset choices. */
  options?: string[] | null;
  /** v5 additive (G3): stable question identity. Optional here (the relay carries
   *  the identity on the REQUIRED sibling `needs_input.question_id`). */
  question_id?: string;
}

/**
 * `needs_input` (agent → server) — surface a parked `drive` question up the WSS
 * channel. OUTBOUND: the relay BUILDS this. `question_id` is required and is
 * echoed back by the `answer`.
 */
export interface NeedsInputMessage extends WireFrame {
  type: 'needs_input';
  run_id: string;
  /** Stable question identity, echoed by the answer (required — v5-only). */
  question_id: string;
  question: RelayQuestion;
}

/**
 * The inner structured answer envelope (mirrors `records/answer.ts`
 * `AnswerMessageSchema`). `question_id` echoes the `needs_input` question so a
 * stale answer racing a superseded question is rejected. `answered_by` + `ts`
 * feed the audit log — NEVER logged verbatim by the relay.
 */
export interface AnswerMessage {
  [field: string]: unknown;
  run_id: string;
  /** Echoes the question's `question_id` (G3). */
  question_id: string;
  /** The answer text. */
  answer: string;
  /** WHO answered — audit-log identity (role-gated). */
  answered_by: string;
  /** ISO-8601 UTC time the answer was submitted. */
  ts: string;
}

/**
 * `answer` (server → agent) — deliver a needs-input answer down to the runner.
 * INBOUND: the relay validates + routes this. The envelope `id` echoes the
 * `needs_input` correlation id.
 */
export interface AnswerDeliveryMessage extends WireFrame {
  type: 'answer';
  answer: AnswerMessage;
}

// ── Build helper (OUTBOUND) ─────────────────────────────────────────────────

/**
 * Build a `needs_input` frame. `id` is the envelope correlation id echoed by
 * the answer so the relay can pair response↔request. The question payload rides
 * through unchanged; the REQUIRED `question_id` sibling carries the identity.
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
// Defensive equivalent of the source's zod `.parse()`: verify the fields the
// relay actually reads; preserve everything else (passthrough).

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse an inbound frame into a well-formed `answer` delivery, or null if it is
 * not one (wrong type, missing/malformed inner payload). Mirrors the source's
 * required inner fields: `run_id`, `question_id`, `answer`, `answered_by`, `ts`
 * all non-empty strings (`ts` accepted as any non-empty string — the relay does
 * not parse it, only forwards it for audit).
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
