/**
 * c4 (`pipeline-ui-v2`): the P2.5 run-bound CHAT channel — `src/relay/chat.ts`
 * (the wire round-trip + ownership boundary) and `src/jobs/chat-session.ts`
 * (the production registry over the job manager's active executors).
 *
 * The three assertions the task's Definition of Done names are marked `DoD`.
 * Everything else exists because the channel is security-critical (07 T7) and
 * a routing relay's interesting behaviour is entirely in its refusals.
 */

import { describe, expect, test } from 'bun:test';
import { CHAT_MESSAGE_MAX_CHARS, ChatReplyMessageSchema, ChatSendMessageSchema } from '@baizor/pipeline-protocol';
import { ChatRelay, type ChatReplySink, type ChatSessionHandle, type ChatSessionRegistry } from '../src/relay/chat';
import { CHAT_ERROR_CODES } from '../src/relay/chat-wire';
import { jobChatRegistry, type ChatCapableSession } from '../src/jobs/chat-session';
import type { RelayClientPort } from '../src/relay/bridge';
import type { WireFrame } from '../src/core/wire';
import { CaptureLogger } from './_helpers';

// ── Test doubles ────────────────────────────────────────────────────────────

/** Mirrors `MockClientPort` in ./relay.test.ts — the same `AgentClient` slice
 *  the needs-input bridge takes, since chat rides the SAME port (M6). */
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

  replies(): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.type === 'chat_reply') as Array<Record<string, unknown>>;
  }
}

/** A session that records what text it was handed, and replies as scripted. */
class RecordingSession implements ChatSessionHandle {
  delivered: string[] = [];
  constructor(
    readonly runId: string,
    private readonly reply: (replies: ChatReplySink) => void | Promise<void> = (r) => r.done('ok')
  ) {}
  deliver(message: string, replies: ChatReplySink): void | Promise<void> {
    this.delivered.push(message);
    return this.reply(replies);
  }
}

/** A registry over a fixed set of sessions — exact run id or nothing. */
function registryOf(...sessions: ChatSessionHandle[]): ChatSessionRegistry {
  return { lookup: (runId) => sessions.find((s) => s.runId === runId) ?? null };
}

let stamps = 0;
function makeRelay(sessions: ChatSessionRegistry, options: { maxRememberedTurns?: number } = {}) {
  const client = new MockClientPort();
  const logger = new CaptureLogger();
  const relay = new ChatRelay({
    client,
    sessions,
    logger,
    now: () => new Date(Date.UTC(2026, 7, 15, 0, 0, ++stamps % 60)).toISOString(),
    ...(options.maxRememberedTurns === undefined ? {} : { maxRememberedTurns: options.maxRememberedTurns }),
  });
  return { client, logger, relay };
}

function chatSend(over: Record<string, unknown> = {}): WireFrame {
  return {
    type: 'chat_send',
    run_id: 'run-1',
    message_id: 'msg-1',
    message: 'how is it going?',
    sent_by: 'owner@example.com',
    ts: '2026-08-15T00:00:00.000Z',
    ...over,
  } as WireFrame;
}

// ── DoD 1: an inbound frame lands in the CORRECT executor session ───────────

describe('chat_send → executor session', () => {
  test('DoD: the message lands in the session the frame names, and in no other', () => {
    const target = new RecordingSession('run-1');
    const bystander = new RecordingSession('run-2');
    const { client } = makeRelay(registryOf(target, bystander));

    client.serverSend(chatSend({ message: 'ship it' }));

    expect(target.delivered).toEqual(['ship it']);
    expect(bystander.delivered).toEqual([]);
  });

  test('the session receives ONLY the text — no run id, no sent_by, no ts', () => {
    // A structural assertion, not a behavioural one: `deliver` takes
    // (message, replies). If a run id were ever added back as a parameter,
    // this test would stop compiling — which is the point (07 T7).
    const target = new RecordingSession('run-1');
    const { client } = makeRelay(registryOf(target));
    client.serverSend(chatSend({ message: 'text only' }));
    expect(target.delivered).toEqual(['text only']);
    expect(target.deliver.length).toBe(2);
  });

  test('attaches exactly one chat_send handler, and stop() detaches it', () => {
    const target = new RecordingSession('run-1');
    const { client, relay } = makeRelay(registryOf(target));
    expect(client.handlerCount('chat_send')).toBe(1);
    relay.stop();
    relay.stop(); // idempotent
    expect(client.handlerCount('chat_send')).toBe(0);
    client.serverSend(chatSend());
    expect(target.delivered).toEqual([]);
  });
});

// ── DoD 2: the reply carries the run binding ────────────────────────────────

