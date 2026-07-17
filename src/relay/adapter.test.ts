/**
 * c3 E2E: the full needs-input round trip wired exactly as `cli.ts` wires it
 * — a REAL `JobExecutor`, a REAL `PullRelayAdapter`, and a REAL
 * `NeedsInputRelay` bridge (only the wire transport + fs/exec seams are
 * faked). Proves the T1-13 alignment end-to-end: park -> needs_input frame
 * carrying drive's question_id -> answer frame -> the adapter resolves the
 * executor's inline await -> `pipeline drive --resume --start <iteration>
 * --answer <text>` is observed. Closes E3 ("T1-13 not wired",
 * `01-current-architecture.md` §4).
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { WireFrame } from '../core/wire';
import { CaptureLogger, tick } from '../../tests/_helpers';
import { DRIVE_COMPLETED, driveAwaiting, FakeJobExec, FakeJobFs, GIT_OK, makeLease } from '../jobs/_helpers';
import { JobExecutor } from '../jobs/executor';
import type { JobExecResult } from '../jobs/types';
import { PullRelayAdapter } from './adapter';
import { NeedsInputRelay, type RelayClientPort } from './bridge';

const ROOT = join('/w');
const DIR = join(ROOT, 'job-1');
const PIPELINE_ROOT = join(DIR, '.claude', 'pipeline', 'release');

/** A minimal `RelayClientPort` double: records sent frames, toggles
 *  online/offline, and lets the test push inbound frames through the same
 *  dispatcher hook `AgentClient` feeds. Mirrors `tests/relay.test.ts`'s
 *  `MockClientPort` (kept local — this suite crosses `jobs` + `relay`, so it
 *  does not belong to either module's own test file). */
class FakeRelayClient implements RelayClientPort {
  sent: WireFrame[] = [];
  online = true;
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
    if (!this.online) return false;
    this.sent.push(frame);
    return true;
  }

  /** Simulate the control plane pushing a frame down to the runner. */
  serverSend(frame: WireFrame): void {
    for (const handler of [...(this.handlers.get(frame.type) ?? [])]) handler(frame);
  }
}

function answerFrame(runId: string, questionId: string, answer: string, id?: string): WireFrame {
  return {
    type: 'answer',
    ...(id !== undefined ? { id } : {}),
    answer: { run_id: runId, question_id: questionId, answer, answered_by: 'user:alice', ts: '2026-07-17T12:00:00Z' },
  };
}

/** An fs pre-seeded so the fixture lease's workspace prep succeeds (mirrors
 *  `src/jobs/executor.test.ts`'s `readyFs`). */
function readyFs(): FakeJobFs {
  const fs = new FakeJobFs();
  fs.existing.add(PIPELINE_ROOT);
  fs.listings.set(join(PIPELINE_ROOT, 'steps'), ['01-plan.md', '02-deploy.md']);
  return fs;
}

/** Exec fake: git always succeeds; drive results come from the queue. */
function driveExec(queue: JobExecResult[]): FakeJobExec {
  return new FakeJobExec((cmd) => {
    if (cmd === 'git') return GIT_OK;
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra drive invocation');
    return next;
  });
}

/** Wire the three production pieces together exactly as `cli.ts` does:
 *  adapter first (no bridge yet) -> bridge (adapter as its `DriveSession`)
 *  -> `adapter.attach(bridge)` -> executor (`needsInput: adapter`). */
function makeWiredWorld(queue: JobExecResult[]) {
  const client = new FakeRelayClient();
  const logger = new CaptureLogger();
  const adapter = new PullRelayAdapter({ logger });
  const bridge = new NeedsInputRelay({ client, drive: adapter, logger, makeId: () => 'corr-1' });
  adapter.attach(bridge);
  const exec = driveExec(queue);
  const executor = new JobExecutor({
    lease: makeLease(),
    runnerId: 'r-1',
    send: () => true,
    workspaceRoot: ROOT,
    exec,
    fs: readyFs(),
    logger,
    needsInput: adapter,
  });
  return { client, bridge, adapter, executor, exec, logger };
}

