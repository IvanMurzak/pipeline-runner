import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import { makeLease, makeRecord } from './_helpers';
import { DEFAULT_LEASE_TTL_S, JobStore, recordFromLease } from './job-store';

const DIR = join('/data', 'jobs');

function makeStore(): { store: JobStore; fs: MemShipperFs; clock: FakeClock; logger: CaptureLogger } {
  const fs = new MemShipperFs();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  return { store: new JobStore({ fs, dir: DIR, clock, logger }), fs, clock, logger };
}

describe('recordFromLease', () => {
  test('accept-time record: phase preparing, no resume substrate yet, lease fields carried', () => {
    const lease = makeLease({ attempt: 2, event_seq_base: 2_000_000, execution_overrides: { model: 'opus' } });
    const record = recordFromLease(lease, '/w/job-1', '2026-07-17T00:00:00.000Z');
    expect(record.job_id).toBe('job-1');
    expect(record.run_id).toBe('run-1');
    expect(record.attempt).toBe(2);
    expect(record.phase).toBe('preparing');
    expect(record.checkout_dir).toBe('/w/job-1');
    expect(record.pipeline_root).toBeNull();
    expect(record.start_iteration).toBeNull();
    expect(record.event_seq_base).toBe(2_000_000);
    expect(record.execution_overrides).toEqual({ model: 'opus' });
    expect(record.lease_ttl_s).toBe(60);
    expect(record.accepted_at).toBe('2026-07-17T00:00:00.000Z');
  });

  test('defaults: attempt 1, design lease TTL when the lease omits one', () => {
    const lease = makeLease();
    delete (lease as Record<string, unknown>).lease_ttl_s;
    const record = recordFromLease(lease, '/w/job-1', '2026-07-17T00:00:00.000Z');
    expect(record.attempt).toBe(1);
    expect(record.lease_ttl_s).toBe(DEFAULT_LEASE_TTL_S);
  });

  test('NO job_jwt is ever persisted (04 secret hygiene)', () => {
    const record = recordFromLease(makeLease(), '/w/job-1', '2026-07-17T00:00:00.000Z');
    expect(JSON.stringify(record)).not.toContain('jwt-secret-1');
    expect('job_jwt' in record).toBe(false);
  });
});

describe('JobStore — record lifecycle', () => {
  test('write → read round-trips; update patches and renews updated_at; touch renews only', () => {
    const { store, clock } = makeStore();
    store.write(makeRecord({ job_id: 'j1' }));
    expect(store.read('j1')?.phase).toBe('running');

    clock.advance(5_000);
    const updated = store.update('j1', { phase: 'awaiting_input' });
    expect(updated?.phase).toBe('awaiting_input');
    expect(updated?.updated_at).toBe(new Date(5_000).toISOString());

    clock.advance(5_000);
    store.touch('j1');
    const touched = store.read('j1');
    expect(touched?.phase).toBe('awaiting_input'); // unchanged
    expect(touched?.updated_at).toBe(new Date(10_000).toISOString());
  });

  test('update of a missing record is a null no-op; remove is idempotent', () => {
    const { store } = makeStore();
    expect(store.update('ghost', { phase: 'running' })).toBeNull();
    store.remove('ghost'); // no throw
  });

  test('a corrupt record file is set aside as .corrupt and reported missing', () => {
    const { store, fs, logger } = makeStore();
    fs.mkdirp(DIR);
    fs.writeFileText(join(DIR, 'bad.json'), '{not json');
    expect(store.read('bad')).toBeNull();
    expect(fs.readFileText(join(DIR, 'bad.json'))).toBeNull();
    expect(fs.readFileText(join(DIR, 'bad.json.corrupt'))).toBe('{not json');
    expect(logger.joined()).toContain('set aside');
  });

  test('list returns every well-formed record', () => {
    const { store } = makeStore();
    store.write(makeRecord({ job_id: 'j1', run_id: 'r1' }));
    store.write(makeRecord({ job_id: 'j2', run_id: 'r2' }));
    expect(store.list().map((r) => r.job_id).sort()).toEqual(['j1', 'j2']);
  });
});

describe('JobStore — supersede + by-run_id uniqueness (04)', () => {
  test('supersede writes the new record then deletes the old one', () => {
    const { store } = makeStore();
    store.write(makeRecord({ job_id: 'j-old', run_id: 'r1' }));
    store.supersede('j-old', makeRecord({ job_id: 'j-new', run_id: 'r1', attempt: 2, accepted_at: '2026-01-02T00:00:00.000Z' }));
    expect(store.read('j-old')).toBeNull();
    expect(store.read('j-new')?.attempt).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  test('crash mid-supersede (two records, one run): list keeps the newest accepted_at and DELETES the loser', () => {
    const { store, logger } = makeStore();
    // Simulate the crash window: both files on disk for the same run.
    store.write(makeRecord({ job_id: 'j-old', run_id: 'r1', accepted_at: '2026-01-01T00:00:00.000Z' }));
    store.write(makeRecord({ job_id: 'j-new', run_id: 'r1', attempt: 2, accepted_at: '2026-01-02T00:00:00.000Z' }));

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.job_id).toBe('j-new');
    expect(store.read('j-old')).toBeNull(); // loser deleted on sight
    expect(logger.joined()).toContain('by-run_id uniqueness');
  });

  test('uniqueness resolution is order-independent (newest wins regardless of scan order)', () => {
    const { store } = makeStore();
    // Written in the OTHER order (newest first) — same outcome.
    store.write(makeRecord({ job_id: 'j-new', run_id: 'r1', attempt: 2, accepted_at: '2026-01-02T00:00:00.000Z' }));
    store.write(makeRecord({ job_id: 'j-old', run_id: 'r1', accepted_at: '2026-01-01T00:00:00.000Z' }));
    expect(store.list().map((r) => r.job_id)).toEqual(['j-new']);
  });
});
