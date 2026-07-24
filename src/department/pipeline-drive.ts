/**
 * `pipeline-drive` — department-mesh task d4 (`07-runtime-contract.md` §2.1,
 * `11-migration-rollout.md` P5). Wraps the EXISTING, UNCHANGED `pipeline
 * drive` contract (`../jobs/drive.ts`'s `buildDriveArgs` / `classifyDriveOutcome`
 * — neither touched by this file) behind the `AgentRuntimeAdapter` surface
 * (`./adapter.ts`, task d1), so `pipeline drive` becomes expressible as one
 * department runtime among others (`jsonl-process`, `container`) — "one
 * adapter abstraction serves both dispatch paths" (P5 DoD).
 *
 * ── This is a REFACTOR, not a new capability ────────────────────────────────
 * The pipeline-DISPATCH path (`../jobs/executor.ts`'s `JobExecutor`) is
 * intentionally left calling `buildDriveArgs`/`classifyDriveOutcome` DIRECTLY,
 * exactly as before this task — its provider-limit pause ladder, needs-input
 * relay (`NeedsInputRelay`), durable resume records, and ordered-completion
 * flush/report sequencing are supervisor-level policy (07 §2: "the adapter is
 * … not responsible for routing, lease management, or protocol framing —
 * those stay in the supervisor") that does not fit this adapter's generic
 * start/send/cancel/dispose surface without inventing NEW behaviour for
 * `pipeline drive` — forbidden by this task's own DoD ("no behaviour change
 * for pipeline runs"). `11-migration-rollout.md` §5 explicitly keeps that
 * "duplicate park/answer path" for pipeline dispatch; this adapter does not
 * retire or replace it. `../jobs/drive.test.ts`'s golden argv tests keep
 * asserting THAT direct path, byte-for-byte unchanged by this file.
 *
 * What THIS file proves instead: `AgentRuntimeAdapter` is expressive enough
 * to describe `pipeline drive`'s exact CLI contract — same argv (07 §2.1:
 * "wraps today's drive.ts contract unchanged"), same BUFFERED `JobExec` seam
 * (`../jobs/types.ts` earmarked this exactly: "that contract stays exactly
 * as-is for `pipeline drive` … d4 later ports it onto the adapter abstraction
 * unchanged"), same exit-code classification — reachable from the
 * department-mesh admission surface (`./manager.ts`) for a department whose
 * resolved `RuntimeConfig.adapterId === 'pipeline-drive'`.
 *
 * ── Declared capabilities (07 §2.1, fixed, never negotiated) ────────────────
 * `acceptsMidTaskInput: false`, `lifecycle: 'per-task'` only — always, not
 * something a `ready`-style handshake could ever raise (there is no
 * handshake: buffered `JobExec`, no stdin, drive exits after every
 * invocation). Consequently:
 *   - `send(handle, {kind:'message', …})` ALWAYS throws — mirrors
 *     `JsonlProcessAdapter`'s own capability-refusal discipline exactly
 *     (`./jsonl-process.ts`). `DepartmentManager` already never calls this
 *     for a `midTaskInput:false` handle (`./manager.ts`'s `deliverMessage`),
 *     so this is belt-and-braces, same posture as jsonl-process's own guard.
 *   - `send(handle, {kind:'task.start', …})` (daemon/per-context handle
 *     reuse) ALSO throws — 07 §2.1 restricts this adapter to `per-task`
 *     only; there is no live process to hand a second task to.
 *   - `checkpoint`/`resume` are not implemented (optional on the interface;
 *     `per-context`/`daemon` reuse do not apply here).
 *
 * ── One process per `start()`, not a loop (07 §1's buffered-exec note) ──────
 * Drive's own contract already has THREE invocation shapes (`start` /
 * `resume` / `answer`, `DriveMode`) chained by the CALLER (`executor.ts`'s
 * `driveLoop`) across possibly many exec calls before a task-level terminal
 * state is reached. THIS adapter's `start()` performs exactly ONE such exec
 * (mode `start`) and reports the ONE resulting `RuntimeEvent` —
 * `completed`, `failed`, or `input_required` — derived verbatim from
 * `classifyDriveOutcome`. It does NOT loop/retry/pause internally (provider-
 * limit policy is supervisor policy, not the adapter's, per 07 §2's own
 * module doc) and it does NOT resume a parked question on a later `send()`
 * (impossible without `acceptsMidTaskInput`, by design, above) — a caller
 * that wants the FULL multi-step drive loop (pause/resume/answer) is exactly
 * what `JobExecutor.driveLoop` already is, untouched by this file.
 *
 * `start()` itself resolves as soon as the handle is minted — there is no
 * "ready" signal to wait for (unlike `jsonl-process`'s handshake), and the
 * BUFFERED `JobExec` seam offers no earlier one either (a single promise that
 * only resolves at exit, `../jobs/types.ts`). The one drive exec races in the
 * background; its outcome reaches `sink` once `pipeline drive` exits —
 * exactly mirroring how `jsonl-process` streams events AFTER `start()`
 * resolves, just with a single terminal-shaped event instead of a live
 * stream (drive has nothing incremental to report, 07 §1's own table: "stdout
 * buffered until close").
 *
 * ── Cancellation (07 §7) ─────────────────────────────────────────────────────
 * There is no wire channel to ask politely (buffered `JobExec`, no stdin) —
 * the injectable `AbortSignal` (`JobExecOptions.signal`) is the only lever,
 * and it is the EXACT SAME mechanism `JobExecutor`'s own cancel/suspend
 * already use for the SAME `pipeline drive` child (`nodeJobExec()`'s abort
 * handling: `child.kill()`, a plain SIGTERM to the direct child — no
 * process-group escalation, because the buffered seam offers none). `cancel()`
 * and `dispose()` both abort; this is IDENTICAL in strength to what pipeline
 * dispatch already had before this task — no credential path, no kill
 * semantics, changed (10-security.md §7 P5 gate).
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import { buildDriveArgs, classifyDriveOutcome, type DriveMode, type DriveTarget } from '../jobs/drive';
import type { JobExec, JobExecResult } from '../jobs/types';
import { nodeJobExec } from '../jobs/types';
import type {
  AgentRuntimeAdapter,
  DeptTaskSpec,
  InvocationEnvelope,
  PipelineDriveSpec,
  ProbeResult,
  Question,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeHandle,
  RuntimeInput,
} from './adapter';
import { RuntimeAdapterError } from './adapter';

/** 07 §2.1: fixed and declared, never negotiated (there is no handshake that
 *  could raise it — unlike `jsonl-process`'s `ready` frame). */
