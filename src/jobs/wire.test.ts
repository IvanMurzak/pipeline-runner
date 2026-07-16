import { describe, expect, test } from 'bun:test';
import { buildAcceptFrame, buildRunStatusFrame, isLeaseMessage, TASK_PIPELINE_UNRESOLVED } from './wire';
import { makeLease, makeTaskLease } from './_helpers';

describe('jobs wire — lease guard', () => {
  test('accepts a well-formed lease', () => {
    expect(isLeaseMessage(makeLease())).toBe(true);
  });

  test('accepts a lease without optional fields (id, lease_ttl_s, content_hash)', () => {
    const lease = makeLease();
    delete lease.id;
    delete lease.lease_ttl_s;
    delete (lease.pipeline_ref as Record<string, unknown>).content_hash;
    expect(isLeaseMessage(lease)).toBe(true);
  });

  test('preserves passthrough extras (additive-forward)', () => {
    const lease = makeLease({ future_field: { nested: true } } as never);
    expect(isLeaseMessage(lease)).toBe(true);
    expect((lease as Record<string, unknown>).future_field).toEqual({ nested: true });
  });

  test.each([
    ['missing job_id', { job_id: '' }],
    ['missing run_id', { run_id: undefined }],
    ['missing job_jwt', { job_jwt: '' }],
    ['non-array labels', { labels: 'os:linux' }],
    ['non-string label member', { labels: ['ok', 7] }],
    ['non-array secret_slugs', { secret_slugs: null }],
    ['zero lease_ttl_s', { lease_ttl_s: 0 }],
    ['fractional lease_ttl_s', { lease_ttl_s: 1.5 }],
  ] as Array<[string, Record<string, unknown>]>)('rejects a lease with %s', (_name, patch) => {
    const lease = { ...makeLease(), ...patch };
    expect(isLeaseMessage(lease as never)).toBe(false);
  });

  test.each([
    ['not an object', 'nope'],
    ['missing repo', { ref: 'main', pipeline: 'p' }],
    ['empty ref', { repo: 'r', ref: '', pipeline: 'p' }],
    ['missing pipeline', { repo: 'r', ref: 'main' }],
    ['empty content_hash', { repo: 'r', ref: 'main', pipeline: 'p', content_hash: '' }],
  ] as Array<[string, unknown]>)('rejects a malformed pipeline_ref: %s', (_name, ref) => {
    expect(isLeaseMessage(makeLease({ pipeline_ref: ref as never }))).toBe(false);
  });

  test('rejects a non-lease frame type', () => {
    expect(isLeaseMessage({ ...makeLease(), type: 'cancel' } as never)).toBe(false);
  });
});

// T2-05: the ADDITIVE task-dispatch lease shape.
describe('jobs wire — task-dispatch lease guard (T2-05)', () => {
  test('the sentinel matches the protocol contract', () => {
    expect(TASK_PIPELINE_UNRESOLVED).toBe('@task');
  });

  test('accepts a well-formed task lease (sentinel pipeline, empty secret_slugs)', () => {
    const lease = makeTaskLease();
    expect(isLeaseMessage(lease)).toBe(true);
    expect(lease.pipeline_ref.pipeline).toBe(TASK_PIPELINE_UNRESOLVED);
    expect(lease.secret_slugs).toEqual([]);
  });

  test('accepts an empty body and empty labels (title says it all)', () => {
    expect(isLeaseMessage(makeTaskLease({ body: '', labels: [] }))).toBe(true);
  });

  test('preserves passthrough extras inside the task (additive-forward)', () => {
    const lease = makeTaskLease({ priority: 7 } as never);
    expect(isLeaseMessage(lease)).toBe(true);
    expect((lease.task as Record<string, unknown>).priority).toBe(7);
  });

  test.each([
    ['empty task_id', { task_id: '' }],
    ['missing task_id', { task_id: undefined }],
    ['empty title', { title: '' }],
    ['missing title', { title: undefined }],
    ['missing body', { body: undefined }],
    ['non-string body', { body: 42 }],
    ['non-array labels', { labels: 'release' }],
    ['non-string label member', { labels: ['ok', 7] }],
  ] as Array<[string, Record<string, unknown>]>)('rejects a task with %s', (_name, patch) => {
    expect(isLeaseMessage(makeTaskLease(patch as never))).toBe(false);
  });

  test('rejects a non-object task', () => {
    expect(isLeaseMessage(makeTaskLease({}, { task: 'do it' } as never))).toBe(false);
    expect(isLeaseMessage(makeTaskLease({}, { task: ['do', 'it'] } as never))).toBe(false);
  });

  test('an ABSENT task keeps the T2-03 fixed-pipeline lease valid (regression)', () => {
    const lease = makeLease();
    expect('task' in lease).toBe(false);
    expect(isLeaseMessage(lease)).toBe(true);
  });
});

