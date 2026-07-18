import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import {
  AbortableHangExec,
  DRIVE_COMPLETED,
  DRIVE_PROVIDER_LIMIT,
  driveAwaiting,
  FakeJobExec,
  FakeJobFs,
  FrameSink,
  GIT_OK,
  makeLease,
  makeProbe,
  makeRecord,
} from './_helpers';
import type { JobExecResult } from './types';
import { DEFAULT_PROVIDER_LIMIT_PAUSE_MS, type JobResult } from './executor';
import { JobStore, type JobRecord } from './job-store';
import { attachJobExecution, JobManager, type JobManagerOptions } from './manager';
import type { RetentionPolicy } from './retention';
import { defaultResolveStartIteration } from './workspace';

const ROOT = join('/w');

/** Seed the fs so a given job id's fixture workspace prepares successfully. */
function seedJob(fs: FakeJobFs, jobId: string): void {
  const pipelineRoot = join(ROOT, jobId, '.claude', 'pipeline', 'release');
  fs.existing.add(pipelineRoot);
  fs.listings.set(join(pipelineRoot, 'steps'), ['01-plan.md']);
}

interface World {
  manager: JobManager;
  dispatcher: Dispatcher;
  exec: FakeJobExec;
  fs: FakeJobFs;
  sink: FrameSink;
  clock: FakeClock;
  logger: CaptureLogger;
  finished: JobResult[];
}

function makeWorld(
  respondDrive: (args: string[]) => JobExecResult | Promise<JobExecResult>,
  overrides: Partial<JobManagerOptions> = {}
): World {
  const dispatcher = new Dispatcher();
  const exec = new FakeJobExec((cmd, args) => (cmd === 'git' ? GIT_OK : respondDrive(args)));
  const fs = new FakeJobFs();
  seedJob(fs, 'job-1');
  seedJob(fs, 'job-2');
  const sink = new FrameSink();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const finished: JobResult[] = [];
  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    labels: () => ['os:linux', 'repo:acme/api'],
    exec,
    fs,
    clock,
    logger,
    // c4: pin the PLAIN LEXICAL resolver by default — this suite's
    // `world.exec.of('pipeline')` counts assume the only 'pipeline'-cmd call
    // is drive. The c4 default-seam wiring itself is covered by
    // workspace.test.ts + executor.test.ts.
    resolveStartIteration: defaultResolveStartIteration,
    events: { onJobFinished: (result) => finished.push(result) },
    ...overrides,
  });
  manager.attach(dispatcher);
  return { manager, dispatcher, exec, fs, sink, clock, logger, finished };
}

describe('JobManager — accept round-trip', () => {
  test('lease in → accept out with the echoed correlation id and this runner id', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease({ id: 'corr-7' }));
    await tick();

    expect(world.sink.ofType('accept')).toEqual([
      { type: 'accept', id: 'corr-7', runner_id: 'r-1', job_id: 'job-1', run_id: 'run-1' },
    ]);
    // The full pipeline ran: checkout + drive + lifecycle frames.
    expect(world.exec.of('pipeline')).toHaveLength(1);
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(world.finished).toEqual([{ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' }]);
    expect(world.manager.activeCount).toBe(0); // job finished and deregistered
  });

  test('a malformed lease is ignored (no accept, no job)', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch({ type: 'lease', job_id: 'job-1' }); // missing everything else
    expect(world.sink.frames).toEqual([]);
    expect(world.manager.activeCount).toBe(0);
    expect(world.logger.joined()).toContain('malformed lease ignored');
  });
});

