#!/usr/bin/env bun
/**
 * A minimal, REAL `jsonl-process` runtime for the department-mesh `e2` P1
 * gate's cancel-kills-a-grandchild proof (cross-repo, cloud `c4` + runner
 * `d2`). Adapted from `./clarifying-runtime.ts`'s shape.
 *
 * Behavior:
 *   `initialize`  -> `ready`.
 *   `task.start`  -> spawns a GRANDCHILD process (an ordinary, non-detached
 *                     child of THIS process, so it inherits this process's
 *                     OS process group — exactly the tree
 *                     `ProcessHandle.killGroup()` (d2, `jobs/types.ts`) must
 *                     reach) that writes a fresh heartbeat timestamp to
 *                     `process.env.HEARTBEAT_PATH` every 50ms and IGNORES
 *                     SIGTERM — it can only be reaped by a real SIGKILL
 *                     (POSIX) or an unconditional `taskkill /T /F`
 *                     (Windows), never by "the parent exited". THIS process
 *                     also ignores SIGTERM, for the same reason — the test
 *                     is proving cancellation reaches the whole tree via the
 *                     supervisor's process-GROUP kill escalation
 *                     (`dispose()` -> SIGTERM then SIGKILL after
 *                     `gracefulShutdownSeconds`), not via either process's
 *                     own cooperation.
 *   `task.cancel` -> deliberately does NOTHING (see above — cancellation
 *                     must not depend on this runtime's cooperation at all).
 *   `shutdown`    -> exit 0 (only reachable if nothing else killed it first).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// See the module doc: only a real process-GROUP kill may reap this process.
process.on('SIGTERM', () => {});

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
        runtime: 'process-tree-runtime',
        version: '1.0.0',
        capabilities: { midTaskInput: false, artifacts: false },
      });
      break;
    case 'task.start': {
      const grandchildScript =
        "process.on('SIGTERM',()=>{});" +
        "const fs=require('node:fs');" +
        'const p=process.env.HEARTBEAT_PATH;' +
        "const beat=()=>{try{fs.writeFileSync(p,String(Date.now()))}catch{}};" +
        'beat();setInterval(beat,50);';
      spawn(process.execPath, ['-e', grandchildScript], {
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
      });
      send({ type: 'task.status', state: 'WORKING', message: 'spawned grandchild, idling forever' });
      break;
    }
    case 'task.cancel':
      // Deliberately silent — see the module doc. The supervisor never waits
      // on this anyway (d2: finalize-now, not "wait for task.failed").
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
    // unrecognized — ignored, same tolerance the adapter applies to us
  }
});
