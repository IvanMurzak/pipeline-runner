/**
 * APPROVAL-GATE PRESERVATION (c2 — runner information-loss #2; 07 T2).
 *
 * The `question.approval` marker that turns a parked question into an APPROVAL
 * GATE used to die inside the runner: `narrowQuestion` (`src/jobs/drive.ts`)
 * rebuilt drive's question as `{text, context, options}`, so the `needs_input`
 * frame the cloud received was indistinguishable from an ordinary question and
 * the run could never be classified `needs-approval`.
 *
 * These are the two fixtures 04 §4.7 asks for, driven through the REAL
 * composition `cli.ts` wires (JobExecutor → PullRelayAdapter → NeedsInputRelay
 * bridge → `needs_input` frame), not a re-implementation of it:
 *
 *   1. A gate survives the whole chain intact.
 *   2. A malformed marker FAILS CLOSED at the frame boundary — the frame goes
 *      out as a plain question, with a warning, and nothing crashes.
 *
 * The security property under test (07 T2) is not "the marker is copied"; it
 * is "the marker on the wire was PARSED BY `ApprovalSchema`, and no other
 * runner-side path can put one there" — hence the boundary tests at the bottom,
 * which pin `buildNeedsInputFrame` as the single site that decides.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ApprovalSchema, type Question } from '@baizor/pipeline-protocol';
import { CaptureLogger, FakeClock, tick } from './_helpers';
import { FakeJobExec, FakeJobFs, GIT_OK, makeLease } from '../src/jobs/_helpers';
import type { JobExecResult } from '../src/jobs/types';
import { classifyDriveOutcome } from '../src/jobs/drive';
import { JobExecutor } from '../src/jobs/executor';
import { defaultResolveStartIteration } from '../src/jobs/workspace';
import { PullRelayAdapter } from '../src/relay/adapter';
import { NeedsInputRelay, type RelayClientPort } from '../src/relay/bridge';
import { buildNeedsInputFrame, validateQuestionApproval } from '../src/relay/wire-relay';
import type { WireFrame } from '../src/core/wire';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.pipeline', 'release');

/** A drive exit-4 park whose question carries whatever `approval` the test
 *  wants — including a malformed one (the point of half these fixtures). */
function drivePark(approval: unknown): JobExecResult {
  return {
    code: 4,
    stdout: JSON.stringify(
      {
        status: 'awaiting-input',
        step_id: '02-deploy',
        question_id: 'q-gate-1',
        iteration_path: 'steps/02-deploy.md',
        session_id: 'sess-1',
        question: {
          text: 'Approve the production deploy?',
          context: 'migration 031 is pending',
          options: ['approve', 'reject'],
          ...(approval !== undefined ? { approval } : {}),
        },
      },
      null,
      2
    ),
    stderr: '',
  };
}

const DRIVE_COMPLETED: JobExecResult = {
  code: 0,
  stdout: JSON.stringify({ status: 'completed' }),
  stderr: '',
};

/** A client port that records what the runner SENDS and lets the test push a
 *  server frame back down the same dispatcher hook the real connection uses. */
class MockClientPort implements RelayClientPort {
  sent: WireFrame[] = [];
  private handlers = new Map<string, Set<(frame: WireFrame) => void>>();