describe('chat_reply', () => {
  test('DoD: a reply carries the run binding and echoes the turn identity', () => {
    const { client } = makeRelay(registryOf(new RecordingSession('run-1', (r) => r.done('all good'))));

    client.serverSend(chatSend({ id: 'corr-9' }));

    const replies = client.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      type: 'chat_reply',
      run_id: 'run-1',
      message_id: 'msg-1',
      message: 'all good',
      done: true,
      id: 'corr-9',
    });
    // Every emitted frame must satisfy the canonical protocol schema.
    expect(ChatReplyMessageSchema.safeParse(replies[0]).success).toBe(true);
  });

  test('the run binding comes from the SESSION, not from the inbound frame', () => {
    // A registry that hands back a session for a DIFFERENT run than the one
    // asked for is a defect; the relay must refuse rather than reply on
    // either run's behalf.
    const wrong = new RecordingSession('run-OTHER');
    const { client } = makeRelay({ lookup: () => wrong });

    client.serverSend(chatSend({ run_id: 'run-1' }));

    expect(wrong.delivered).toEqual([]);
    const replies = client.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.run_id).toBe('run-1');
    expect(replies[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.notOwned });
  });

  test('streams chunks then a final done:true, every chunk bound to the run', () => {
    const { client } = makeRelay(
      registryOf(
        new RecordingSession('run-1', (r) => {
          r.chunk('think');
          r.chunk('ing…');
          r.done('done thinking');
        })
      )
    );

    client.serverSend(chatSend());

    const replies = client.replies();
    expect(replies.map((r) => [r.message, r.done])).toEqual([
      ['think', false],
      ['ing…', false],
      ['done thinking', true],
    ]);
    expect(replies.every((r) => r.run_id === 'run-1' && r.message_id === 'msg-1')).toBe(true);
    expect(replies.every((r) => ChatReplyMessageSchema.safeParse(r).success)).toBe(true);
  });

  test('post-terminal sink calls are dropped, never emitted', () => {
    const { client, logger } = makeRelay(
      registryOf(
        new RecordingSession('run-1', (r) => {
          r.done('final');
          r.chunk('too late');
          r.done('twice');
          r.fail(CHAT_ERROR_CODES.internalError, 'also too late');
        })
      )
    );

    client.serverSend(chatSend());

    expect(client.replies()).toHaveLength(1);
    expect(logger.joined()).toContain('after the turn closed');
  });

  test('an over-long reply chunk is clamped to the wire cap rather than emitted unparseable', () => {
    const { client } = makeRelay(registryOf(new RecordingSession('run-1', (r) => r.done('y'.repeat(CHAT_MESSAGE_MAX_CHARS + 500)))));

    client.serverSend(chatSend());

    const reply = client.replies()[0]!;
    expect((reply.message as string).length).toBe(CHAT_MESSAGE_MAX_CHARS);
    expect(ChatReplyMessageSchema.safeParse(reply).success).toBe(true);
  });

  test('an offline connection loses the reply but still settles the turn for replay', () => {
    const { client } = makeRelay(registryOf(new RecordingSession('run-1')));
    client.online = false;

    client.serverSend(chatSend());
    expect(client.replies()).toHaveLength(0);

    // The cloud's F7 queue redelivers the send; the stored terminal replays.
    client.online = true;
    client.serverSend(chatSend());
    expect(client.replies()).toHaveLength(1);
    expect(client.replies()[0]).toMatchObject({ done: true, message: 'ok' });
  });
});

// ── DoD 3: a frame for a non-owned run is rejected ──────────────────────────

describe('ownership boundary (07 T7)', () => {
  test('DoD: a chat_send for a run this runner does not own is rejected, never delivered', () => {
    const mine = new RecordingSession('run-mine');
    const { client } = makeRelay(registryOf(mine));

    client.serverSend(chatSend({ run_id: 'run-someone-elses', message_id: 'msg-x' }));

    expect(mine.delivered).toEqual([]);
    const replies = client.replies();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      run_id: 'run-someone-elses',
      message_id: 'msg-x',
      done: true,
      error: { code: CHAT_ERROR_CODES.notOwned },
    });
  });

  test('the rejection is a FRAME, not silence', () => {
    const { client } = makeRelay(registryOf());
    client.serverSend(chatSend());
    expect(client.replies()).toHaveLength(1);
    expect(client.replies()[0]!.done).toBe(true);
  });

  test('the ownership check runs BEFORE the payload parse', () => {
    // An oversized message for a non-owned run must be refused as
    // `not_owned` — the security gate is first, and the parse verdict is
    // never reported for a run we do not own.
    const { client } = makeRelay(registryOf());
    client.serverSend(chatSend({ message: 'z'.repeat(CHAT_MESSAGE_MAX_CHARS + 1) }));
    expect((client.replies()[0]!.error as Record<string, unknown>).code).toBe(CHAT_ERROR_CODES.notOwned);
  });

  test('no message payload, rejected value, or sender identity reaches the log', () => {
    const secret = 'CORRELATION-HORIZON-SECRET';
    const { client, logger } = makeRelay(registryOf());
    client.serverSend(chatSend({ message: secret, sent_by: `${secret}@example.com` }));
    expect(logger.joined()).not.toContain(secret);
    expect(logger.joined()).toContain(CHAT_ERROR_CODES.notOwned);
  });
});

