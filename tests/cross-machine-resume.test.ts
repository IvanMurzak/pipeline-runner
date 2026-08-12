/**
 * f3 integration — a run PARKED ON ONE MACHINE and RESUMED ON ANOTHER, over a
 * real filesystem, with only processes scripted.
 *
 * ── How the machine boundary is constructed ────────────────────────────────
 *
 * Two `JobManager` "daemons" are booted over disk state that shares NOTHING
 * except the handoff directory and the repository their checkouts come from.
 * Each machine gets its own:
 *
 *   - workspace root   (`ws`)        — so machine B checks out fresh, from git,
 *                                      and can never see A's working tree
 *   - job-record store (`data/jobs`) — so B has no `JobRecord` for the run and
 *                                      cannot take c6's same-machine resume path
 *   - HOME             (`home`)      — so `~/.claude/projects/**` transcripts
 *                                      written by A are unreachable from B
 *
 * That triple is exactly the machine-local state the design calls out. The one
 * thing they share is `runState/` — the f3 handoff, standing in for the shared
 * storage a fleet would put behind it.
 *
 * **What is deliberately NOT carried across:** the SDK/claude session files
 * (`.runtime/<run_id>/sessions/*.json`), the transcripts they point at, the job
 * record, and the working tree. Tests below assert each of those absences
 * rather than assuming them — an omission that is not asserted is an omission
 * that quietly becomes a dependency.
 *
 * ── The assertion that matters ─────────────────────────────────────────────
 *
 * Not "the run completed". The scripted `pipeline drive` appends every step it
 * executes to a shared LEDGER — the test's observation instrument, not product
 * state — so the run's whole execution history across both machines is a single
 * list. The claim is exact:
 *
 *     ledger === ['01-plan', '02-build', '03-test', '04-ship']
 *
 * Every step exactly once, in order: **none re-executed, none skipped.** The
 * control test (no handoff store) shows the same harness producing
 * `['01-plan','02-build','01-plan','02-build','03-test','04-ship']`, which is
 * what proves the cursor is doing the work rather than the fixture.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../src/core/dispatcher';
import {
  claudeTranscriptPath,
  defaultResolveStartIteration,
  fsRunStateStore,
  fsSubstrateProbe,
  JobManager,
  JobStore,
  type JobExec,
  type JobExecOptions,
  type JobExecResult,
  type RunStateBundle,
} from '../src/jobs';
import { FrameSink, makeLease, type RanJobCommand } from '../src/jobs/_helpers';
import { nodeShipperFs } from '../src/shipper/fs';
import { CaptureLogger, FakeClock, tick } from './_helpers';

const GIT_OK: JobExecResult = { code: 0, stdout: '', stderr: '' };

/** The pipeline every machine in this file runs. */
const STEPS = ['01-plan', '02-build', '03-test', '04-ship'] as const;

const DRIVE_COMPLETED: JobExecResult = { code: 0, stdout: JSON.stringify({ status: 'completed' }), stderr: '' };

/**
 * A scripted `pipeline drive` that is a REAL little engine over the durable
 * cursor, because a fixture that ignores the cursor could not distinguish a
 * working handoff from a lucky one.
 *
 *   - `--start`  → the cursor starts at step 0.
 *   - `--resume` → the cursor is READ from `.runtime/<run_id>/next.json`; if it
 *                  is not there, the run restarts from 0 (which is precisely
 *                  what the control test observes).
 *
 * Each executed step is appended to the shared ledger, marked `done` in a step
 * session file, and given a claude transcript under THIS machine's HOME — the
 * machine-local artifacts a real drive leaves behind, so the tests can assert
 * they did not travel.
 *
 * After `stopAfter` steps the process HANGS, modelling a drive still working on
 * the next step; `suspend()` (graceful shutdown) is what ends it.
 */
class ScriptedPipelineExec implements JobExec {
  calls: RanJobCommand[] = [];

  constructor(
    private readonly home: string,
    private readonly ledgerPath: string,
    private readonly stopAfter: number
  ) {}

  of(cmd: string): RanJobCommand[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }

  private appendLedger(stepId: string): void {
    const current = existsSync(this.ledgerPath) ? (JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as string[]) : [];
    current.push(stepId);
    writeFileSync(this.ledgerPath, JSON.stringify(current));
  }

