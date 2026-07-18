/**
 * c6 integration (design 04 test plan) — REAL filesystem, scripted processes:
 *
 *   1. daemon death mid-drive → restart < TTL  → `--resume` argv, NO wipe
 *   2. daemon death → restart > TTL            → NO spawn (quarantine) until a
 *      `resume_hint` lease arrives → ADOPTION in the RECORDED checkout
 *   3. server `cancel`                          → record + workspace gone
 *
 * "kill -9" is modeled as it actually manifests: the first manager's world is
 * ABANDONED mid-drive (its exec promise never settles, exactly like a killed
 * daemon's children) and a brand-new manager/store boots over the SAME disk
 * state. Records, workspaces, runtime substrate, and claude transcripts are
 * all real files under a per-test temp dir — only processes are scripted
 * (portable across the Windows CI leg; no real signals, no real git).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/core/dispatcher';
import {
  claudeTranscriptPath,
  fsSubstrateProbe,
  JobManager,
  JobStore,
  defaultResolveStartIteration,
  type JobExec,
  type JobExecOptions,
  type JobExecResult,
} from '../src/jobs';
import { nodeShipperFs } from '../src/shipper/fs';
import { CaptureLogger, FakeClock, tick } from './_helpers';
import { FrameSink, makeLease, type RanJobCommand } from '../src/jobs/_helpers';

const GIT_OK: JobExecResult = { code: 0, stdout: '', stderr: '' };

/**
 * The scripted process seam: git "checkout" materializes a real pipeline
 * tree; `pipeline drive` materializes the real resume substrate (next.json,
 * a running step-session file, its claude transcript under the fake HOME)
 * and then HANGS until the c6 abort signal (a killed daemon's child /
 * a cancel).
 */
class RealFsScriptedExec implements JobExec {
  calls: RanJobCommand[] = [];

  constructor(private readonly home: string) {}

  of(cmd: string): RanJobCommand[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }

  async run(cmd: string, args: string[], opts: JobExecOptions = {}): Promise<JobExecResult> {
    this.calls.push({ cmd, args, opts });
    if (cmd === 'git') {
      if (args.includes('checkout')) {
        const dir = args[1]!; // ['-C', <dir>, 'checkout', ...]
        const pipelineRoot = join(dir, '.claude', 'pipeline', 'release');
        mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
        writeFileSync(join(pipelineRoot, 'steps', '01-plan.md'), '# plan\n');
      }
      return GIT_OK;
    }
    // `pipeline drive`: create the durable substrate the reconcile verifies.
    const pipelineRoot = args[args.indexOf('--root') + 1]!;
    const runId = args[args.indexOf('--run-id') + 1]!;
    const runtime = join(pipelineRoot, '.runtime', runId);
    mkdirSync(join(runtime, 'sessions'), { recursive: true });
    writeFileSync(join(runtime, 'next.json'), '{}\n');
    writeFileSync(join(runtime, 'sessions', '02-deploy.json'), JSON.stringify({ session_id: 'sess-1', status: 'running' }));
    const transcript = claudeTranscriptPath(this.home, opts.cwd ?? '', 'sess-1');
    mkdirSync(join(transcript, '..'), { recursive: true });
    writeFileSync(transcript, '{"type":"transcript"}\n');
    // Hang like a live drive; settle only when killed (abort).
    return new Promise((resolve) => {
      const settle = (): void => resolve({ code: null, stdout: '', stderr: '', error: 'killed' });
      if (opts.signal?.aborted) {
        settle();
        return;
      }
      opts.signal?.addEventListener('abort', settle, { once: true });
    });
  }
}

interface World {
  manager: JobManager;
  dispatcher: Dispatcher;
  exec: RealFsScriptedExec;
  sink: FrameSink;
  clock: FakeClock;
  logger: CaptureLogger;
  store: JobStore;
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file-lock stragglers — temp dir, best-effort */
    }
  }
});

function makeBase(): { base: string; home: string; ws: string; storeDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'ffi-c6-'));
  cleanups.push(base);
  return { base, home: join(base, 'home'), ws: join(base, 'ws'), storeDir: join(base, 'data', 'jobs') };
}

/** Boot a manager "daemon" over the given disk state. Each call is a fresh
 *  process life; the disk is the only carry-over (that is the point). */
function bootWorld(paths: { home: string; ws: string; storeDir: string }, clockStartMs: number): World {
  const dispatcher = new Dispatcher();
  const exec = new RealFsScriptedExec(paths.home);
  const sink = new FrameSink();
  const clock = new FakeClock();
  clock.advance(clockStartMs);
  const logger = new CaptureLogger();
  const realFs = nodeShipperFs();
  const store = new JobStore({ fs: realFs, dir: paths.storeDir, clock, logger });
  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: paths.ws,
    labels: () => ['os:linux'],
    exec,
    // REAL job fs: workspaces and wipes are actual directories.
    // (default nodeJobFs — not injected)
    clock,
    logger,
    resolveStartIteration: defaultResolveStartIteration,
    store,
    substrate: fsSubstrateProbe(realFs, paths.home),
  });
  manager.attach(dispatcher);
  return { manager, dispatcher, exec, sink, clock, logger, store };
}

