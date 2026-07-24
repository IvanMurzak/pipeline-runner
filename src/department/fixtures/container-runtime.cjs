#!/usr/bin/env node
/**
 * A minimal, REAL `jsonl-process` runtime for the department-mesh `e2` P1
 * gate's LIVE Docker container-tier proof (`d8`). Plain CommonJS (not
 * TypeScript/bun) so it runs unmodified inside a vanilla `node:*` image with
 * no bun/ts-node install step — the `container` adapter (`d8`) wraps
 * whatever `command`/`args` the department declares, so this is mounted
 * READ-ONLY into the container at a fixed path and invoked as
 * `node /fixtures/container-runtime.cjs`.
 *
 * Behavior: on `task.start`, probes the THREE controls the `container`
 * adapter is supposed to enforce (07-runtime-contract.md §2.1/§2.2,
 * 10-security.md §5) and reports the results as JSON in `task.completed`'s
 * `summary` for the test to assert on:
 *   - `rootWrite`: attempt to write OUTSIDE any explicit mount (container
 *     root) — must be BLOCKED by `--read-only`.
 *   - `workspaceWrite`: attempt to write INSIDE the auto-provisioned
 *     per-execution workspace mount (`/workspace`, read-write) — must
 *     SUCCEED (proves the sandbox isn't simply broken/inert).
 *   - `egress`: attempt an outbound HTTP connection — must be BLOCKED by
 *     `--network none` (the default when no `egressAllowlist` is declared).
 */

const readline = require('node:readline');
const fs = require('node:fs');
const http = require('node:http');

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function attemptRootWrite() {
  try {
    fs.writeFileSync('/escape-attempt.txt', 'pwned');
    return { blocked: false };
  } catch (err) {
    return { blocked: true, code: err && err.code };
  }
}

function attemptWorkspaceWrite() {
  try {
    fs.writeFileSync('/workspace/ok.txt', 'hello-from-container');
    const readBack = fs.readFileSync('/workspace/ok.txt', 'utf8');
    return { ok: readBack === 'hello-from-container' };
  } catch (err) {
    return { ok: false, code: err && err.code };
  }
}

function attemptEgress() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const req = http.get({ host: 'example.com', port: 80, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        finish({ blocked: false, status: res.statusCode });
      });
      req.on('error', (err) => finish({ blocked: true, code: err && err.code }));
      req.on('timeout', () => {
        req.destroy();
        finish({ blocked: true, code: 'TIMEOUT' });
      });
    } catch (err) {
      finish({ blocked: true, code: err && err.code });
    }
  });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  switch (msg.type) {
    case 'initialize':
      send({
        type: 'ready',
        runtime: 'container-escape-probe',
        version: '1.0.0',
        capabilities: { midTaskInput: false, artifacts: false },
      });
      break;
    case 'task.start':
      send({ type: 'task.status', state: 'WORKING', message: 'probing sandbox boundaries' });
      Promise.resolve()
        .then(async () => {
          const rootWrite = attemptRootWrite();
          const workspaceWrite = attemptWorkspaceWrite();
          const egress = await attemptEgress();
          send({ type: 'task.completed', summary: JSON.stringify({ rootWrite, workspaceWrite, egress }) });
        })
        .catch((err) => {
          send({ type: 'task.failed', reason: `probe threw: ${err instanceof Error ? err.message : String(err)}`, retrySafe: false });
        });
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