describe('JobManager — preconditions', () => {
  test('declined before registration (no runner_id yet)', () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { runnerId: () => null });
    world.dispatcher.dispatch(makeLease());
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('runner not registered');
  });

  test('declined while draining', () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { draining: () => true });
    world.dispatcher.dispatch(makeLease());
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('draining');
  });

  test('declined at capacity while a job is in flight', async () => {
    let releaseFirst: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (releaseFirst = resolve)));
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    await tick();
    expect(world.manager.activeCount).toBe(1);

    world.dispatcher.dispatch(makeLease({ id: 'c2', job_id: 'job-2', run_id: 'run-2' }));
    expect(world.sink.ofType('accept')).toHaveLength(1); // job-2 declined
    expect(world.logger.joined()).toContain('at capacity (1/1)');

    releaseFirst(DRIVE_COMPLETED);
    await tick();
    expect(world.manager.activeCount).toBe(0);
  });

  test('a higher capacity() admits parallel jobs', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { capacity: () => 2 });
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    world.dispatcher.dispatch(makeLease({ id: 'c2', job_id: 'job-2', run_id: 'run-2' }));
    await tick();
    expect(world.sink.ofType('accept')).toHaveLength(2);
    expect(world.finished).toHaveLength(2);
  });

  test('a redelivered lease for an ACTIVE job re-acknowledges without a second run', async () => {
    let release: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (release = resolve)));
    world.dispatcher.dispatch(makeLease({ id: 'c1' }));
    await tick();
    world.dispatcher.dispatch(makeLease({ id: 'c1-redelivery' }));

    const accepts = world.sink.ofType('accept');
    expect(accepts).toHaveLength(2);
    expect(accepts[1]!.id).toBe('c1-redelivery');
    expect(world.manager.activeCount).toBe(1);
    expect(world.exec.of('pipeline')).toHaveLength(1); // never started twice

    release(DRIVE_COMPLETED);
    await tick();
  });

  test('declined when the lease asks for an unadvertised label', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease({ labels: ['os:linux', 'gpu'] }));
    expect(world.sink.frames).toEqual([]);
    expect(world.logger.joined()).toContain('unadvertised labels: gpu');
  });

  test('without a labels() accessor any label set is admitted', async () => {
    const world = makeWorld(() => DRIVE_COMPLETED, { labels: undefined });
    world.dispatcher.dispatch(makeLease({ labels: ['anything'] }));
    await tick();
    expect(world.sink.ofType('accept')).toHaveLength(1);
  });

  test('an offline connection means no accept and no job start', () => {
    const world = makeWorld(() => DRIVE_COMPLETED);
    world.sink.online = false;
    world.dispatcher.dispatch(makeLease());
    expect(world.manager.activeCount).toBe(0);
    expect(world.exec.calls).toHaveLength(0);
    expect(world.logger.joined()).toContain('not accepted — connection not online');
  });
});

describe('JobManager — heartbeat composition accessors', () => {
  test('activeRunIds reflects in-flight runs and empties on completion', async () => {
    let release: (r: JobExecResult) => void = () => {};
    const world = makeWorld(() => new Promise((resolve) => (release = resolve)));
    expect(world.manager.activeRunIds()).toEqual([]);
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.manager.activeRunIds()).toEqual(['run-1']);
    release(DRIVE_COMPLETED);
    await tick();
    expect(world.manager.activeRunIds()).toEqual([]);
  });

  test('runnerStatus/pausedUntil surface a provider-limit pause', async () => {
    const results = [DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED];
    const world = makeWorld(() => results.shift()!);
    expect(world.manager.runnerStatus()).toBe('online');
    world.dispatcher.dispatch(makeLease());
    await tick();

    expect(world.manager.runnerStatus()).toBe('paused');
    expect(world.manager.pausedUntil()).toBe(new Date(DEFAULT_PROVIDER_LIMIT_PAUSE_MS).toISOString());

    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    expect(world.manager.runnerStatus()).toBe('online');
    expect(world.manager.pausedUntil()).toBeNull();
  });

  // c2 invariant (06.3): a paused OR awaiting-input job MUST stay in
  // active_run_ids — otherwise a parked run on a live runner would look
  // idle to the cloud's per-run lease refresher and get interrupted out
  // from under it. The manager's `active` map already guarantees this (it
  // only ever deletes on the executor's terminal settle); these tests
  // assert the invariant explicitly at the heartbeat-composition boundary.
  test('a provider-limit-paused run stays in activeRunIds (not just runnerStatus)', async () => {
    const results = [DRIVE_PROVIDER_LIMIT, DRIVE_COMPLETED];
    const world = makeWorld(() => results.shift()!);
    world.dispatcher.dispatch(makeLease());
    await tick();

    expect(world.manager.runnerStatus()).toBe('paused');
    expect(world.manager.activeRunIds()).toEqual(['run-1']); // still reported while paused

    world.clock.advance(DEFAULT_PROVIDER_LIMIT_PAUSE_MS);
    await tick();
    expect(world.manager.activeRunIds()).toEqual([]); // resumed → completed → deregistered
  });

  test('an awaiting-input-parked run stays in activeRunIds (status stays "online" — only provider-limit pauses report "paused")', async () => {
    let release: (answer: string | null) => void = () => {};
    const results = [driveAwaiting(), DRIVE_COMPLETED];
    const world = makeWorld(() => results.shift()!, {
      needsInput: { onQuestion: () => new Promise<string | null>((resolve) => (release = resolve)) },
    });
    world.dispatcher.dispatch(makeLease());
    await tick();

    expect(world.manager.activeRunIds()).toEqual(['run-1']); // parked, still active
    expect(world.manager.runnerStatus()).toBe('online'); // awaiting-input ≠ provider-limit pause
    expect(world.manager.pausedUntil()).toBeNull();

    release('host-a');
    await tick();
    expect(world.manager.activeRunIds()).toEqual([]); // answered → resumed → completed → deregistered
  });
});

