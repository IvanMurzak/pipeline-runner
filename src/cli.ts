#!/usr/bin/env bun
/**
 * `pipeline-runner` CLI — a THIN wrapper over `src/core/`; all logic lives (and
 * is tested) there. Subcommands:
 *
 *   register --url <base-url> [--token <runner-token>]
 *            [--client-id <id> --client-secret <secret>] [--label <l>]...
 *            [--capacity <n>] [--cli-version <v>] [--plugin-version <v>]
 *            [--gpu] [--container] [--store-only]
 *       Store the agent identity, then (unless --store-only) connect once to
 *       validate the credential and persist the server-assigned runner id.
 *       Also captures this instance's D17 capability advertisement
 *       (isolation/gpu/os/resource hints, `./core/capabilities.ts`). `--gpu`
 *       is operator-declared; `--container` is VERIFIED (a live docker probe,
 *       `./department/container.ts`'s `probeContainerRuntimeAvailable`)
 *       before the `container` isolation tier is ever advertised (D17 R14).
 *
 *   set-credentials --client-id <id> --client-secret <secret> [--drop-token]
 *                   [--home <path>]
 *       department-mesh d5 (P6): install this runner's OAuth client
 *       credentials onto the EXISTING identity, so the next register presents
 *       a short-lived `runner:register` token instead of the plaintext
 *       long-lived one (`13-mcp-authorization.md` §10.2). The values come from
 *       `POST /api/v1/runners/:id/oauth-credentials` (shown once). The legacy
 *       token is KEPT as the fallback that guarantees this runner can still
 *       register; `--drop-token` removes it, which an operator should do only
 *       after the cloud's `/api/v1/runners/credential-window` says it is safe.
 *
 *   start [--home <path>]
 *       Run the agent loop: connect, register, heartbeat, reconnect. Acquires
 *       the per-home exclusive lock first (department-mesh d7, D17,
 *       `./core/home.ts`) — refuses to start if another live daemon already
 *       holds this home. `--home <path>` (or the PIPELINE_RUNNER_HOME env
 *       var it sets) roots this instance's config dir, data dir, and job-
 *       workspace root, isolating it from every other home on the host.
 *
 *   bind --department <id> --command <cmd> [--adapter <id>] [--arg <a>]...
 *        [--cwd <path>] [--lifecycle <l>] [--spec <json>] [--home <path>]
 *   unbind --department <id> [--home <path>]
 *   bindings [--json] [--home <path>]
 *       simplified-onboarding b1 (design 05 §5 step 6, D14): the LOCAL
 *       department runtime bindings — which `department_id` this machine will
 *       actually execute, and how. They live in a file-backed store
 *       (`./department/bindings.ts`) that a RUNNING supervisor reloads, so
 *       `pipeline department serve` on a machine that is already serving ends
 *       in `● online` instead of "restart the supervisor". This is also the
 *       seam another package shells out to rather than writing this package's
 *       config store itself (D26's rule, applied to the binding too).
 *
 *   status   Print the stored identity (token redacted).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { detectCapabilities, type IsolationTier } from './core/capabilities';
import { AGENT_VERSION, ConfigStore, describeIdentity, detectOs, type AgentIdentity } from './core/config';
import { AgentClient } from './core/connection';
// department-mesh (task d7, D17): the isolated-home lock + generalized
// workspace-root resolver — see `./core/home.ts`'s module doc for the full
// picture (config/data dir home-awareness lives in `core/config.ts` /
// `shipper/fs.ts` themselves).
import {
  acquireHomeLock,
  HomeLockError,
  type HomeLockHandle,
  isProcessAlive,
  PIPELINE_RUNNER_HOME_ENV,
  readHomeLockPid,
  resolveLockHomeDir,
  resolveWorkspaceRoot,
} from './core/home';
import { consoleLogger } from './core/log';
// department-mesh d5 (P6, 13 §10.2): which credential registers this runner,
// and which secret authenticates it as an OAuth client. See
// `./core/register-credential.ts` — the connection wires the provider itself.
import { carryForwardLegacyToken, selectClientSecret, storeOAuthClientCredentials } from './core/register-credential';
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
// attachJobExecution's construction shape without touching pipeline dispatch.
// simplified-onboarding b1 (D14): what a `department_id` resolves to now comes
// from the file-backed, RELOADABLE binding store — `PIPELINE_RUNNER_DEPARTMENTS`
// survives inside it as a deprecated, boot-time-only fallback.
import { BindingStoreError, DepartmentBindingStore } from './department/bindings';
import { DEPARTMENT_RUNTIMES_ENV } from './department/config';
// department-mesh d8 (D17): the `container` isolation-tier adapter — an
// ADDITIONAL entry in the manager's adapter registry, resolved by
// `RuntimeConfig.adapterId` exactly like `jsonl-process`; a department only
// ever reaches it if its resolved config says `adapterId: 'container'`.
import { ContainerAdapter, probeContainerRuntimeAvailable } from './department/container';
// department-mesh d6 (13-mcp-authorization.md §12): the runner's confidential
// OAuth client — obtains/caches execution-scoped tokens via
// `client_credentials`, authenticating with `runner_id` as the client_id and
// (d5/c15) the DISTINCT `oauth_client_secret` when this runner has one, else
// its legacy token. Wired into `DepartmentManager` below so every (re)spawn can
// point a model-driven runtime at `<base_url>/mcp` with a live token (07 §4).
import { ExecutionTokenManager } from './department/execution-token-manager';
import { JsonlProcessAdapter } from './department/jsonl-process';
import { DepartmentManager, nodeJournalWriter } from './department/manager';
// department-mesh d4 (P5 consolidation): `pipeline drive` ported onto the
// SAME `AgentRuntimeAdapter` abstraction, wrapping `../jobs/drive.ts`'s
// argv/outcome contract unchanged — an ADDITIONAL registry entry, resolved by
// `RuntimeConfig.adapterId === 'pipeline-drive'` exactly like `container`
// above. The pipeline-DISPATCH path (`JobExecutor`, wired further down this
// file) is untouched and does NOT go through this adapter — see
// `./department/pipeline-drive.ts`'s module doc for why.
import { PipelineDriveAdapter } from './department/pipeline-drive';

const REGISTER_ONCE_TIMEOUT_MS = 30_000;

/**
 * d5: env fallbacks for the OAuth client secret, so the one long-lived secret
 * P6 introduces need not sit in argv (world-readable in `ps` on Linux) or in
 * shell history. The flag still works; the env var is simply the better habit
 * and costs nothing to offer.
 */
