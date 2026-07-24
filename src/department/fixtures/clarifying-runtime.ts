#!/usr/bin/env bun
/**
 * A minimal, REAL `jsonl-process` runtime for the department-mesh `e1` P0
 * vertical-slice gate (cross-repo end-to-end test). Adapted from
 * `./scripted-runtime.ts` (d1's conformance fixture) to match the P0 exit
 * criterion literally (11-migration-rollout.md P0 "Exit"): "a task created
 * over HTTP reaches a JSONL department on a real runner, asks a question, is
 * answered, completes."
 *
 * Behavior:
 *   `initialize`  -> `ready` (declares `midTaskInput: false` — this fixture
 *                     always expects a FRESH `task.start` with the full
 *                     message history, never a live `task.message`; matches
 *                     03-flows.md §2's primary "release the lease, offer a
 *                     new execution" resume path, not the live-input path).
 *   `task.start`  -> if the task's message history contains fewer than TWO
 *                     `ROLE_USER` messages (i.e. no answer yet): emits
 *                     `task.status` (WORKING) then `task.input_required`
 *                     (one clarifying question) and STOPS (awaits the next
 *                     `task.start` — a fresh execution/process, per the
 *                     `midTaskInput:false` contract above).
 *                    Otherwise (an answer is present, second `ROLE_USER`
 *                     message): emits `task.progress` then `task.completed`.
 *   `task.cancel` -> `task.failed`.
 *   `shutdown`    -> exit 0.
 */

import { createInterface } from 'node:readline';

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

interface WireMessage {
  messageId?: string;
  role?: string;
  parts?: Array<{ text?: string }>;
}

const QUESTION_ID = 'q-clarify-1';

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // mirrors the malformed-line tolerance the adapter itself applies
  }
  switch (msg.type) {
    case 'initialize':
      send({
        type: 'ready',
        runtime: 'clarifying-runtime',
        version: '1.0.0',
        capabilities: { midTaskInput: false, artifacts: false },
      });
      break;
    case 'task.start': {
      const task = msg.task as { messages?: WireMessage[] } | undefined;
      const messages = task?.messages ?? [];
      const userMessages = messages.filter((m) => m.role === 'ROLE_USER');
      if (userMessages.length < 2) {
        send({ type: 'task.status', state: 'WORKING', message: 'inspecting the request' });
        send({
          type: 'task.input_required',
          questionId: QUESTION_ID,
          question: { text: 'Which target platform — Android or iOS?', options: ['Android', 'iOS'] },
        });
        break;
      }
      const answerText = userMessages[userMessages.length - 1]?.parts?.[0]?.text ?? '';
      send({ type: 'task.progress', note: `applying answer: ${answerText}` });
      send({ type: 'task.completed', summary: `done for ${answerText}` });
      break;
    }
    case 'task.cancel':
      send({ type: 'task.failed', reason: 'canceled', retrySafe: false });
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
    // unrecognized — ignored, same tolerance the adapter applies to us
  }
});
