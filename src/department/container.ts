/**
 * `container` — the strong isolation-tier `AgentRuntimeAdapter` (department-
 * mesh, task d8; `07-runtime-contract.md` §2.1/§2.2, `10-security.md` §5,
 * T15, T30, R14). Wraps `jsonl-process` (or, via `ContainerAdapterOptions.inner`,
 * any other `AgentRuntimeAdapter`) in a container with a **read-only root,
 * explicit mounts only, and an egress allowlist** — the JSONL contract and the
 * `AgentRuntimeAdapter` interface are reused UNCHANGED; `container` is a
 * wrapping, not a new protocol (07 §2.1). Concretely: `start()`/`probe()`
 * rewrite the given `RuntimeConfig.command`/`args` into a `docker run …
 * <image> <command> <args>` invocation and hand THAT to the wrapped inner
 * adapter, which never knows it is running inside a container — it just sees
 * a different `command`/`args`, exactly as `RuntimeConfig`'s own doc says any
 * adapter should ("reads only the fields it understands"). `send()`/`cancel()`
 * /`dispose()` delegate straight through on the SAME handle the inner adapter
 * minted (unwrapped from `ContainerHandle`), so process-group kill escalation
 * (d2, 07 §7) is inherited byte-for-byte, not reimplemented.
 *
 * ── Optional by construction (07 §2.2) ──────────────────────────────────────
 * `process` stays the runner's default; nothing here is reachable unless a
 * department's resolved `RuntimeConfig.adapterId === 'container'` AND carries
 * a `container` spec — `tryBuild()` below refuses (throws/returns
 * `ok:false`) rather than ever running a department unsandboxed when the spec
 * is missing. Advertising the capability (R14: "a runner must not advertise a
 * capability it can't actually isolate") is `probeContainerRuntimeAvailable`'s
 * job — see its doc — wired from `../cli.ts`'s `register --container`, never
 * assumed true the way `--gpu` is (gpu genuinely cannot be portably verified;
 * "is docker actually runnable on this host" CAN be, so this adapter checks
 * rather than trusts).
 *
 * ── Controls this file actually enforces (07 §2.1, 10 §5) ──────────────────
 *   - `--read-only` root, always — not a spec-configurable flag. `--tmpfs
 *     /tmp` gives a bounded, memory-backed scratch dir so `--read-only` stays
 *     usable without relaxing it (never a host bind-mount, never persisted).
 *   - Explicit mounts ONLY: every `-v` flag traces to a `ContainerSpec.mounts`
 *     entry or the adapter's own auto-provisioned per-execution workspace
 *     mount (below) — never an implicit "mount the whole workspace/host fs".
 *   - `--cap-drop=ALL` + `--security-opt=no-new-privileges` — defense in
 *     depth so a compromised process cannot regain capabilities (e.g.
 *     CAP_DAC_OVERRIDE, CAP_SYS_ADMIN) that would otherwise undermine
 *     `--read-only`.
 *   - Egress: no allowlist ⇒ `--network none` (airtight — zero network
 *     access). A non-empty allowlist REQUIRES `ContainerSpec.egressNetwork`
 *     (fail-closed — see `adapter.ts`'s `ContainerSpec.egressNetwork` doc);
 *     the allowlist itself also rides a `--label` so external
 *     provisioning/enforcement tooling can read it. **What this file does
 *     NOT do**: actually implement per-destination firewall rules. Docker's
 *     CLI has no native "allow only host X" primitive — real enforcement
 *     needs host-level iptables/nftables rules (or an egress-proxy sidecar)
 *     scoped to `egressNetwork`, which is infrastructure the OPERATOR
 *     provisions to match the declared allowlist, not something a per-`docker
 *     run` invocation can set up. This is the gap the task prompt calls out
 *     as deferred to a live-Docker verification pass (`e2`/the release gate)
 *     — everything UP TO building the correct, validated `docker run` argv
 *     (including refusing to run with a declared-but-unenforced allowlist)
 *     is implemented and unit-tested here.
 *
 * ── Per-execution workspace (T15/T30) ───────────────────────────────────────
 * `start()` mkdirs (never wipes) `<workspaceRoot>/<sanitized taskId>` and
 * mounts it read-write at `ContainerSpec.workspaceContainerPath` (default
 * `/workspace`, also the default `--workdir`). Keyed by `taskId` (stable
 * across a `per-context` respawn of the SAME execution) rather than a fresh
 * random path per `start()` call, so crash-recovery/idle-evict-then-resume
 * (`./manager.ts`) can still see what the runtime wrote before — exactly the
 * "continuity that cannot survive eviction must be written to the workspace"
 * contract 07 §5 already promises for `jsonl-process`. Distinct executions
 * (distinct `taskId`s) never share a directory. `dispose()` deliberately does
 * NOT remove this directory: `dispose()` also fires on idle-eviction, which
 * expects a LATER respawn to resume from what is on disk — deleting it there
 * would silently break that continuity contract. Only the CONTAINER (ephemeral
 * compute) is torn down on `dispose()`; the workspace (persistent state) is
 * swept the same way `pipeline drive` job workspaces are — by a separate
 * retention mechanism, out of this task's scope (noted as a follow-up, not a
 * security gap: worst case is disk growth under a dedicated, sanitized root).
 *
 * ── Why an explicit container-teardown seam (`ContainerRuntimeControl`) ─────
 * The inner adapter's `dispose()` SIGTERM/SIGKILLs the process GROUP of
 * whatever it spawned — here, the `docker run -i` CLI process, not the
 * containerized process itself. Docker does not reliably stop a container
 * just because its own foreground CLI client was killed (the daemon can keep
 * it running, detached from the now-dead client). `--rm` plus an explicit
 * `docker rm -f <name>` (this file's `ContainerRuntimeControl`, run
 * independently after the inner `dispose()`/on `probe()`'s cleanup path)
 * closes that gap so a `container` execution's teardown is as bounded and
 * deterministic as `jsonl-process`'s own (d2, 07 §7) — never "the CLI died,
 * hope the container did too".
 */

