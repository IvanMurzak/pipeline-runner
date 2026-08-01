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
 *
 * ── schema 2: what `pipeline department status` needs (b4, 05 §6) ───────────
 * Schema 1 carried `executionId`/`taskId`/`contextId` and nothing else, which
 * 05 §6 names as the reason `status` "can render state and timings but not the
 * sender or engine columns": there was no department id, no sender identity, no
 * engine name, and no per-department index — finding one department's work meant
 * opening EVERY `<executionId>/events.jsonl` under the journal root and reading
 * a line to see whose it was.
 *
 * Schema 2 adds the three missing fields to every envelope and a per-department
 * INDEX file next to the execution directories (`./by-department/<departmentId>/
 * executions.jsonl`, one line per admitted execution). A consumer resolves a
 * department's executions by computing ONE path (`departmentIndexPath`) and
 * reading it — no directory scan.
 *
 * Envelopes are append-only, so schema 1 lines stay on disk forever and must
 * stay readable: the three added fields are the ONLY difference, so a schema-1
 * line still parses field-for-field as it always did and simply reports no
 * department/sender/engine. Nothing was renamed, removed, or re-typed — the
 * version bump is a reader's hint, not a format break.
 */

import { join } from 'node:path';
import type { DeptMessage, RuntimeEvent } from './adapter';

/** 1 → 2 (b4): `department_id` / `sender` / `engine` added. See the module
 *  doc — a reader that understands 2 also reads 1, with those three absent. */
export const DEPARTMENT_JOURNAL_SCHEMA = 2;

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
  /** schema 2 (b4): which department this execution belongs to — the field
   *  `status` groups by, and the key the per-department index is filed under. */
  department_id: string;
  /** schema 2 (b4): who addressed the task, from the opening message's
   *  `metadata.sender` (`senderFromMessages`). `null` when the sender did not
   *  state one — rendered as `—` rather than omitted (05 §6). */
  sender: string | null;
  /** schema 2 (b4): the USER-FACING engine name (`claude-code`), never the
   *  internal `adapterId` (06 §7 / D9). `null` for an adapter that is not in
   *  `./engine.ts`'s registry, since there is no engine name to state. */
  engine: string | null;
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
  departmentId: string;
  sender: string | null;
  engine: string | null;
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
    department_id: opts.departmentId,
    sender: opts.sender,
    engine: opts.engine,
    data: toJournalData(opts.event),
  };
}

// ── Where the journal lives, and the per-department index (b4, 05 §6) ────────

export const DEPARTMENT_JOURNAL_FILE = 'events.jsonl';
/** Sub-directory of the journal root the per-department index lives under —
 *  a sibling of the `<executionId>/` directories, not inside one. */
export const DEPARTMENT_INDEX_DIR = 'by-department';
export const DEPARTMENT_INDEX_FILE = 'executions.jsonl';
export const DEPARTMENT_INDEX_SCHEMA = 1;

/** Execution and department ids are caller-minted (offer frame) — sanitize
 *  before using one as a path segment, same discipline as
 *  `../jobs/workspace.ts`'s job ids. */
export function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** `<journalRoot>/<executionId>/events.jsonl` — unchanged from schema 1. */
export function departmentJournalPath(journalRoot: string, executionId: string): string {
  return join(journalRoot, sanitizeForPath(executionId), DEPARTMENT_JOURNAL_FILE);
}

/**
 * `<journalRoot>/by-department/<departmentId>/executions.jsonl` — the whole of
 * "a per-department index resolves without scanning every execution directory".
 * It is a PURE path computation from a department id, so a consumer (`status`)
 * opens exactly one known file instead of listing the journal root and reading
 * a line out of every execution's journal to discover which department it
 * belonged to.
 */
export function departmentIndexPath(journalRoot: string, departmentId: string): string {
  return join(journalRoot, DEPARTMENT_INDEX_DIR, sanitizeForPath(departmentId), DEPARTMENT_INDEX_FILE);
}

/**
 * One index line: an execution this runner admitted for the department, with
 * everything `status`'s header row needs (who sent it, which engine ran it,
 * when it started) plus the path to its full journal. Append-only and written
 * ONCE, at admission — the outcome is not duplicated here, it stays in the
 * execution's own journal, which this entry says exactly where to find.
 */
export interface DepartmentIndexEntry {
  schema: number;
  ts: string;
  type: 'department.execution_started';
  department_id: string;
  /** The department EXECUTION id — same field name/meaning as the envelope's. */
  run_id: string;
  task_id: string;
  context_id: string;
  engine: string | null;
  sender: string | null;
  /** Where this execution's `events.jsonl` is (`departmentJournalPath`). */
  journal_path: string;
}

export function buildDepartmentIndexEntry(opts: {
  executionId: string;
  taskId: string;
  contextId: string;
  departmentId: string;
  sender: string | null;
  engine: string | null;
  journalPath: string;
  nowIso: string;
}): DepartmentIndexEntry {
  return {
    schema: DEPARTMENT_INDEX_SCHEMA,
    ts: opts.nowIso,
    type: 'department.execution_started',
    department_id: opts.departmentId,
    run_id: opts.executionId,
    task_id: opts.taskId,
    context_id: opts.contextId,
    engine: opts.engine,
    sender: opts.sender,
    journal_path: opts.journalPath,
  };
}

/** Read one index line back, or null when it is not one (a truncated final
 *  line after a crash, a foreign file). Tolerant on purpose: an index is a
 *  convenience for a reader, never the source of truth. */
export function parseDepartmentIndexLine(line: string): DepartmentIndexEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entry = parsed as Record<string, unknown>;
  if (entry.type !== 'department.execution_started') return null;
  if (typeof entry.run_id !== 'string' || entry.run_id.length === 0) return null;
  if (typeof entry.department_id !== 'string' || entry.department_id.length === 0) return null;
  return entry as unknown as DepartmentIndexEntry;
}

/** Longest sender identity a journal line carries — the same bound (and the
 *  same single-line flattening) `./claude-code.ts` applies to the SAME field
 *  before putting it in a session's context. */
const MAX_SENDER = 200;

/**
 * Who addressed this task, from the opening message's `metadata.sender` —
 * the same key `./claude-code.ts`'s `buildSessionContext` reads, so the name
 * a session is told and the name the journal records can never disagree.
 * `null` when no sender was stated (05 §6: `status` renders `—`, it does not
 * invent one).
 */
export function senderFromMessages(messages: readonly DeptMessage[]): string | null {
  // The opening INBOUND message. Not `role === 'ROLE_USER'`: a calling
  // department's agent sends `ROLE_AGENT`, and the `?? messages[0]` fallback
  // made that misread survive as "no sender" rather than fail — so the journal
  // recorded `—` for exactly the cross-department tasks a sender matters most
  // on. Same predicate as `claude-code.ts`, so the two cannot disagree.
  const first = messages.find((message) => message.selfAuthored !== true) ?? messages[0];
  const raw = first?.metadata?.sender;
  if (typeof raw !== 'string') return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > MAX_SENDER ? `${flat.slice(0, MAX_SENDER)}…` : flat;
}