  readonly dispatcher = {
    on: (type: string, handler: (frame: WireFrame) => void): (() => void) => {
      let set = this.handlers.get(type);
      if (!set) {
        set = new Set();
        this.handlers.set(type, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    },
  };

  send(frame: WireFrame): boolean {
    this.sent.push(frame);
    return true;
  }

  serverSend(frame: WireFrame): void {
    for (const handler of [...(this.handlers.get(frame.type) ?? [])]) handler(frame);
  }

  needsInputFrames(): WireFrame[] {
    return this.sent.filter((f) => f.type === 'needs_input');
  }
}

/**
 * The production composition: a JobExecutor whose needs-input seam is the REAL
 * pull→push adapter attached to the REAL relay bridge (exactly `cli.ts`'s
 * two-phase wiring). Drives `park` first, then a completed run once the answer
 * comes back.
 */
function makeWorld(park: JobExecResult) {
  const queue: JobExecResult[] = [park, DRIVE_COMPLETED];
  const exec = new FakeJobExec((cmd) => {
    if (cmd === 'git') return GIT_OK;
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
  const fs = new FakeJobFs();
  fs.existing.add(PIPELINE_ROOT);
  fs.listings.set(join(PIPELINE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);

  const client = new MockClientPort();
  const logger = new CaptureLogger();
  const adapter = new PullRelayAdapter({ logger });
  const bridge = new NeedsInputRelay({ client, drive: adapter, logger, makeId: () => 'corr-1' });
  adapter.attach(bridge);

  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: () => true,
    workspaceRoot: ROOT,
    fs,
    clock: new FakeClock(),
    logger,
    makeId: () => 'q-minted',
    resolveStartIteration: defaultResolveStartIteration,
    exec,
    needsInput: adapter,
  });
  return { executor, client, logger };
}

/** Run the executor until it has parked and its `needs_input` frame is on the
 *  wire, then answer it so `start()` can settle. Returns the frame + result. */
async function driveToFrameAndAnswer(park: JobExecResult) {
  const world = makeWorld(park);
  const settled = world.executor.start();
  for (let i = 0; i < 50 && world.client.needsInputFrames().length === 0; i += 1) await tick();
  const frames = world.client.needsInputFrames();
  expect(frames).toHaveLength(1);
  const frame = frames[0]!;

  world.client.serverSend({
    type: 'answer',
    id: frame.id,
    answer: {
      run_id: 'run-1',
      question_id: 'q-gate-1',
      answer: 'approve',
      answered_by: 'user:alice',
      ts: '2026-08-15T12:00:00Z',
    },
  });
  const result = await settled;
  return { frame, result, logger: world.logger, client: world.client };
}

describe('c2 — a gate survives narrowQuestion → ParkedQuestion → needs_input frame', () => {
  test('classifyDriveOutcome preserves `question.approval` verbatim (narrowQuestion no longer drops it)', () => {
    const outcome = classifyDriveOutcome(drivePark({ required_role: 'admin' }));
    expect(outcome.kind).toBe('awaiting_input');
    if (outcome.kind !== 'awaiting_input') throw new Error('unreachable');

    // The gate marker, intact — alongside the fields narrowing always kept.
    expect(outcome.parked.question).toEqual({
      text: 'Approve the production deploy?',
      context: 'migration 031 is pending',
      options: ['approve', 'reject'],
      approval: { required_role: 'admin' },
    });
  });

  test('a plain question is narrowed byte-identically — no `approval` key invented', () => {
    const outcome = classifyDriveOutcome(drivePark(undefined));
    if (outcome.kind !== 'awaiting_input') throw new Error('expected an awaiting_input park');
    expect(outcome.parked.question).toEqual({
      text: 'Approve the production deploy?',
      context: 'migration 031 is pending',
      options: ['approve', 'reject'],
    });
    expect('approval' in outcome.parked.question).toBe(false);
  });

  test('END-TO-END: the gate reaches the cloud on the needs_input frame, schema-shaped', async () => {
    const { frame, result } = await driveToFrameAndAnswer(drivePark({ required_role: 'owner' }));

    expect(frame.run_id).toBe('run-1');
    expect(frame.question_id).toBe('q-gate-1'); // drive's own identity, not a minted one
    const question = frame.question as Question;
    expect(question.text).toBe('Approve the production deploy?');
    // The marker survived the whole runner: narrowQuestion → ParkedQuestion →
    // adapter → bridge → frame. This is the assertion 04 §4.7 asks for.
    expect(question.approval).toEqual({ required_role: 'owner' });
    // And what shipped is a value the CLOUD's strict parse accepts — d2 derives
    // `awaiting_kind='approval'` from exactly this object's presence.
    expect(ApprovalSchema.safeParse(question.approval).success).toBe(true);
    expect(question.approval != null).toBe(true); // presence, never truthiness

    // The run still completed normally after the answer — preservation is not
    // allowed to change the park/resume round-trip.
    expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
  });

  test('END-TO-END: unknown fields inside a valid approval ride along (additive-forward)', async () => {
    const { frame } = await driveToFrameAndAnswer(
      drivePark({ required_role: 'admin', reason: 'production', future_field: 7 })
    );
    expect((frame.question as Question).approval).toEqual({
      required_role: 'admin',
      reason: 'production',
      future_field: 7,
    });
  });

  test('END-TO-END: a plain question still ships with no `approval` key at all', async () => {
    const { frame, logger } = await driveToFrameAndAnswer(drivePark(undefined));
    const question = frame.question as Record<string, unknown>;
    expect('approval' in question).toBe(false);
    // No gate, no complaint: absent is the ordinary case, not a malformation.
    expect(logger.joined()).not.toContain('malformed approval');
  });
});

describe('c2 — a malformed approval FAILS CLOSED at the frame boundary (07 T2)', () => {
  // Every shape a forged/garbled marker could take. `true` is the historically
  // dangerous one: the protocol's own history includes a boolean-typed trap, and
  // a truthiness-based reader would have promoted this to a gate.
  const malformed: Array<[string, unknown]> = [
    ['a legacy boolean', true],
    ['a boolean false', false],
    ['a role outside the closed enum', { required_role: 'superuser' }],
    ['a missing required_role', { note: 'approve me' }],
    ['a non-string required_role', { required_role: 3 }],
    ['a bare string', 'owner'],
    ['an array', [{ required_role: 'owner' }]],
    ['a number', 1],
  ];

  for (const [label, approval] of malformed) {
    test(`END-TO-END: ${label} is dropped — plain question + warning, no crash`, async () => {
      const { frame, result, logger } = await driveToFrameAndAnswer(drivePark(approval));

      const question = frame.question as Record<string, unknown>;
      // FAIL CLOSED: no gate on the wire, in any form — not the raw value, not
      // a coerced one, not an empty object.
      expect('approval' in question).toBe(false);
      // ...but the question itself still reaches the answerer intact.
      expect(question.text).toBe('Approve the production deploy?');
      expect(question.options).toEqual(['approve', 'reject']);
      // The degradation is LOUD.
      expect(logger.joined()).toContain('malformed approval marker');
      expect(logger.joined()).toContain('q-gate-1');
      // ...and never crashes the job.
      expect(result).toEqual({ job_id: 'job-1', run_id: 'run-1', ok: true, outcome: 'completed' });
    });
  }

  test('the warning names the schema complaint but never logs the approval VALUE', async () => {
    // Regression guard: zod's `invalid_enum_value` MESSAGE quotes the rejected
    // value ("...received 'sudo-secret-role'"), so forwarding zod messages into
    // the log would leak the question payload the drop exists to distrust. The
    // boundary emits path + CODE only.
    const { logger } = await driveToFrameAndAnswer(drivePark({ required_role: 'sudo-secret-role' }));
    const logged = logger.joined();
    expect(logged).toContain('malformed approval marker');
    expect(logged).toContain('required_role: invalid_enum_value'); // the field + why
    expect(logged).not.toContain('sudo-secret-role'); // never the payload itself
  });
});

describe('c2 — the boundary is the ONLY approval authority (07 T2)', () => {
  test('validateQuestionApproval ships the SCHEMA OUTPUT, not the raw input', () => {
    const raw = { required_role: 'admin' as const };
    const out = validateQuestionApproval({ text: 'q?', approval: raw });
    expect(out.approval).toEqual(raw);
    // Not the same object: what goes on the wire is ApprovalSchema's parse
    // result, so a mutation of the source after validation cannot reach the
    // cloud, and nothing unvalidated is ever forwarded by reference.
    expect(out.approval).not.toBe(raw);
  });

  test('an explicit null approval is the no-gate case, not a malformation', () => {
    const warnings: string[] = [];
    const out = validateQuestionApproval({ text: 'q?', approval: null }, (d) => warnings.push(d));
    expect('approval' in out).toBe(false);
    expect(warnings).toEqual([]);
  });

  test('sibling question fields survive validation untouched (additive-forward)', () => {
    const out = validateQuestionApproval({
      text: 'q?',
      context: 'ctx',
      options: ['a'],
      question_id: 'q-1',
      future_sibling: 'kept',
      approval: { required_role: 'viewer' },
    } as Parameters<typeof validateQuestionApproval>[0]);
    expect(out).toEqual({
      text: 'q?',
      context: 'ctx',
      options: ['a'],
      question_id: 'q-1',
      future_sibling: 'kept',
      approval: { required_role: 'viewer' },
    });
  });

  test('buildNeedsInputFrame validates — a frame cannot be built around an unvalidated marker', () => {
    const complaints: string[] = [];
    const good = buildNeedsInputFrame('run-1', 'q-1', { text: 'q?', approval: { required_role: 'member' } }, 'corr-1');
    expect((good.question as Question).approval).toEqual({ required_role: 'member' });

    const bad = buildNeedsInputFrame('run-1', 'q-2', { text: 'q?', approval: { required_role: 'root' } }, 'corr-2', (d) =>
      complaints.push(d)
    );
    expect('approval' in (bad.question as Record<string, unknown>)).toBe(false);
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toContain('required_role');
  });

  test('a re-surface replays the frame validated on the FIRST surface (one judgement per identity)', () => {
    const client = new MockClientPort();
    const logger = new CaptureLogger();
    const bridge = new NeedsInputRelay({
      client,
      drive: { resumeWithAnswer: () => {} },
      logger,
      makeId: () => 'corr-1',
    });

    bridge.surface({ run_id: 'run-1', question_id: 'q-1', question: { text: 'q?', approval: { required_role: 'admin' } } });
    // A second surface for the SAME identity, now claiming a different gate:
    // the stored frame wins, so the marker cannot be swapped after the fact.
    bridge.surface({ run_id: 'run-1', question_id: 'q-1', question: { text: 'q?', approval: { required_role: 'viewer' } } });

    const frames = client.needsInputFrames();
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect((frame.question as Question).approval).toEqual({ required_role: 'admin' });
    }
    expect(bridge.resurfacePending()).toBe(1);
    expect((client.needsInputFrames()[2]!.question as Question).approval).toEqual({ required_role: 'admin' });
  });
});