describe('attachJobExecution', () => {
  test('composes over an AgentClient-shaped surface (dispatcher + send)', async () => {
    const dispatcher = new Dispatcher();
    const sink = new FrameSink();
    const exec = new FakeJobExec((cmd) => (cmd === 'git' ? GIT_OK : DRIVE_COMPLETED));
    const fs = new FakeJobFs();
    seedJob(fs, 'job-1');
    const manager = attachJobExecution(
      { dispatcher, send: sink.send },
      { runnerId: () => 'r-1', workspaceRoot: ROOT, exec, fs, clock: new FakeClock() }
    );
    dispatcher.dispatch(makeLease());
    await tick();
    expect(sink.ofType('accept')).toHaveLength(1);
    expect(sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(manager.activeCount).toBe(0);
  });

  test('importing + attaching alone starts nothing (construction-time-lazy)', () => {
    const dispatcher = new Dispatcher();
    const sink = new FrameSink();
    const exec = new FakeJobExec(() => GIT_OK);
    const clock = new FakeClock();
    attachJobExecution(
      { dispatcher, send: sink.send },
      { runnerId: () => 'r-1', workspaceRoot: ROOT, exec, fs: new FakeJobFs(), clock }
    );
    expect(exec.calls).toHaveLength(0);
    expect(sink.frames).toEqual([]);
    expect(clock.pendingCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// c6 (design 04 — D1): durable records, reconcile/quarantine/adoption, cancel
// handler, terminal workspace lifecycle + retention GC, graceful suspend.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_DIR = join('/data', 'jobs');
const OLD_CHECKOUT = join(ROOT, 'job-old');

/** A recoverable stored record rooted under this suite's fixture paths, with
 *  `updated_at` pinned to the FakeClock epoch (t=0) so tests steer freshness
 *  by advancing the clock. */
function storedRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return makeRecord({
    checkout_dir: OLD_CHECKOUT,
    pipeline_root: join(OLD_CHECKOUT, '.claude', 'pipeline', 'release'),
    accepted_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  });
}

interface C6World extends World {
  store: JobStore;
  memFs: MemShipperFs;
}

function makeC6World(
  respondDrive: (args: string[]) => JobExecResult | Promise<JobExecResult>,
  opts: {
    records?: JobRecord[];
    retention?: RetentionPolicy;
    exec?: FakeJobExec;
    overrides?: Partial<JobManagerOptions>;
  } = {}
): C6World {
  const dispatcher = new Dispatcher();
  const exec = opts.exec ?? new FakeJobExec((cmd, args) => (cmd === 'git' ? GIT_OK : respondDrive(args)));
  const fs = new FakeJobFs();
  seedJob(fs, 'job-1');
  seedJob(fs, 'job-new');
  const sink = new FrameSink();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const finished: JobResult[] = [];
  const memFs = new MemShipperFs();
  const store = new JobStore({ fs: memFs, dir: STORE_DIR, clock, logger });
  for (const record of opts.records ?? []) store.write(record);
  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    labels: () => ['os:linux', 'repo:acme/api'],
    exec,
    fs,
    clock,
    logger,
    resolveStartIteration: defaultResolveStartIteration,
    store,
    substrate: makeProbe(),
    retention: opts.retention,
    events: { onJobFinished: (result) => finished.push(result) },
    ...opts.overrides,
  });
  manager.attach(dispatcher);
  return { manager, dispatcher, exec, fs, sink, clock, logger, finished, store, memFs };
}

const HANG_FOREVER = (): Promise<JobExecResult> => new Promise<JobExecResult>(() => {});

describe('JobManager — c6 durable record at accept', () => {
  test('the record is written at ACCEPT, before any prep I/O, and gains the substrate after prep', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease());
    // Synchronous check — startJob writes the record BEFORE the (async)
    // executor runs any prep I/O (04: crash at any later point is findable).
    const atAccept = world.store.read('job-1');
    expect(atAccept).not.toBeNull();
    expect(atAccept!.phase).toBe('preparing');
    expect(atAccept!.checkout_dir).toBe(join(ROOT, 'job-1'));
    expect(atAccept!.pipeline_root).toBeNull();
    await tick();
    // Completed under default retention: record + workspace reaped (E6 fix).
    expect(world.store.read('job-1')).toBeNull();
    expect(world.fs.removed).toContain(join(ROOT, 'job-1'));
  });

  test('the record never contains the job JWT (04 secret hygiene)', async () => {
    const world = makeC6World(HANG_FOREVER);
    world.dispatcher.dispatch(makeLease());
    await tick();
    const raw = world.memFs.readFileText(world.store.pathFor('job-1'));
    expect(raw).not.toBeNull();
    expect(raw!).not.toContain('jwt-secret-1');
  });

  test('heartbeat-tick writer: touchActiveRecords renews updated_at for ACTIVE jobs only', async () => {
    const stale = storedRecord({ job_id: 'job-q', run_id: 'run-q', lease_ttl_s: 1 });
    const world = makeC6World(HANG_FOREVER, { records: [stale] });
    world.clock.advance(120_000);
    world.manager.reconcile(); // run-q → quarantined
    world.dispatcher.dispatch(makeLease());
    await tick();

    world.clock.advance(5_000);
    world.manager.touchActiveRecords();
    expect(world.store.read('job-1')!.updated_at).toBe(new Date(125_000).toISOString());
    // Quarantined records are NOT touched — their staleness is the signal.
    expect(world.store.read('job-q')!.updated_at).toBe(new Date(0).toISOString());
  });
});

describe('JobManager — c6 startup reconcile', () => {
  test('FRESH record: listed in activeRunIds SYNCHRONOUSLY (before the first heartbeat), resumed with --resume, no wipe', async () => {
    const world = makeC6World(HANG_FOREVER, { records: [storedRecord()] });
    world.clock.advance(30_000); // 30s < 90s TTL
    const summary = world.manager.reconcile();

    expect(summary.resumed.map((r) => r.job_id)).toEqual(['job-old']);
    // The heartbeat-seeding guarantee: listed the moment reconcile returns.
    expect(world.manager.activeRunIds()).toEqual(['run-1']);

    await tick();
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toContain('--resume');
    expect(drive[0]!.opts.cwd).toBe(OLD_CHECKOUT);
    expect(world.exec.of('git')).toHaveLength(0); // no re-prep
    expect(world.fs.removed).toEqual([]); // no wipe
    // F1: silent resume — no run_status started.
    expect(world.sink.ofType('run_status')).toEqual([]);
  });

  test('STALE record: QUARANTINED — no spawn, no listing, capacity still free', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED, { records: [storedRecord()] });
    world.clock.advance(120_000); // 120s > 90s TTL
    const summary = world.manager.reconcile();

    expect(summary.quarantined.map((r) => r.run_id)).toEqual(['run-1']);
    expect(world.manager.activeRunIds()).toEqual([]); // never listed
    expect(world.exec.of('pipeline')).toHaveLength(0); // never spawned
    expect(world.manager.quarantinedCount).toBe(1);
    expect(world.store.read('job-old')).not.toBeNull(); // record + workspace kept

    // Capacity-free: an unrelated lease at capacity 1 is still admitted.
    world.dispatcher.dispatch(makeLease({ job_id: 'job-1', run_id: 'run-9' }));
    await tick();
    expect(world.sink.ofType('accept')).toHaveLength(1);
  });

  test('UNRECOVERABLE record: dropped + deferred run_status halted, flushed once online', () => {
    const world = makeC6World(() => DRIVE_COMPLETED, {
      records: [storedRecord()],
      overrides: { substrate: makeProbe({ nextJsonExists: () => false }) },
    });
    world.clock.advance(30_000);
    const summary = world.manager.reconcile();

    expect(summary.dropped).toHaveLength(1);
    expect(summary.dropped[0]!.reason).toContain('next.json');
    expect(world.store.read('job-old')).toBeNull(); // record dropped
    expect(world.fs.removed).toContain(OLD_CHECKOUT); // useless substrate reaped
    expect(world.sink.frames).toEqual([]); // pre-connect: nothing sent yet

    world.manager.flushDeferredReports();
    const frames = world.sink.ofType('run_status');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.phase).toBe('halted');
    expect(String(frames[0]!.halt_reason)).toContain('resume state lost/expired');
  });

  test('deferred reports survive an offline flush and send on the next one', () => {
    const world = makeC6World(() => DRIVE_COMPLETED, {
      records: [storedRecord()],
      overrides: { substrate: makeProbe({ checkoutExists: () => false }) },
    });
    world.clock.advance(30_000);
    world.manager.reconcile();

    world.sink.online = false;
    world.manager.flushDeferredReports();
    expect(world.sink.frames).toEqual([]);
    world.sink.online = true;
    world.manager.flushDeferredReports();
    expect(world.sink.ofType('run_status')).toHaveLength(1);
  });

  test('a tombstoned (terminal) record is never reconciled', () => {
    const world = makeC6World(() => DRIVE_COMPLETED, {
      records: [storedRecord({ terminal: { outcome: 'completed', at: new Date(0).toISOString() } })],
      retention: { keepForever: false, retentionMs: 3_600_000 },
    });
    world.clock.advance(30_000);
    const summary = world.manager.reconcile();
    expect(summary.resumed).toEqual([]);
    expect(summary.quarantined).toEqual([]);
    expect(summary.dropped).toEqual([]);
  });
});