export const PIPELINE_DRIVE_CAPABILITIES: RuntimeCapabilities = { midTaskInput: false, artifacts: false };

export interface PipelineDriveAdapterOptions {
  exec?: JobExec;
  logger?: Logger;
  /** Mints a fallback `input_required` question id for a parked outcome whose
   *  drive final JSON predates `question_id` (06.2.1) — mirrors
   *  `JobExecutor`'s own fallback-minting (`../jobs/executor.ts`'s
   *  `this.makeId()` in `driveLoop`'s `awaiting_input` branch). */
  makeId?(): string;
}

// ── The handle ────────────────────────────────────────────────────────────

class PipelineDriveHandle implements RuntimeHandle {
  readonly adapterId = 'pipeline-drive';
  readonly capabilities: RuntimeCapabilities = PIPELINE_DRIVE_CAPABILITIES;
  /** Set by `cancel()`/`dispose()` — once true, a still-in-flight exec's
   *  eventual result is never reported (mirrors `jsonl-process`'s "an exit
   *  during dispose() is not reported as a failure"). */
  disposed = false;

  constructor(
    readonly taskId: string,
    readonly contextId: string,
    readonly controller: AbortController
  ) {}
}

function asPipelineDriveHandle(handle: RuntimeHandle): PipelineDriveHandle {
  if (!(handle instanceof PipelineDriveHandle)) {
    throw new RuntimeAdapterError('pipeline-drive: handle was not minted by this adapter');
  }
  return handle;
}

// ── The adapter ───────────────────────────────────────────────────────────

export class PipelineDriveAdapter implements AgentRuntimeAdapter {
  readonly id = 'pipeline-drive';

  private readonly exec: JobExec;
  private readonly logger: Logger;
  private readonly makeId: () => string;

  constructor(options: PipelineDriveAdapterOptions = {}) {
    this.exec = options.exec ?? nodeJobExec();
    this.logger = options.logger ?? nullLogger;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
  }

