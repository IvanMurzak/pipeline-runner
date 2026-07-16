import { describe, expect, test } from 'bun:test';
import { NeedsInputRelay, type DriveSession, type RelayClientPort } from '../src/relay/bridge';
import { parseAnswerDelivery } from '../src/relay/wire-relay';
import type { WireFrame } from '../src/core/wire';
import { CaptureLogger } from './_helpers';

// ── A mock client port: records sent frames, controllable online/offline, and
//    lets the test push inbound frames through the same dispatcher hook the
//    connection uses. Mirrors the AgentClient surface the relay needs. ─────────

class MockClientPort implements RelayClientPort {
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

  handlerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

/** A recording drive-session seam. */
class RecordingDrive implements DriveSession {
  calls: Array<{ runId: string; questionId: string; answerText: string }> = [];
  constructor(private readonly onCall?: () => void | Promise<void>) {}
  resumeWithAnswer(runId: string, questionId: string, answerText: string): void | Promise<void> {
    this.calls.push({ runId, questionId, answerText });
    return this.onCall?.();
  }
}

function makeRelay(overrides: { online?: boolean; drive?: DriveSession } = {}) {
  const client = new MockClientPort();
  if (overrides.online === false) client.online = false;
  const drive = overrides.drive ?? new RecordingDrive();
  const logger = new CaptureLogger();
  let ids = 0;
  const relay = new NeedsInputRelay({ client, drive, logger, makeId: () => `corr-${++ids}` });
  return { client, drive: drive as RecordingDrive, logger, relay };
}

function question(runId = 'run-1', questionId = 'q-1', text = 'Deploy to prod?') {
  return { run_id: runId, question_id: questionId, question: { text, context: null, options: null } };
}

function answerFrame(
  runId: string,
  questionId: string,
  answer: string,
  opts: { id?: string; answered_by?: string; ts?: string } = {}
): WireFrame {
  return {
    type: 'answer',
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    answer: {
      run_id: runId,
      question_id: questionId,
      answer,
      answered_by: opts.answered_by ?? 'user:alice',
      ts: opts.ts ?? '2026-07-11T12:00:00Z',
    },
  };
}

describe('surface -> needs_input', () => {
  test('a surfaced question sends a well-shaped needs_input frame with a correlation id', () => {
    const { client, relay } = makeRelay();
    const res = relay.surface(question('run-1', 'q-1', 'Ship it?'));

    expect(res.delivered).toBe(true);
    expect(res.id).toBe('corr-1');
    expect(client.sent).toHaveLength(1);
    const frame = client.sent[0]!;
    expect(frame.type).toBe('needs_input');
    expect(frame.id).toBe('corr-1'); // correlation id on the envelope
    expect(frame.run_id).toBe('run-1');
    expect(frame.question_id).toBe('q-1'); // REQUIRED sibling identity
    expect((frame.question as { text: string }).text).toBe('Ship it?');
    expect(relay.pendingCount).toBe(1);
    expect(relay.hasPending('run-1', 'q-1')).toBe(true);
  });

  test('re-surfacing the same (run_id, question_id) reuses the correlation id (idempotent)', () => {
    const { client, relay } = makeRelay();
    const first = relay.surface(question('run-1', 'q-1'));
    const second = relay.surface(question('run-1', 'q-1'));
    expect(second.id).toBe(first.id);
    expect(client.sent).toHaveLength(2); // sent twice...
    expect(client.sent[0]!.id).toBe(client.sent[1]!.id); // ...same id
    expect(relay.pendingCount).toBe(1); // ...one pending entry
  });
});

describe('answer routing -> drive resume', () => {
  test('an answer routes to the matching pending question and resumes drive with the text', () => {
    const { client, drive, relay } = makeRelay();
    const { id } = relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-1', 'Yes, ship it', { id }));

    expect(drive.calls).toEqual([{ runId: 'run-1', questionId: 'q-1', answerText: 'Yes, ship it' }]);
    expect(relay.pendingCount).toBe(0); // resolved
    expect(relay.hasPending('run-1', 'q-1')).toBe(false);
  });

  test('routing works even when the answer omits the envelope correlation id', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-1', 'go')); // no `id`
    expect(drive.calls).toHaveLength(1);
    expect(drive.calls[0]!.answerText).toBe('go');
  });
});