describe('JobManager — c6 adoption', () => {
  test('resume_hint lease for a quarantined run ADOPTS: recorded cwd, superseded record, announced start', async () => {
    const world = makeC6World(HANG_FOREVER, { records: [storedRecord()] });
    world.clock.advance(120_000);
    world.manager.reconcile();
    expect(world.manager.quarantinedCount).toBe(1);

    world.dispatcher.dispatch(
      makeLease({ id: 'c-adopt', job_id: 'job-new', run_id: 'run-1', resume_hint: true, attempt: 2, event_seq_base: 2_000_000 })
    );
    await tick();

    expect(world.sink.ofType('accept')).toHaveLength(1); // accepted first (offer must not time out)
    // Superseded: new record carries the OLD checkout + new identity.
    expect(world.store.read('job-old')).toBeNull();
    const adopted = world.store.read('job-new');
    expect(adopted).not.toBeNull();
    expect(adopted!.checkout_dir).toBe(OLD_CHECKOUT);
    expect(adopted!.attempt).toBe(2);
    expect(adopted!.event_seq_base).toBe(2_000_000);
    expect(world.manager.quarantinedCount).toBe(0);
    // Drive re-entered in the RECORDED dir with {kind:'resume'}.
    const drive = world.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toContain('--resume');
    expect(drive[0]!.opts.cwd).toBe(OLD_CHECKOUT);
    // Adoption announces the NEW job's run_status started.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
    expect(world.manager.activeRunIds()).toEqual(['run-1']);
  });

  test('adoption REFUSED on pipeline_ref mismatch: quarantined leftovers discarded, fresh prep instead', async () => {
    const world = makeC6World(HANG_FOREVER, { records: [storedRecord()] });
    world.clock.advance(120_000);
    world.manager.reconcile();

    world.dispatcher.dispatch(
      makeLease({
        job_id: 'job-new',
        run_id: 'run-1',
        resume_hint: true,
        pipeline_ref: { repo: 'git@example.com:acme/OTHER.git', ref: 'main', pipeline: 'release', content_hash: null },
      })
    );
    await tick();

    expect(world.logger.joined()).toContain('adoption of run run-1 declined');
    expect(world.store.read('job-old')).toBeNull(); // by-run uniqueness: old record gone
    expect(world.fs.removed).toContain(OLD_CHECKOUT); // old workspace discarded
    expect(world.exec.of('git').length).toBeGreaterThan(0); // fresh checkout ran
    const record = world.store.read('job-new');
    expect(record).not.toBeNull();
    expect(record!.checkout_dir).toBe(join(ROOT, 'job-new'));
  });

  test('adoption REFUSED when the pinned hash no longer verifies', async () => {
    const pinnedRef = {
      repo: 'git@example.com:acme/api.git',
      ref: 'main',
      pipeline: 'release',
      content_hash: 'sha256:aaa',
    };
    const world = makeC6World(HANG_FOREVER, {
      records: [storedRecord({ pipeline_ref: pinnedRef })],
      overrides: { verifyContentHash: () => false },
    });
    world.clock.advance(120_000);
    world.manager.reconcile();

    world.dispatcher.dispatch(makeLease({ job_id: 'job-new', run_id: 'run-1', resume_hint: true, pipeline_ref: pinnedRef }));
    await tick();
    expect(world.logger.joined()).toContain('re-verify failed');
    expect(world.exec.of('git').length).toBeGreaterThan(0); // fell through to fresh prep
  });

  test('a NON-resume_hint lease for a quarantined run discards the leftovers and preps fresh (by-run uniqueness)', async () => {
    const world = makeC6World(HANG_FOREVER, { records: [storedRecord()] });
    world.clock.advance(120_000);
    world.manager.reconcile();

    world.dispatcher.dispatch(makeLease({ job_id: 'job-new', run_id: 'run-1' }));
    await tick();
    expect(world.store.read('job-old')).toBeNull();
    expect(world.fs.removed).toContain(OLD_CHECKOUT);
    expect(world.exec.of('git').length).toBeGreaterThan(0);
  });
});