  /**
   * Best-effort binary-presence check. Unlike `jsonl-process`'s `probe()`
   * (a real `initialize`/`ready` handshake, 07 §3), `pipeline drive` has NO
   * handshake to probe at all — this simply confirms `config.command
   * --version` runs. Not wired into any live admission path today (nothing
   * in `./manager.ts` calls `adapter.probe()` — same as every other adapter
   * in this package); it exists to satisfy the interface and is exercised by
   * this module's own tests.
   */
  async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const result = await this.exec.run(config.command, ['--version'], { cwd: config.cwd, env: config.env });
    if (result.code !== 0) {
      return {
        ok: false,
        reason: `'${config.command} --version' exited ${result.code ?? 'null'}${result.error ? `: ${result.error}` : ''}`,
      };
    }
    const version = result.stdout.trim();
    return {
      ok: true,
      runtime: 'pipeline-drive',
      capabilities: PIPELINE_DRIVE_CAPABILITIES,
      ...(version.length > 0 ? { version } : {}),
    };
  }

  async start(invocation: InvocationEnvelope, sink: RuntimeEventSink): Promise<RuntimeHandle> {
    const { runtime, task } = invocation;
    const drive = runtime.pipelineDrive;
    if (drive === undefined) {
      throw new RuntimeAdapterError("pipeline-drive: RuntimeConfig.pipelineDrive is required (07 §2.1)");
    }
    if (drive.pipelineRoot.trim().length === 0) {
      throw new RuntimeAdapterError('pipeline-drive: pipelineDrive.pipelineRoot must not be blank');
    }
    if (drive.startIteration.trim().length === 0) {
      throw new RuntimeAdapterError('pipeline-drive: pipelineDrive.startIteration must not be blank');
    }

    const controller = new AbortController();
    const handle = new PipelineDriveHandle(task.taskId, task.contextId, controller);
    // Fire-and-forget: the ONE drive exec races in the background; its
    // outcome reaches `sink` once `pipeline drive` exits (see this module's
    // doc — there is no earlier signal the buffered `JobExec` seam could
    // offer, unlike jsonl-process's `ready`).
    void this.runOnce(runtime, drive, task, sink, handle);
    return handle;
  }

  async send(handleIn: RuntimeHandle, input: RuntimeInput): Promise<void> {
    asPipelineDriveHandle(handleIn); // validates minting, mirrors every other adapter here
    if (input.kind === 'message') {
      throw new RuntimeAdapterError(
        "pipeline-drive: acceptsMidTaskInput:false (07 §2.1) — task.message can never be sent to this runtime; the supervisor must queue it and deliver at the next start()"
      );
    }
    throw new RuntimeAdapterError(
      "pipeline-drive: lifecycle is 'per-task' only (07 §2.1) — there is no live process to hand a second task.start to"
    );
  }

  async cancel(handleIn: RuntimeHandle, _reason?: string): Promise<void> {
    const handle = asPipelineDriveHandle(handleIn);
    // No wire channel to ask politely (buffered JobExec, no stdin) — abort is
    // the only lever, identical in strength to what pipeline dispatch already
    // had (`JobExecutor`'s own cancel/suspend use the same signal-based
    // abort against the same `nodeJobExec()` seam). See this module's doc.
    handle.controller.abort();
  }

  async dispose(handleIn: RuntimeHandle): Promise<void> {
    const handle = asPipelineDriveHandle(handleIn);
    if (handle.disposed) return;
    handle.disposed = true;
    handle.controller.abort();
  }

  private async runOnce(
    runtime: RuntimeConfig,
    drive: PipelineDriveSpec,
    task: DeptTaskSpec,
    sink: RuntimeEventSink,
    handle: PipelineDriveHandle
  ): Promise<void> {
    const target: DriveTarget = {
      pipelineRoot: drive.pipelineRoot,
      runId: task.taskId,
      ...(drive.defaultModel !== undefined ? { defaultModel: drive.defaultModel } : {}),
      ...(drive.defaultEffort !== undefined ? { defaultEffort: drive.defaultEffort } : {}),
      ...(drive.variables !== undefined ? { variables: drive.variables } : {}),
    };
    const mode: DriveMode = { kind: 'start', startIteration: drive.startIteration };
    // The SAME, unchanged argv builder pipeline-dispatch uses — this IS the
    // "one abstraction serves both dispatch paths" proof (P5 DoD).
    const args = buildDriveArgs(target, mode);

    let result: JobExecResult;
    try {
      result = await this.exec.run(runtime.command, args, {
        cwd: runtime.cwd,
        env: runtime.env,
        signal: handle.controller.signal,
      });
    } catch (err) {
      // `JobExec.run()`'s own contract promises never to reject (failures are
      // data — `../jobs/types.ts`); this is defence in depth against a
      // differently-behaved injected seam, same posture as
      // `./manager.ts`'s `executionTokens?.renew(...).catch(() => {})`.
      const reason = `pipeline drive exec threw: ${err instanceof Error ? err.message : String(err)}`;
      if (handle.disposed) {
        this.logger.debug(`pipeline-drive[${task.taskId}]: exec threw after dispose — dropped (${reason})`);
        return;
      }
      sink({ type: 'failed', reason, retrySafe: false });
      return;
    }

    // Torn down via cancel()/dispose() while the exec was in flight — the
    // outcome (however classified) is moot; the supervisor already finalized
    // this execution through a different path (mirrors jsonl-process's "an
    // exit during dispose() is not reported as a failure").
    if (handle.disposed) {
      this.logger.debug(`pipeline-drive[${task.taskId}]: exec settled after dispose — outcome dropped`);
      return;
    }

    sink(this.toRuntimeEvent(result));
  }

  /** `classifyDriveOutcome` (`../jobs/drive.ts`, UNCHANGED) has four kinds;
   *  `RuntimeEvent` has three that apply here. `halted` and `failed` map onto
   *  the SAME `RuntimeEvent` shape — exactly mirroring `JobExecutor.driveLoop`'s
   *  own switch, where the `'halted'` and `'failed'` cases already do the
   *  identical thing (`reportTerminal('halted', …)` then `this.fail(…)`). */
  private toRuntimeEvent(result: JobExecResult): RuntimeEvent {
    const outcome = classifyDriveOutcome(result);
    switch (outcome.kind) {
      case 'completed':
        return { type: 'completed', summary: outcome.outcome };
      case 'halted':
        return { type: 'failed', reason: outcome.reason, retrySafe: false };
      case 'failed':
        return { type: 'failed', reason: outcome.reason, retrySafe: false };
      case 'awaiting_input': {
        const parked = outcome.parked;
        const question: Question = {
          text: parked.question.text,
          context: parked.question.context,
          options: parked.question.options,
        };
        // 06.2.1/06.2.2: drive's own minted question_id wins verbatim; an
        // older CLI whose park JSON predates the field gets a fallback —
        // same rule `JobExecutor.driveLoop` applies for its OWN parked path.
        return { type: 'input_required', questionId: parked.question_id ?? this.makeId(), question };
      }
    }
  }
}

