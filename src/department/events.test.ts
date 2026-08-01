/**
 * Journal envelope + per-department index (simplified-onboarding b4;
 * `05-department-project.md` §6). Schema 2 is what `pipeline department status`
 * needs to render a sender and an engine column at all, and the index is what
 * lets it find one department's executions without opening every execution
 * directory under the journal root.
 *
 * The load-bearing compatibility claim — "envelopes are append-only; keep old
 * lines readable" — is tested against a VERBATIM schema-1 line, not against a
 * line this build produced.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { DeptMessage } from './adapter';
import {
  buildDepartmentIndexEntry,
  buildDepartmentJournalEnvelope,
  DEPARTMENT_JOURNAL_SCHEMA,
  departmentIndexPath,
  departmentJournalPath,
  parseDepartmentIndexLine,
  senderFromMessages,
} from './events';

const ENVELOPE_OPTS = {
  executionId: 'dexec-1',
  taskId: 'dtask-1',
  contextId: 'dctx-1',
  departmentId: 'unity-department',
  sender: 'ivan@acme',
  engine: 'claude-code',
  nowIso: '2026-07-26T14:22:00.000Z',
};

/** A journal line exactly as this package wrote it before b4 — kept verbatim,
 *  since the point is that a line NO CURRENT CODE PATH produces still reads. */
const SCHEMA_1_LINE = JSON.stringify({
  schema: 1,
  ts: '2026-07-23T00:00:00.000Z',
  type: 'department.progress',
  run_id: 'dexec-old',
  task_id: 'dtask-old',
  context_id: 'dctx-old',
  data: { note: '12/40 scripts analysed' },
});

describe('journal envelope — schema 2 identity fields (05 §6)', () => {
  test('every envelope carries the department, the sender and the ENGINE name', () => {
    const envelope = buildDepartmentJournalEnvelope({
      ...ENVELOPE_OPTS,
      event: { type: 'progress', note: 'using Read' },
    });
    expect(envelope.schema).toBe(2);
    expect(envelope.department_id).toBe('unity-department');
    expect(envelope.sender).toBe('ivan@acme');
    expect(envelope.engine).toBe('claude-code');
    // Unchanged from schema 1, field for field.
    expect(envelope.run_id).toBe('dexec-1');
    expect(envelope.task_id).toBe('dtask-1');
    expect(envelope.context_id).toBe('dctx-1');
    expect(envelope.type).toBe('department.progress');
    expect(envelope.data).toEqual({ note: 'using Read' });
  });

  test('an unstated sender / an unregistered engine are null, never omitted (status renders `—`)', () => {
    const envelope = buildDepartmentJournalEnvelope({
      ...ENVELOPE_OPTS,
      sender: null,
      engine: null,
      event: { type: 'completed' },
    });
    expect(envelope.sender).toBeNull();
    expect(envelope.engine).toBeNull();
    expect('sender' in envelope).toBe(true);
    expect('engine' in envelope).toBe(true);
  });

  test('an old (schema 1) line still parses, and every field a v1 reader reads is still there', () => {
    const old = JSON.parse(SCHEMA_1_LINE) as Record<string, unknown>;
    expect(old.schema).toBe(1);
    expect(old.type).toBe('department.progress');
    expect(old.run_id).toBe('dexec-old');
    expect(old.task_id).toBe('dtask-old');
    expect(old.context_id).toBe('dctx-old');
    expect(old.data).toEqual({ note: '12/40 scripts analysed' });
    // The three added fields are simply absent — the version bump is a hint to
    // a reader, not a format break.
    expect(old.department_id).toBeUndefined();
    expect(old.sender).toBeUndefined();
    expect(old.engine).toBeUndefined();
  });

  test('schema 2 is a strict superset of schema 1: nothing was renamed, removed or re-typed', () => {
    const old = JSON.parse(SCHEMA_1_LINE) as Record<string, unknown>;
    const fresh = buildDepartmentJournalEnvelope({
      ...ENVELOPE_OPTS,
      event: { type: 'progress', note: '12/40 scripts analysed' },
    }) as unknown as Record<string, unknown>;
    for (const key of Object.keys(old)) {
      expect(key in fresh).toBe(true);
      expect(typeof fresh[key]).toBe(typeof old[key]);
    }
    expect(DEPARTMENT_JOURNAL_SCHEMA).toBe(2);
  });
});