describe('c3 E2E — park -> needs_input -> answer -> resume (wired exactly as cli.ts)', () => {
  test('drive question_id passthrough: needs_input carries it verbatim, the answer resolves the pull await, and the resume argv is observed', async () => {
    const world = makeWiredWorld([driveAwaiting('steps/02-deploy.md', 'Which host?', 'drive-q-1'), DRIVE_COMPLETED]);
    const done = world.executor.start();
    await tick();

    expect(world.executor.state).toBe('awaiting_input'); // budget/state machine unchanged by the wiring
    expect(world.client.sent).toHaveLength(1);
    const needsInput = world.client.sent[0]!;
    expect(needsInput.type).toBe('needs_input');
    expect(needsInput.run_id).toBe('run-1');
    expect(needsInput.question_id).toBe('drive-q-1'); // drive's own id, NOT executor-minted

    world.client.serverSend(answerFrame('run-1', 'drive-q-1', 'host-a', needsInput.id as string));
    const result = await done;

    expect(result.ok).toBe(true);
    const driveCalls = world.exec.of('pipeline');
    expect(driveCalls).toHaveLength(2);
    expect(driveCalls[1]!.args).toEqual([
      'drive',
      '--root',
      PIPELINE_ROOT,
      '--run-id',
      'run-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
  });

  test('once-only delivery: a duplicate answer for an already-resolved question never double-resumes drive (bridge.ts:224 semantics)', async () => {
    const world = makeWiredWorld([driveAwaiting('steps/02-deploy.md', 'Which host?', 'drive-q-1'), DRIVE_COMPLETED]);
    const done = world.executor.start();
    await tick();

    const needsInput = world.client.sent[0]!;
    world.client.serverSend(answerFrame('run-1', 'drive-q-1', 'host-a', needsInput.id as string));
    // A late duplicate racing behind the first — the bridge deletes its
    // pending entry BEFORE delivering (bridge.ts:224), so this must be
    // dropped before ever reaching the adapter's resumeWithAnswer again.
    world.client.serverSend(answerFrame('run-1', 'drive-q-1', 'host-b', needsInput.id as string));

    const result = await done;
    expect(result.ok).toBe(true);
    expect(world.exec.of('pipeline')).toHaveLength(2); // start + exactly ONE resume
    expect(world.exec.of('pipeline')[1]!.args).toContain('host-a'); // the FIRST answer won, never 'host-b'
  });

  test('old-CLI fallback: a park JSON without question_id still round-trips (executor mints, adapter/bridge correlate on the minted id — 06.2.2)', async () => {
    const world = makeWiredWorld([driveAwaiting('steps/02-deploy.md', 'Which host?'), DRIVE_COMPLETED]);
    const done = world.executor.start();
    await tick();

    expect(world.client.sent).toHaveLength(1);
    const mintedId = world.client.sent[0]!.question_id as string;
    expect(typeof mintedId).toBe('string');
    expect(mintedId.length).toBeGreaterThan(0);

    world.client.serverSend(answerFrame('run-1', mintedId, 'host-a', world.client.sent[0]!.id as string));
    const result = await done;

    expect(result.ok).toBe(true);
    expect(world.exec.of('pipeline')[1]!.args).toContain('--answer');
    expect(world.exec.of('pipeline')[1]!.args).toContain('host-a');
  });

  test('offline park stays pending and re-surfaces once the client reconnects (resurfacePending, bridge.ts:178-187)', async () => {
    const world = makeWiredWorld([driveAwaiting('steps/02-deploy.md', 'Which host?', 'drive-q-9'), DRIVE_COMPLETED]);
    world.client.online = false;
    const done = world.executor.start();
    await tick();

    expect(world.client.sent).toHaveLength(0); // nothing left the runner while offline
    expect(world.bridge.pendingCount).toBe(1);
    expect(world.bridge.hasPending('run-1', 'drive-q-9')).toBe(true);
    expect(world.executor.state).toBe('awaiting_input'); // parked, not failed, while offline

    // Reconnect — cli.ts's AgentClientEvents.onOnline calls exactly this.
    world.client.online = true;
    const delivered = world.bridge.resurfacePending();
    expect(delivered).toBe(1);
    expect(world.client.sent).toHaveLength(1);
    expect(world.client.sent[0]!.question_id).toBe('drive-q-9');

    world.client.serverSend(answerFrame('run-1', 'drive-q-9', 'host-a', world.client.sent[0]!.id as string));
    const result = await done;
    expect(result.ok).toBe(true);
  });
});