describe('rejection of stale / cross-run / duplicate / mismatched answers', () => {
  test('a STALE / SUPERSEDED question_id (no pending match) is ignored — no resume', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-2', 'stale')); // q-2 never surfaced

    expect(drive.calls).toHaveLength(0);
    expect(relay.pendingCount).toBe(1); // q-1 still open
    expect(relay.hasPending('run-1', 'q-1')).toBe(true);
  });

  test('a CROSS-RUN answer (same question_id, different run) is ignored', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-2', 'q-1', 'wrong run'));

    expect(drive.calls).toHaveLength(0);
    expect(relay.hasPending('run-1', 'q-1')).toBe(true);
  });

  test('a DUPLICATE answer does NOT double-resume', () => {
    const { client, drive, relay } = makeRelay();
    const { id } = relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-1', 'once', { id }));
    client.serverSend(answerFrame('run-1', 'q-1', 'twice', { id })); // late duplicate

    expect(drive.calls).toHaveLength(1);
    expect(drive.calls[0]!.answerText).toBe('once');
    expect(relay.pendingCount).toBe(0);
  });

  test('an answer whose echoed correlation id MISMATCHES the pending frame is ignored', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1')); // corr-1
    client.serverSend(answerFrame('run-1', 'q-1', 'nope', { id: 'corr-999' }));

    expect(drive.calls).toHaveLength(0);
    expect(relay.hasPending('run-1', 'q-1')).toBe(true); // stays open
  });

  test('a malformed answer frame (missing inner fields) is ignored, not thrown', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    client.serverSend({ type: 'answer', answer: { run_id: 'run-1' } }); // no question_id/answer/...
    client.serverSend({ type: 'answer' }); // no inner payload at all

    expect(drive.calls).toHaveLength(0);
    expect(relay.pendingCount).toBe(1);
  });

  test('two pending questions on the same run route independently', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    relay.surface(question('run-1', 'q-2'));
    expect(relay.pendingCount).toBe(2);
    client.serverSend(answerFrame('run-1', 'q-2', 'answer to two'));
    expect(drive.calls).toEqual([{ runId: 'run-1', questionId: 'q-2', answerText: 'answer to two' }]);
    expect(relay.hasPending('run-1', 'q-1')).toBe(true); // q-1 untouched
    expect(relay.hasPending('run-1', 'q-2')).toBe(false);
  });
});

describe('offline behavior + reconnect resurface', () => {
  test('surfacing while OFFLINE reports delivered:false, keeps the question pending (not lost)', () => {
    const { client, relay } = makeRelay({ online: false });
    const res = relay.surface(question('run-1', 'q-1'));

    expect(res.delivered).toBe(false);
    expect(client.sent).toHaveLength(0); // nothing left the runner
    expect(relay.pendingCount).toBe(1); // still tracked
    expect(relay.hasPending('run-1', 'q-1')).toBe(true);
  });

  test('resurfacePending() re-sends every queued question once the client is back online', () => {
    const { client, relay } = makeRelay({ online: false });
    relay.surface(question('run-1', 'q-1'));
    relay.surface(question('run-2', 'q-9'));
    expect(client.sent).toHaveLength(0);

    client.online = true; // reconnected
    const delivered = relay.resurfacePending();

    expect(delivered).toBe(2);
    expect(client.sent.map((f) => f.question_id).sort()).toEqual(['q-1', 'q-9']);
    // The re-sent frames keep their original correlation ids.
    expect(client.sent.every((f) => typeof f.id === 'string')).toBe(true);
    expect(relay.pendingCount).toBe(2); // still awaiting answers
  });

  test('an answer that arrives after a reconnect resurface resolves the pending question', () => {
    const { client, drive, relay } = makeRelay({ online: false });
    const { id } = relay.surface(question('run-1', 'q-1'));
    client.online = true;
    relay.resurfacePending();
    client.serverSend(answerFrame('run-1', 'q-1', 'delayed yes', { id }));
    expect(drive.calls).toEqual([{ runId: 'run-1', questionId: 'q-1', answerText: 'delayed yes' }]);
  });
});