import { join } from 'node:path';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { JobExec, JobFs, JobSpawn } from '../jobs/types';
import { nodeJobExec, nodeJobFs, nodeJobSpawn } from '../jobs/types';
import { defaultDataDir } from '../shipper/fs';
import type {
  AgentRuntimeAdapter,
  ContainerEgressRule,
  ContainerMount,
  ContainerRuntimeBinary,
  ContainerSpec,
  InvocationEnvelope,
  ProbeResult,
  RuntimeConfig,
  RuntimeEventSink,
  RuntimeHandle,
  RuntimeInput,
} from './adapter';
import { RuntimeAdapterError } from './adapter';
import { JsonlProcessAdapter } from './jsonl-process';

export const DEFAULT_CONTAINER_RUNTIME_BINARY: ContainerRuntimeBinary = 'docker';
export const DEFAULT_WORKSPACE_CONTAINER_PATH = '/workspace';
export const DEFAULT_TMPFS_SIZE_MB = 64;
/** Docker label carrying the JSON-encoded egress allowlist for external
 *  provisioning/enforcement tooling to read — see the module doc's egress
 *  note. Only attached when the allowlist is non-empty. */
export const EGRESS_ALLOWLIST_LABEL = 'pipeline.dept.egress-allowlist';

/**
 * Filesystem-/docker-name-safe form of an id (task id, container name). This
 * feeds `join(workspaceRoot, sanitizeName(taskId))` — so beyond stripping
 * anything outside `[A-Za-z0-9_.-]` (which already neutralizes embedded path
 * separators), a result that reduces to NOTHING but dots/dashes once those
 * are stripped (`'..'`, `'.'`, `'...'`, `'--'`, …) is rejected too: `'..'`
 * alone would `join()` to the PARENT of `workspaceRoot` — a real path
 * traversal, not merely a cosmetic concern. Mirrors
 * `../jobs/workspace.ts`'s `sanitizeJobId` exactly for this reason (that
 * function guards the identical join-with-a-caller-supplied-id shape for
 * `pipeline drive` job workspaces). Falls back to a fixed placeholder rather
 * than throwing: this id also feeds a container NAME, where a same-value
 * collision is harmless (a random suffix is always appended), unlike a
 * resolved path escaping the workspace root.
 */
function sanitizeName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '-');
  return safe.replace(/[.-]/g, '').length > 0 ? safe : 'x';
}

