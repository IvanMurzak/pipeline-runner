#!/usr/bin/env bun
/**
 * A minimal, REAL `jsonl-process` runtime for the end-to-end integration
 * test (`../jsonl-process.real.test.ts`) — proves the production
 * `nodeJobSpawn()` seam (real OS pipes, incremental stdout parsing, a live
 * writable stdin) works, not just the in-memory fake the rest of the suite
 * uses. Not a test file itself (no `.test.` in the name — `bun test`'s
 * default discovery does not pick it up); spawned as a child process.
 *
 * Behavior: `initialize` → `ready`; `task.start` → `task.status` (WORKING) +
 * `task.progress`; `task.message` → echoes the text back as a `task.message`
 * then `task.completed`; `task.cancel` → `task.failed`; `shutdown` → exit 0.
 */

import { createInterface } from 'node:readline';

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

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
      send({ type: 'ready', runtime: 'scripted-runtime', version: '1.0.0', capabilities: { midTaskInput: true, artifacts: true } });
      break;
    case 'task.start':
      send({ type: 'task.status', state: 'WORKING', message: 'starting' });
      send({ type: 'task.progress', note: 'halfway' });
      break;
    case 'task.message': {
      const message = msg.message as { parts?: Array<{ text?: string }> } | undefined;
      const text = message?.parts?.[0]?.text ?? '';
      send({ type: 'task.message', parts: [{ text: `echo: ${text}`, mediaType: 'text/plain' }] });
      send({ type: 'task.completed', summary: 'done' });
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