/**
 * Narrow an unknown value (loaded from `PIPELINE_RUNNER_DEPARTMENTS`,
 * `./config.ts`'s placeholder department-runtime resolution) back into a
 * `PipelineDriveSpec`, or `undefined` if it is not well-formed enough to
 * drive a run from — same tolerant-parse philosophy `./container.ts`'s own
 * `narrowContainerSpec` already uses. Deliberately strict about the two
 * REQUIRED fields (`pipelineRoot`, `startIteration` — a spec missing either
 * cannot build a valid `--root`/`--start` invocation) but tolerant of
 * malformed OPTIONAL fields, each simply omitted.
 */
export function narrowPipelineDriveSpec(raw: unknown): PipelineDriveSpec | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.pipelineRoot !== 'string' || r.pipelineRoot.length === 0) return undefined;
  if (typeof r.startIteration !== 'string' || r.startIteration.length === 0) return undefined;

  const spec: PipelineDriveSpec = { pipelineRoot: r.pipelineRoot, startIteration: r.startIteration };
  if (typeof r.defaultModel === 'string' && r.defaultModel.length > 0) spec.defaultModel = r.defaultModel;
  if (typeof r.defaultEffort === 'string' && r.defaultEffort.length > 0) spec.defaultEffort = r.defaultEffort;
  if (typeof r.variables === 'object' && r.variables !== null && !Array.isArray(r.variables)) {
    const variables: Record<string, string> = {};
    for (const [key, value] of Object.entries(r.variables as Record<string, unknown>)) {
      if (typeof value === 'string') variables[key] = value;
    }
    spec.variables = variables;
  }
  return spec;
}