/** Life 1: accept a lease, drive to `running` (real substrate on disk), then
 *  "kill -9" — the world is simply abandoned mid-hang. */
async function runAndKill(paths: { home: string; ws: string; storeDir: string }): Promise<{ checkout: string }> {
  const world = bootWorld(paths, 0);
  world.dispatcher.dispatch(makeLease());
  await tick();
  expect(world.manager.activeRunIds()).toEqual(['run-1']);
  const record = world.store.read('job-1');
  expect(record).not.toBeNull();
  expect(record!.phase).toBe('running');
  expect(existsSync(record!.checkout_dir)).toBe(true);
  return { checkout: record!.checkout_dir };
  // world dropped here — the hanging drive promise IS the killed daemon.
}

describe('c6 integration — crash, restart, adoption, cancel (real fs)', () => {
  test('kill -9 → restart < TTL: FRESH resume with --resume in the same checkout, no wipe', async () => {
    const paths = makeBase();
    const { checkout } = await runAndKill(paths);
    const marker = join(checkout, '.claude', 'pipeline', 'release', 'steps', '01-plan.md');
    expect(existsSync(marker)).toBe(true);

    // Restart 30s later (< 90s TTL).
    const world2 = bootWorld(paths, 30_000);
    const summary = world2.manager.reconcile();
    expect(summary.resumed).toHaveLength(1);
    expect(world2.manager.activeRunIds()).toEqual(['run-1']); // seeded before any beat
    await tick();

    expect(world2.exec.of('git')).toHaveLength(0); // no re-checkout
    const drive = world2.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toContain('--resume');
    expect(drive[0]!.args).not.toContain('--start'); // resume, not restart
    expect(drive[0]!.opts.cwd).toBe(checkout);
    expect(existsSync(marker)).toBe(true); // NO wipe — the substrate survived
    expect(world2.sink.ofType('run_status')).toEqual([]); // F1: silent
  });

  test('kill -9 → restart > TTL: quarantine (no spawn) until the resume_hint lease → adoption in the RECORDED dir', async () => {
    const paths = makeBase();
    const { checkout } = await runAndKill(paths);

    // Restart 200s later (> 90s TTL).
    const world2 = bootWorld(paths, 200_000);
    const summary = world2.manager.reconcile();
    expect(summary.quarantined).toHaveLength(1);
    expect(world2.manager.activeRunIds()).toEqual([]);
    await tick();
    expect(world2.exec.of('pipeline')).toHaveLength(0); // NO optimistic spawn

    // The server's re-offer: attempt 2, resume_hint, new job id.
    world2.dispatcher.dispatch(
      makeLease({ id: 'c-re', job_id: 'job-2', run_id: 'run-1', resume_hint: true, attempt: 2, event_seq_base: 2_000_000 })
    );
    await tick();

    expect(world2.sink.ofType('accept')).toHaveLength(1);
    const drive = world2.exec.of('pipeline');
    expect(drive).toHaveLength(1);
    expect(drive[0]!.args).toContain('--resume');
    expect(drive[0]!.opts.cwd).toBe(checkout); // the RECORDED (old job's) dir
    // Record superseded on the real disk: job-1 file gone, job-2 present.
    expect(world2.store.read('job-1')).toBeNull();
    const adopted = world2.store.read('job-2');
    expect(adopted).not.toBeNull();
    expect(adopted!.checkout_dir).toBe(checkout);
    expect(adopted!.attempt).toBe(2);
    expect(existsSync(checkout)).toBe(true);
    // The adopted job announces its start.
    expect(world2.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
  });

  test('server cancel: drive killed, record file + workspace directory GONE', async () => {
    const paths = makeBase();
    const world = bootWorld(paths, 0);
    world.dispatcher.dispatch(makeLease());
    await tick();
    const checkout = world.store.read('job-1')!.checkout_dir;
    expect(existsSync(checkout)).toBe(true);

    world.dispatcher.dispatch({ type: 'cancel', run_id: 'run-1', reason: 'user cancelled' });
    await tick();
    await tick();

    expect(world.manager.activeRunIds()).toEqual([]);
    expect(world.store.read('job-1')).toBeNull();
    expect(existsSync(checkout)).toBe(false);
    // started only — a cancel produces no terminal run_status from the runner.
    expect(world.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started']);
  });
});