const CLIENT_SECRET_ENV = 'PIPELINE_RUNNER_OAUTH_CLIENT_SECRET';
const CLIENT_ID_ENV = 'PIPELINE_RUNNER_OAUTH_CLIENT_ID';

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw.trim().length > 0 ? raw.trim() : undefined;
}

function fail(message: string): never {
  console.error(`[pipeline-runner] error: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      'usage: pipeline-runner <command>',
      '',
      '  register --url <base-url> [--token <runner-token>]',
      '           [--client-id <id>] [--client-secret <secret>] [--label <l>]...',
      '           [--capacity <n>] [--cli-version <v>] [--plugin-version <v>]',
      '           [--gpu] [--container] [--store-only]',
      '  set-credentials --client-id <id> --client-secret <secret> [--drop-token] [--home <path>]',
      '  start [--home <path>]',
      '  bind --department <id> --command <cmd> [--adapter <id>] [--arg <a>]...',
      '       [--cwd <path>] [--lifecycle <per-task|per-context|daemon>]',
      '       [--spec <json>] [--home <path>]',
      '  unbind --department <id> [--home <path>]',
      '  bindings [--json] [--home <path>]',
      '  status',
      '  service <install|uninstall|status> [--dry-run] [--name <name>] [--home <path>]',
      '',
      `  ${CLIENT_ID_ENV} / ${CLIENT_SECRET_ENV} may supply the OAuth client`,
      '  credentials instead of the flags (keeps the secret out of argv).',
      '',
      `  ${DEPARTMENT_RUNTIMES_ENV} is DEPRECATED — it is read only when no binding`,
      '  file exists, and a supervisor configured that way cannot learn about a new',
      '  department without a restart. Use `bind` instead.',
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
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      label: { type: 'string', multiple: true },
      capacity: { type: 'string' },
      'cli-version': { type: 'string' },
      'plugin-version': { type: 'string' },
      'store-only': { type: 'boolean' },
      gpu: { type: 'boolean' },
      container: { type: 'boolean' },
    },
  });
  if (!values.url) fail('--url <base-url> is required');
  // d5 (P6): EITHER credential registers this runner. The legacy token is no
  // longer required for a runner that was given OAuth client credentials — the
  // whole point of P6 — but it is still accepted, because that is what every
  // deployed runner has and the cloud dual-accepts it (c15).
  //
  // The env vars are consulted ONLY when the operator asked for the OAuth path
  // on the command line (either flag present). Otherwise a plain
  // `register --token X` in a shell that happens to export
  // PIPELINE_RUNNER_OAUTH_* would silently attach credentials nobody asked
  // for. `set-credentials`, whose whole purpose is installing them, keeps the
  // unconditional fallback.
  const oauthRequested = values['client-id'] !== undefined || values['client-secret'] !== undefined;
  const clientId = values['client-id'] ?? (oauthRequested ? envValue(CLIENT_ID_ENV) : undefined);
  const clientSecret = values['client-secret'] ?? (oauthRequested ? envValue(CLIENT_SECRET_ENV) : undefined);
  if (oauthRequested) {
    // Say out loud which half came from the environment — a credential picked
    // up invisibly is a credential nobody audits.
    if (values['client-id'] === undefined && clientId !== undefined) console.log(`[pipeline-runner] client id from ${CLIENT_ID_ENV}`);
    if (values['client-secret'] === undefined && clientSecret !== undefined) console.log(`[pipeline-runner] client secret from ${CLIENT_SECRET_ENV}`);
  }
  if (clientSecret !== undefined && clientId === undefined) {
    fail(`--client-id <id> is required with --client-secret (or set ${CLIENT_ID_ENV}); it is the runner id shown when the credential was issued`);
  }
  if (clientId !== undefined && clientSecret === undefined) {
    fail(`--client-secret <secret> is required with --client-id (or set ${CLIENT_SECRET_ENV})`);
  }
  if (!values.token && clientSecret === undefined) {
    fail(`--token <runner-token>, or --client-id + --client-secret (or ${CLIENT_ID_ENV}/${CLIENT_SECRET_ENV}), is required`);
  }
  const capacity = values.capacity !== undefined ? Number(values.capacity) : undefined;
  if (capacity !== undefined && (!Number.isInteger(capacity) || capacity <= 0)) {
    fail('--capacity must be a positive integer');
  }

  // department-mesh d8 (D17, R14): `--container` OPTS IN to advertising the
  // `container` isolation tier, but only after ACTUALLY VERIFYING the
  // runtime is usable on this host — never trusted on the flag alone, unlike
  // `--gpu` (no portable auto-detection exists for that one; docker CAN be
  // checked, so it is). A runner must never advertise a capability it cannot
  // actually isolate.
  let isolation: IsolationTier[] = ['process'];
  if (values.container === true) {
    const probe = await probeContainerRuntimeAvailable();
    if (probe.available) {
      isolation = ['process', 'container'];
      console.log(`[pipeline-runner] container isolation tier available (docker ${probe.version ?? 'unknown version'}) — advertising 'container'`);
    } else {
      console.warn(
        `[pipeline-runner] warn: --container was requested but the container runtime is not usable (${probe.reason}) — NOT advertising 'container' (R14: a runner must never advertise isolation it cannot actually provide)`
      );
    }
  }

  const identity: AgentIdentity = {
    base_url: values.url,
    ...(values.token !== undefined ? { runner_token: values.token } : {}),
    // d5: `client_id` IS the runner id by the cloud's own construction
    // (`POST /api/v1/runners` returns `clientId: row.id`), so storing it as
    // `runner_id` is the same value the register ack will confirm.
    ...(clientSecret !== undefined ? { oauth_client_secret: clientSecret, runner_id: clientId } : {}),
    labels: [`os:${detectOs()}`, ...(values.label ?? [])],
    capacity,
    os: detectOs(),
    agent_version: AGENT_VERSION,
    // The `pipeline` CLI version skews independently; detection is a later
    // concern — pass --cli-version when it matters.
    cli_version: values['cli-version'] ?? 'unknown',
    plugin_version: values['plugin-version'] ?? null,
    // department-mesh d7/d8 (D17): gpu is operator-declared (--gpu) — same
    // posture as --capacity/--label, no portable cross-platform
    // auto-detection exists without a native dependency. `isolation` is
    // verified above, never just declared.
    capabilities: detectCapabilities({ gpu: values.gpu === true, isolation }),
  };
  const store = new ConfigStore();
  // d5 (P6): `register` overwrites the config wholesale, so migrating a LIVE
  // runner with `--client-id/--client-secret` (and no `--token`) would
  // otherwise delete the legacy fallback silently. Carry it forward and say so;
  // removing it stays the explicit act it is in `set-credentials --drop-token`.
  let previous: AgentIdentity | null = null;
  try {
    previous = store.load();
  } catch {
    previous = null; // an unreadable/incomplete old config is not a fallback
  }
  const { identity: toStore, carried } = carryForwardLegacyToken(previous, identity);
  store.save(toStore);
  console.log(`[pipeline-runner] identity stored at ${store.path}`);
  if (carried) {
    console.log(
      '[pipeline-runner] kept the existing legacy runner token as a fallback — remove it with ' +
        '`pipeline-runner set-credentials --drop-token` once the control plane reports this runner clear.'
    );
  } else if (toStore.runner_token === undefined) {
    console.warn(
      '[pipeline-runner] warn: this identity has NO legacy runner token. If the OAuth token exchange fails, ' +
        'this runner has nothing to fall back on and will retry with backoff until it succeeds. Pass --token ' +
        'as well to keep a fallback.'
    );
  }
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
    transports: defaultTransports(toStore.base_url, consoleLogger),
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

/**
 * department-mesh d5 (P6): install (or replace) this runner's OAuth client
 * credentials on an ALREADY-REGISTERED identity — "migrate on re-registration,
 * never a flag day" (`11-migration-rollout.md` P6, R11). The next connect
 * exchanges them for a short-lived `runner:register` token and stops putting a
 * plaintext long-lived secret on the wire.
 *
 * The legacy token stays put unless `--drop-token` is passed: while it is
 * there, ANY failure of the OAuth path (endpoint down, secret wrong, window
 * mis-configured) degrades to a working registration instead of an outage.
 */
function runSetCredentials(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      'client-id': { type: 'string' },
      'client-secret': { type: 'string' },
      'drop-token': { type: 'boolean' },
      home: { type: 'string' },
    },
  });
  // d7 (D17): same idiom as `runStart` — a host running several isolated
  // runners must be able to name WHICH one is being migrated.
  if (values.home) process.env[PIPELINE_RUNNER_HOME_ENV] = values.home;
  const clientId = values['client-id'] ?? envValue(CLIENT_ID_ENV);
  const clientSecret = values['client-secret'] ?? envValue(CLIENT_SECRET_ENV);
  if (!clientId) fail(`--client-id <id> is required (or set ${CLIENT_ID_ENV})`);
  if (!clientSecret) fail(`--client-secret <secret> is required (or set ${CLIENT_SECRET_ENV})`);

  const store = new ConfigStore();
  if (store.load() === null) fail('no agent identity configured — run `pipeline-runner register` first');
  storeOAuthClientCredentials(store, { clientId, clientSecret });
  console.log(`[pipeline-runner] OAuth client credentials stored at ${store.path} (client_id ${clientId})`);

  if (values['drop-token'] === true) {
    store.update({ runner_token: undefined });
    console.warn(
      '[pipeline-runner] warn: the legacy runner token has been REMOVED from this config. This runner can no ' +
        'longer fall back to it if the OAuth path fails — re-run `register --token ...` to restore one.'
    );
  } else {
    console.log(
      '[pipeline-runner] the legacy runner token is kept as a fallback. Remove it with --drop-token once ' +
        'GET /api/v1/runners/credential-window reports this runner clear.'
    );
  }
  console.log('[pipeline-runner] restart the runner for the change to take effect.');
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

  // department-mesh (task d1): the adapter registry starts with
  // `jsonl-process` (the flagship). Runtime resolution is env-driven for now
  // (see the import doc); a `department.offer` for an unresolvable
  // department_id gets a `capability` reject, same as an offer this runner
  // genuinely cannot serve.
  //
  // d2 (real leases, reject, process-group kill, deadlines) is wired here:
  // `renewLeases()` rides the heartbeat `onBeat` hook above; reject-with-
  // reason and process-group cancellation are internal to `DepartmentManager`
  // / `JsonlProcessAdapter` and need no extra composition here.
  //
  // d8 (D17): `ContainerAdapter` is registered ALONGSIDE `jsonl-process`, not
  // instead of it — a department only reaches it when its resolved
  // `RuntimeConfig.adapterId === 'container'` (`resolveRuntimeConfig` below);
  // every other department keeps running exactly as before. Registering the
  // adapter here does NOT itself advertise the `container` capability — that
  // is `register --container`'s job (above), gated on a live docker probe.
  //
  // d4 (P5 consolidation): `PipelineDriveAdapter` is registered the SAME way —
  // a department only reaches it when its resolved `RuntimeConfig.adapterId
  // === 'pipeline-drive'`; every other department (and, separately, the
  // pipeline-DISPATCH path below, which never touches this registry at all)
  // keeps running exactly as before.
  //
  // KNOWN GAP (deliberate, still open post-d2): unlike `manager`/
  // `shipperLifecycle` above, department executions are NOT yet wired into
  // graceful shutdown's drain/suspend sequence below — draining new offers
  // (via `client.draining || shuttingDown`) is wired today, in-flight
  // executions are not yet suspended on SIGTERM/SIGINT.
  //
  // simplified-onboarding b1 (D14, design 05 §5 step 6): runtime resolution is
  // no longer a boot-time snapshot. `DepartmentBindingStore` re-reads its
  // file on a debounced directory watch, on SIGHUP, and on a slow safety-net
  // poll, and `resolveRuntimeConfig` below reads the LIVE snapshot on every
  // offer — so a department bound while this supervisor is running is served
  // without a restart, and an unbound one stops being accepted. Every failure
  // mode (missing, unreadable, malformed, group/world-writable) resolves to
  // ZERO bindings: a broken file can only ever narrow what this machine runs.
  const departmentBindings = new DepartmentBindingStore({ logger: consoleLogger });
  departmentBindings.reload();
  const stopBindingWatch = departmentBindings.watch((snapshot, changed) => {
    if (!changed) return;
    consoleLogger.info(`department bindings reloaded: ${snapshot.bindings.size} bound (${snapshot.source})`);
  });
  // The explicit reload trigger. POSIX only: on Windows SIGHUP means "the
  // console window closed" and the process is torn down ~10s later regardless,
  // so installing a handler there would misrepresent a shutdown as a reload —
  // the directory watch is the Windows mechanism and needs no signal.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      consoleLogger.info('SIGHUP — re-reading department bindings');
      departmentBindings.reload();
    });
  }
  // d6: live accessors (not captured values) — same idiom as `runnerId`/
  // `labels`/`capacity` just above, so a manager constructed before
  // `register_ack` still works once `store.load()` starts returning a
  // `runner_id` (the OAuth client_id) and reflects a later `register`
  // (client_secret rotation) without reconstruction.
  // d5 (P6 / c15): the client secret is the DISTINCT `oauth_client_secret` when
  // this runner has one, falling back to the legacy token when it does not —
  // `selectClientSecret` is the one place that ordering lives, shared with the
  // register path, so both token kinds migrate together. d6 hard-wired the
  // legacy token here; c15 issued a separate secret precisely so the legacy
  // credential could retire independently.
  const executionTokens = new ExecutionTokenManager({
    baseUrl: () => store.load()?.base_url ?? null,
    clientId: () => store.load()?.runner_id ?? null,
    clientSecret: () => {
      const current = store.load();
      return current === null ? null : selectClientSecret(current);
    },
    logger: consoleLogger,
  });
  departmentManager = new DepartmentManager({
    adapters: [
      new JsonlProcessAdapter({ logger: consoleLogger }),
      new ContainerAdapter({ logger: consoleLogger }),
      new PipelineDriveAdapter({ logger: consoleLogger }),
    ],
    resolveRuntimeConfig: (departmentId) => departmentBindings.get(departmentId),
    send: (frame) => client.send(frame),
    dispatcher: client.dispatcher,
    journal: nodeJournalWriter(),
    journalRoot: join(defaultDataDir(), 'department'),
    draining: () => client.draining || shuttingDown,
    executionTokens,
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
    // b1: the binding watcher's timers/handle go with it. It is created with
    // `persistent: false`, so this is tidiness rather than a hang fix.
    releaseLock: () => {
      stopBindingWatch();
      lock.release();
    },
    exit: (code) => process.exit(code),
    logger: consoleLogger,
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  client.start();
  // Active timers/sockets keep the Bun event loop alive; nothing else to do.
}

// ── simplified-onboarding b1: the local runtime-binding surface ────────────

/**
 * Tell a RUNNING supervisor for this home to re-read its bindings.
 *
 * The directory watch already picks the change up on every platform; SIGHUP
 * is the explicit trigger that does not depend on `fs.watch` being delivered
 * (network mounts, some container overlays). On Windows SIGHUP is not a
 * reload signal at all — it means the console closed — so we say what will
 * happen instead of sending it.
 */
function signalSupervisorReload(): void {
  const pid = readHomeLockPid(resolveLockHomeDir());
  if (pid === null || !isProcessAlive(pid)) {
    console.log('[pipeline-runner] no supervisor is running for this home — the change applies at the next `start`.');
    return;
  }
  if (process.platform === 'win32') {
    console.log(`[pipeline-runner] supervisor pid ${pid} is running — it picks this up automatically (file watch).`);
    return;
  }
  try {
    process.kill(pid, 'SIGHUP');
    console.log(`[pipeline-runner] signalled supervisor pid ${pid} (SIGHUP) to reload.`);
  } catch (err) {
    console.log(
      `[pipeline-runner] could not signal pid ${pid} (${err instanceof Error ? err.message : String(err)}) — ` +
        'its file watch still picks the change up.'
    );
  }
}

function bindingStoreFor(home: string | undefined, quiet = false): DepartmentBindingStore {
  // Same idiom as `runStart`/`runSetCredentials`: set the env var FIRST so
  // every path resolver below lands in the right home.
  if (home) process.env[PIPELINE_RUNNER_HOME_ENV] = home;
  // `quiet` drops the store's own INFO summary (the command prints its own,
  // better one) while keeping every WARN — a deprecation or a skipped entry
  // must never be swallowed by a presentation choice.
  return new DepartmentBindingStore({ logger: quiet ? { ...consoleLogger, info: () => {} } : consoleLogger });
}

function runBind(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      department: { type: 'string' },
      adapter: { type: 'string' },
      command: { type: 'string' },
      arg: { type: 'string', multiple: true },
      cwd: { type: 'string' },
      lifecycle: { type: 'string' },
      spec: { type: 'string' },
      home: { type: 'string' },
    },
  });
  if (!values.department) fail('--department <id> is required');

  // `--spec` is the escape hatch for the specs no flag set should carry —
  // `container` sandboxes (d8) and `pipeline-drive` targets (d4) are nested
  // objects. The flags layer ON TOP of it so the common case stays flat and
  // the complex case stays possible, without two ways to spell one field.
  let base: Record<string, unknown> = {};
  if (values.spec !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.spec);
    } catch {
      fail('--spec must be a JSON object describing the runtime');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('--spec must be a JSON object');
    base = parsed as Record<string, unknown>;
  }
  const spec: Record<string, unknown> = { adapterId: 'jsonl-process', ...base };
  if (values.adapter !== undefined) spec.adapterId = values.adapter;
  if (values.command !== undefined) spec.command = values.command;
  if (values.arg !== undefined) spec.args = values.arg;
  if (values.cwd !== undefined) spec.cwd = values.cwd;
  if (values.lifecycle !== undefined) spec.lifecycle = values.lifecycle;
  if (typeof spec.command !== 'string' || spec.command.length === 0) {
    fail('--command <cmd> is required (or a `command` field in --spec)');
  }

  const store = bindingStoreFor(values.home);
  let stored;
  try {
    stored = store.bind(values.department, spec);
  } catch (err) {
    if (err instanceof BindingStoreError) fail(`could not write the runtime binding: ${store.path} (${err.message})`);
    throw err;
  }
  console.log(`[pipeline-runner] bound ${values.department} -> ${stored.adapterId}: ${stored.command} (${store.path})`);
  // The store narrows rather than rejects on optional fields (dropping one can
  // only narrow what runs) — but a silently dropped flag is a lie, so say it.
  if (values.lifecycle !== undefined && stored.lifecycle === undefined) {
    console.warn(
      `[pipeline-runner] warn: lifecycle '${values.lifecycle}' is not one of per-task|per-context|daemon — dropped; ` +
        'the adapter default applies'
    );
  }
  signalSupervisorReload();
}

