/**
 * End-to-end integration test over a REAL OS subprocess (`nodeJobSpawn()`,
 * `../jobs/types.ts`) — the rest of the suite exercises `JsonlProcessAdapter`
 * against an in-memory `FakeJobSpawn` for speed/determinism; this one proves
 * the production spawn seam (real stdin pipe, incremental stdout parsing)
 * actually works end-to-end against `./fixtures/scripted-runtime.ts`.
 *
 * Kept minimal and fast (real process start/stop has real overhead) — the
 * adapter's edge cases are already covered thoroughly by the fake-driven
 * suite; this file only needs to prove the wiring, not re-test every branch.
 */

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from './adapter';
import { makeMessage } from './_test-helpers';
import { JsonlProcessAdapter } from './jsonl-process';
import { nodeJobSpawn } from '../jobs/types';

const FIXTURE = join(import.meta.dir, 'fixtures', 'scripted-runtime.ts');

describe('JsonlProcessAdapter — real subprocess (nodeJobSpawn)', () => {
  test('start → status → progress → send(message) → message → completed → dispose, over a real pipe', async () => {
    const adapter = new JsonlProcessAdapter({ spawn: nodeJobSpawn() });
    const events: RuntimeEvent[] = [];
    const handle = await adapter.start(
      {
        runtime: { adapterId: 'jsonl-process', command: process.execPath, args: [FIXTURE], startupTimeoutSeconds: 15 },
        task: { taskId: 'real-t1', contextId: 'real-c1', messages: [makeMessage()] },
      },
      (event) => events.push(event)
    );
    expect(handle.capabilities).toEqual({ midTaskInput: true, artifacts: true });

    await adapter.send(handle, { kind: 'message', message: makeMessage({ messageId: 'q', parts: [{ text: 'hello' }] }) });

    // Real async I/O — poll for the terminal event instead of a fixed sleep.
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === 'completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await adapter.dispose(handle);

    expect(events).toEqual([
      { type: 'status', state: 'WORKING', message: 'starting' },
      { type: 'progress', note: 'halfway' },
      { type: 'message', parts: [{ text: 'echo: hello', mediaType: 'text/plain' }] },
      { type: 'completed', summary: 'done' },
    ]);
  }, 20_000);
});