  async run(cmd: string, args: string[], opts: JobExecOptions = {}): Promise<JobExecResult> {
    this.calls.push({ cmd, args, opts });
    if (cmd === 'git') {
      if (args.includes('checkout')) {
        // A fresh clone of the SAME repository: the pipeline definition is
        // there, and nothing else. No `.runtime`, no prior working tree.
        const dir = args[1]!;
        mkdirSync(join(dir, '.pipeline', 'release', 'steps'), { recursive: true });
        for (const step of STEPS) writeFileSync(join(dir, '.pipeline', 'release', 'steps', `${step}.md`), `# ${step}\n`);
      }
      return GIT_OK;
    }

    const pipelineRoot = args[args.indexOf('--root') + 1]!;
    const runId = args[args.indexOf('--run-id') + 1]!;
    const runtime = join(pipelineRoot, '.runtime', runId);
    const cursorPath = join(runtime, 'next.json');

    let index = 0;
    if (args.includes('--resume') && existsSync(cursorPath)) {
      index = (JSON.parse(readFileSync(cursorPath, 'utf8')) as { index?: number }).index ?? 0;
    }

    mkdirSync(join(runtime, 'sessions'), { recursive: true });
    let executed = 0;
    while (index < STEPS.length && executed < this.stopAfter) {
      const stepId = STEPS[index]!;
      this.appendLedger(stepId);
      // Machine-local artifacts of a completed step: the pinned session and
      // its transcript. Both stay on THIS machine, by design.
      const sessionId = `sess-${stepId}`;
      writeFileSync(join(runtime, 'sessions', `${stepId}.json`), JSON.stringify({ session_id: sessionId, status: 'done' }));
      const transcript = claudeTranscriptPath(this.home, opts.cwd ?? '', sessionId);
      mkdirSync(join(transcript, '..'), { recursive: true });
      writeFileSync(transcript, '{"type":"transcript","content":"secrets and prose"}\n');
      index += 1;
      executed += 1;
      // Crash-safe cursor persistence, exactly like the real command layer:
      // written after every step, before the next spawn.
      writeFileSync(cursorPath, JSON.stringify({ index, phase: 'await-step', worktree_provisioned: false }));
    }

    if (index >= STEPS.length) return DRIVE_COMPLETED;
    // Still working on the next step: hang until the abort signal.
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

interface Machine {
  manager: JobManager;
  dispatcher: Dispatcher;
  exec: ScriptedPipelineExec;
  sink: FrameSink;
  logger: CaptureLogger;
  store: JobStore;
  paths: MachinePaths;
}

interface MachinePaths {
  home: string;
  ws: string;
  storeDir: string;
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

interface Fleet {
  base: string;
  a: MachinePaths;
  b: MachinePaths;
  /** The ONLY storage both machines can see. */
  runStateDir: string;
  /** The test's observation instrument — not product state. */
  ledgerPath: string;
}

function makeFleet(): Fleet {
  const base = mkdtempSync(join(tmpdir(), 'f3-xmachine-'));
  cleanups.push(base);
  const machine = (name: string): MachinePaths => ({
    home: join(base, name, 'home'),
    ws: join(base, name, 'ws'),
    storeDir: join(base, name, 'data', 'jobs'),
  });
  return {
    base,
    a: machine('machine-a'),
    b: machine('machine-b'),
    runStateDir: join(base, 'shared', 'runState'),
    ledgerPath: join(base, 'ledger.json'),
  };
}

function ledger(fleet: Fleet): string[] {
  return existsSync(fleet.ledgerPath) ? (JSON.parse(readFileSync(fleet.ledgerPath, 'utf8')) as string[]) : [];
}

/** Boot one machine's daemon. `runStateDir === null` ⇒ no handoff (control). */
function bootMachine(fleet: Fleet, paths: MachinePaths, opts: { stopAfter: number; runStateDir: string | null }): Machine {
  const dispatcher = new Dispatcher();
  const exec = new ScriptedPipelineExec(paths.home, fleet.ledgerPath, opts.stopAfter);
  const sink = new FrameSink();
  const clock = new FakeClock();
  const logger = new CaptureLogger();
  const realFs = nodeShipperFs();
  const store = new JobStore({ fs: realFs, dir: paths.storeDir, clock, logger });
  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: paths.ws,
    labels: () => ['os:linux'],
    exec,
    clock,
    logger,
    resolveStartIteration: defaultResolveStartIteration,
    store,
    substrate: fsSubstrateProbe(realFs, paths.home),
    // Keep terminal workspaces so the "what did NOT travel" assertions inspect
    // a real tree instead of passing vacuously against a deleted directory.
    retention: { keepForever: true, retentionMs: null },
    ...(opts.runStateDir === null ? {} : { runState: fsRunStateStore(realFs, opts.runStateDir) }),
  });
  manager.attach(dispatcher);
  return { manager, dispatcher, exec, sink, logger, store, paths };
}

function publishedBundle(fleet: Fleet, runId = 'run-1'): RunStateBundle | null {
  return fsRunStateStore(nodeShipperFs(), fleet.runStateDir).fetch(runId);
}

/** Machine A: run the first two steps, then drain (graceful shutdown). */
async function runAndReleaseOnA(fleet: Fleet, runStateDir: string | null): Promise<Machine> {
  const a = bootMachine(fleet, fleet.a, { stopAfter: 2, runStateDir });
  a.dispatcher.dispatch(makeLease({ job_id: 'job-a', run_id: 'run-1' }));
  await tick();
  expect(a.manager.activeRunIds()).toEqual(['run-1']);
  expect(ledger(fleet)).toEqual(['01-plan', '02-build']);
  // The fleet event that releases a machine: a drain/redeploy.
  await a.manager.suspendAll();
  await tick();
  return a;
}

describe('f3 — cross-machine resume carried by the durable cursor alone', () => {
  test('a run released by machine A resumes on machine B: no step re-executed, none skipped', async () => {
    const fleet = makeFleet();
    const a = await runAndReleaseOnA(fleet, fleet.runStateDir);
    const checkoutA = a.store.read('job-a')!.checkout_dir;

    // ── What machine A published ─────────────────────────────────────────
    const bundle = publishedBundle(fleet);
    expect(bundle).not.toBeNull();
    expect(bundle!.run_id).toBe('run-1');
    expect(bundle!.pending_question).toBe(false);
    // The cursor, and NOTHING else. No session id, no transcript, no path
    // belonging to machine A — asserted against the serialized bundle so a
    // future field cannot smuggle any of them in unnoticed.
    const wire = JSON.stringify(bundle);
    expect(wire).not.toContain('sess-');
    expect(wire).not.toContain('transcript');
    expect(wire).not.toContain(fleet.a.home);
    expect(wire).not.toContain(checkoutA);
    expect(JSON.parse(bundle!.cursor)).toMatchObject({ index: 2 });

    // ── Machine B is genuinely a different machine ───────────────────────
    const b = bootMachine(fleet, fleet.b, { stopAfter: STEPS.length, runStateDir: fleet.runStateDir });
    expect(b.store.read('job-a')).toBeNull(); // no job record here
    expect(b.store.read('job-b')).toBeNull();
    expect(existsSync(fleet.b.home)).toBe(false); // no ~/.claude carry-over
    expect(existsSync(join(fleet.b.ws, 'job-b'))).toBe(false);
    expect(b.manager.reconcile().resumed).toHaveLength(0); // nothing local to resume

    // The server re-offers the run here.
    b.dispatcher.dispatch(makeLease({ id: 'c-b', job_id: 'job-b', run_id: 'run-1', resume_hint: true, attempt: 2 }));
    await tick();

    // ── The assertion that matters ───────────────────────────────────────
    expect(ledger(fleet)).toEqual(['01-plan', '02-build', '03-test', '04-ship']);

    // B checked out fresh and RESUMED rather than restarting.
    const drives = b.exec.of('pipeline');
    expect(drives).toHaveLength(1);
    expect(drives[0]!.args).toContain('--resume');
    expect(drives[0]!.args).not.toContain('--start');
    expect(b.exec.of('git').length).toBeGreaterThan(0); // a real fresh checkout
    const checkoutB = drives[0]!.opts.cwd!;
    expect(checkoutB).not.toBe(checkoutA);
    expect(checkoutB.startsWith(fleet.b.ws)).toBe(true);

    // ── What did NOT travel ──────────────────────────────────────────────
    // A's transcripts are unreachable from B: the only session files under B's
    // checkout are the ones B itself wrote for the steps B ran.
    const sessionsB = join(checkoutB, '.pipeline', 'release', '.runtime', 'run-1', 'sessions');
    expect(existsSync(join(sessionsB, '01-plan.json'))).toBe(false);
    expect(existsSync(join(sessionsB, '02-build.json'))).toBe(false);
    expect(existsSync(join(sessionsB, '03-test.json'))).toBe(true);
    expect(existsSync(claudeTranscriptPath(fleet.b.home, checkoutB, 'sess-01-plan'))).toBe(false);
    expect(existsSync(claudeTranscriptPath(fleet.a.home, checkoutA, 'sess-01-plan'))).toBe(true);

    // Terminal ⇒ the handoff is dropped; no other machine can pick this up.
    expect(b.sink.ofType('run_status').map((f) => f.phase)).toEqual(['started', 'completed']);
    expect(publishedBundle(fleet)).toBeNull();
  });

  test('CONTROL: without the handoff store, machine B restarts the run from step 1', async () => {
    const fleet = makeFleet();
    await runAndReleaseOnA(fleet, null);
    expect(publishedBundle(fleet)).toBeNull(); // nothing was published

    const b = bootMachine(fleet, fleet.b, { stopAfter: STEPS.length, runStateDir: null });
    b.dispatcher.dispatch(makeLease({ id: 'c-b', job_id: 'job-b', run_id: 'run-1', resume_hint: true, attempt: 2 }));
    await tick();

    // The same harness, the same lease — two steps are executed a SECOND time.
    // This is what the run costs without the cursor, and it is the baseline the
    // test above improves on.
    expect(ledger(fleet)).toEqual(['01-plan', '02-build', '01-plan', '02-build', '03-test', '04-ship']);
    expect(b.exec.of('pipeline')[0]!.args).toContain('--start');
  });

  test('a cursor naming machine-local substrate is REFUSED — B starts clean rather than resuming over a guess', async () => {
    const fleet = makeFleet();
    const a = await runAndReleaseOnA(fleet, fleet.runStateDir);
    const checkoutA = a.store.read('job-a')!.checkout_dir;

    // Rewrite the published bundle's cursor as an `isolation: external` run,
    // whose run-level worktree exists only on machine A.
    const storePath = join(fleet.runStateDir, 'run-1.json');
    const stored = JSON.parse(readFileSync(storePath, 'utf8')) as RunStateBundle;
    stored.cursor = JSON.stringify({ index: 2, worktree_provisioned: true, worktree_path: join(checkoutA, '.wt') });
    writeFileSync(storePath, JSON.stringify(stored));

    const b = bootMachine(fleet, fleet.b, { stopAfter: STEPS.length, runStateDir: fleet.runStateDir });
    b.dispatcher.dispatch(makeLease({ id: 'c-b', job_id: 'job-b', run_id: 'run-1', resume_hint: true, attempt: 2 }));
    await tick();

    expect(b.exec.of('pipeline')[0]!.args).toContain('--start');
    expect(b.logger.joined()).toContain('not restored');
    expect(b.logger.joined()).toContain('worktree');
  });

  test('a lease WITHOUT resume_hint never consults the handoff store', async () => {
    const fleet = makeFleet();
    await runAndReleaseOnA(fleet, fleet.runStateDir);
    expect(publishedBundle(fleet)).not.toBeNull();

    const b = bootMachine(fleet, fleet.b, { stopAfter: STEPS.length, runStateDir: fleet.runStateDir });
    b.dispatcher.dispatch(makeLease({ id: 'c-b', job_id: 'job-b', run_id: 'run-1', attempt: 2 }));
    await tick();

    // A re-dispatch that is NOT a re-offer is a new run of the pipeline: the
    // server, not the runner, decides that a run is being continued.
    expect(b.exec.of('pipeline')[0]!.args).toContain('--start');
    expect(ledger(fleet)).toEqual(['01-plan', '02-build', '01-plan', '02-build', '03-test', '04-ship']);
  });
});
