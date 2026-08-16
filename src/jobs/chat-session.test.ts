/**
 * c4 (`pipeline-ui-v2`): the P2.5 chat channel wired END TO END over the REAL
 * objects the daemon composes in `../cli.ts` — `JobManager` + `JobExecutor` +
 * the needs-input `NeedsInputRelay` bridge + `PullRelayAdapter` + `ChatRelay`
 * + `jobChatRegistry`. `./chat-session.ts`'s own unit coverage lives in
 * `../../tests/chat-relay.test.ts`; what this file proves is the composition:
 * that an inbound `chat_send` reaches the executor session of the run it
 * names, through the SAME relay bridge an `answer` travels (M6: no second
 * transport), and that a frame for any other run reaches nothing at all.
 *
 * Two jobs run concurrently on purpose. A routing test with one session
 * cannot fail the way cross-run delivery would (07 T7) — with two, "landed in
 * the correct session" and "landed in a session" are different assertions.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { NeedsInputRelay as NeedsInputRelayBridge } from '../relay/bridge';
import { PullRelayAdapter } from '../relay/adapter';
import { ChatRelay } from '../relay/chat';
import { CHAT_ERROR_CODES } from '../relay/chat-wire';
import { FakeJobExec, FakeJobFs, FrameSink, GIT_OK, makeLease } from './_helpers';
import { jobChatRegistry } from './chat-session';
import { JobManager } from './manager';
import type { JobExecResult } from './types';
import { defaultResolveStartIteration } from './workspace';

const ROOT = join('/w');

function seedJob(fs: FakeJobFs, jobId: string): void {
  const pipelineRoot = join(ROOT, jobId, '.pipeline', 'release');
  fs.existing.add(pipelineRoot);
  fs.listings.set(join(pipelineRoot, 'steps'), ['01-plan.md']);
}

/** A drive park (exit 4), optionally carrying a c2 approval-gate marker. */
function parked(questionId: string, approval?: unknown): JobExecResult {
  return {
    code: 4,
    stdout: JSON.stringify({
      status: 'awaiting-input',
      step_id: '02-deploy',
      question_id: questionId,
      iteration_path: 'steps/01-plan.md',
      session_id: 'sess-1',
      question: { text: 'Which host?', context: 'ctx', ...(approval === undefined ? {} : { approval }) },
    }),
    stderr: '',
  };
}

const COMPLETED: JobExecResult = { code: 0, stdout: JSON.stringify({ status: 'completed' }), stderr: '' };

function runIdOf(args: string[]): string {
  return args[args.indexOf('--run-id') + 1] ?? '';
}

/**
 * Build the daemon's real construction order: manager → bridge → adapter →
 * chat relay, all over one dispatcher and one send.
 */
function makeWorld(options: { approvalFor?: Record<string, unknown> } = {}) {
  const dispatcher = new Dispatcher();
  const sink = new FrameSink();
  const fs = new FakeJobFs();
  seedJob(fs, 'job-1');
  seedJob(fs, 'job-2');
  const logger = new CaptureLogger();

  // Each run parks on its first drive, then completes on the resume.
  const parksLeft = new Map<string, boolean>([
    ['run-1', true],
    ['run-2', true],
  ]);
  const exec = new FakeJobExec((cmd, args) => {
    if (cmd === 'git') return GIT_OK;
    const runId = runIdOf(args);
    if (parksLeft.get(runId) === true) {
      parksLeft.set(runId, false);
      return parked(`q-${runId}`, options.approvalFor?.[runId]);
    }
    return COMPLETED;
  });

  const client = {
    send: sink.send,
    dispatcher: { on: (type: string, handler: (frame: WireFrame) => void) => dispatcher.on(type, handler) },
  };

  const relayAdapter = new PullRelayAdapter({ logger });
  const relayBridge = new NeedsInputRelayBridge({ client, drive: relayAdapter, logger, makeId: () => 'corr-1' });
  relayAdapter.attach(relayBridge);

  const manager = new JobManager({
    runnerId: () => 'r-1',
    send: sink.send,
    workspaceRoot: ROOT,
    capacity: () => 4,
    exec,
    fs,
    clock: new FakeClock(),
    logger,
    resolveStartIteration: defaultResolveStartIteration,
    needsInput: relayAdapter,
  });
  manager.attach(dispatcher);

  const chatRelay = new ChatRelay({
    client,
    sessions: jobChatRegistry({
      jobs: { activeSession: (runId) => manager.activeSession(runId) },
      delivery: relayBridge,
      logger,
    }),
    logger,
    now: () => '2026-08-15T00:00:00.000Z',
  });

  return { dispatcher, sink, exec, manager, chatRelay, logger };
}