describe('JobManager — c6 cancel handler (D8)', () => {
  test('cancel for an ACTIVE run: drive killed, record + workspace GONE, no terminal run_status', async () => {
    const exec = new AbortableHangExec();
    const world = makeC6World(HANG_FOREVER, { exec: exec as unknown as FakeJobExec });
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.manager.activeRunIds()).toEqual(['run-1']);

    world.dispatcher.dispatch({ type: 'cancel', run_id: 'run-1' });
    await tick();

    expect(world.manager.activeRunIds()).toEqual([]);
    expect(world.store.read('job-1')).toBeNull();
    expect(world.fs.removed).toContain(join(ROOT, 'job-1'));
    // started only — the server initiated the cancel.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
    expect(world.finished[0]).toMatchObject({ ok: false, cancelled: true });
  });

  test('cancel for a QUARANTINED run: record + workspace gone, nothing spawned', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED, { records: [storedRecord()] });
    world.clock.advance(120_000);
    world.manager.reconcile();

    world.dispatcher.dispatch({ type: 'cancel', run_id: 'run-1' });
    await tick();
    expect(world.manager.quarantinedCount).toBe(0);
    expect(world.store.read('job-old')).toBeNull();
    expect(world.fs.removed).toContain(OLD_CHECKOUT);
    expect(world.exec.of('pipeline')).toHaveLength(0);
  });

  test('cancel for a run this runner does NOT own is ignored', async () => {
    const world = makeC6World(HANG_FOREVER);
    world.dispatcher.dispatch(makeLease());
    await tick();
    world.dispatcher.dispatch({ type: 'cancel', run_id: 'run-elsewhere' });
    await tick();
    expect(world.manager.activeRunIds()).toEqual(['run-1']); // untouched
    expect(world.logger.joined()).toContain('not owned by this runner');
  });

  test('a malformed cancel is ignored', () => {
    const world = makeC6World(HANG_FOREVER);
    world.dispatcher.dispatch({ type: 'cancel' }); // no run_id
    expect(world.logger.joined()).toContain('malformed cancel ignored');
  });
});