function runUnbind(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { department: { type: 'string' }, home: { type: 'string' } } });
  if (!values.department) fail('--department <id> is required');
  const store = bindingStoreFor(values.home);
  let removed: boolean;
  try {
    removed = store.unbind(values.department);
  } catch (err) {
    if (err instanceof BindingStoreError) fail(`could not update the runtime binding: ${store.path} (${err.message})`);
    throw err;
  }
  if (!removed) {
    console.log(`[pipeline-runner] ${values.department} was not bound in ${store.path} — nothing to do.`);
    return;
  }
  console.log(`[pipeline-runner] unbound ${values.department} (${store.path}) — new offers for it will be rejected.`);
  console.log('[pipeline-runner] executions already running for it are NOT cancelled; they finish on their own terms.');
  signalSupervisorReload();
}

function runBindings(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, home: { type: 'string' } } });
  const store = bindingStoreFor(values.home, true);
  const snapshot = store.reload();
  if (values.json === true) {
    console.log(
      JSON.stringify(
        {
          path: snapshot.path,
          source: snapshot.source,
          refusal: snapshot.refusal,
          departments: Object.fromEntries(snapshot.bindings),
        },
        null,
        2
      )
    );
    // A refused store is a failure an operator (or a script) must be able to
    // see without parsing prose.
    if (snapshot.refusal !== null) process.exit(1);
    return;
  }
  console.log(`store: ${snapshot.path} (source: ${snapshot.source})`);
  if (snapshot.refusal !== null) {
    console.error(`[pipeline-runner] error: REFUSED — ${snapshot.refusal}`);
    console.error('[pipeline-runner] no departments are configured; every offer will be rejected.');
    process.exit(1);
  }
  if (snapshot.bindings.size === 0) {
    console.log(`no departments bound. Bind one with: pipeline-runner bind --department <id> --command <cmd>`);
    return;
  }
  for (const id of store.ids()) {
    const config = snapshot.bindings.get(id)!;
    const args = config.args !== undefined && config.args.length > 0 ? ` ${config.args.join(' ')}` : '';
    console.log(`  ${id}  ${config.adapterId}  ${config.command}${args}${config.lifecycle ? `  [${config.lifecycle}]` : ''}`);
  }
  if (snapshot.source === 'env') {
    console.warn(`[pipeline-runner] warn: these come from ${DEPARTMENT_RUNTIMES_ENV}, which is DEPRECATED and cannot be reloaded.`);
  }
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
  case 'set-credentials':
    runSetCredentials(rest);
    break;
  case 'start':
    runStart(rest);
    break;
  // simplified-onboarding b1: the local runtime-binding surface.
  case 'bind':
    runBind(rest);
    break;
  case 'unbind':
    runUnbind(rest);
    break;
  case 'bindings':
    runBindings(rest);
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