// ── Malformed inbound ───────────────────────────────────────────────────────

describe('malformed chat_send', () => {
  test('an owned run with an oversized message is refused with message_too_large', () => {
    const target = new RecordingSession('run-1');
    const { client } = makeRelay(registryOf(target));

    const oversized = 'x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1);
    expect(ChatSendMessageSchema.safeParse(chatSend({ message: oversized })).success).toBe(false);
    client.serverSend(chatSend({ message: oversized }));

    expect(target.delivered).toEqual([]);
    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.messageTooLarge });
  });

  test('an owned run with an otherwise schema-invalid frame is refused with invalid_message', () => {
    const target = new RecordingSession('run-1');
    const { client } = makeRelay(registryOf(target));

    client.serverSend(chatSend({ ts: 'not-a-timestamp' }));

    expect(target.delivered).toEqual([]);
    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.invalidMessage });
  });

  test('a frame with no recoverable (run_id, message_id) is the ONE silent case', () => {
    const { client, logger } = makeRelay(registryOf(new RecordingSession('run-1')));

    client.serverSend({ type: 'chat_send', message: 'orphan' } as WireFrame);
    client.serverSend(chatSend({ run_id: '' }));
    client.serverSend(chatSend({ message_id: 42 }));

    expect(client.replies()).toHaveLength(0);
    expect(logger.lines.filter((l) => l.includes('no (run_id, message_id)'))).toHaveLength(3);
  });

  test('a session that throws terminates the turn with internal_error', () => {
    const { client } = makeRelay(
      registryOf(
        new RecordingSession('run-1', () => {
          throw new Error('session exploded');
        })
      )
    );

    client.serverSend(chatSend());

    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.internalError });
  });

  test('a session whose promise rejects terminates the turn with internal_error', async () => {
    const { client } = makeRelay(registryOf(new RecordingSession('run-1', () => Promise.reject(new Error('async boom')))));

    client.serverSend(chatSend());
    await Promise.resolve();
    await Promise.resolve();

    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.internalError });
  });
});

// ── Redelivery (F7) ─────────────────────────────────────────────────────────

describe('redelivery dedupe on (run_id, message_id)', () => {
  test('a redelivered send is never injected twice; the terminal reply replays', () => {
    const target = new RecordingSession('run-1');
    const { client } = makeRelay(registryOf(target));

    client.serverSend(chatSend());
    client.serverSend(chatSend());
    client.serverSend(chatSend());

    expect(target.delivered).toEqual(['how is it going?']);
    const replies = client.replies();
    expect(replies).toHaveLength(3);
    expect(replies[1]).toEqual(replies[0]!);
    expect(replies[2]).toEqual(replies[0]!);
  });

  test('a different message_id on the same run is a NEW turn', () => {
    const target = new RecordingSession('run-1');
    const { client } = makeRelay(registryOf(target));

    client.serverSend(chatSend({ message_id: 'msg-1', message: 'first' }));
    client.serverSend(chatSend({ message_id: 'msg-2', message: 'second' }));

    expect(target.delivered).toEqual(['first', 'second']);
  });

  test('the same message_id on a different run is a NEW turn (the key is composite)', () => {
    const a = new RecordingSession('run-a');
    const b = new RecordingSession('run-b');
    const { client } = makeRelay(registryOf(a, b));

    client.serverSend(chatSend({ run_id: 'run-a', message: 'to a' }));
    client.serverSend(chatSend({ run_id: 'run-b', message: 'to b' }));

    expect(a.delivered).toEqual(['to a']);
    expect(b.delivered).toEqual(['to b']);
  });

  test('a redelivery of an IN-FLIGHT turn is dropped, not replayed', () => {
    let release: (() => void) | null = null;
    const target = new RecordingSession(
      'run-1',
      (r) =>
        new Promise<void>((resolve) => {
          release = () => {
            r.done('late');
            resolve();
          };
        })
    );
    const { client, logger } = makeRelay(registryOf(target));

    client.serverSend(chatSend());
    client.serverSend(chatSend());

    expect(target.delivered).toHaveLength(1);
    expect(client.replies()).toHaveLength(0);
    expect(logger.joined()).toContain('in-flight turn — dropped');
    release!();
  });

  test('remembered turns are bounded', () => {
    const target = new RecordingSession('run-1');
    const { relay, client } = makeRelay(registryOf(target), { maxRememberedTurns: 3 });

    for (let i = 0; i < 10; i += 1) client.serverSend(chatSend({ message_id: `msg-${i}` }));

    expect(target.delivered).toHaveLength(10);
    expect(relay.trackedTurns).toBe(3);
  });
});