describe('JobManager — c6 terminal lifecycle + retention GC (E6 fix, D15)', () => {
  test('default policy: a completed job reaps workspace AND record immediately', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED);
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.store.read('job-1')).toBeNull();
    expect(world.fs.removed).toContain(join(ROOT, 'job-1'));
  });

  test('retention window: terminal record is tombstoned, workspace kept; sweep reaps after the window', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED, {
      retention: { keepForever: false, retentionMs: 60_000 },
    });
    world.dispatcher.dispatch(makeLease());
    await tick();

    const tombstone = world.store.read('job-1');
    expect(tombstone).not.toBeNull();
    expect(tombstone!.terminal!.outcome).toBe('completed');
    expect(world.fs.removed).toEqual([]); // kept for the window

    expect(world.manager.sweepRetention()).toEqual([]); // window not passed
    world.clock.advance(60_000);
    expect(world.manager.sweepRetention()).toEqual(['job-1']);
    expect(world.store.read('job-1')).toBeNull();
    expect(world.fs.removed).toContain(join(ROOT, 'job-1'));
  });

  test('KEEP_WORKSPACES (keepForever): tombstoned, never swept', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED, {
      retention: { keepForever: true, retentionMs: null },
    });
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.store.read('job-1')!.terminal).toBeDefined();
    world.clock.advance(365 * 86_400_000);
    expect(world.manager.sweepRetention()).toEqual([]);
    expect(world.fs.removed).toEqual([]);
  });

  test('preserve_workspace (05.2 unshipped improvements) survives terminal AND the sweep', async () => {
    const world = makeC6World(async () => {
      // Mid-run, something flags the workspace preserved (the improver seam).
      world.store.update('job-1', { preserve_workspace: true });
      return DRIVE_COMPLETED;
    });
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.store.read('job-1')!.terminal).toBeDefined();
    expect(world.fs.removed).toEqual([]);
    world.clock.advance(365 * 86_400_000);
    expect(world.manager.sweepRetention()).toEqual([]);
    expect(world.fs.removed).toEqual([]);
  });

  test('long-quarantined leftovers are reaped by the sweep after the quarantine window', () => {
    const world = makeC6World(() => DRIVE_COMPLETED, { records: [storedRecord()] });
    world.clock.advance(120_000);
    world.manager.reconcile();
    expect(world.manager.quarantinedCount).toBe(1);

    expect(world.manager.sweepRetention()).toEqual([]); // 14d default not reached
    world.clock.advance(14 * 86_400_000);
    expect(world.manager.sweepRetention()).toEqual(['job-old']);
    expect(world.manager.quarantinedCount).toBe(0);
    expect(world.store.read('job-old')).toBeNull();
    expect(world.fs.removed).toContain(OLD_CHECKOUT);
  });

  test('prep-failure halt also reaps record + workspace by default', async () => {
    const world = makeC6World(() => DRIVE_COMPLETED);
    world.fs.existing.clear(); // pipeline root will be missing → prep fails
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.finished[0]).toMatchObject({ ok: false });
    expect(world.store.read('job-1')).toBeNull();
    expect(world.fs.removed).toContain(join(ROOT, 'job-1'));
  });
});

