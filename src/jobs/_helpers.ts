/**
 * Shared job-execution test fakes: a scriptable exec seam, an in-memory job
 * filesystem, a frame-capturing send, and a lease fixture. Underscore-prefixed
 * so `bun test` does not pick this file up as a suite (repo convention).
 * FakeClock / CaptureLogger / tick are reused from `tests/_helpers`.
 */

import type { WireFrame } from '../core/wire';
import type { JobRecord } from './job-store';
import type { SubstrateProbe } from './reconcile';
import type { JobExec, JobExecOptions, JobExecResult } from './types';
import type { JobFs } from './types';
import { TASK_PIPELINE_UNRESOLVED, type LeaseMessage, type LeaseTask } from './wire';

/** A recorded exec call, assertable in order. */
export interface RanJobCommand {
  cmd: string;
  args: string[];
  opts: JobExecOptions;
}

export const GIT_OK: JobExecResult = { code: 0, stdout: '', stderr: '' };

/**
 * Scriptable exec: `respond` decides each call's result (sync or async so
 * tests can hold an invocation open). Records every call, never spawns.
 */
export class FakeJobExec implements JobExec {
  calls: RanJobCommand[] = [];

  constructor(private readonly respond: (cmd: string, args: string[]) => JobExecResult | Promise<JobExecResult>) {}

  async run(cmd: string, args: string[], opts: JobExecOptions = {}): Promise<JobExecResult> {
    this.calls.push({ cmd, args, opts });
    return this.respond(cmd, args);
  }

  /** Calls made to a given binary (e.g. just the drive invocations). */
  of(cmd: string): RanJobCommand[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }
}

/** In-memory job fs: pre-seed `existing` paths and `listings` per directory. */
export class FakeJobFs implements JobFs {
  existing = new Set<string>();
  listings = new Map<string, string[]>();
  removed: string[] = [];
  made: string[] = [];

  mkdirp(path: string): void {
    this.made.push(path);
    this.existing.add(path);
  }

  exists(path: string): boolean {
    return this.existing.has(path);
  }

  removeDir(path: string): void {
    this.removed.push(path);
    this.existing.delete(path);
  }

  listDir(path: string): string[] {
    return this.listings.get(path) ?? [];
  }
}

/** A frame-capturing send seam; flip `online` to simulate a dropped link. */
export class FrameSink {
  frames: WireFrame[] = [];
  online = true;

  send = (frame: WireFrame): boolean => {
    if (!this.online) return false;
    this.frames.push(frame);
    return true;
  };

  ofType(type: string): WireFrame[] {
    return this.frames.filter((frame) => frame.type === type);
  }
}

/** A well-formed lease fixture; override any field per test. */
export function makeLease(overrides: Partial<LeaseMessage> = {}): LeaseMessage {
  return {
    type: 'lease',
    id: 'corr-1',
    job_id: 'job-1',
    run_id: 'run-1',
    pipeline_ref: { repo: 'git@example.com:acme/api.git', ref: 'main', pipeline: 'release', content_hash: null },
    labels: ['os:linux'],
    job_jwt: 'jwt-secret-1',
    secret_slugs: ['DEPLOY_KEY'],
    lease_ttl_s: 60,
    ...overrides,
  };
}

/** T2-05: a well-formed task fixture; override any field per test. */
export function makeTask(overrides: Partial<LeaseTask> = {}): LeaseTask {
  return {
    task_id: 'task-1',
    title: 'Ship the release',
    body: 'Cut a release for the api service',
    labels: ['release'],
    ...overrides,
  };
}

/** T2-05: a task-dispatch lease fixture — the `@task` sentinel + a `task`
 *  payload, `secret_slugs` always [] (the contract for task leases). */
export function makeTaskLease(taskOverrides: Partial<LeaseTask> = {}, overrides: Partial<LeaseMessage> = {}): LeaseMessage {
  return makeLease({
    pipeline_ref: {
      repo: 'git@example.com:acme/api.git',
      ref: 'main',
      pipeline: TASK_PIPELINE_UNRESOLVED,
      content_hash: null,
    },
    secret_slugs: [],
    task: makeTask(taskOverrides),
    ...overrides,
  });
}