// ── Pure argv construction (unit-testable without Docker) ──────────────────

function buildNetworkArgs(spec: ContainerSpec): string[] {
  const hasAllowlist = (spec.egressAllowlist?.length ?? 0) > 0;
  if (!hasAllowlist) return ['--network', 'none'];
  if (spec.egressNetwork === undefined || spec.egressNetwork.trim().length === 0) {
    throw new RuntimeAdapterError(
      "container: 'egressAllowlist' is set but 'egressNetwork' is missing — refusing to attach to an unenforced default network (fail-closed, 10-security.md §5)"
    );
  }
  return ['--network', spec.egressNetwork];
}

function validateEgressAllowlist(rules: ContainerEgressRule[]): void {
  for (const rule of rules) {
    if (typeof rule.host !== 'string' || rule.host.trim().length === 0) {
      throw new RuntimeAdapterError('container: an egressAllowlist entry is missing a host');
    }
  }
}

export interface BuildContainerArgsParams {
  spec: ContainerSpec;
  /** The department's own command/args — what runs INSIDE the container, at
   *  the image's entrypoint boundary (unchanged JSONL-speaking binary). */
  command: string;
  args: string[];
  /** Explicit env for the CONTAINER (never the host's `process.env` — see
   *  `ContainerAdapter.tryBuild`'s doc for why that is safe by construction). */
  env?: Record<string, string | undefined>;
  containerName: string;
  workspaceHostPath: string;
}

export interface BuiltContainerInvocation {
  runtimeBinary: ContainerRuntimeBinary;
  args: string[];
}

/**
 * Build the `docker run …` argv for one execution — pure, no I/O, exhaustively
 * unit-tested (07 §9's "adapter conformance … runnable against any adapter"
 * DoD extends to proving THIS wrapping is correct, not just delegated).
 * Throws `RuntimeAdapterError` on anything that would silently under-sandbox:
 * a missing image, a relative/root/duplicate mount path, or a declared
 * allowlist with no enforcement network named.
 */