describe('drive-resume seam robustness + lifecycle', () => {
  test('a drive seam that throws is contained (logged), the read loop survives', () => {
    const throwingDrive: DriveSession = {
      resumeWithAnswer() {
        throw new Error('spawn failed');
      },
    };
    const { client, relay, logger } = makeRelay({ drive: throwingDrive });
    relay.surface(question('run-1', 'q-1'));
    expect(() => client.serverSend(answerFrame('run-1', 'q-1', 'boom'))).not.toThrow();
    expect(logger.joined()).toContain('drive resume for run run-1 question q-1 threw');
    expect(relay.pendingCount).toBe(0); // resolved despite the throw
  });

  test('a rejected async drive resume is caught, not an unhandled rejection', async () => {
    const rejectingDrive: DriveSession = {
      resumeWithAnswer() {
        return Promise.reject(new Error('resume rejected'));
      },
    };
    const { client, relay, logger } = makeRelay({ drive: rejectingDrive });
    relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-1', 'async boom'));
    await new Promise((r) => setTimeout(r, 0)); // let the rejection settle
    expect(logger.joined()).toContain('drive resume for run run-1 question q-1 failed');
  });

  test('stop() detaches the answer handler — later answers no longer route', () => {
    const { client, drive, relay } = makeRelay();
    relay.surface(question('run-1', 'q-1'));
    expect(client.handlerCount('answer')).toBe(1);
    relay.stop();
    expect(client.handlerCount('answer')).toBe(0);
    client.serverSend(answerFrame('run-1', 'q-1', 'too late'));
    expect(drive.calls).toHaveLength(0);
  });
});

describe('secrets discipline', () => {
  test('the answer TEXT and AUTHOR never appear in any log line', () => {
    const { client, logger, relay } = makeRelay();
    const SECRET_ANSWER = 'the-db-password-is-hunter2';
    const AUTHOR = 'user:top-secret-identity';
    relay.surface(question('run-1', 'q-1'));
    client.serverSend(answerFrame('run-1', 'q-1', SECRET_ANSWER, { answered_by: AUTHOR }));

    expect(relay.pendingCount).toBe(0); // it DID route...
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.joined()).not.toContain(SECRET_ANSWER); // ...without logging the text
    expect(logger.joined()).not.toContain(AUTHOR); // ...or the author
    expect(logger.joined()).toContain('answer routed for run run-1 question q-1'); // safe ids only
  });
});

describe('parseAnswerDelivery guard', () => {
  test('accepts a fully-formed answer and rejects each missing-field variant', () => {
    const good = answerFrame('run-1', 'q-1', 'ok', { id: 'x' });
    expect(parseAnswerDelivery(good as WireFrame)).not.toBeNull();

    expect(parseAnswerDelivery({ type: 'needs_input', answer: {} } as WireFrame)).toBeNull(); // wrong type
    expect(parseAnswerDelivery({ type: 'answer' } as WireFrame)).toBeNull(); // no inner
    expect(parseAnswerDelivery({ type: 'answer', answer: null } as WireFrame)).toBeNull();
    expect(
      parseAnswerDelivery({
        type: 'answer',
        answer: { run_id: 'r', question_id: 'q', answer: 'a', answered_by: 'u' },
      } as WireFrame)
    ).toBeNull(); // missing ts
    expect(
      parseAnswerDelivery({
        type: 'answer',
        answer: { run_id: 'r', question_id: 'q', answer: '', answered_by: 'u', ts: 't' },
      } as WireFrame)
    ).toBeNull(); // empty answer text
  });
});