/** T2-05: a `pipeline match` exec result carrying the given candidates. */
export function matchOutput(
  candidates: Array<{ name: string; manifest: string; score: number }>,
  task = 'query'
): JobExecResult {
  return {
    code: 0,
    stdout: JSON.stringify(
      {
        task,
        candidates: candidates.map((c) => ({
          ...c,
          first_iteration: null,
          end_state: '',
          matched_terms: [],
        })),
        excluded: [],
      },
      null,
      2
    ),
    stderr: '',
  };
}

/** Drive results, ready to script through FakeJobExec. */
export const DRIVE_COMPLETED: JobExecResult = {
  code: 0,
  stdout: JSON.stringify({ status: 'completed' }, null, 2),
  stderr: '',
};

export const DRIVE_HALTED: JobExecResult = {
  code: 1,
  stdout: JSON.stringify({ status: 'halted', reason: 'step 02 halted: tests failed' }, null, 2),
  stderr: '',
};

/** `questionId` omitted (default) simulates an older CLI that predates the
 *  b2 park-JSON `question_id` field (06.2.1) — the executor mint-fallback
 *  case (06.2.2). Pass one to simulate the current contract's passthrough. */
export function driveAwaiting(
  iterationPath = 'steps/02-deploy.md',
  text = 'Which host?',
  questionId?: string
): JobExecResult {
  return {
    code: 4,
    stdout: JSON.stringify(
      {
        status: 'awaiting-input',
        step_id: '02-deploy',
        ...(questionId !== undefined ? { question_id: questionId } : {}),
        iteration_path: iterationPath,
        session_id: 'sess-1',
        question: { text, context: 'ctx', options: ['a', 'b'] },
      },
      null,
      2
    ),
    stderr: '',
  };
}

export const DRIVE_PROVIDER_LIMIT: JobExecResult = {
  code: 1,
  stdout: '',
  stderr: 'claude: usage limit reached — resets later',
};

// ── c6: job-record + reconcile fixtures ─────────────────────────────────────

/** A well-formed recoverable job record (phase `running`); override per test.
 *  Paths deliberately mirror the makeLease fixture's derived workspace. */
export function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const checkout = overrides.checkout_dir ?? '/w/job-old';
  return {
    job_id: 'job-old',
    run_id: 'run-1',
    attempt: 1,
    pipeline_ref: { repo: 'git@example.com:acme/api.git', ref: 'main', pipeline: 'release', content_hash: null },
    checkout_dir: checkout,
    pipeline_root: `${checkout}/.claude/pipeline/release`,
    start_iteration: 'steps/01-plan.md',
    lease_ttl_s: 90,
    secret_slugs: [],
    phase: 'running',
    paused_until: null,
    consecutive_pauses: 0,
    questions: [],
    accepted_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A substrate probe scripted per test (everything present by default). */
export function makeProbe(overrides: Partial<SubstrateProbe> = {}): SubstrateProbe {
  return {
    checkoutExists: () => true,
    nextJsonExists: () => true,
    transcriptsPresent: () => true,
    ...overrides,
  };
}

/**
 * An exec whose non-git commands HANG until the c6 abort signal fires (the
 * cancel/suspend seam) — resolves `{code:null, error:'aborted'}` on abort,
 * exactly like a killed child through `nodeJobExec`.
 */
export class AbortableHangExec implements JobExec {
  calls: RanJobCommand[] = [];

  async run(cmd: string, args: string[], opts: JobExecOptions = {}): Promise<JobExecResult> {
    this.calls.push({ cmd, args, opts });
    if (cmd === 'git') return GIT_OK;
    return new Promise((resolve) => {
      const settle = (): void => resolve({ code: null, stdout: '', stderr: '', error: 'aborted' });
      if (opts.signal?.aborted) {
        settle();
        return;
      }
      opts.signal?.addEventListener('abort', settle, { once: true });
    });
  }

  of(cmd: string): RanJobCommand[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }
}