export function buildContainerArgs(params: BuildContainerArgsParams): BuiltContainerInvocation {
  const { spec } = params;
  if (typeof spec.image !== 'string' || spec.image.trim().length === 0) {
    throw new RuntimeAdapterError("container: RuntimeConfig.container.image is required");
  }
  const workspaceContainerPath = spec.workspaceContainerPath ?? DEFAULT_WORKSPACE_CONTAINER_PATH;
  if (!workspaceContainerPath.startsWith('/')) {
    throw new RuntimeAdapterError(
      `container: workspaceContainerPath must be an absolute container path, got '${workspaceContainerPath}'`
    );
  }

  const seenContainerPaths = new Set<string>([workspaceContainerPath]);
  const mountFlags: string[] = [];
  for (const mount of spec.mounts) {
    if (typeof mount.hostPath !== 'string' || mount.hostPath.trim().length === 0) {
      throw new RuntimeAdapterError('container: a mount is missing hostPath');
    }
    if (typeof mount.containerPath !== 'string' || !mount.containerPath.startsWith('/')) {
      throw new RuntimeAdapterError(`container: mount containerPath must be an absolute container path, got '${String(mount.containerPath)}'`);
    }
    if (mount.containerPath === '/') {
      throw new RuntimeAdapterError('container: refusing to mount over the container root (/)');
    }
    if (seenContainerPaths.has(mount.containerPath)) {
      throw new RuntimeAdapterError(`container: duplicate mount containerPath '${mount.containerPath}' — every mount (including the auto workspace mount at '${workspaceContainerPath}') must target a distinct path`);
    }
    seenContainerPaths.add(mount.containerPath);
    mountFlags.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ':ro' : ''}`);
  }

  const allowlist = spec.egressAllowlist ?? [];
  validateEgressAllowlist(allowlist);
  const networkArgs = buildNetworkArgs(spec);

  const envFlags: string[] = [];
  for (const [key, value] of Object.entries(params.env ?? {})) {
    if (value === undefined) continue;
    envFlags.push('-e', `${key}=${value}`);
  }

  const workdir = spec.workdir ?? workspaceContainerPath;
  const tmpfsSizeMb = spec.tmpfsSizeMb ?? DEFAULT_TMPFS_SIZE_MB;

  const args: string[] = [
    'run',
    '--name', params.containerName,
    '--rm',
    '-i',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', `/tmp:rw,noexec,nosuid,size=${tmpfsSizeMb}m`,
    ...networkArgs,
    ...(allowlist.length > 0 ? ['--label', `${EGRESS_ALLOWLIST_LABEL}=${JSON.stringify(allowlist)}`] : []),
    '-v', `${params.workspaceHostPath}:${workspaceContainerPath}`,
    ...mountFlags,
    '-w', workdir,
    ...envFlags,
    ...(spec.extraArgs ?? []),
    spec.image,
    params.command,
    ...params.args,
  ];

  return { runtimeBinary: spec.runtimeBinary ?? DEFAULT_CONTAINER_RUNTIME_BINARY, args };
}

/**
 * Narrow an unknown value (loaded from `PIPELINE_RUNNER_DEPARTMENTS`,
 * `./config.ts`'s placeholder department-runtime resolution) back into a
 * `ContainerSpec`, or `undefined` if it is not well-formed enough to build a
 * sandbox from — same tolerant-parse philosophy `./config.ts`'s own
 * `narrowRuntimeConfig` and `../core/capabilities.ts`'s
 * `narrowRunnerCapabilities` already use. Deliberately strict about `image`
 * (a `ContainerSpec` with no image is useless) but tolerant of malformed
 * OPTIONAL fields — each one is simply omitted, never enough to fail the
 * whole spec, mirroring `narrowRuntimeConfig`'s own per-field behavior.
 */
export function narrowContainerSpec(raw: unknown): ContainerSpec | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.image !== 'string' || r.image.length === 0) return undefined;

  const mounts: ContainerMount[] = [];
  if (Array.isArray(r.mounts)) {
    for (const m of r.mounts) {
      if (typeof m !== 'object' || m === null) continue;
      const mm = m as Record<string, unknown>;
      if (typeof mm.hostPath !== 'string' || mm.hostPath.length === 0) continue;
      if (typeof mm.containerPath !== 'string' || mm.containerPath.length === 0) continue;
      mounts.push({ hostPath: mm.hostPath, containerPath: mm.containerPath, ...(typeof mm.readOnly === 'boolean' ? { readOnly: mm.readOnly } : {}) });
    }
  }

  const spec: ContainerSpec = { image: r.image, mounts };

  if (Array.isArray(r.egressAllowlist)) {
    const rules: ContainerEgressRule[] = [];
    for (const e of r.egressAllowlist) {
      if (typeof e !== 'object' || e === null) continue;
      const ee = e as Record<string, unknown>;
      if (typeof ee.host !== 'string' || ee.host.length === 0) continue;
      rules.push({ host: ee.host, ...(typeof ee.port === 'number' && Number.isFinite(ee.port) ? { port: ee.port } : {}) });
    }
    if (rules.length > 0) spec.egressAllowlist = rules;
  }
  if (typeof r.egressNetwork === 'string' && r.egressNetwork.length > 0) spec.egressNetwork = r.egressNetwork;
  if (r.runtimeBinary === 'docker' || r.runtimeBinary === 'podman') spec.runtimeBinary = r.runtimeBinary;
  if (typeof r.workdir === 'string' && r.workdir.length > 0) spec.workdir = r.workdir;
  if (typeof r.workspaceContainerPath === 'string' && r.workspaceContainerPath.length > 0) {
    spec.workspaceContainerPath = r.workspaceContainerPath;
  }
  if (typeof r.tmpfsSizeMb === 'number' && Number.isFinite(r.tmpfsSizeMb)) spec.tmpfsSizeMb = r.tmpfsSizeMb;
  if (Array.isArray(r.extraArgs)) spec.extraArgs = r.extraArgs.filter((a): a is string => typeof a === 'string');

  return spec;
}

// ── Container-runtime-availability probe (R14: verify before advertising) ──

export interface ContainerRuntimeProbeResult {
  available: boolean;
  version?: string;
  /** Present when `available:false` — why, for the operator's console output. */
  reason?: string;
}

/**
 * "Is `docker`/`podman` actually runnable on this host" — the check
 * `../cli.ts`'s `register --container` runs BEFORE ever advertising the
 * `container` isolation tier (R14: "a `container`-tier runner must not
 * advertise a capability it can't actually isolate"). Unlike `--gpu` (no
 * portable, dependency-free auto-detection exists), this genuinely CAN be
 * verified — so it is, rather than trusted on the operator's word alone.
 * Fails closed: any non-zero exit, spawn error, or missing binary ⇒
 * `available:false` with a reason, never a guess.
 */
export async function probeContainerRuntimeAvailable(
  exec: JobExec = nodeJobExec(),
  runtimeBinary: ContainerRuntimeBinary = DEFAULT_CONTAINER_RUNTIME_BINARY
): Promise<ContainerRuntimeProbeResult> {
  const result = await exec.run(runtimeBinary, ['version', '--format', '{{.Server.Version}}']);
  if (result.code !== 0) {
    const detail = (result.stderr || result.error || '').trim().split('\n')[0];
    return {
      available: false,
      reason: `'${runtimeBinary} version' exited ${result.code ?? 'null'}${detail ? `: ${detail}` : ''}`,
    };
  }
  const version = result.stdout.trim();
  return { available: true, ...(version.length > 0 ? { version } : {}) };
}

// ── Container teardown seam ─────────────────────────────────────────────────

export interface ContainerRuntimeControl {
  /** Best-effort `<runtimeBinary> rm -f <name>` — mirrors
   *  `ProcessHandle.killGroup()`'s "already gone is fine" posture; never
   *  throws (a genuinely stuck container is the operator's to investigate,
   *  not this seam's to retry forever). */
  removeContainer(name: string, runtimeBinary: ContainerRuntimeBinary): Promise<void>;
}

export function nodeContainerRuntimeControl(exec: JobExec = nodeJobExec()): ContainerRuntimeControl {
  return {
    async removeContainer(name, runtimeBinary) {
      await exec.run(runtimeBinary, ['rm', '-f', name]);
    },
  };
}

// ── The handle ────────────────────────────────────────────────────────────

class ContainerHandle implements RuntimeHandle {
  readonly adapterId = 'container';

  constructor(
    readonly inner: RuntimeHandle,
    readonly containerName: string,
    readonly runtimeBinary: ContainerRuntimeBinary
  ) {}

  get taskId(): string {
    return this.inner.taskId;
  }

  get contextId(): string {
    return this.inner.contextId;
  }

  get capabilities(): RuntimeHandle['capabilities'] {
    return this.inner.capabilities;
  }
}

function asContainerHandle(handle: RuntimeHandle): ContainerHandle {
  if (!(handle instanceof ContainerHandle)) {
    throw new RuntimeAdapterError('container: handle was not minted by this adapter');
  }
  return handle;
}

// ── The adapter ───────────────────────────────────────────────────────────

export interface ContainerAdapterOptions {
  /** The adapter this wraps and delegates the ENTIRE JSONL contract to,
   *  unchanged (07 §2.1). Defaults to a fresh `JsonlProcessAdapter` sharing
   *  this option's `spawn`/`clock`/`logger`. */
  inner?: AgentRuntimeAdapter;
  spawn?: JobSpawn;
  clock?: Clock;
  logger?: Logger;
  control?: ContainerRuntimeControl;
  /** Root directory the per-execution workspace directories are created
   *  under (T15/T30). Default `<dataDir>/department/container-workspaces`. */
  workspaceRoot?: string;
  fs?: JobFs;
  env?: Record<string, string | undefined>;
  /** Suffix generator for container names (default: an 8-char random id) —
   *  injectable so tests get deterministic, assertable names. */
  makeId?(): string;
}

type BuildOutcome =
  | { ok: true; config: RuntimeConfig; containerName: string; runtimeBinary: ContainerRuntimeBinary }
  | { ok: false; reason: string };

export class ContainerAdapter implements AgentRuntimeAdapter {
  readonly id = 'container';

  private readonly inner: AgentRuntimeAdapter;
  private readonly control: ContainerRuntimeControl;
  private readonly fs: JobFs;
  private readonly workspaceRoot: string;
  private readonly makeId: () => string;
  private readonly logger: Logger;

  constructor(options: ContainerAdapterOptions = {}) {
    const spawn = options.spawn ?? nodeJobSpawn();
    const clock = options.clock ?? systemClock;
    const logger = options.logger ?? nullLogger;
    this.logger = logger;
    this.inner = options.inner ?? new JsonlProcessAdapter({ spawn, clock, logger });
    this.control = options.control ?? nodeContainerRuntimeControl();
    this.fs = options.fs ?? nodeJobFs();
    this.workspaceRoot = options.workspaceRoot ?? join(defaultDataDir(options.env), 'department', 'container-workspaces');
    this.makeId = options.makeId ?? (() => crypto.randomUUID().slice(0, 8));
  }

  async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const built = this.tryBuild(config, `probe-${this.makeId()}`);
    if (!built.ok) return { ok: false, reason: built.reason };
    try {
      return await this.inner.probe(built.config);
    } finally {
      // Best-effort cleanup net: `--rm` handles the common case, this covers
      // the "process ignored `shutdown` and had to be force-killed" one —
      // see the module doc's teardown-seam note.
      void this.control.removeContainer(built.containerName, built.runtimeBinary);
    }
  }

  async start(invocation: InvocationEnvelope, sink: RuntimeEventSink): Promise<RuntimeHandle> {
    const built = this.tryBuild(invocation.runtime, invocation.task.taskId);
    if (!built.ok) throw new RuntimeAdapterError(built.reason);
    const innerHandle = await this.inner.start({ ...invocation, runtime: built.config }, sink);
    return new ContainerHandle(innerHandle, built.containerName, built.runtimeBinary);
  }

  async send(handleIn: RuntimeHandle, input: RuntimeInput): Promise<void> {
    const handle = asContainerHandle(handleIn);
    return this.inner.send(handle.inner, input);
  }

  async cancel(handleIn: RuntimeHandle, reason?: string): Promise<void> {
    const handle = asContainerHandle(handleIn);
    return this.inner.cancel(handle.inner, reason);
  }

  async dispose(handleIn: RuntimeHandle): Promise<void> {
    const handle = asContainerHandle(handleIn);
    try {
      await this.inner.dispose(handle.inner);
    } finally {
      await this.control.removeContainer(handle.containerName, handle.runtimeBinary);
    }
  }

  /**
   * Validate + build one execution's container invocation: mkdir the
   * per-execution workspace (T15/T30, never wiped — see the module doc), then
   * `buildContainerArgs`. Never throws — failures are DATA (`ok:false`), same
   * discipline `ProbeResult`/`AdmitResult` already use elsewhere in this
   * package, so `probe()` can turn a bad spec into `{ok:false, reason}`
   * instead of a rejected promise.
   */
  private tryBuild(config: RuntimeConfig, taskIdForNaming: string): BuildOutcome {
    if (config.container === undefined) {
      return {
        ok: false,
        reason: `container: RuntimeConfig for adapterId '${config.adapterId}' is missing 'container' — refusing to run unsandboxed`,
      };
    }
    const containerName = `pipeline-dept-${sanitizeName(taskIdForNaming)}-${this.makeId()}`;
    const workspaceHostPath = join(this.workspaceRoot, sanitizeName(taskIdForNaming));
    try {
      this.fs.mkdirp(workspaceHostPath);
      const { runtimeBinary, args } = buildContainerArgs({
        spec: config.container,
        command: config.command,
        args: config.args ?? [],
        env: config.env,
        containerName,
        workspaceHostPath,
      });
      return {
        ok: true,
        containerName,
        runtimeBinary,
        // `env`/`cwd` are cleared on the OUTER config: they belong to the
        // CONTAINED process, and are already folded into `args` as `-e`/`-w`
        // flags above. Passing `env: undefined` through to the inner adapter
        // does NOT leak the daemon's host environment into the container —
        // `nodeJobSpawn()` merging `process.env` there supplies the `docker`
        // CLI PROCESS's own environment (PATH, DOCKER_HOST, …, needed just to
        // run `docker` at all), which has no bearing on what the CONTAINER's
        // environment is: docker does not forward the client's env into the
        // container unless told to with `-e`, which is exactly the boundary
        // this adapter uses to pass through ONLY `config.env`.
        config: { ...config, command: runtimeBinary, args, env: undefined, cwd: undefined },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`container: ${reason}`);
      return { ok: false, reason };
    }
  }
}
