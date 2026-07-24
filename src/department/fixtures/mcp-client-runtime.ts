#!/usr/bin/env bun
/**
 * A minimal, REAL `jsonl-process` runtime that ALSO proves the department-
 * mesh d6 "point model-driven runtimes at /mcp" plumbing end-to-end
 * (`../manager-mesh-oauth.real.test.ts`): on `task.start` it reads
 * `PIPELINE_MESH_MCP_URL` / `PIPELINE_MESH_EXECUTION_TOKEN` from ITS OWN
 * process environment — injected by `DepartmentManager.spawnAndStart`
 * (`../manager.ts`), never carried on a JSONL frame (13-mcp-authorization.md
 * §12: "no token rides the offer frame — the runner requests its own") —
 * and makes a REAL HTTP call to the (mock, in this test) cloud MCP endpoint
 * using them, exactly as a genuine model-driven MCP client would connect to
 * `https://api.ai-pipeline.dev/mcp` on its own initiative (07 §4: "any
 * MCP-speaking runtime … needs only a URL and a token"). Reports what it saw
 * back over the ordinary JSONL contract so the test can assert on
 * `RuntimeEvent`s without needing to parse this process's own stdout.
 *
 * Not a test file itself (no `.test.` in the name); spawned as a child
 * process, same convention as `./scripted-runtime.ts`.
 */

import { createInterface } from 'node:readline';

function send(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function callMcp(): Promise<void> {
  const url = process.env.PIPELINE_MESH_MCP_URL;
  const token = process.env.PIPELINE_MESH_EXECUTION_TOKEN;
  if (!url || !token) {
    // Proves the OTHER half of the DoD: no token available (offline / refused
    // by the AS) degrades to "no MCP access this run" rather than a crash —
    // this branch IS exercised, by the "refused" test case.
    send({ type: 'task.failed', reason: 'no PIPELINE_MESH_MCP_URL/PIPELINE_MESH_EXECUTION_TOKEN in env', retrySafe: false });
    return;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task.get_current', arguments: {} } }),
    });
    const bodyText = await response.text();
    if (response.status === 200) {
      send({ type: 'task.message', parts: [{ text: `mcp-call-ok status=${response.status} body=${bodyText}`, mediaType: 'text/plain' }] });
      send({ type: 'task.completed', summary: 'mcp-ok' });
    } else {
      send({ type: 'task.failed', reason: `mcp-call-rejected status=${response.status} body=${bodyText}`, retrySafe: false });
    }
  } catch (err) {
    send({ type: 'task.failed', reason: `mcp-call-network-error ${err instanceof Error ? err.message : String(err)}`, retrySafe: false });
  }
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
      send({ type: 'ready', runtime: 'mcp-client-runtime', version: '1.0.0', capabilities: { midTaskInput: false, artifacts: false } });
      break;
    case 'task.start':
      void callMcp();
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
    // unrecognized — ignored, same tolerance the adapter applies to us
  }
});
