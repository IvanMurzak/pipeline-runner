#!/usr/bin/env bun
/**
 * A minimal, REAL `jsonl-process` runtime for the department-mesh `e2` P1
 * gate's park-expiry manifest-plumbing proof (cloud `c2`'s
 * `department.config_update` emission -> runner `d2`'s
 * `DepartmentManager.handleConfigUpdateFrame`, the fix landed alongside this
 * fixture on the `feat/mesh-e2-fixes` branch).
 *
 * Behavior:
 *   `initialize`  -> `ready` (`midTaskInput: false` — a fresh `task.start`
 *                     restarts the process; this fixture never expects a
 *                     live `task.message`).
 *   `task.start`  -> ALWAYS parks (asks a clarifying question it never
 *                     expects an answer to in this test), then starts
 *                     writing a fresh heartbeat timestamp to
 *                     `process.env.HEARTBEAT_PATH` every 50ms. The
 *                     supervisor's `armParkTimer`/`onParkExpired` (d2) is
 *                     what eventually disposes this process — when it does,
 *                     `dispose()` kills it and the heartbeats stop. The test
 *                     watches for exactly that: heartbeats stopping at the
 *                     department's OVERRIDDEN `limits.parkExpiry`, not the
 *                     7-day default, proving the manifest value actually
 *                     reached the runner's timer.
 *   `task.cancel` -> `task.failed` (not exercised by the park-expiry test,
 *                     kept for parity with the other fixtures / manual use).
 *   `shutdown`    -> exit 0.
 */

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  const path = process.env.HEARTBEAT_PATH;
  if (path === undefined || path.length === 0 || heartbeatTimer !== null) return;
  const beat = (): void => {
    try {
      writeFileSync(path, String(Date.now()));
    } catch {
      /* best-effort */
    }
  };
  beat();
  heartbeatTimer = setInterval(beat, 50);
}

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (msg.type) {
    case 'initialize':
      send({
        type: 'ready',
        runtime: 'parking-heartbeat-runtime',
        version: '1.0.0',
        capabilities: { midTaskInput: false, artifacts: false },
      });
      break;
    case 'task.start':
      send({ type: 'task.status', state: 'WORKING', message: 'inspecting the request' });
      send({
        type: 'task.input_required',
        questionId: 'q-park-1',
        question: { text: 'Waiting on input that will never arrive in this test' },
      });
      startHeartbeat();
      break;
    case 'task.cancel':
      send({ type: 'task.failed', reason: 'canceled', retrySafe: false });
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
    // unrecognized — ignored
  }
});
