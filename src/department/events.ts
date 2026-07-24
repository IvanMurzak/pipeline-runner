/**
 * Maps a normalized `RuntimeEvent` (`./adapter.ts`) onto a JOURNAL envelope
 * the EXISTING shipper (`../shipper/shipper.ts`) can tail, filter, and ship —
 * task d1's "emit `department.event` through the existing shipper" (07 §8).
 *
 * One journal `type` per `RuntimeEvent` variant (`department.status`,
 * `department.message`, `department.input_required`, `department.artifact`,
 * `department.progress`, `department.completed`, `department.failed`) —
 * mirrors how the pipeline's own journal namespaces events by domain
 * (`iteration.started`, `run.completed`, …), and is what lets
 * `DATA_ALLOWLISTS` (`../shipper/privacy.ts`) allowlist each shape precisely
 * instead of one catch-all blob. Field names are snake_case, matching every
 * other journal event in this codebase — the JSONL wire contract to the
 * child process (`./jsonl-process.ts`) is camelCase, but that is a SEPARATE,
 * external protocol; this is the runner's own internal telemetry shape.
 *
 * `run_id` carries the department EXECUTION id: the shipper's `ingestLine()`
 * (G2 rule) only ships a line whose `run_id` is a non-empty string, and its
 * `(run_id, seq)` idempotency/dedup discipline is exactly what 08 §5
 * describes department events wanting at the execution granularity.
 */

import type { RuntimeEvent } from './adapter';

export const DEPARTMENT_JOURNAL_SCHEMA = 1;

/** Every journal `type` a `RuntimeEvent` can produce — the exhaustive list
 *  `DATA_ALLOWLISTS` must cover (asserted by
 *  `tests/shipper-privacy-department.test.ts`). */
export const DEPARTMENT_JOURNAL_EVENT_TYPES = [
  'department.status',
  'department.message',
  'department.input_required',
  'department.artifact',
  'department.progress',
  'department.completed',
  'department.failed',
] as const;

export interface DepartmentJournalEnvelope {
  schema: number;
  ts: string;
  type: (typeof DEPARTMENT_JOURNAL_EVENT_TYPES)[number];
  /** The department EXECUTION id (shipper `run_id` — see the module doc). */
  run_id: string;
  task_id: string;
  context_id: string;
  data: Record<string, unknown>;
}

function toJournalData(event: RuntimeEvent): Record<string, unknown> {
  switch (event.type) {
    case 'status':
      return { state: event.state, ...(event.message !== undefined ? { message: event.message } : {}) };
    case 'progress':
      return { note: event.note };
    case 'message':
      return {
        parts: event.parts.map((part) => ({
          ...(part.text !== undefined ? { text: part.text } : {}),
          ...(part.raw !== undefined ? { raw: part.raw } : {}),
          ...(part.url !== undefined ? { url: part.url } : {}),
          ...(part.data !== undefined ? { data: part.data } : {}),
          ...(part.mediaType !== undefined ? { media_type: part.mediaType } : {}),
          ...(part.filename !== undefined ? { filename: part.filename } : {}),
        })),
      };
    case 'input_required':
      return {
        question_id: event.questionId,
        question: {
          text: event.question.text,
          context: event.question.context ?? null,
          options: event.question.options ?? null,
        },
      };
    case 'artifact':
      return {
        name: event.name,
        media_type: event.mediaType,
        ...(event.path !== undefined ? { path: event.path } : {}),
        ...(event.bytes !== undefined ? { bytes_base64: Buffer.from(event.bytes).toString('base64') } : {}),
      };
    case 'completed':
      return { ...(event.summary !== undefined ? { summary: event.summary } : {}) };
    case 'failed':
      return { reason: event.reason, retry_safe: event.retrySafe };
  }
}

/** Build one journal-line envelope for a `RuntimeEvent`. Callers append
 *  `JSON.stringify(...)  + '\n'` to the execution's journal file — the
 *  EventShipper (already running against that path) does the rest. */
export function buildDepartmentJournalEnvelope(opts: {
  executionId: string;
  taskId: string;
  contextId: string;
  event: RuntimeEvent;
  nowIso: string;
}): DepartmentJournalEnvelope {
  return {
    schema: DEPARTMENT_JOURNAL_SCHEMA,
    ts: opts.nowIso,
    type: `department.${opts.event.type}`,
    run_id: opts.executionId,
    task_id: opts.taskId,
    context_id: opts.contextId,
    data: toJournalData(opts.event),
  };
}
