#!/usr/bin/env bun
/**
 * `pipeline-runner` CLI — a THIN wrapper over `src/core/`; all logic lives (and
 * is tested) there. Subcommands:
 *
 *   register --url <base-url> --token <runner-token> [--label <l>]...
 *            [--capacity <n>] [--cli-version <v>] [--plugin-version <v>]
 *            [--gpu] [--store-only]
 *       Store the agent identity, then (unless --store-only) connect once to
 *       validate the token and persist the server-assigned runner id.
 *       Also captures this instance's D17 capability advertisement
 *       (isolation/gpu/os/resource hints, `./core/capabilities.ts`).
 *
 *   start [--home <path>]
 *       Run the agent loop: connect, register, heartbeat, reconnect. Acquires
 *       the per-home exclusive lock first (department-mesh d7, D17,
 *       `./core/home.ts`) — refuses to start if another live daemon already
 *       holds this home. `--home <path>` (or the PIPELINE_RUNNER_HOME env
 *       var it sets) roots this instance's config dir, data dir, and job-
 *       workspace root, isolating it from every other home on the host.
 *   status   Print the stored identity (token redacted).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { detectCapabilities } from './core/capabilities';
import { AGENT_VERSION, ConfigStore, describeIdentity, detectOs, type AgentIdentity } from './core/config';
import { AgentClient } from './core/connection';
// department-mesh (task d7, D17): the isolated-home lock + generalized
// workspace-root resolver — see `./core/home.ts`'s module doc for the full
// picture (config/data dir home-awareness lives in `core/config.ts` /
// `shipper/fs.ts` themselves).
import { acquireHomeLock, HomeLockError, type HomeLockHandle, PIPELINE_RUNNER_HOME_ENV, resolveLockHomeDir, resolveWorkspaceRoot } from './core/home';
import { consoleLogger } from './core/log';
import { defaultTransports } from './core/transport';
import type { RunnerStatus } from './core/wire';
import { defaultDataDir, nodeShipperFs } from './shipper/fs';
// T2-03: job execution (lease → accept → workspace → drive) lives in ./jobs.
// c2: the event-shipper composition (onWorkspaceReady → EventShipper) also
// lives there (./jobs/shipper-lifecycle) — see `createShipperLifecycle` below.
// c6 (design 04 — D1): durable job records + startup reconcile + retention GC
// + graceful shutdown; construction order in `runStart` is load-bearing.
import {
  attachJobExecution,
  createGracefulShutdown,
  createShipperLifecycle,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  fsSubstrateProbe,
  JobStore,
  resolveRetentionPolicy,
  type JobManager,
} from './jobs';
// c3 (T1-13): the needs-input relay bridge + its pull->push adapter — see
// `runStart` below for the construction order. `NeedsInputRelay` is aliased
// because `./jobs` exports a DIFFERENT interface of the same name (the
// executor's synchronous-pull seam) — `01-current-architecture.md` §1.5
// calls out the two-shapes collision this alias avoids at the import site.
import { NeedsInputRelay as NeedsInputRelayBridge, PullRelayAdapter } from './relay';
// T1-15: service install/uninstall/status lives in ./service (its own module).
import { runService } from './service';
// department-mesh (task d1): a SECOND, PARALLEL admission surface for
// department tasks (`department.offer`/`.message`/`.cancel`) — mirrors
// attachJobExecution's construction shape without touching pipeline
// dispatch. `parseDepartmentRuntimesEnv` is a placeholder until department
// install/config_update (task c2) lands — see `./department/config.ts`.
import { parseDepartmentRuntimesEnv } from './department/config';
import { JsonlProcessAdapter } from './department/jsonl-process';
import { DepartmentManager, nodeJournalWriter } from './department/manager';

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
      '           [--capacity <n>] [--cli-version <v>] [--plugin-version <v>]',
      '           [--gpu] [--store-only]',
      '  start [--home <path>]',
      '  status',
      '  service <install|uninstall|status> [--dry-run] [--name <name>] [--home <path>]',
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
      gpu: { type: 'boolean' },
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
    // department-mesh d7 (D17): isolation is always ['process'] until the
    // `container` adapter (task d8) lands; gpu is operator-declared
    // (--gpu) — same posture as --capacity/--label, no portable
    // cross-platform auto-detection exists without a native dependency.
    capabilities: detectCapabilities({ gpu: values.gpu === true }),
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

function runStart(argv: string[] = []): void {
  // department-mesh d7 (D17): `--home <path>` sets PIPELINE_RUNNER_HOME for
  // THIS process before anything else resolves a config/data/workspace path
  // — every downstream `defaultConfigDir`/`defaultDataDir`/
  // `resolveWorkspaceRoot` call below (directly or via `ConfigStore`/
  // `JobStore`/`DepartmentManager`) picks it up automatically since they all
  // default to reading `process.env`. This is how a named OS service
  // (`service/plan.ts`'s `resolveInvocation`) pins an instance to its home:
  // the definition's ExecStart/ProgramArguments/binPath bakes in this flag.
  const { values: startValues } = parseArgs({ args: argv, options: { home: { type: 'string' } } });
  if (startValues.home) process.env[PIPELINE_RUNNER_HOME_ENV] = startValues.home;

  // d7: the per-home exclusive lock — "one daemon per home" (07 §2.2). Must
  // be acquired BEFORE the store/job-store/department journal below touch
  // the home, and fails loudly (not a silent second-instance pile-up) when
  // another live daemon already holds it.
  let lock: HomeLockHandle;
  try {
    lock = acquireHomeLock(resolveLockHomeDir());
  } catch (err) {
    if (err instanceof HomeLockError) fail(err.message);
    throw err;
  }
  consoleLogger.info(`home lock acquired: ${lock.path}`);

  const store = new ConfigStore();
  const identity = store.load();
  if (identity === null) {
    lock.release(); // clean early exit, not a crash — no self-heal needed
    fail('no agent identity configured — run `pipeline-runner register` first');
  }

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

  // c6: local drain flag — set by the graceful-shutdown routine below; the
  // manager's `draining()` reads it alongside the server's drain directive.
  let shuttingDown = false;

  // d2: same forward-reference trick as `manager` above — `departmentManager`
  // is constructed AFTER `client` (it needs `client.send`/`client.dispatcher`),
  // but `onBeat` below must call its `renewLeases()` on the SAME heartbeat
  // cadence `department.lease_renew` rides (07 §6: TTL/3, never a 2nd timer).
  let departmentManager: DepartmentManager | null = null;

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
      // c6: also flush the reconcile's deferred `run_status halted` frames
      // (UNRECOVERABLE drops happen pre-connect — best-effort, once online).
      onOnline: () => {
        relayBridge.resurfacePending();
        manager?.flushDeferredReports();
      },
    },
    activeRunIds: () => manager?.activeRunIds() ?? [],
    runnerStatus: (): RunnerStatus => manager?.runnerStatus() ?? 'online',
    pausedUntil: () => manager?.pausedUntil() ?? null,
    // c6: the heartbeat-tick record writer (04) — each beat renews every
    // active job record's `updated_at`, keeping a live runner's records
    // FRESH for the reconcile.
    // d2: same beat also renews every live department execution's lease
    // (`department.lease_renew` at TTL/3) — the existing cadence, not a 2nd timer.
    onBeat: () => {
      manager?.touchActiveRecords();
      departmentManager?.renewLeases();
    },
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

  // c6: the durable job-state store lives in the DATA dir (04: same root as
  // the shipper state — NOT the config dir, NOT inside any checkout).
  const shipperFs = nodeShipperFs();
  const jobStore = new JobStore({
    fs: shipperFs,
    dir: join(defaultDataDir(), 'jobs'),
    logger: consoleLogger,
  });

  // T2-03: accept job leases (additive — attaches `lease` + `cancel`
  // handlers only; the register/heartbeat/reconnect paths are untouched).
  manager = attachJobExecution(client, {
    runnerId: () => store.load()?.runner_id ?? null,
    labels: () => store.load()?.labels ?? [],
    capacity: () => store.load()?.capacity ?? 1,
    draining: () => client.draining || shuttingDown,
    // d7 (D17): generalizes PIPELINE_RUNNER_JOBS_DIR onto the isolated home
    // (`<home>/jobs`) — an explicit PIPELINE_RUNNER_JOBS_DIR still wins, and
    // the no-home/no-override case is byte-identical to before this change.
    workspaceRoot: resolveWorkspaceRoot(),
    logger: consoleLogger,
    // c3: the needs-input relay — every parked question now round-trips
    // through the bridge instead of hitting the default auto-fail seam.
    needsInput: relayAdapter,
    events: shipperLifecycle,
    // c6: durable records + reconcile substrate + terminal retention (D15).
    store: jobStore,
    substrate: fsSubstrateProbe(shipperFs, homedir()),
    retention: resolveRetentionPolicy(process.env, consoleLogger),
  });

  // department-mesh (task d1): the adapter registry starts with just
  // `jsonl-process` (the flagship) — `pipeline-drive` joins it when d4 ports
  // the existing dispatch path onto the same abstraction. Runtime resolution
  // is env-driven for now (see the import doc); a `department.offer` for an
  // unresolvable department_id gets a `capability` reject, same as an
  // offer this runner genuinely cannot serve.
  //
  // d2 (real leases, reject, process-group kill, deadlines) is wired here:
  // `renewLeases()` rides the heartbeat `onBeat` hook above; reject-with-
  // reason and process-group cancellation are internal to `DepartmentManager`
  // / `JsonlProcessAdapter` and need no extra composition here.
  //
  // KNOWN GAP (deliberate, still open post-d2): unlike `manager`/
  // `shipperLifecycle` above, department executions are NOT yet wired into
  // graceful shutdown's drain/suspend sequence below — draining new offers
  // (via `client.draining || shuttingDown`) is wired today, in-flight
  // executions are not yet suspended on SIGTERM/SIGINT.
  const departmentRuntimes = parseDepartmentRuntimesEnv(process.env.PIPELINE_RUNNER_DEPARTMENTS, consoleLogger);
  departmentManager = new DepartmentManager({
    adapters: [new JsonlProcessAdapter({ logger: consoleLogger })],
    resolveRuntimeConfig: (departmentId) => departmentRuntimes.get(departmentId) ?? null,
    send: (frame) => client.send(frame),
    dispatcher: client.dispatcher,
    journal: nodeJournalWriter(),
    journalRoot: join(defaultDataDir(), 'department'),
    draining: () => client.draining || shuttingDown,
    logger: consoleLogger,
  });
  departmentManager.attach(client.dispatcher);

  // c6 ORDERING (04 §Startup reconcile — load-bearing): scan + classify the
  // job records BEFORE connecting, so `activeRunIds()` is already seeded with
  // the FRESH resumes when the first heartbeat fires (heartbeats start
  // synchronously at register-ack). Quarantined records wait, capacity-free,
  // for the server's resume_hint re-offer or cancel.
  const summary = manager.reconcile();
  if (summary.resumed.length + summary.quarantined.length + summary.dropped.length > 0) {
    consoleLogger.info(
      `reconcile: ${summary.resumed.length} resumed, ${summary.quarantined.length} quarantined, ${summary.dropped.length} unrecoverable`
    );
  }
  // c6 retention GC (D15, E6): boot-time sweep + periodic re-arm.
  manager.sweepRetention();
  manager.startRetentionSweeps(DEFAULT_RETENTION_SWEEP_INTERVAL_MS);

  // c6 graceful shutdown (04): drain → suspend jobs (records persisted,
  // drive children terminated; their per-step state is durable) → flush the
  // shipper spool → close the socket → exit 0. Windows note: SCM stop is a
  // hard terminate and console-close delivers no signal — acceptable BECAUSE
  // the whole design assumes hard death; this drain is an optimization.
  const shutdown = createGracefulShutdown({
    drain: () => {
      shuttingDown = true;
    },
    suspendJobs: () => manager!.suspendAll(),
    flushShippers: () => shipperLifecycle.stopAll(),
    closeConnection: () => client.stop(),
    // d7 (D17): release the per-home lock on a clean shutdown. Best-effort —
    // a hard death (SCM stop, kill -9) skips this and relies on the next
    // `start`'s stale-pid self-heal (`core/home.ts`) instead.
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
    logger: consoleLogger,
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

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
    runStart(rest);
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
