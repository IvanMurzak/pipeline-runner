#!/usr/bin/env bun
/**
 * `pipeline-runner` CLI — a THIN wrapper over `src/core/`; all logic lives (and
 * is tested) there. Subcommands:
 *
 *   register --url <base-url> --token <runner-token> [--label <l>]...
 *            [--capacity <n>] [--cli-version <v>] [--plugin-version <v>]
 *            [--store-only]
 *       Store the agent identity, then (unless --store-only) connect once to
 *       validate the token and persist the server-assigned runner id.
 *
 *   start    Run the agent loop: connect, register, heartbeat, reconnect.
 *   status   Print the stored identity (token redacted).
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_VERSION, ConfigStore, defaultConfigDir, describeIdentity, detectOs, type AgentIdentity } from './core/config';
import { AgentClient } from './core/connection';
import { consoleLogger } from './core/log';
import { defaultTransports } from './core/transport';
import type { RunnerStatus } from './core/wire';
// T2-03: job execution (lease → accept → workspace → drive) lives in ./jobs.
// c2: the event-shipper composition (onWorkspaceReady → EventShipper) also
// lives there (./jobs/shipper-lifecycle) — see `createShipperLifecycle` below.
import { attachJobExecution, createShipperLifecycle, type JobManager } from './jobs';
// c3 (T1-13): the needs-input relay bridge + its pull->push adapter — see
// `runStart` below for the construction order. `NeedsInputRelay` is aliased
// because `./jobs` exports a DIFFERENT interface of the same name (the
// executor's synchronous-pull seam) — `01-current-architecture.md` §1.5
// calls out the two-shapes collision this alias avoids at the import site.
import { NeedsInputRelay as NeedsInputRelayBridge, PullRelayAdapter } from './relay';
// T1-15: service install/uninstall/status lives in ./service (its own module).
import { runService } from './service';

const REGISTER_ONCE_TIMEOUT_MS = 30_000;

function fail(message: string): never {
  console.error(`[pipeline-runner] error: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      'usage: pipeline-runner <command>',
      '',
      '  register --url <base-url> --token <runner-token> [--label <l>]...',
      '           [--capacity <n>] [--cli-version <v>] [--plugin-version <v>] [--store-only]',
      '  start',
      '  status',
      '  service <install|uninstall|status> [--dry-run]',
      '',
      `pipeline-runner ${AGENT_VERSION} (protocol v1)`,
    ].join('\n')
  );
  process.exit(0);
}

async function runRegister(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      label: { type: 'string', multiple: true },
      capacity: { type: 'string' },
      'cli-version': { type: 'string' },
      'plugin-version': { type: 'string' },
      'store-only': { type: 'boolean' },
    },
  });
  if (!values.url) fail('--url <base-url> is required');
  if (!values.token) fail('--token <runner-token> is required');
  const capacity = values.capacity !== undefined ? Number(values.capacity) : undefined;
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity <= 0)) {
    fail('--capacity must be a positive integer');
  }

  const identity: AgentIdentity = {
    base_url: values.url,
    runner_token: values.token,
    labels: [`os:${detectOs()}`, ...(values.label ?? [])],
    capacity,
    os: detectOs(),
    agent_version: AGENT_VERSION,
    // The `pipeline` CLI version skews independently; detection is a later
    // concern — pass --cli-version when it matters.
    cli_version: values['cli-version'] ?? 'unknown',
    plugin_version: values['plugin-version'] ?? null,
  };
  const store = new ConfigStore();
  store.save(identity);
  console.log(`[pipeline-runner] identity stored at ${store.path}`);
  if (values['store-only']) return;

  console.log('[pipeline-runner] connecting to validate registration...');
  let settle: (outcome: 'online' | 'fatal' | 'timeout') => void = () => {};
  const outcomePromise = new Promise<'online' | 'fatal' | 'timeout'>((resolve) => {
    const timeout = setTimeout(() => resolve('timeout'), REGISTER_ONCE_TIMEOUT_MS);
    settle = (outcome) => {
      clearTimeout(timeout);
      resolve(outcome);
    };
  });
  const client = new AgentClient({
    store,
    transports: defaultTransports(identity.base_url, consoleLogger),
    logger: consoleLogger,
    events: {
      onOnline: () => settle('online'),
      onFatal: () => settle('fatal'),
    },
  });
  client.start();
  const outcome = await outcomePromise;
  client.stop();
  if (outcome === 'online') {
    const runnerId = store.load()?.runner_id;
    console.log(`[pipeline-runner] registered as ${runnerId}`);
  } else if (outcome === 'fatal') {
    fail(client.fatalReason ?? 'registration failed');
  } else {
    fail('could not reach the control plane within 30s — identity stored; run `pipeline-runner start` to retry');
  }
}

function runStart(): void {
  const store = new ConfigStore();
  const identity = store.load();
  if (identity === null) fail('no agent identity configured — run `pipeline-runner register` first');

  // Assigned below, once `attachJobExecution` returns — these accessors are
  // captured by closure into `client`'s heartbeat composition (c2: stop
  // discarding attachJobExecution's return, thread the manager's
  // activeRunIds()/runnerStatus()/pausedUntil() into the heartbeat loop
  // instead of the pre-wiring `[]`/'online' stub).
  let manager: JobManager | null = null;
  // c3: assigned right after `client` below (the bridge needs the live
  // `client` as its RelayClientPort). `onOnline` only fires once the
  // connection actually registers — well after that assignment — so this
  // forward reference is safe (mirrors the `manager` pattern above).
  let relayBridge: NeedsInputRelayBridge;

  const client = new AgentClient({
    store,
    transports: defaultTransports(identity.base_url, consoleLogger),
    logger: consoleLogger,
    events: {
      onFatal: () => process.exit(1),
      // c3: re-send every still-pending needs_input frame once THIS
      // runner's own connection is back online (bridge.ts's `send()`
      // returned false while offline — the question stayed pending, never
      // lost, because drive already journalled the park as `awaiting_input`).
      // NOT the same gap as E12/06.2.4 (an answer POSTed to the CLOUD while
      // the runner was offline needing cloud-side `redeliverQueuedAnswers`
      // on register/reconnect) — that is a separate, P4, cloud-side change.
      onOnline: () => relayBridge.resurfacePending(),
    },
    activeRunIds: () => manager?.activeRunIds() ?? [],
    runnerStatus: (): RunnerStatus => manager?.runnerStatus() ?? 'online',
    pausedUntil: () => manager?.pausedUntil() ?? null,
  });

  // c3 (T1-13): construct ONE needs-input relay bridge + its pull->push
  // adapter on this connection — closes E3 (every parked question
  // previously failed the job, "T1-13 not wired", executor.ts:384). Two-
  // phase construction (see relay/adapter.ts's module doc): the adapter is
  // built first (no bridge yet), the bridge takes the adapter as its
  // `DriveSession`, then `attach()` closes the loop — all synchronously,
  // before `client.start()`, so no lease can race the wiring.
  const relayAdapter = new PullRelayAdapter({ logger: consoleLogger });
  relayBridge = new NeedsInputRelayBridge({ client, drive: relayAdapter, logger: consoleLogger });
  relayAdapter.attach(relayBridge);

  // c2: per-job EventShipper lifecycle (onWorkspaceReady → start, terminal →
  // stop) — closes E4 (a cloud-dispatched run produced no server-side
  // events). WSS `upload` transport (default; runner-token authenticated via
  // this same connection).
  const shipperLifecycle = createShipperLifecycle({
    send: (frame) => client.send(frame),
    dispatcher: client.dispatcher,
    logger: consoleLogger,
  });

  // T2-03: accept job leases (additive — attaches a `lease` handler only; the
  // register/heartbeat/reconnect paths above are untouched).
  manager = attachJobExecution(client, {
    runnerId: () => store.load()?.runner_id ?? null,
    labels: () => store.load()?.labels ?? [],
    capacity: () => store.load()?.capacity ?? 1,
    draining: () => client.draining,
    workspaceRoot: process.env.PIPELINE_RUNNER_JOBS_DIR ?? join(defaultConfigDir(), 'jobs'),
    logger: consoleLogger,
    // c3: the needs-input relay — every parked question now round-trips
    // through the bridge instead of hitting the default auto-fail seam.
    needsInput: relayAdapter,
    events: shipperLifecycle,
  });
  client.start();
  // Active timers/sockets keep the Bun event loop alive; nothing else to do.
}

function runStatus(): void {
  const store = new ConfigStore();
  const identity = store.load();
  if (identity === null) fail('no agent identity configured — run `pipeline-runner register` first');
  console.log(JSON.stringify(describeIdentity(identity), null, 2));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'register':
    await runRegister(rest);
    break;
  case 'start':
    runStart();
    break;
  case 'status':
    runStatus();
    break;
  case 'service':
    // T1-15: additive route to the service module (only change outside src/service/).
    runService(rest);
    break;
  case '--version':
    console.log(AGENT_VERSION);
    break;
  default:
    usage();
}