// ── The production registry over the job manager ────────────────────────────

describe('jobChatRegistry (ownership over live executors)', () => {
  function session(runId: string, target: ChatCapableSession['chatTarget']): ChatCapableSession {
    return { runId, chatTarget: target };
  }

  function setup(sessions: ChatCapableSession[], deliverResult = true) {
    const calls: Array<{ runId: string; questionId: string; text: string }> = [];
    const registry = jobChatRegistry({
      jobs: { activeSession: (runId) => sessions.find((s) => s.runId === runId) ?? null },
      delivery: {
        deliverPending: (runId, questionId, text) => {
          calls.push({ runId, questionId, text });
          return deliverResult;
        },
      },
    });
    return { calls, ...makeRelayWith(registry) };
  }

  function makeRelayWith(sessions: ChatSessionRegistry) {
    const client = new MockClientPort();
    const logger = new CaptureLogger();
    new ChatRelay({ client, sessions, logger, now: () => '2026-08-15T00:00:00.000Z' });
    return { client, logger };
  }

  test('a parked, ungated session receives the text through the needs-input delivery seam', () => {
    const { calls, client } = setup([session('run-1', { questionId: 'q-7', approvalGated: false })]);

    client.serverSend(chatSend({ message: 'proceed with option B' }));

    expect(calls).toEqual([{ runId: 'run-1', questionId: 'q-7', text: 'proceed with option B' }]);
    expect(client.replies()[0]).toMatchObject({ run_id: 'run-1', message_id: 'msg-1', done: true });
    expect(client.replies()[0]!.error).toBeUndefined();
  });

  test('the delivery seam is called with the SESSION run id, never a frame-supplied one', () => {
    const { calls, client } = setup([session('run-1', { questionId: 'q-7', approvalGated: false })]);
    client.serverSend(chatSend({ run_id: 'run-1' }));
    expect(calls[0]!.runId).toBe('run-1');
  });

  test('a run with no live executor is not owned', () => {
    const { calls, client } = setup([session('run-other', { questionId: 'q-1', approvalGated: false })]);

    client.serverSend(chatSend({ run_id: 'run-1' }));

    expect(calls).toEqual([]);
    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.notOwned });
  });

  test('an owned but NOT-parked session refuses with session_unavailable', () => {
    const { calls, client } = setup([session('run-1', null)]);

    client.serverSend(chatSend());

    expect(calls).toEqual([]);
    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.sessionUnavailable });
  });

  test('an APPROVAL-GATED park refuses chat — a gate must not be cleared by a chat turn', () => {
    const { calls, client } = setup([session('run-1', { questionId: 'q-7', approvalGated: true })]);

    client.serverSend(chatSend({ message: 'yes, approve it' }));

    expect(calls).toEqual([]);
    const error = client.replies()[0]!.error as Record<string, unknown>;
    expect(error.code).toBe(CHAT_ERROR_CODES.sessionUnavailable);
    expect(String(error.message)).toContain('approval');
  });

  test('a park resolved between lookup and delivery loses the race cleanly', () => {
    const { client } = setup([session('run-1', { questionId: 'q-7', approvalGated: false })], false);

    client.serverSend(chatSend());

    expect(client.replies()[0]!.error).toMatchObject({ code: CHAT_ERROR_CODES.sessionUnavailable });
  });

  test('a registry-level run-id mismatch is refused rather than delivered', () => {
    const calls: string[] = [];
    const registry = jobChatRegistry({
      // A deliberately broken source: it answers every lookup with run-2.
      jobs: { activeSession: () => session('run-2', { questionId: 'q-1', approvalGated: false }) },
      delivery: {
        deliverPending: (runId) => {
          calls.push(runId);
          return true;
        },
      },
    });
    const { client } = makeRelayWith(registry);

    client.serverSend(chatSend({ run_id: 'run-1' }));

    expect(calls).toEqual([]);
    expect(client.replies()[0]).toMatchObject({ run_id: 'run-1', error: { code: CHAT_ERROR_CODES.notOwned } });
  });
});