describe('JobManager — c6 ordered completion at the listing boundary (c5 race)', () => {
  test('a completing run stays in activeRunIds until the terminal flush + run_status finished', async () => {
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => (releaseFlush = resolve));
    const world = makeC6World(() => DRIVE_COMPLETED, {
      overrides: {
        events: {
          onTerminalFlush: () => flushGate,
        },
      },
    });
    world.dispatcher.dispatch(makeLease());
    await tick();

    // Drive completed, but the terminal flush is still in flight: the run
    // must STILL be listed and the terminal run_status must not have gone out.
    expect(world.manager.activeRunIds()).toEqual(['run-1']);
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);

    releaseFlush();
    await tick();
    // flush → run_status → release listing.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(world.manager.activeRunIds()).toEqual([]);
  });
});

describe('JobManager — c6 graceful suspend', () => {
  test('suspendAll: drive children aborted, records TOUCHED + KEPT, workspaces intact', async () => {
    const exec = new AbortableHangExec();
    const world = makeC6World(HANG_FOREVER, { exec: exec as unknown as FakeJobExec });
    world.dispatcher.dispatch(makeLease());
    await tick();
    expect(world.manager.activeRunIds()).toEqual(['run-1']);

    world.clock.advance(9_000);
    await world.manager.suspendAll();

    const record = world.store.read('job-1');
    expect(record).not.toBeNull(); // the resume substrate — kept
    expect(record!.phase).toBe('running');
    expect(record!.updated_at).toBe(new Date(9_000).toISOString()); // touched at suspend
    expect(world.fs.removed).toEqual([]); // workspace intact
    expect(world.manager.activeRunIds()).toEqual([]); // settled
    expect(world.finished[0]).toMatchObject({ ok: false, suspended: true });
    // No terminal run_status — the run is not over, just parked on disk.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
  });
});