function chatSend(runId: string, messageId: string, message: string): WireFrame {
  return {
    type: 'chat_send',
    run_id: runId,
    message_id: messageId,
    message,
    sent_by: 'owner@example.com',
    ts: '2026-08-15T00:00:00.000Z',
  } as WireFrame;
}

/** Drive both fixture jobs to their parked state. */
async function startBothParked(world: ReturnType<typeof makeWorld>): Promise<void> {
  world.dispatcher.dispatch(makeLease({ job_id: 'job-1', run_id: 'run-1' }));
  world.dispatcher.dispatch(makeLease({ job_id: 'job-2', run_id: 'run-2' }));
  for (let i = 0; i < 40; i += 1) {
    if (world.manager.activeSession('run-1')?.chatTarget != null && world.manager.activeSession('run-2')?.chatTarget != null) return;
    await tick();
  }
  throw new Error('fixture jobs never parked');
}

function chatReplies(sink: FrameSink): Array<Record<string, unknown>> {
  return sink.frames.filter((f) => f.type === 'chat_reply') as Array<Record<string, unknown>>;
}

describe('chat channel, end to end over the real relay bridge', () => {
  test('DoD: an inbound chat_send lands in the executor session of the run it names — and only that one', async () => {
    const world = makeWorld();
    await startBothParked(world);

    world.dispatcher.dispatch(chatSend('run-2', 'msg-1', 'use the eu-west host'));
    for (let i = 0; i < 40 && world.exec.of('pipeline').filter((c) => runIdOf(c.args) === 'run-2').length < 2; i += 1) await tick();

    const run2Drives = world.exec.of('pipeline').filter((c) => runIdOf(c.args) === 'run-2');
    const run1Drives = world.exec.of('pipeline').filter((c) => runIdOf(c.args) === 'run-1');

    // run-2's session resumed with the chat text as its input — the same
    // `--answer` re-entry an `answer` frame produces.
    expect(run2Drives).toHaveLength(2);
    expect(run2Drives[1]!.args).toContain('--answer');
    expect(run2Drives[1]!.args[run2Drives[1]!.args.indexOf('--answer') + 1]).toBe('use the eu-west host');

    // run-1's session never moved: still parked on its first drive.
    expect(run1Drives).toHaveLength(1);
    expect(world.manager.activeSession('run-1')?.chatTarget).toEqual({ questionId: 'q-run-1', approvalGated: false });
  });

  test('DoD: the reply frame carries the run binding of the session that took the turn', async () => {
    const world = makeWorld();
    await startBothParked(world);

    world.dispatcher.dispatch(chatSend('run-2', 'msg-7', 'go ahead'));
    for (let i = 0; i < 40 && chatReplies(world.sink).length === 0; i += 1) await tick();

    const replies = chatReplies(world.sink);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'chat_reply', run_id: 'run-2', message_id: 'msg-7', done: true });
    expect(replies[0]!.error).toBeUndefined();
  });

  test('DoD: a chat_send for a run this runner does not own is rejected and reaches no session', async () => {
    const world = makeWorld();
    await startBothParked(world);
    const drivesBefore = world.exec.of('pipeline').length;

    world.dispatcher.dispatch(chatSend('run-999', 'msg-x', 'do something else'));
    await tick();
    await tick();

    expect(world.exec.of('pipeline')).toHaveLength(drivesBefore);
    const replies = chatReplies(world.sink);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      run_id: 'run-999',
      message_id: 'msg-x',
      done: true,
      error: { code: CHAT_ERROR_CODES.notOwned },
    });
    // Both real sessions are untouched and still parked.
    expect(world.manager.activeSession('run-1')?.chatTarget).not.toBeNull();
    expect(world.manager.activeSession('run-2')?.chatTarget).not.toBeNull();
  });

  test('a chat turn resolves the pending needs_input exactly once — a later answer cannot double-resume', async () => {
    const world = makeWorld();
    await startBothParked(world);

    world.dispatcher.dispatch(chatSend('run-2', 'msg-1', 'chat wins the race'));
    for (let i = 0; i < 40 && world.exec.of('pipeline').filter((c) => runIdOf(c.args) === 'run-2').length < 2; i += 1) await tick();

    // The control plane's real `answer` for the SAME question arrives late.
    world.dispatcher.dispatch({
      type: 'answer',
      id: 'corr-1',
      answer: {
        run_id: 'run-2',
        question_id: 'q-run-2',
        answer: 'answer arrives too late',
        answered_by: 'owner@example.com',
        ts: '2026-08-15T00:00:01.000Z',
      },
    } as WireFrame);
    await tick();
    await tick();

    const run2Drives = world.exec.of('pipeline').filter((c) => runIdOf(c.args) === 'run-2');
    expect(run2Drives).toHaveLength(2);
    expect(world.logger.joined()).toContain('matches no pending question');
  });

  test('an approval-gated park refuses the chat turn and stays parked', async () => {
    const world = makeWorld({ approvalFor: { 'run-2': { required_role: 'owner' } } });
    await startBothParked(world);
    const drivesBefore = world.exec.of('pipeline').length;

    expect(world.manager.activeSession('run-2')?.chatTarget).toEqual({ questionId: 'q-run-2', approvalGated: true });

    world.dispatcher.dispatch(chatSend('run-2', 'msg-1', 'approved, ship it'));
    await tick();
    await tick();

    expect(world.exec.of('pipeline')).toHaveLength(drivesBefore);
    expect(chatReplies(world.sink)[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.sessionUnavailable });
    expect(world.manager.activeSession('run-2')?.chatTarget?.approvalGated).toBe(true);
  });

  test('a malformed approval marker still counts as gated (fail closed for chat)', async () => {
    const world = makeWorld({ approvalFor: { 'run-2': true } });
    await startBothParked(world);

    expect(world.manager.activeSession('run-2')?.chatTarget?.approvalGated).toBe(true);

    world.dispatcher.dispatch(chatSend('run-2', 'msg-1', 'approved'));
    await tick();

    expect(chatReplies(world.sink)[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.sessionUnavailable });
  });

  test('a running (not parked) session refuses the turn rather than queueing it', async () => {
    const world = makeWorld();
    world.dispatcher.dispatch(makeLease({ job_id: 'job-1', run_id: 'run-1' }));
    // Deliver while the job is still preparing/running — before it parks.
    world.dispatcher.dispatch(chatSend('run-1', 'msg-1', 'hello?'));
    await tick();

    const replies = chatReplies(world.sink);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.sessionUnavailable });
  });

  test('chatTarget is retracted the moment the session resumes', async () => {
    const world = makeWorld();
    await startBothParked(world);

    world.dispatcher.dispatch(chatSend('run-2', 'msg-1', 'proceed'));
    for (let i = 0; i < 40 && world.manager.activeSession('run-2') !== null; i += 1) await tick();

    // run-2 completed and left the active map entirely; a second chat turn
    // for it is therefore not owned, not "owned but unavailable".
    expect(world.manager.activeSession('run-2')).toBeNull();
    world.dispatcher.dispatch(chatSend('run-2', 'msg-2', 'anything else?'));
    await tick();
    const last = chatReplies(world.sink).at(-1)!;
    expect(last.error).toMatchObject({ code: CHAT_ERROR_CODES.notOwned });
  });

  test('activeSession is exact-id: no prefix, no nearest match', async () => {
    const world = makeWorld();
    await startBothParked(world);

    expect(world.manager.activeSession('run-1')?.runId).toBe('run-1');
    expect(world.manager.activeSession('run-')).toBeNull();
    expect(world.manager.activeSession('run-11')).toBeNull();
    expect(world.manager.activeSession('')).toBeNull();
  });
});