// T3-06: the ADDITIVE matrix-run execution-overrides shape.
describe('jobs wire — execution-overrides lease guard (T3-06)', () => {
  test('accepts a lease with both model and effort overrides', () => {
    const lease = makeLease({ execution_overrides: { model: 'opus', effort: 'high' } });
    expect(isLeaseMessage(lease)).toBe(true);
    expect(lease.execution_overrides).toEqual({ model: 'opus', effort: 'high' });
  });

  test('accepts a partial override (model only)', () => {
    expect(isLeaseMessage(makeLease({ execution_overrides: { model: 'sonnet' } }))).toBe(true);
  });

  test('accepts a partial override (effort only)', () => {
    expect(isLeaseMessage(makeLease({ execution_overrides: { effort: 'max' } }))).toBe(true);
  });

  test('accepts an empty overrides object (a cell overriding neither)', () => {
    expect(isLeaseMessage(makeLease({ execution_overrides: {} }))).toBe(true);
  });

  test('accepts a canonical claude-* model id (validity is computePlan\'s job, not the guard)', () => {
    expect(isLeaseMessage(makeLease({ execution_overrides: { model: 'claude-opus-4-8' } }))).toBe(true);
    // Shape-valid but semantically unknown values still pass the guard — the
    // CLI/computePlan warn-and-inherit on them; the wire only rejects bad SHAPE.
    expect(isLeaseMessage(makeLease({ execution_overrides: { model: 'nonsense', effort: 'turbo' } }))).toBe(true);
  });

  test('preserves passthrough extras inside execution_overrides (additive-forward)', () => {
    const lease = makeLease({ execution_overrides: { model: 'opus', cell_id: 3 } as never });
    expect(isLeaseMessage(lease)).toBe(true);
    expect((lease.execution_overrides as Record<string, unknown>).cell_id).toBe(3);
  });

  test.each([
    ['non-object (string)', 'opus'],
    ['array', ['opus']],
    ['null', null],
    ['non-string model', { model: 42 }],
    ['empty-string model', { model: '' }],
    ['non-string effort', { effort: true }],
    ['empty-string effort', { effort: '' }],
  ] as Array<[string, unknown]>)('rejects execution_overrides that are %s', (_name, value) => {
    expect(isLeaseMessage(makeLease({ execution_overrides: value as never }))).toBe(false);
  });

  test('an ABSENT execution_overrides keeps the lease valid (regression)', () => {
    const lease = makeLease();
    expect('execution_overrides' in lease).toBe(false);
    expect(isLeaseMessage(lease)).toBe(true);
  });
});

describe('jobs wire — accept', () => {
  test('echoes the lease correlation id and carries identity', () => {
    const accept = buildAcceptFrame(makeLease({ id: 'corr-9' }), 'r-1');
    expect(accept).toEqual({ type: 'accept', id: 'corr-9', runner_id: 'r-1', job_id: 'job-1', run_id: 'run-1' });
  });

  test('omits id when the lease had none', () => {
    const lease = makeLease();
    delete lease.id;
    const accept = buildAcceptFrame(lease, 'r-1');
    expect('id' in accept).toBe(false);
  });
});

describe('jobs wire — run_status', () => {
  test('started carries no terminal detail', () => {
    expect(buildRunStatusFrame('run-1', 'job-1', 'started')).toEqual({
      type: 'run_status',
      run_id: 'run-1',
      job_id: 'job-1',
      phase: 'started',
    });
  });

  test('completed carries the outcome', () => {
    const frame = buildRunStatusFrame('run-1', 'job-1', 'completed', { outcome: 'completed' });
    expect(frame.phase).toBe('completed');
    expect(frame.outcome).toBe('completed');
    expect('halt_reason' in frame).toBe(false);
  });

  test('halted carries the halt reason', () => {
    const frame = buildRunStatusFrame('run-1', 'job-1', 'halted', { halt_reason: 'boom' });
    expect(frame.phase).toBe('halted');
    expect(frame.halt_reason).toBe('boom');
  });
});