describe('sender extraction (the same key the session context reads)', () => {
  function message(overrides: Partial<DeptMessage> = {}): DeptMessage {
    return { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'do the thing' }], ...overrides };
  }

  test('reads metadata.sender off the opening user message', () => {
    expect(senderFromMessages([message({ metadata: { sender: 'ivan@acme' } })])).toBe('ivan@acme');
  });

  test('skips OUR OWN turns to find the sender of the task', () => {
    // The intent is unchanged — our own reply must never be read as the
    // sender. What identifies it is `selfAuthored`, not the role: a calling
    // department's agent legitimately sends ROLE_AGENT, and treating that as
    // "ours" is what made cross-department tasks record no sender at all.
    const messages = [
      message({ role: 'ROLE_AGENT', selfAuthored: true, metadata: { sender: 'not-the-sender' } }),
      message({ messageId: 'm2', metadata: { sender: 'ivan@acme' } }),
    ];
    expect(senderFromMessages(messages)).toBe('ivan@acme');
  });

  test('an inbound ROLE_AGENT message IS the sender — another department is not us', () => {
    const messages = [message({ role: 'ROLE_AGENT', metadata: { sender: 'software (TD)' } })];
    expect(senderFromMessages(messages)).toBe('software (TD)');
  });

  test('no metadata, a non-string sender, or a blank one is null — never invented', () => {
    expect(senderFromMessages([message()])).toBeNull();
    expect(senderFromMessages([message({ metadata: {} })])).toBeNull();
    expect(senderFromMessages([message({ metadata: { sender: 42 } })])).toBeNull();
    expect(senderFromMessages([message({ metadata: { sender: '   ' } })])).toBeNull();
    expect(senderFromMessages([])).toBeNull();
  });

  test('is flattened to one line and bounded — a journal line is not a place for prose', () => {
    const long = senderFromMessages([message({ metadata: { sender: `${'x'.repeat(500)}\n\nmore` } })]);
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(201);
    expect(long).not.toContain('\n');
  });
});

describe('per-department index — resolves without scanning every execution directory', () => {
  test('the index path is a pure computation from the department id', () => {
    expect(departmentIndexPath('/data/department', 'unity-department')).toBe(
      join('/data/department', 'by-department', 'unity-department', 'executions.jsonl'),
    );
    // Ids are caller-minted (offer frame): a traversal attempt becomes one
    // flat, harmless path segment.
    expect(departmentIndexPath('/data/department', '../../etc')).toBe(
      join('/data/department', 'by-department', '.._.._etc', 'executions.jsonl'),
    );
  });

  test('the journal path is unchanged from schema 1', () => {
    expect(departmentJournalPath('/data/department', 'dexec-1')).toBe(join('/data/department', 'dexec-1', 'events.jsonl'));
  });

  test('an index entry names the execution, who sent it, what ran it, and where its journal is', () => {
    const entry = buildDepartmentIndexEntry({
      executionId: 'dexec-1',
      taskId: 'dtask-1',
      contextId: 'dctx-1',
      departmentId: 'unity-department',
      sender: 'ivan@acme',
      engine: 'claude-code',
      journalPath: departmentJournalPath('/data/department', 'dexec-1'),
      nowIso: '2026-07-26T14:22:00.000Z',
    });
    expect(entry).toEqual({
      schema: 1,
      ts: '2026-07-26T14:22:00.000Z',
      type: 'department.execution_started',
      department_id: 'unity-department',
      run_id: 'dexec-1',
      task_id: 'dtask-1',
      context_id: 'dctx-1',
      engine: 'claude-code',
      sender: 'ivan@acme',
      journal_path: join('/data/department', 'dexec-1', 'events.jsonl'),
    });
    // Round-trips: what a reader gets back is what was written.
    expect(parseDepartmentIndexLine(JSON.stringify(entry))).toEqual(entry);
  });

  test('a truncated or foreign line is skipped, not thrown on — an index is a convenience, not the truth', () => {
    expect(parseDepartmentIndexLine('{"schema":1,"type":"department.exec')).toBeNull();
    expect(parseDepartmentIndexLine('null')).toBeNull();
    expect(parseDepartmentIndexLine('[]')).toBeNull();
    expect(parseDepartmentIndexLine(JSON.stringify({ type: 'something.else', run_id: 'x', department_id: 'y' }))).toBeNull();
    expect(parseDepartmentIndexLine(JSON.stringify({ type: 'department.execution_started', run_id: '' }))).toBeNull();
  });
});
