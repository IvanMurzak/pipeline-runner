/**
 * department-mesh (task d1) privacy-allowlist coverage: "New `department.*`
 * event types are in `DATA_ALLOWLISTS` — asserted by a test, not caught in
 * prod" (the DoD line, mirroring 07-runtime-contract.md §8's "Mandatory,
 * easily missed" warning). An event type absent from `DATA_ALLOWLISTS` ships
 * `data: {}` at the metadata tier — this suite fails loudly if that ever
 * happens for a department event, instead of shipping silently-empty data.
 *
 * Also exercises the actual REDACTION behavior at the metadata tier: a
 * department's message/artifact content is task data, not telemetry, and is
 * stripped/placeholdered exactly like `awaiting_input.question` — never
 * leaked just because the event type is new.
 */

import { describe, expect, test } from 'bun:test';
import { buildDepartmentJournalEnvelope, DEPARTMENT_JOURNAL_EVENT_TYPES, type DepartmentJournalEnvelope } from '../src/department/events';
import type { RuntimeEvent } from '../src/department/adapter';
import { filterEventForTier, MESSAGE_PARTS_PLACEHOLDER, QUESTION_PLACEHOLDER, type PrivacyTier } from '../src/shipper/privacy';

const ENVELOPE = { executionId: 'dexec-1', taskId: 'dtask-1', contextId: 'dctx-1', nowIso: '2026-07-23T00:00:00.000Z' };

/** `DepartmentJournalEnvelope` is a plain interface, not `Record<string,
 *  unknown>` — spreading into a fresh object literal picks up TS's implicit
 *  index signature for object literals so this typechecks against
 *  `filterEventForTier`'s signature (the SAME shape every real journal line
 *  has, since `JSON.parse()` — the shipper's own ingest path — always
 *  produces a plain indexable object too). */
function filterDept(envelope: DepartmentJournalEnvelope, tier: PrivacyTier): Record<string, unknown> {
  return filterEventForTier({ ...envelope }, tier);
}

const SAMPLE_EVENTS: RuntimeEvent[] = [
  { type: 'status', state: 'WORKING', message: 'SECRET_STATUS_message-with-detail' },
  { type: 'progress', note: 'SECRET_PROGRESS_12-of-40-files' },
  { type: 'message', parts: [{ text: 'SECRET_MESSAGE_the-actual-reply', mediaType: 'text/markdown' }] },
  {
    type: 'input_required',
    questionId: 'q-1',
    question: { text: 'SECRET_QUESTION_android-or-ios', context: 'SECRET_CONTEXT', options: ['SECRET_OPTION_a'] },
  },
  { type: 'artifact', name: 'review.md', mediaType: 'text/markdown', path: '/SECRET/checkout/out/review.md' },
  { type: 'completed', summary: 'SECRET_SUMMARY_what-was-done' },
  { type: 'failed', reason: 'SECRET_REASON_unity-not-installed', retrySafe: false },
];

describe('department-mesh privacy allowlist coverage (DoD)', () => {
  test('DEPARTMENT_JOURNAL_EVENT_TYPES is exhaustive: every RuntimeEvent variant maps to a journal type', () => {
    const produced = new Set(SAMPLE_EVENTS.map((event) => buildDepartmentJournalEnvelope({ ...ENVELOPE, event }).type));
    expect([...produced].sort()).toEqual([...DEPARTMENT_JOURNAL_EVENT_TYPES].sort());
  });

  for (const event of SAMPLE_EVENTS) {
    test(`'department.${event.type}' has a DATA_ALLOWLISTS entry — metadata tier does not ship data:{}`, () => {
      const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event });
      const filtered = filterDept(envelope, 'metadata');
      // The unknown-type fallback (privacy.ts) is EXACTLY `data: {}`. Any
      // allowlisted type ships at least its structural fields, so this
      // single assertion is the coverage check: a missing entry means this
      // fails for every event kind above.
      expect(filtered.data).not.toEqual({});
    });
  }

  test('envelope task_id/context_id survive the metadata-tier filter (structural, not content)', () => {
    const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event: SAMPLE_EVENTS[0]! });
    const filtered = filterDept(envelope, 'metadata');
    expect(filtered.task_id).toBe('dtask-1');
    expect(filtered.context_id).toBe('dctx-1');
    expect(filtered.run_id).toBe('dexec-1');
  });
});

describe('department-mesh privacy allowlist — content redaction at metadata tier', () => {
  test('a department message is redacted like a pipeline question, not shipped verbatim', () => {
    const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event: SAMPLE_EVENTS[2]! });
    const filtered = filterDept(envelope, 'metadata');
    expect(JSON.stringify(filtered)).not.toContain('SECRET_MESSAGE');
    expect(filtered.data).toEqual({ parts: [{ text: MESSAGE_PARTS_PLACEHOLDER, media_type: 'text/plain' }] });
  });

  test('a department question is placeholdered exactly like awaiting_input.question', () => {
    const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event: SAMPLE_EVENTS[3]! });
    const filtered = filterDept(envelope, 'metadata');
    expect(JSON.stringify(filtered)).not.toContain('SECRET_QUESTION');
    expect(JSON.stringify(filtered)).not.toContain('SECRET_OPTION');
    expect(filtered.data).toEqual({ question_id: 'q-1', question: { text: QUESTION_PLACEHOLDER } });
  });

  test('an artifact path/bytes never ship at metadata tier — only name/media_type', () => {
    const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event: SAMPLE_EVENTS[4]! });
    const filtered = filterDept(envelope, 'metadata');
    expect(filtered.data).toEqual({ name: 'review.md', media_type: 'text/markdown' });
    expect(JSON.stringify(filtered)).not.toContain('/SECRET/checkout');
  });

  test('status/progress/completed/failed free-text is truncated-but-present (summary), never dropped entirely', () => {
    const longMessage = 'x'.repeat(500);
    const statusEnvelope = buildDepartmentJournalEnvelope({
      ...ENVELOPE,
      event: { type: 'status', state: 'WORKING', message: longMessage },
    });
    const filtered = filterDept(statusEnvelope, 'metadata');
    expect(typeof filtered.data).toBe('object');
    const data = filtered.data as Record<string, unknown>;
    expect((data.message as string).length).toBeLessThan(longMessage.length);
    expect(data.state).toBe('WORKING');
  });

  test('events/full tiers ship department content verbatim (no filtering above metadata)', () => {
    const envelope = buildDepartmentJournalEnvelope({ ...ENVELOPE, event: SAMPLE_EVENTS[2]! });
    const filtered = filterDept(envelope, 'events');
    expect(JSON.stringify(filtered)).toContain('SECRET_MESSAGE');
  });
});
